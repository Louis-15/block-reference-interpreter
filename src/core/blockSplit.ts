/**
 * 回车 / 块内换行的编辑计划。
 *
 * Tine / Logseq 是**大纲笔记**：正文里每一行都属于某个 `- ` 块。
 * VS Code 内置 Markdown 完全没有这个行为（`markdown-basics` 里没有
 * `onEnterRules`），所以必须由插件实现两件事：
 *
 * 1. 回车（Enter）：拆出**同级新块**，正文区域任何位置都要带 `- `；
 *    空块回车也要继续产生空块——空块是合法的占位/分隔手段。
 * 2. 块内换行（Shift+Enter）：只插入软换行，缩进与块内容对齐，不产生新块。
 *
 * 这一层是纯函数：只判断该不该处理、插入什么文本，不碰编辑器。
 */

import { parseSourceBlockLine } from './blockLine';
import { findDeepestBlockAtLine } from './blockParser';
import { getOpeningFenceState, isClosingFence, type MarkdownFenceState } from './fence';
import type { ParsedFile } from './types';

/** 不能接管按键的原因；调用方据此回退到 VS Code 默认行为。 */
export type BlockEnterReject =
	/** 有选区：交给默认行为，避免吞掉用户选中的文本。 */
	| 'has-selection'
	/** frontmatter 区域：回车应继续写 YAML。 */
	| 'frontmatter'
	/** 页面属性区（`title::` 之类）：回车应继续写属性。 */
	| 'page-property'
	/** 代码围栏内部：回车必须只是新增代码行。 */
	| 'in-fence'
	/** Markdown 表格内：回车应交给编辑器处理表格布局。 */
	| 'in-table'
	/** 光标在块首行的 `- ` 标记区域内：拆开会产生畸形结构。 */
	| 'before-content'
	/** 行号越界。 */
	| 'no-line';

/** 回车计划：插入一行带项目符号的新块。 */
export interface BlockEnterPlan {
	kind: 'insert-block';
	/** 要插入的文本，例如 `\n  - `。 */
	insertText: string;
}

/** 纯换行计划：代码围栏及其边界行，不能插入项目符号或额外缩进。 */
export interface PlainNewlinePlan {
	kind: 'plain-newline';
	/** 要插入的文本。 */
	insertText: string;
	/**
	 * 是否插到行尾而不是光标处。
	 *
	 * 围栏的起始行（`- ```js`）与结束行（` ``` `）中间按回车会把三连反引号
	 * 拆成两半，围栏直接失效。这类行只能在行尾换行，把光标带到下一行。
	 */
	atLineEnd: boolean;
}

/** 块内换行计划：只插入软换行与内容缩进。 */
export interface SoftBreakPlan {
	kind: 'soft-break';
	/** 要插入的文本，例如 `\n  `。 */
	insertText: string;
}

/** 回车结果。 */
export type BlockEnterResult =
	| BlockEnterPlan
	| PlainNewlinePlan
	| { kind: 'reject'; reject: BlockEnterReject };

/** 块内换行结果。 */
export type SoftBreakResult =
	| SoftBreakPlan
	| PlainNewlinePlan
	| { kind: 'reject'; reject: BlockEnterReject };

/** 选项。 */
export interface BlockEnterOptions {
	/** 制表位宽度，必须与解析器一致。 */
	tabSize?: number;
	/** 当前是否有非空选区。 */
	hasSelection?: boolean;
}

/** 块内容相对项目符号的额外缩进，与属性行保持一致。 */
const CONTENT_INDENT = '  ';

/** Markdown 表格行：以 `|` 开头（允许缩进）。 */
const TABLE_LINE_PATTERN = /^[ \t]*\|/;

/** 页面属性行（文件开头、非列表、形如 `key:: value`）。 */
const PAGE_PROPERTY_PATTERN = /^\s*[^-\s].*?::\s*.*$/;

/** 判断某一行之前是否存在未闭合的围栏（即该行在围栏内部）。 */
export function isLineInsideFence(
	lines: readonly string[],
	targetLine: number,
	tabSize = 4,
): boolean {
	let fence: MarkdownFenceState | null = null;

	for (let line = 0; line < targetLine; line++) {
		const text = lines[line] ?? '';
		if (fence) {
			if (isClosingFence(text, fence, tabSize)) {
				fence = null;
			}
			continue;
		}
		const opening = getOpeningFenceState(text, tabSize);
		if (opening) {
			fence = opening;
		}
	}

	return fence !== null;
}

