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

/**
 * 顶格 ATX 标题行的正则（行首没有任何缩进）。
 *
 * Tine / Logseq 的解析器（lsdoc）把这种行当作**独立的块**，和 `- ` 列表块并列：
 * 它可以被折叠、可以挂 `id::`、可以被 `((uuid))` 引用。典型写法是
 *
 * ```markdown
 * # 1 大义、天理
 * collapsed:: true
 * id:: 66b1f836-...
 * 	- 孟子：民为贵……
 * ```
 *
 * 两个条件必须同时满足，放宽任何一个都会把普通正文误判成块：
 * - `#` 紧贴行首：缩进的 `#` 在本插件里仍是普通续行；
 * - `#` 后面是空白或直接行尾：`#标签` 是 tag，`#速记` 之类的写法不能被当成标题。
 */
const ATX_HEADING_REGEX = /^#{1,6}(?:[ \t]+|$)/;

/** 判断一行是否为顶格 ATX 标题（`# 标题`，行首无缩进）。 */
export function isAtxHeadingLine(line: string): boolean {
	return ATX_HEADING_REGEX.test(line);
}

/**
 * 按 LF 切分并剥离每行尾部 CR（兼容 CRLF 文件）。
 *
 * 放在本模块而不是解析器里：这是纯粹的「文本 → 行数组」操作，
 * 与块树构建无关，解析器只是它的调用方。
 */
export function splitLines(content: string): string[] {
	const lines = content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

	/**
	 * 剥掉 UTF-8 BOM。
	 *
	 * BOM 是不可见字符，但它会让首行变成 `\uFEFF- xxx`，
	 * 于是列表行正则匹配失败、**整个第一个块丢失**，
	 * 表现为「文件里的块 ID 找不到」这种极难定位的问题。
	 * 当前笔记库没有 BOM 文件，但用户随时可能从别处导入。
	 */
	const first = lines[0];
	if (first !== undefined && first.charCodeAt(0) === 0xfeff) {
		lines[0] = first.slice(1);
	}

	return lines;
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
