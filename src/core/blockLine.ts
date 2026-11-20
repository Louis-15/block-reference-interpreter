/**
 * 列表行识别与缩进列宽测量。
 *
 * 这两个函数看着简单，但它们是整个块解析的地基：
 * 缩进算错一个制表位，父子关系就会整体错位，块引用就会指向错误的子树。
 */

import type { BlockLineInfo } from './types';

/**
 * 水平线判定。
 *
 * 必须先于列表行判定执行：`---` 在 Markdown 里是分隔线，
 * 但列表行正则也能把它当成一个空列表项，导致产生幽灵块。
 * 同时这条规则也保护了 frontmatter 的起止边界。
 */
const HORIZONTAL_RULE_REGEX = /^[ \t]*(?:-[ \t]*){3,}$/;

/**
 * 列表行判定。
 *
 * 覆盖三种合法形态：
 * - `- 内容`
 * - `-`（行尾直接结束，空块）
 * - `-   `（仅尾部空白，也是空块）
 *
 * 刻意不接受 `*` 和 `+`：Tine / Logseq 的块语法固定用 `-`，
 * 放宽反而会把 Markdown 里的无序列表当成带 ID 的块。
 */
const SOURCE_BLOCK_LINE_REGEX = /^([ \t]*)-(?:[ \t]+(.*)|[ \t]*)$/;

/**
 * 把一段空白换算成「列数」。
 *
 * 制表符不能算 1 列：编辑器按 tabStop 对齐，Logseq 系笔记普遍用制表符做层级缩进。
 * 若按 1 列处理，`\t\t-` 与 `    -`（4 空格）会被判断成同一层级，块树直接错。
 *
 * @param value 只包含空格与制表符的字符串
 * @param tabSize 制表位宽度，默认 4（与 Tine / Logseq 默认一致）
 */
export function measureIndentColumns(value: string, tabSize = 4): number {
	let columns = 0;
	for (const char of value) {
		if (char === '\t') {
			// 对齐到下一个制表位；正好落在边界上时前进完整一格。
			const toNextStop = tabSize - (columns % tabSize);
			columns += toNextStop === 0 ? tabSize : toNextStop;
			continue;
		}
		columns += 1;
	}
	return columns;
}

/**
 * 解析一行是否为列表块首行。
 *
 * @returns 命中时返回缩进空白与正文；不是列表行（或其实是水平线）时返回 null
 */
export function parseSourceBlockLine(line: string): BlockLineInfo | null {
	if (HORIZONTAL_RULE_REGEX.test(line)) {
		return null;
	}

	const match = line.match(SOURCE_BLOCK_LINE_REGEX);
	if (!match) {
		return null;
	}

	return {
		leadingWhitespace: match[1] ?? '',
		content: match[2] ?? '',
	};
}

/** 判断一行是否为列表块首行。 */
export function isSourceBlockLine(line: string): boolean {
	return parseSourceBlockLine(line) !== null;
}

/** 取一行行首空白的列数。 */
export function lineIndentColumns(line: string, tabSize = 4): number {
	const match = line.match(/^[ \t]*/);
	return match ? measureIndentColumns(match[0], tabSize) : 0;
}

/** 判断一行是否完全空白（空格/制表符/回车都算）。 */
export function isBlankLine(line: string): boolean {
	return line.trim().length === 0;
}
