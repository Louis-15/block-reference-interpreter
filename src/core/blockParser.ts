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
 *
 * 键名大小写不敏感：Tine 写入时用小写 `id::`，但手写/导入的数据里
 * 会出现 `ID::`、`Id::`。若不识别，这些块会被当成「没有 ID」，
 * 生成功能就会重复插入第二行 `id::`。
 */
const BLOCK_ID_REGEX =
	/^\s*id::\s*([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\s*$/i;

/**
 * 页面属性行（文件开头、非列表、形如 `key:: value`）。
 *
 * `[^-\s]` 排除了列表行与水平线，避免把 `- xxx` 误判成属性。
 */
const PAGE_PROPERTY_REGEX = /^\s*[^-\s].*?::\s*.*$/;

/**
 * 块属性行（`collapsed::`、`tine.author::` 等）。
 *
 * 键名允许除空白和半角冒号之外的任意字符：
 * - Tine 会写 `tine.author::`，点号必须支持；
 * - Logseq 的属性键还可能包含 `/`、`-`、`_`；
 * - 只认半角 `::`，正文里的中文全角 `：` 不会被误判。
 *
 * 早先限定为 `[A-Za-z0-9_-]+`，会把 `tine.author::` 排除在属性组之外，
 * 导致生成 `id::` 时插到它前面，属性组顺序被打乱。
 */
const BLOCK_PROPERTY_REGEX = /^\s*[^\s:]+::(?:\s|$)/;

/**
 * 判断一行是否为块属性行（`key:: value` 形态）。
 *
 * 生成块 ID 时，插入点要落在「块首行之后的连续属性组」末尾。
 * 两边必须用同一套判定，否则解析器认为的属性组和插入计划认为的属性组
 * 会不一致，导致 `id::` 插到正文之后。
 */
export function isBlockPropertyLine(line: string): boolean {
	return BLOCK_PROPERTY_REGEX.test(line);
}

export interface ParseOptions {
	/** 制表位宽度，默认 4。必须与编辑器/Tine 设置一致，否则层级会错。 */
	tabSize?: number;
}

/** 按 LF 切分并剥离每行尾部 CR（兼容 CRLF 文件）。 */
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
			/**
			 * 文件开头、尚未打开任何块时的非列表行。
			 *
			 * 支持「无 `- ` 前缀的隐式块」：真实库里有文件把块首行写成顶格标题：
			 *
			 * ```
			 * # 1 大义、天理
			 * collapsed:: true
			 * id:: 66b1f836-...
			 * ```
			 *
			 * 这类块没有任何列表标记，若直接跳过，它的 `id::` 会丢失，
			 * 所有引用它的地方都变成悬空引用（该 UUID 在真实库中被引用 13 次）。
			 *
			 * 只在「栈为空」时创建，所以影响范围仅限文件开头，
			 * 不会把正文中间的段落误判成块。
			 */
			if (isBlankLine(line)) {
				continue;
			}

			const implicitIndent = lineIndentColumns(line, tabSize);
			const implicitIndex = blocks.length;
			blocks.push({
				startLine: lineNumber,
				endLine: lineNumber,
				indent: implicitIndent,
				ownLines: [line],
				parent: -1,
				children: [],
			});
			ownEndLines.push(lineNumber);
			stack.push(implicitIndex);
			blockAtStartLine.set(lineNumber, implicitIndex);
			pendingBlanks = [];
			continue;
		}

		if (isBlankLine(line)) {
			pendingBlanks.push(line);
			continue;
		}

		const indent = lineIndentColumns(line, tabSize);

		/**
		 * 块 ID 归属。
		 *
		 * **缩进可以等于块首行的缩进**，不能要求严格大于。
		 * 实测笔记库里有 12 个文件写成：
		 *
		 * ```
		 * - # 1 文字、字母、数字
		 * id:: 67921802-cf13-4d90-91aa-6c536b6c10e8
		 * ```
		 *
		 * `id::` 完全顶格。按「必须更深」处理会把这些 ID 全部丢掉，
		 * 于是所有引用它们的块都变成「悬空引用」——这是最容易误判成
		 * 「块已被删除」的一类假故障，必须支持。
		 *
		 * 判定提前到「缩进不够就跳过」之前，否则等于号情况永远走不到这里。
		 */
		const idMatch = line.match(BLOCK_ID_REGEX);
		if (idMatch && idMatch[1] && indent >= top.indent) {
			// 同一块出现多个 id:: 时保留第一个，后面的忽略。
			if (!top.id) {
				top.id = idMatch[1].toLowerCase();
			}
			appendToCurrent(topIndex, line, lineNumber);
			continue;
		}

		// 缩进不够：不属于当前块，也不属于任何祖先（否则它们也早该缩进更深）。
		// 这里仍用严格小于判定：缩进等于块首行的普通正文不应并入块内容。
		if (indent <= top.indent) {
			/**
			 * 例外：属性行允许与块首行同缩进。
			 *
			 * 真实库中存在这种写法（块首行顶格、属性也顶格）：
			 * ```
			 * # 1 大义、天理
			 * collapsed:: true
			 * id:: 66b1f836-...
			 * ```
			 * 若不放宽，`collapsed::` 被丢弃（影响小），
			 * 但同一模式下的其他属性也会一起丢，容易演变成难查的数据缺失。
			 * 只对「字母数字 + `::`」形态放宽，正文不会被误并。
			 */
			if (indent === top.indent && BLOCK_PROPERTY_REGEX.test(line)) {
				appendToCurrent(topIndex, line, lineNumber);
				continue;
			}
			pendingBlanks = [];
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
