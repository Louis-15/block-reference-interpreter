/**
 * 块引用扫描器。
 *
 * 目标：从 Markdown 文本里找出所有 `((uuid))`，并给出精确行列号，
 * 同时**必须**排除三类假阳性：
 *   1. frontmatter（YAML 里的示例 UUID）
 *   2. 代码围栏内（代码示例）
 *   3. 行内代码内（`` `((uuid))` ``）
 *
 * 排不干净会直接污染 AI 的输入：AI 会以为某个块真的被引用了。
 */

import { getOpeningFenceState, isClosingFence, skipInlineCodeSpan, type MarkdownFenceState } from './fence';
import type { ReferenceHit } from './types';

/**
 * 块引用主匹配。
 *
 * UUID 长度下限取 36，与 Tine/Obsidian 实现一致：
 * 标准 UUID 是 36 字符，放宽下限是为了兼容极少数带额外后缀的变体。
 * 上限不设，但字符集限定为 UUID 合法字符，避免跨越正常标点。
 *
 * 同时支持全角括号：中文输入法下极易把 `((` 打成 `（（`，
 * 实测当前笔记库为 0 例，但支持成本几乎为零。
 */
const BLOCK_REF_PATTERN = /(?:\(\(([A-Za-z0-9_-]{36,})\)\)|（（([A-Za-z0-9_-]{36,})））)/g;

/** 命中位置之前是否紧邻 `{{embed`。 */
const EMBED_PREFIX_PATTERN = /\{\{embed\s*$/;

/**
 * 计算一行内所有行内代码区间的 [start, end) 下标。
 *
 * 反引号数量必须严格配对：`` ` `` 只能闭合单个反引号，
 * 这样才能正确处理 `` ``a`b`` `` 这种内部含反引号的写法。
 */
function computeInlineCodeRanges(line: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let index = 0;
	while (index < line.length) {
		if (line[index] === '`') {
			const end = skipInlineCodeSpan(line, index);
			ranges.push([index, end]);
			index = end;
			continue;
		}
		index++;
	}
	return ranges;
}

/** 判断下标是否落在任一区间内。 */
function isInsideRanges(ranges: Array<[number, number]>, position: number): boolean {
	for (const [start, end] of ranges) {
		if (position >= start && position < end) {
			return true;
		}
	}
	return false;
}

/** 扫描单行，把命中追加到 out。 */
function scanLine(line: string, lineNumber: number, out: ReferenceHit[]): void {
	// 先在整行上跑正则，再逐个过滤行内代码区间。
	// 这样比「逐字符前进 + 每次设置 lastIndex」更简单，也不会漏掉重叠候选。
	BLOCK_REF_PATTERN.lastIndex = 0;
	const inlineCodeRanges = computeInlineCodeRanges(line);
	let match: RegExpExecArray | null;

	while ((match = BLOCK_REF_PATTERN.exec(line)) !== null) {
		if (isInsideRanges(inlineCodeRanges, match.index)) {
			continue;
		}

		const rawUuid = match[1] ?? match[2];
		if (!rawUuid) {
			continue;
		}

		const before = line.slice(0, match.index);
		out.push({
			uuid: rawUuid.toLowerCase(),
			line: lineNumber,
			column: match.index,
			kind: EMBED_PREFIX_PATTERN.test(before) ? 'embed' : 'inline',
		});
	}
}

/**
 * 扫描整个文件的行序列，返回全部块引用命中。
 *
 * 扫描顺序与语义必须与 `parseMarkdown` 中的块解析保持一致，
 * 否则会出现「引用被算进去了，但块边界判错」的错配。
 */
export function scanReferences(lines: readonly string[], tabSize = 4): ReferenceHit[] {
	const hits: ReferenceHit[] = [];

	// frontmatter：首行 `---` 起，到 `---` 或 `...` 结束。
	let inFrontmatter = lines.length > 0 && (lines[0] ?? '').trim() === '---';
	let fence: MarkdownFenceState | null = null;

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber] ?? '';

		if (inFrontmatter) {
			const trimmed = line.trim();
			if (lineNumber > 0 && (trimmed === '---' || trimmed === '...')) {
				inFrontmatter = false;
			}
			continue;
		}

		if (fence) {
			if (isClosingFence(line, fence, tabSize)) {
				fence = null;
			}
			continue;
		}

		const openingFence = getOpeningFenceState(line, tabSize);
		if (openingFence) {
			fence = openingFence;
			continue;
		}

		scanLine(line, lineNumber, hits);
	}

	return hits;
}

/** 提取一行里所有块引用 UUID（按出现顺序，含重复）。 */
export function extractUuidsFromLine(line: string): string[] {
	const hits: ReferenceHit[] = [];
	scanLine(line, 0, hits);
	return hits.map((hit) => hit.uuid);
}