/** 该行本身是否是围栏的起始行或结束行。 */
export function isFenceBoundaryLine(
	lines: readonly string[],
	targetLine: number,
	tabSize = 4,
): boolean {
	const text = lines[targetLine] ?? '';
	if (getOpeningFenceState(text, tabSize)) {
		return true;
	}

	// 不是起始行，再看它是否闭合了前面某个围栏。
	let fence: MarkdownFenceState | null = null;
	for (let line = 0; line < targetLine; line++) {
		const current = lines[line] ?? '';
		if (fence) {
			if (isClosingFence(current, fence, tabSize)) {
				fence = null;
			}
			continue;
		}
		const opening = getOpeningFenceState(current, tabSize);
		if (opening) {
			fence = opening;
		}
	}

	return fence !== null && isClosingFence(text, fence, tabSize);
}

/**
 * 该行是否位于代码围栏的上下文中。
 *
 * 与 `isLineInsideFence` 的区别：把**起始行与结束行本身**也算进来。
 * 这两行虽然不在围栏「内部」，但在中间插入内容同样会把三连反引号拆散，
 * 必须按代码行处理。
 */
export function isLineInFenceContext(
	lines: readonly string[],
	targetLine: number,
	tabSize = 4,
): boolean {
	return (
		isLineInsideFence(lines, targetLine, tabSize) ||
		isFenceBoundaryLine(lines, targetLine, tabSize)
	);
}

/** 该行是否位于 frontmatter 内（含起止的 `---`）。 */
export function isLineInFrontmatter(lines: readonly string[], targetLine: number): boolean {
	if (lines.length === 0 || (lines[0] ?? '').trim() !== '---') {
		return false;
	}
	if (targetLine === 0) {
		return true;
	}
	for (let line = 1; line < lines.length; line++) {
		const trimmed = (lines[line] ?? '').trim();
		if (trimmed === '---' || trimmed === '...') {
			return targetLine <= line;
		}
	}
	// 没有结束标记：整篇都被当成 frontmatter，保守放行更安全。
	return true;
}

/**
 * 该行是否属于文件开头的页面属性区。
 *
 * 只在第一个块之前判定：一旦正文开始，`key::` 形态的行就是块属性，
 * 不再属于页面。
 */
export function isPagePropertyLine(parsed: ParsedFile, targetLine: number): boolean {
	const firstBlockLine = parsed.blocks[0]?.startLine;
	if (firstBlockLine !== undefined && targetLine >= firstBlockLine) {
		return false;
	}
	return PAGE_PROPERTY_PATTERN.test(parsed.lines[targetLine] ?? '');
}

/** 统一的前置检查：返回拒绝原因，或 null 表示可以接管。 */
function checkCommonRejects(
	parsed: ParsedFile,
	line: number,
	options: BlockEnterOptions,
): BlockEnterReject | null {
	if (options.hasSelection) {
		return 'has-selection';
	}
	if (parsed.lines[line] === undefined) {
		return 'no-line';
	}

	const tabSize = options.tabSize ?? 4;
	if (isLineInFrontmatter(parsed.lines, line)) {
		return 'frontmatter';
	}
	if (isLineInFenceContext(parsed.lines, line, tabSize)) {
		// 代码行由调用方转成 plain-newline，这里只负责标记「不要插项目符号」。
		return 'in-fence';
	}
	if (TABLE_LINE_PATTERN.test(parsed.lines[line] ?? '')) {
		return 'in-table';
	}
	if (isPagePropertyLine(parsed, line)) {
		return 'page-property';
	}
	return null;
}

/** 取块首行的项目符号长度（含缩进与 `- `）。 */
function markerLengthOf(blockFirstLine: string): number {
	return blockFirstLine.match(/^[ \t]*-[ \t]*/)?.[0].length ?? 0;
}

/**
 * 代码围栏内的换行计划。
 *
 * 关键：**必须保留当前行的缩进**。
 *
 * 列表项里的代码块（`- ``` ` + 缩进内容）要求每一行都有缩进，
 * 一旦插入顶格新行，VS Code 会认为围栏提前结束，代码块被切成两段。
 * 这正是用户在大代码块里按 Shift+Enter 看到的现象。
 *
 * 围栏的起始行与结束行更特殊：在 ` ``` ` 中间换行会把三连反引号拆开，
 * 所以只能插到行尾，把光标带到下一行。
 */
function buildFenceNewlinePlan(
	parsed: ParsedFile,
	line: number,
	tabSize: number,
): PlainNewlinePlan {
	if (isFenceBoundaryLine(parsed.lines, line, tabSize)) {
		return { kind: 'plain-newline', insertText: '\n', atLineEnd: true };
	}

	const indent = (parsed.lines[line] ?? '').match(/^[ \t]*/)?.[0] ?? '';
	return { kind: 'plain-newline', insertText: `\n${indent}`, atLineEnd: false };
}

