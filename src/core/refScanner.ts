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
 * 两个分支，顺序不能颠倒：
 * 1. **embed 表达式** `{{embed ((uuid))}}` —— 必须优先匹配，
 *    否则内部的 `((uuid))` 会被第二个分支当成普通行内引用，
 *    导致同一个 UUID 被计入两次，且渲染范围只剩内层、外壳 `{{embed }}` 残留。
 * 2. **普通行内引用** `((uuid))` / 全角 `（（uuid））`
 *
 * UUID 字符集限定为 `[A-Za-z0-9_-]`，长度下限 36（标准 UUID 长度），
 * 这样可以避免跨越正常标点、也不会把 `((abc))` 之类的伪引用算进来。
 *
 * embed 允许 `{{ embed ... }}` 这种带空格的写法：Tine/Logseq 都接受，
 * 成本只是几个 `\s*`，但少了它就会漏解析。
 * UUID 两侧也允许空白（`(( uuid ))`）：手写时很容易多打空格。
 */
const BLOCK_REF_PATTERN =
	/(?:\{\{\s*embed\s*(?:\(\(\s*([A-Za-z0-9_-]{36,})\s*\)\)|（（\s*([A-Za-z0-9_-]{36,})\s*））)\s*\}\})|(?:\(\(\s*([A-Za-z0-9_-]{36,})\s*\)\)|（（\s*([A-Za-z0-9_-]{36,})\s*））)/g;

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

		// 分组布局：
		//   1/2 = embed 内部的半角/全角 UUID
		//   3/4 = 普通行内的半角/全角 UUID
		// 有 embed 分组即说明命中的是 embed 分支。
		const embedUuid = match[1] ?? match[2];
		const inlineUuid = match[3] ?? match[4];
		const rawUuid = embedUuid ?? inlineUuid;
		if (!rawUuid) {
			continue;
		}

		out.push({
			uuid: rawUuid.toLowerCase(),
			line: lineNumber,
			column: match.index,
			// 范围覆盖整个表达式：embed 时含 `{{embed ` 与 `}}`，
			// 这样行内渲染才能把外壳一起替换掉，不会留下 `{{embed 标题}}` 这种残骸。
			endColumn: match.index + match[0].length,
			kind: embedUuid ? 'embed' : 'inline',
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
