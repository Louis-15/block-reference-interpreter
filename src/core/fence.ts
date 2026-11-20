/**
 * Markdown 代码围栏状态机。
 *
 * 为什么需要它：
 * 1. 围栏里的 `((uuid))` 是代码示例，不能当块引用解析；
 * 2. 围栏里的 `id:: xxx` 也不是块属性；
 * 3. 围栏内的行仍然属于「外面那个块」，所以块解析遇到围栏时要继续把行归给当前块，
 *    只是不做语法判定。
 *
 * 与标准 CommonMark 的差异（有意为之）：
 * CommonMark 规定 4 列及以上缩进的 ``` 不算围栏，只是缩进代码块的内容。
 * 但 Tine / Logseq 的笔记里，代码块几乎总是写在列表项内部：
 *
 * ```
 * - 代码示例
 * \t```js          ← 缩进 4 列
 * \t代码
 * \t```
 * ```
 *
 * 按 CommonMark 处理，这段代码里的 `- xxx` 会被误判成新块，块树直接崩掉。
 * 所以这里接受任意缩进的围栏标记，代价是极少数「缩进代码块里恰好写了 ```」的场景会误判，
 * 这在笔记库中实际不存在。
 */

import { measureIndentColumns } from './blockLine';

export interface MarkdownFenceState {
	/** 围栏字符。 */
	char: '`' | '~';
	/** 开围栏长度（至少 3）。 */
	length: number;
	/** 闭围栏允许的最小缩进列数。 */
	minClosingIndentColumns: number;
	/** 闭围栏允许的最大缩进列数；null 表示不限。 */
	maxClosingIndentColumns: number | null;
}

/** 根级围栏：行首空白后直接是围栏标记。 */
const ROOT_FENCE_REGEX = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/**
 * 列表项内围栏：`- ``` `、`- [ ] ``` ` 等。
 * 捕获组 1 是缩进 + 列表标记；闭围栏的缩进至少要追上列表标记前的空白。
 */
const LIST_ITEM_FENCE_REGEX = /^([ \t]*-[ \t]+(?:\[[ xX-]\][ \t]+)?)(`{3,}|~{3,})(.*)$/;

/** 闭围栏剩余部分必须只有标记与尾部空白。 */
const CLOSING_FENCE_REMAINDER_REGEX = /^(`{3,}|~{3,})[ \t]*$/;

/**
 * 若该行开启了一个代码围栏，返回围栏状态；否则返回 null。
 *
 * 列表项内围栏优先匹配：`  - ```js` 既是列表行也是围栏行，
 * 这种情况下闭围栏缩进要跟随列表标记的缩进。
 */
export function getOpeningFenceState(line: string, tabSize = 4): MarkdownFenceState | null {
	const listItemMatch = line.match(LIST_ITEM_FENCE_REGEX);
	if (listItemMatch) {
		const marker = listItemMatch[2] ?? '';
		const leading = (listItemMatch[1] ?? '').match(/^[ \t]*/)?.[0] ?? '';
		return {
			char: marker[0] as '`' | '~',
			length: marker.length,
			minClosingIndentColumns: measureIndentColumns(leading, tabSize),
			maxClosingIndentColumns: null,
		};
	}

	const rootMatch = line.match(ROOT_FENCE_REGEX);
	if (!rootMatch) {
		return null;
	}

	const marker = rootMatch[2] ?? '';
	const indentColumns = measureIndentColumns(rootMatch[1] ?? '', tabSize);
	return {
		char: marker[0] as '`' | '~',
		length: marker.length,
		// 缩进不设上限：见文件头部关于 Logseq 列表内代码块的说明。
		minClosingIndentColumns: indentColumns,
		maxClosingIndentColumns: null,
	};
}

/**
 * 判断该行是否闭合了给定围栏。
 *
 * 闭合条件（全部满足）：
 * - 缩进不小于开围栏所在行的缩进（避免用更浅的缩进误闭合）；
 * - 剩余部分只有同字符、长度不短于开围栏的标记，允许尾部空白。
 */
export function isClosingFence(line: string, state: MarkdownFenceState, tabSize = 4): boolean {
	const indentation = line.match(/^[ \t]*/)?.[0] ?? '';
	const indentColumns = measureIndentColumns(indentation, tabSize);

	if (indentColumns < state.minClosingIndentColumns) {
		return false;
	}
	if (state.maxClosingIndentColumns !== null && indentColumns > state.maxClosingIndentColumns) {
		return false;
	}

	const remainder = line.slice(indentation.length);
	const markerMatch = remainder.match(CLOSING_FENCE_REMAINDER_REGEX);
	if (!markerMatch) {
		return false;
	}

	const marker = markerMatch[1] ?? '';
	return marker[0] === state.char && marker.length >= state.length;
}

/**
 * 跳过行内代码跨度。
 *
 * 从 `start`（指向第一个反引号）开始，返回该行内代码结束后的下标。
 * 未闭合时只跳过开头那串反引号，保持与 CommonMark 一致的宽松处理。
 */
export function skipInlineCodeSpan(line: string, start: number): number {
	let ticks = 0;
	while (start + ticks < line.length && line[start + ticks] === '`') {
		ticks++;
	}

	const delimiter = '`'.repeat(ticks);
	const closingIndex = line.indexOf(delimiter, start + ticks);
	if (closingIndex === -1) {
		return start + ticks;
	}

	return closingIndex + ticks;
}
