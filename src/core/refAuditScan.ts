/**
 * 严格引用扫描。
 *
 * 与 `refScanner` 的分工：
 * - `refScanner` 服务于渲染/反链，只抓「看起来像 UUID」的引用；
 * - 这里用更宽松的正则，把 `((abc))`、`(((uuid)))` 这类畸形引用也抓出来，
 *   再由审计主流程逐个判断值是否规范。
 *
 * 同样跳过 frontmatter、代码围栏与行内代码。
 */

import { getOpeningFenceState, isClosingFence, skipInlineCodeSpan, type MarkdownFenceState } from './fence';

/** 严格扫描到的一处引用。 */
export interface StrictReference {
	line: number;
	column: number;
	endColumn: number;
	value: string;
	/** 前后多包了一层括号，例如 `(((uuid)))`。 */
	wrapped: boolean;
	/**
	 * `((` 前面紧跟非空白字符（含行内紧邻文字、中文标点等）。
	 *
	 * Tine / Logseq 的原生规则是「行首，或空白之后的 `((uuid))` 才算块引用」。
	 * 紧贴前文的写法在本扩展里仍能扫描到，但粘回 Tine 会退化成普通文本，
	 * 所以必须单独标出来提示补一个空格。
	 */
	tightPrefix: boolean;
}

/**
 * 严格引用正则。
 *
 * 不允许跨行、不允许内部再出现括号，避免把两个相邻引用吞成一个。
 */
const STRICT_REFERENCE_PATTERN = /\(\(\s*([^()\n]*?)\s*\)\)|（（\s*([^（）\n]*?)\s*））/g;

/** 计算一行内所有行内代码区间 [start, end)。与 refScanner 保持一致。 */
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

function isInsideRanges(ranges: Array<[number, number]>, position: number): boolean {
	for (const [start, end] of ranges) {
		if (position >= start && position < end) {
			return true;
		}
	}
	return false;
}

/** 扫描全文所有 `((...))`（含畸形）。 */
export function scanStrictReferences(lines: readonly string[], tabSize: number): StrictReference[] {
	const references: StrictReference[] = [];
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

		const opening = getOpeningFenceState(line, tabSize);
		if (opening) {
			fence = opening;
			continue;
		}

		const inlineCodeRanges = computeInlineCodeRanges(line);
		STRICT_REFERENCE_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = STRICT_REFERENCE_PATTERN.exec(line)) !== null) {
			if (isInsideRanges(inlineCodeRanges, match.index)) {
				continue;
			}
			const value = (match[1] ?? match[2] ?? '').trim();
			const before = line[match.index - 1];
			const after = line[match.index + match[0].length];

			/*
			 * 空白规则要追溯到宏的起点。
			 *
			 * `{{embed ((uuid))}}` 同样要求 `{{` 前面是行首或空白，但本正则只从内层
			 * `((` 开始匹配，直接看 `((` 前一个字符会漏判（内层前面永远是空格）。
			 * 因此先看看 `((` 前面是不是 `{{` / `{{embed` 开头，是的话把判定位置挪到 `{{`。
			 */
			const macro = /\{\{\s*embed\s*$/i.exec(line.slice(0, match.index));
			const prefixIndex = macro ? match.index - macro[0].length : match.index;
			const prefixChar = prefixIndex > 0 ? line[prefixIndex - 1] : undefined;

			references.push({
				line: lineNumber,
				column: match.index,
				endColumn: match.index + match[0].length,
				value,
				wrapped:
					before === '(' || before === '（' || after === ')' || after === '）',
				// `prefixChar` 为 undefined 表示整行以引用开头，属于合法写法。
				tightPrefix: prefixChar !== undefined && !/\s/.test(prefixChar),
			});
		}
	}

	return references;
}