/**
 * 计算回车计划。
 *
 * 规则（与 Tine / Logseq 对齐）：
 * - 块内任意位置回车 → 插入 `\n + 块缩进 + '- '`，拆出同级新块；
 * - 空块回车 → 同样产生新的空块（空块是合法写法，允许连续多个）；
 * - 正文区域但不在块内（例如块间空行、顶格文本）→ 插入 `\n- `，让新行变成块；
 * - 代码围栏及其边界行 → 只换行，绝不插项目符号。
 *
 * @param parsed 当前文档的解析结果
 * @param line 光标所在行（0-based）
 * @param character 光标所在列（0-based）
 * @param options 选项
 */
export function buildBlockEnterPlan(
	parsed: ParsedFile,
	line: number,
	character: number,
	options: BlockEnterOptions = {},
): BlockEnterResult {
	const tabSize = options.tabSize ?? 4;
	const rejected = checkCommonRejects(parsed, line, options);
	if (rejected === 'in-fence') {
		return buildFenceNewlinePlan(parsed, line, tabSize);
	}
	if (rejected) {
		return { kind: 'reject', reject: rejected };
	}

	const blockIndex = findDeepestBlockAtLine(parsed, line);
	const block = blockIndex >= 0 ? parsed.blocks[blockIndex] : undefined;

	if (!block) {
		// 正文区域、但不在任何块内：仍然要产生大纲块。
		return { kind: 'insert-block', insertText: '\n- ' };
	}

	const blockFirstLine = parsed.lines[block.startLine] ?? '';
	const blockLine = parseSourceBlockLine(blockFirstLine);
	if (!blockLine) {
		/*
		 * 页首隐式块（没有 `- ` 前缀，例如顶格 `# 标题`）。
		 *
		 * 它不是标准大纲块，但用户的要求是「正文区域任何回车都要产生块」，
		 * 所以这里不退让：直接插一个顶格项目符号，把光标后的内容变成真正的块。
		 */
		return { kind: 'insert-block', insertText: '\n- ' };
	}

	// 光标落在块首行的 `- ` 标记区域内时，插入 `\n- ` 会把项目符号拆成两半。
	if (line === block.startLine && character < markerLengthOf(blockFirstLine)) {
		return { kind: 'reject', reject: 'before-content' };
	}

	return {
		kind: 'insert-block',
		insertText: `\n${blockLine.leadingWhitespace}- `,
	};
}

/**
 * 计算块内换行（Shift+Enter）计划。
 *
 * 与回车的区别：不插入项目符号，只插入换行 + 内容缩进，
 * 于是新行在解析上仍然属于同一个块。
 *
 * 代码围栏内只插入纯换行：代码的缩进应该由用户自己控制，
 * 自动加缩进会破坏缩进敏感的语言（如 Python）。
 */
export function buildSoftBreakPlan(
	parsed: ParsedFile,
	line: number,
	character: number,
	options: BlockEnterOptions = {},
): SoftBreakResult {
	/*
	 * 软换行有自己的前置检查，不能复用回车的：
	 * 代码围栏内回车要被拒绝（交给编辑器新增代码行），
	 * 但 Shift+Enter 在围栏里正应该插入一个纯换行。
	 */
	if (options.hasSelection) {
		return { kind: 'reject', reject: 'has-selection' };
	}
	if (parsed.lines[line] === undefined) {
		return { kind: 'reject', reject: 'no-line' };
	}

	const tabSize = options.tabSize ?? 4;
	if (isLineInFrontmatter(parsed.lines, line)) {
		return { kind: 'reject', reject: 'frontmatter' };
	}
	if (isLineInFenceContext(parsed.lines, line, tabSize)) {
		// 代码围栏及其边界行：保留当前行缩进，绝不插项目符号、也不加块缩进。
		return buildFenceNewlinePlan(parsed, line, tabSize);
	}
	if (TABLE_LINE_PATTERN.test(parsed.lines[line] ?? '')) {
		return { kind: 'reject', reject: 'in-table' };
	}
	if (isPagePropertyLine(parsed, line)) {
		return { kind: 'reject', reject: 'page-property' };
	}

	const blockIndex = findDeepestBlockAtLine(parsed, line);
	const block = blockIndex >= 0 ? parsed.blocks[blockIndex] : undefined;
	if (!block) {
		// 块外：退化成普通换行，不额外加缩进。
		return { kind: 'soft-break', insertText: '\n' };
	}

	const blockFirstLine = parsed.lines[block.startLine] ?? '';
	const blockLine = parseSourceBlockLine(blockFirstLine);
	if (!blockLine) {
		// 隐式块没有项目符号，也就没有可对齐的内容缩进。
		return { kind: 'soft-break', insertText: '\n' };
	}
	if (line === block.startLine && character < markerLengthOf(blockFirstLine)) {
		return { kind: 'reject', reject: 'before-content' };
	}

	return {
		kind: 'soft-break',
		insertText: `\n${blockLine.leadingWhitespace}${CONTENT_INDENT}`,
	};
}
