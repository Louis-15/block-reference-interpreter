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
	isAtxHeadingLine,
	isBlankLine,
	lineIndentColumns,
	measureIndentColumns,
	parseSourceBlockLine,
	splitLines,
} from './blockLine';
import { getOpeningFenceState, isClosingFence, type MarkdownFenceState } from './fence';
import { skipPreamble } from './preamble';
import { scanReferences } from './refScanner';
import type { BlockNode, ParsedFile } from './types';

/**
 * `splitLines` 从这里继续对外导出。
 *
 * 它已经移到 `blockLine.ts`（那里才是「文本 → 行数组」这类行级操作的家），
 * 但调用方与测试一直从 `blockParser` 导入，保持这条路径可用。
 */
export { splitLines } from './blockLine';

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
 * 块属性行（`collapsed::`、`tine.author::` 等）。
 *
 * 键名限定为 ASCII 标识符字符：字母、数字、`-`、`_`、`.`、`/`。
 *
 * 为什么不能放宽到「任意非空白字符」：中文正文里经常出现 `::`
 * （例如「这是正文，id:: 应插在这里」），放宽后整行会被当成属性行，
 * 于是 `id::` 被插到正文之后而不是块首行之后——真实验收时已踩到。
 *
 * 真实笔记库统计（1266 个 ID、6506 个 collapsed）只出现过 8 种键，
 * 全部落在该字符集内：`collapsed` / `id` / `tags` / `numbering` /
 * `title` / `tine/favorites` / `tine.tag-table` / `heading`。
 */
const BLOCK_PROPERTY_REGEX = /^\s*[A-Za-z0-9_./-]+::(?:\s|$)/;

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

	// ---------- 第一阶段：跳过前言区（frontmatter + 页面属性）----------
	// 这些行属于「页面」而不是某个块，收集起来供来源展示与页面名读取使用。
	const { startLine, pageProperties } = skipPreamble(lines);
	let lineNumber = startLine;

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

	/**
	 * 创建一个根级块（没有 `- ` 列表标记的块），并把它设为当前块。
	 *
	 * 两种形态共用这段逻辑，差别只在调用方要不要先清空栈：
	 * - 文件开头尚未进入任何块时的顶格内容（隐式块，保留实际缩进）；
	 * - 任意位置的顶格 `# 标题`（Tine / lsdoc 的 heading 块，缩进恒为 0）。
	 *
	 * 抽成一个函数是为了让「块长什么样」只有一处定义——三处各写一遍时，
	 * 只要有一处漏了 `blockAtStartLine`，悬停与跳转就会在这个块上失效。
	 */
	const pushRootBlock = (line: string, atLine: number, indent: number): void => {
		const index = blocks.length;
		blocks.push({
			startLine: atLine,
			endLine: atLine,
			indent,
			ownLines: [line],
			parent: -1,
			children: [],
		});
		ownEndLines.push(atLine);
		stack.push(index);
		blockAtStartLine.set(atLine, index);
		pendingBlanks = [];
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
			 */
			if (isBlankLine(line)) {
				continue;
			}

			pushRootBlock(line, lineNumber, lineIndentColumns(line, tabSize));
			continue;
		}

		if (isBlankLine(line)) {
			pendingBlanks.push(line);
			continue;
		}

		const indent = lineIndentColumns(line, tabSize);

		/**
		 * 顶格 `# 标题`：Tine / Logseq 把它当作独立块（lsdoc 的 heading），
		 * 和 `- ` 列表块并列，可以挂 `id::`、可以被引用。
		 *
		 * 它结束此前所有还开着的块，成为新的根级块——这正是「缩进更浅就关掉子块」
		 * 的层级语义，只是顶格标题的「更浅」等于零。
		 *
		 * 必须放在 `indent <= top.indent` 判定之前：顶格标题的缩进恒为 0，
		 * 若先走那条分支，它会被当成「缩进不够的杂行」直接丢弃，
		 * 于是后一个标题下的子块会错误地并入前一个标题的子树，
		 * `id::` 也会挂到错误的块上。
		 */
		if (indent === 0 && isAtxHeadingLine(line)) {
			stack.length = 0;
			pushRootBlock(line, lineNumber, 0);
			continue;
		}

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
