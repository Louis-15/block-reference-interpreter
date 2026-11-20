/**
 * 大纲式 Markdown（Tine / Logseq）解析器。
 *
 * 把一个 `.md` 文件解析成「块扁平数组 + 父子下标」的结构，并抽出块 ID 与块引用。
 *
 * 设计要点：
 * - 块树用「下标 + parent/children」表达，而不是对象互引，避免循环引用、
 *   也方便将来做增量缓存与序列化。
 * - 所有行号都是 0-based 原始文件行号，这样悬停定位、报错定位都能直接换算。
 * - 解析器只读，绝不修改原始文本。
 */

import {
	isBlankLine,
	lineIndentColumns,
	measureIndentColumns,
	parseSourceBlockLine,
} from './blockLine';
import { getOpeningFenceState, isClosingFence, type MarkdownFenceState } from './fence';
import { scanReferences } from './refScanner';
import type { BlockNode, ParsedFile } from './types';

/**
 * 块 ID 属性行。
 *
 * 与 Obsidian 插件实现保持一致：只接受标准 36 位 UUID 形态。
 * 这里要求 UUID 出现在 `id::` 之后，且整行除属性外没有别的内容。
 */
const BLOCK_ID_REGEX =
	/^\s*id::\s*([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\s*$/;

/**
 * 页面属性行（文件开头、非列表、形如 `key:: value`）。
 *
 * `[^-\s]` 排除了列表行与水平线，避免把 `- xxx` 误判成属性。
 */
const PAGE_PROPERTY_REGEX = /^\s*[^-\s].*?::\s*.*$/;

export interface ParseOptions {
	/** 制表位宽度，默认 4。必须与编辑器/Tine 设置一致，否则层级会错。 */
	tabSize?: number;
}

/** 按 LF 切分并剥离每行尾部 CR（兼容 CRLF 文件）。 */
export function splitLines(content: string): string[] {
	return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * 解析一个 Markdown 文件。
 *
 * @param path 文件标识（调用方决定用绝对路径还是相对路径）
 * @param content 文件全文
 */
export function parseMarkdown(path: string, content: string, options: ParseOptions = {}): ParsedFile {
	const tabSize = options.tabSize ?? 4;
	const lines = splitLines(content);

	const blocks: BlockNode[] = [];
	/** 当前打开的块的祖先链（下标栈），栈顶即"当前块"。 */
	const stack: number[] = [];
	const blockAtStartLine = new Map<number, number>();
	/** 每个块自身内容的最后一行（不含子块），收尾时用于算 endLine。 */
	const ownEndLines: number[] = [];
	const pageProperties: string[] = [];

	let lineNumber = 0;

	// ---------- 第一阶段：跳过 frontmatter ----------
	if (lines.length > 0 && (lines[0] ?? '').trim() === '---') {
		lineNumber = 1;
		while (lineNumber < lines.length) {
			const trimmed = (lines[lineNumber] ?? '').trim();
			lineNumber++;
			if (trimmed === '---' || trimmed === '...') {
				break;
			}
		}
	}

	// ---------- 第二阶段：跳过文件开头的页面属性 ----------
	// 这些行属于「页面」而不是某个块，收集起来供来源展示使用。
	while (lineNumber < lines.length) {
		const line = lines[lineNumber] ?? '';
		if (isBlankLine(line)) {
			lineNumber++;
			continue;
		}
		if (PAGE_PROPERTY_REGEX.test(line)) {
			pageProperties.push(line);
			lineNumber++;
			continue;
		}
		break;
	}

	// ---------- 第三阶段：逐行构建块树 ----------
	let fence: MarkdownFenceState | null = null;
	/**
	 * 暂存的空行。
	 *
	 * 空行是否属于某个块，取决于「它后面还有没有属于该块的内容」。
	 * 直接丢弃会让块内段落之间的空行消失，直接追加又会让块尾部拖一堆空行，
	 * 所以延迟到下一次真正追加内容时再决定。
	 */
	let pendingBlanks: string[] = [];

	const appendToCurrent = (blockIndex: number, line: string, atLine: number): void => {
		const block = blocks[blockIndex];
		if (!block) {
			return;
		}
		if (pendingBlanks.length > 0) {
			block.ownLines.push(...pendingBlanks);
			pendingBlanks = [];
		}
		block.ownLines.push(line);
		ownEndLines[blockIndex] = atLine;
	};

	for (; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber] ?? '';
		const topIndex = stack.length > 0 ? stack[stack.length - 1] : -1;
		const top = topIndex >= 0 ? blocks[topIndex] : undefined;

		// 围栏内部：整行归当前块，不做任何语法判定。
		if (fence) {
			if (top) {
				appendToCurrent(topIndex, line, lineNumber);
			}
			if (isClosingFence(line, fence, tabSize)) {
				fence = null;
			}
			continue;
		}

		// 列表行：开启新块。
		const blockLine = parseSourceBlockLine(line);
		if (blockLine) {
			const indent = measureIndentColumns(blockLine.leadingWhitespace, tabSize);

			// 弹栈到第一个缩进严格小于当前行的块，它就是父块。
			while (stack.length > 0) {
				const stackTop = blocks[stack[stack.length - 1] as number];
				if (!stackTop || stackTop.indent < indent) {
					break;
				}
				stack.pop();
			}

			const parent = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
			const index = blocks.length;
			blocks.push({
				startLine: lineNumber,
				endLine: lineNumber,
				indent,
				ownLines: [line],
				parent,
				children: [],
			});
			ownEndLines.push(lineNumber);

			if (parent >= 0) {
				blocks[parent]?.children.push(index);
			}
			stack.push(index);
			blockAtStartLine.set(lineNumber, index);

			// 新块开启了围栏，则进入围栏状态。
			const openingFence = getOpeningFenceState(line, tabSize);
			if (openingFence) {
				fence = openingFence;
			}

			// 块与块之间的空行不属于任何块。
			pendingBlanks = [];
			continue;
		}

		// 以下都是非列表行。
		if (!top || topIndex < 0) {
			// 第一个块出现之前的内容（frontmatter/page properties 之外）直接忽略。
			continue;
		}

		if (isBlankLine(line)) {
			pendingBlanks.push(line);
			continue;
		}

		const indent = lineIndentColumns(line, tabSize);

		// 缩进不够：不属于当前块，也不属于任何祖先（否则它们也早该缩进更深）。
		if (indent <= top.indent) {
			pendingBlanks = [];
			continue;
		}

		// 块 ID：只有缩进严格大于块首行时才归属该块，避免把子块的 id 抢过来。
		const idMatch = line.match(BLOCK_ID_REGEX);
		if (idMatch && idMatch[1]) {
			// 同一块出现多个 id:: 时保留第一个，后面的忽略（实测库中无此情况）。
			if (!top.id) {
				top.id = idMatch[1].toLowerCase();
			}
			appendToCurrent(topIndex, line, lineNumber);
			const openingFence = getOpeningFenceState(line, tabSize);
			if (openingFence) {
				fence = openingFence;
			}
			continue;
		}

		// 普通续行 / 属性行（collapsed:: 等）。
		appendToCurrent(topIndex, line, lineNumber);

		const openingFence = getOpeningFenceState(line, tabSize);
		if (openingFence) {
			fence = openingFence;
		}
	}

	// ---------- 第四阶段：收尾 ----------
	// endLine 必须覆盖所有子块：逆序遍历，因为子块下标一定大于父块下标。
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		if (!block) {
			continue;
		}
		let end = ownEndLines[index] ?? block.startLine;
		for (const childIndex of block.children) {
			const child = blocks[childIndex];
			if (child && child.endLine > end) {
				end = child.endLine;
			}
		}
		block.endLine = end;
	}

	// 构建 UUID → 块 索引（数组承载重复 ID）。
	const blocksById = new Map<string, number[]>();
	for (let index = 0; index < blocks.length; index++) {
		const id = blocks[index]?.id;
		if (!id) {
			continue;
		}
		const existing = blocksById.get(id);
		if (existing) {
			existing.push(index);
		} else {
			blocksById.set(id, [index]);
		}
	}

	return {
		path,
		lines,
		blocks,
		blockAtStartLine,
		blocksById,
		references: scanReferences(lines, tabSize),
		pageProperties,
	};
}

/**
 * 找出包含指定行号的「最深」块。
 *
 * 用于悬停预览与光标定位：一个行号可能落在多个块范围内（祖先链），
 * 取最深的那一个才符合用户直觉。
 */
export function findDeepestBlockAtLine(parsed: ParsedFile, lineNumber: number): number {
	let best = -1;
	for (let index = 0; index < parsed.blocks.length; index++) {
		const block = parsed.blocks[index];
		if (!block) {
			continue;
		}
		if (lineNumber >= block.startLine && lineNumber <= block.endLine) {
			if (best === -1 || (parsed.blocks[best]?.indent ?? -1) <= block.indent) {
				best = index;
			}
		}
	}
	return best;
}
