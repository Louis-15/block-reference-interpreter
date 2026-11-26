/**
 * 块内容渲染：把块树转成「给 AI / 给人看」的纯文本。
 *
 * 渲染原则：
 * - 根块首行去掉 `- ` 列表标记，作为正文标题；
 * - 子块保留 `- ` 标记，只做相对缩进归一化，让层级一眼可见；
 * - 隐藏 `id::`、`collapsed::` 这类纯元数据/UI 状态，但保留其他属性
 *   （例如 `tine.author::`、`tags::` 可能带语义）；
 * - 制表符一律展开成空格，避免不同工具下显示错位。
 */

import { measureIndentColumns, parseSourceBlockLine } from './blockLine';
import type { ParsedFile } from './types';

/** 渲染选项。 */
export interface RenderOptions {
	/** 是否包含子块，默认 true。 */
	includeChildren?: boolean;
	/** 紧凑模式：只输出每个块的首行正文，默认 false。 */
	compact?: boolean;
	/** 需要隐藏的属性名（小写，不含 `::`）。 */
	hideProperties?: string[];
	/** 制表位宽度，默认 4。 */
	tabSize?: number;
	/** 每一层子块使用的缩进空格数，默认 2。 */
	indentUnit?: number;
	/** 是否去掉标题标记（`#` / `##` …），默认 false。 */
	stripHeadingMarks?: boolean;
}

const DEFAULT_HIDDEN_PROPERTIES = ['id', 'collapsed'];

/**
 * 属性行匹配：`key:: value`。
 *
 * 键名与解析器保持一致（ASCII 标识符字符），否则渲染层会隐藏一行
 * 解析器根本没当成属性的正文。
 */
const PROPERTY_LINE_REGEX = /^\s*([A-Za-z0-9_./-]+)::(?:\s|$)/;

/** 判断一行是否为需要隐藏的属性行。 */
function isHiddenPropertyLine(line: string, hidden: ReadonlySet<string>): boolean {
	const match = line.match(PROPERTY_LINE_REGEX);
	if (!match || !match[1]) {
		return false;
	}
	return hidden.has(match[1].toLowerCase());
}

/**
 * 把续行的前导空白归一化：展开制表符，并去掉属于「块基准缩进」的那部分。
 *
 * 例：块缩进 0，续行 `\t  文本` → `    文本`（4+2 空格）。
 * 例：块缩进 4，续行 `\t\t文本` → `    文本`（8-4=4 空格）。
 */
function normalizeContinuation(line: string, baseIndentColumns: number, tabSize: number): string {
	const match = line.match(/^[ \t]*/);
	const leading = match ? match[0] : '';
	const rest = line.slice(leading.length);
	const columns = measureIndentColumns(leading, tabSize);

	if (columns <= baseIndentColumns) {
		// 缩进不超过块基准：与首行齐平的续写，直接去掉前导空白。
		return rest;
	}

	return ' '.repeat(columns - baseIndentColumns) + rest;
}

/** 取块首行的正文（去掉 `- ` 标记与首尾空白）。 */
export function getBlockTitle(blockLine: string): string {
	const info = parseSourceBlockLine(blockLine);
	if (info) {
		return info.content.trim();
	}
	// 理论上不会走到这里（块首行一定是列表行），保底返回去掉前导空白的原文。
	return blockLine.trim();
}

/**
 * 去掉标题标记（`#` / `##` …）。
 *
 * 为什么需要：Logseq 系笔记常用 `- ## 3.1 小节名` 表示层级，
 * 但在行内渲染、悬停预览、展开文档这些「给人看」的场景里，
 * 连 `##` 一起显示会很吵。渲染成普通文本更清爽。
 *
 * **注意**：只匹配行首 `#` 加空白。`#标签`（Logseq 的 tag 语法）不会被误伤，
 * 因为它没有空格分隔，而 `- # 标题` 才是 heading。
 */
export function stripHeadingMarks(title: string): string {
	return title.replace(/^#{1,6}[ \t]+/, '');
}

interface ResolvedRenderOptions {
	includeChildren: boolean;
	compact: boolean;
	tabSize: number;
	indentUnit: number;
	hidden: ReadonlySet<string>;
	stripHeadingMarks: boolean;
}

/**
 * 递归输出一个块。
 *
 * @param isRoot 根块去掉列表标记（它是标题），子块保留标记（它们是层级内容）
 */
function emitBlock(
	parsed: ParsedFile,
	blockIndex: number,
	depth: number,
	isRoot: boolean,
	options: ResolvedRenderOptions,
	out: string[],
): void {
	const block = parsed.blocks[blockIndex];
	if (!block) {
		return;
	}

	const prefix = ' '.repeat(depth * options.indentUnit);
	const rawTitle = getBlockTitle(block.ownLines[0] ?? '');
	const title = options.stripHeadingMarks ? stripHeadingMarks(rawTitle) : rawTitle;
	// 空块（正文为空）只输出列表标记本身，避免行尾拖一串空格。
	out.push((isRoot ? prefix + title : `${prefix}- ${title}`).trimEnd());

	// 块自身续行：紧凑模式下省略，因为它通常是解释性正文而非结构。
	if (!options.compact) {
		for (let index = 1; index < block.ownLines.length; index++) {
			const line = block.ownLines[index] ?? '';
			if (isHiddenPropertyLine(line, options.hidden)) {
				continue;
			}
			if (line.trim() === '') {
				out.push('');
				continue;
			}
			out.push(prefix + normalizeContinuation(line, block.indent, options.tabSize));
		}
	}

	if (!options.includeChildren) {
		return;
	}

	for (const childIndex of block.children) {
		emitBlock(parsed, childIndex, depth + 1, false, options, out);
	}
}

/**
 * 渲染一个块的完整子树。
 *
 * @returns 多行文本；块不存在时返回空字符串
 */
export function renderBlockTree(parsed: ParsedFile, blockIndex: number, options: RenderOptions = {}): string {
	const hidden = new Set(
		(options.hideProperties ?? DEFAULT_HIDDEN_PROPERTIES).map((name) => name.toLowerCase()),
	);
	const resolved: ResolvedRenderOptions = {
		includeChildren: options.includeChildren ?? true,
		compact: options.compact ?? false,
		tabSize: options.tabSize ?? 4,
		indentUnit: options.indentUnit ?? 2,
		hidden,
		stripHeadingMarks: options.stripHeadingMarks ?? false,
	};

	const out: string[] = [];
	emitBlock(parsed, blockIndex, 0, true, resolved, out);

	// 去掉尾部空行，避免输出末尾拖一串空白。
	while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') {
		out.pop();
	}

	return out.join('\n');
}

/**
 * 计算块的子树规模（行数 / 字符数）。
 *
 * 用于在输出里标注「这次展开有多大」，让 AI 知道拿到的是摘要还是全文。
 */
export function measureSubtree(parsed: ParsedFile, blockIndex: number): { lines: number; chars: number } {
	let lines = 0;
	let chars = 0;

	const walk = (index: number): void => {
		const block = parsed.blocks[index];
		if (!block) {
			return;
		}
		lines += block.ownLines.length;
		for (const line of block.ownLines) {
			chars += line.length;
		}
		for (const childIndex of block.children) {
			walk(childIndex);
		}
	};

	walk(blockIndex);
	return { lines, chars };
}
