/**
 * 「展开全文」的结构化数据。
 *
 * 为什么要结构化而不是直接拼文本：
 * 展开全文现在要在网页里显示，并且**每个块都要标出它来自哪篇笔记**，
 * 点击标题能跳到那篇笔记的对应行。这要求来源是「路径 + 行号」这样的数据，
 * 而不能只是文本里的 `来源：pages/xxx.md 第 12 行` 这一行字。
 *
 * 与 `expandNote.ts` 的分工：
 * - `expandNote.ts` 产出的是给 **AI 读**的纯文本（要显式标记、要预算控制）；
 * - 本文件产出的是给 **人看**的结构化视图（要可点击来源、要保留缩进）。
 *
 * 这一层不依赖 `vscode`，可在 Node 里直接单测。
 */

import type { BlockLookupResult, GraphIndex } from './graphIndex';
import { getBlockTitle, measureSubtree, renderBlockTree, stripHeadingMarks } from './render';
import type { RenderOptions } from './render';

/** 一个可跳转的位置。 */
export interface ExpandLocation {
	/** 文件绝对路径。 */
	path: string;
	/** 0-based 行号。 */
	line: number;
	/** 显示用的路径（相对图谱根，如 `pages/权力的游戏.md`）。 */
	displayPath: string;
}

/** 一个被展开的块。 */
export interface ExpandBlock {
	/** 块 UUID。 */
	uuid: string;
	/** 块首行正文（作为标题）。 */
	title: string;
	/** 来源位置；块不存在时为 undefined。 */
	source?: ExpandLocation;
	/** 行范围显示，例如 `第 12–17 行`。 */
	lineRange?: string;
	/** 规模说明，例如 `6 行 / 88 字符`。 */
	size?: string;
	/** 内容行（已渲染、保留缩进）。 */
	lines: string[];
	/** 警告（块不存在 / 重复定义 / 循环引用 / 被截断）。 */
	warnings: string[];
	/** 嵌套层级，0 表示直接引用的块。 */
	depth: number;
}

/** 内容流里的一项。 */
export type ExpandFlowItem =
	/** 原文行。 */
	| {
			type: 'source';
			/** 0-based 行号。 */
			line: number;
			/** 原文内容。 */
			text: string;
			/** 这一行是否触发了展开（用于高亮）。 */
			hasExpansion: boolean;
	  }
	/** 就地展开的块。 */
	| { type: 'block'; block: ExpandBlock };

/** 完整的展开视图。 */
export interface ExpandView {
	/** 顶部主标题。 */
	title: string;
	/** 副标题（整篇展开时是文件名）。 */
	subtitle?: string;
	/** 统计说明（引用数等）。 */
	summary?: string;
	/** 内容流。 */
	flow: ExpandFlowItem[];
}

/** 生成视图时的选项。 */
export interface ExpandViewOptions {
	/** 图谱根目录，用于把绝对路径压成显示路径。 */
	graphRoot?: string;
	/** 嵌套引用展开深度，0 表示不展开。默认 3。 */
	maxDepth?: number;
	/** 渲染时隐藏的属性名。 */
	hideProperties?: string[];
	/** 是否去掉标题里的 `#` 标记，默认 true（给人看的场景）。 */
	stripHeading?: boolean;
	/** 内容行数上限，0 表示不限。 */
	maxLines?: number;
}

/** 把绝对路径转成相对图谱根的显示路径。 */
function toDisplayPath(filePath: string, graphRoot?: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	if (!graphRoot) {
		return normalized;
	}
	const root = graphRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	return normalized.toLowerCase().startsWith(root.toLowerCase() + '/')
		? normalized.slice(root.length + 1)
		: normalized;
}

/** 把渲染文本切成行，并去掉尾部空行。 */
function toLines(text: string): string[] {
	const lines = text.split('\n');
	while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
		lines.pop();
	}
	return lines;
}

/** 收集块范围内的引用（同一行同一 UUID 只算一次）。 */
function collectNestedRefs(
	result: BlockLookupResult,
): Array<{ uuid: string }> {
	const block = result.parsed.blocks[result.blockIndex];
	if (!block) {
		return [];
	}
	const seen = new Set<string>();
	const collected: Array<{ uuid: string }> = [];
	for (const hit of result.parsed.references) {
		if (hit.line < block.startLine || hit.line > block.endLine) {
			continue;
		}
		if (seen.has(hit.uuid)) {
			continue;
		}
		seen.add(hit.uuid);
		collected.push({ uuid: hit.uuid });
	}
	return collected;
}

/**
 * 递归收集一个 UUID 对应的展开块。
 *
 * 与 `resolve.ts` 的递归不同：那里拼的是文本，这里拼的是结构化数据，
 * 目的是让每个块都能独立带一个「来源」链接。
 */
function collectBlocks(
	index: GraphIndex,
	uuid: string,
	depth: number,
	options: ExpandViewOptions,
	visited: Set<string>,
	out: ExpandBlock[],
): void {
	const normalized = uuid.toLowerCase();
	const maxDepth = options.maxDepth ?? 3;
	const stripHeading = options.stripHeading !== false;

	const renderOptions: RenderOptions = {
		stripHeadingMarks: stripHeading,
		hideProperties: options.hideProperties,
	};

	if (visited.has(normalized)) {
		out.push({
			uuid: normalized,
			title: '（循环引用，已跳过）',
			lines: [],
			warnings: ['该块已在当前展开路径中'],
			depth,
		});
		return;
	}

	const candidates = index.lookupBlocks(normalized);

	if (candidates.length === 0) {
		out.push({
			uuid: normalized,
			title: '未找到该块',
			lines: [],
			warnings: ['块可能已被删除、引用来自其他图谱，或块从未保存过 ID'],
			depth,
		});
		return;
	}

	const nextVisited = new Set(visited);
	nextVisited.add(normalized);

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		if (!candidate) {
			continue;
		}

		const blockNode = candidate.parsed.blocks[candidate.blockIndex];
		const rawTitle = blockNode ? getBlockTitle(blockNode.ownLines[0] ?? '') : '';
		const title = stripHeading ? stripHeadingMarks(rawTitle) : rawTitle;

		const size = measureSubtree(candidate.parsed, candidate.blockIndex);
		const lineRange = blockNode
			? `第 ${blockNode.startLine + 1}–${blockNode.endLine + 1} 行`
			: undefined;

		const warnings: string[] = [];
		if (candidates.length > 1) {
			warnings.push(
				`该 UUID 在 ${candidates.length} 处重复定义，这是第 ${candidateIndex + 1} 处候选`,
			);
		}

		let rendered = toLines(
			renderBlockTree(candidate.parsed, candidate.blockIndex, renderOptions),
		);

		/*
		 * 去掉首行：它是块自身标题，网页里已单独显示为标题，留着会重复一遍。
		 * 只保留「块里面有什么」——子块与续行。
		 */
		rendered = rendered.slice(1);

		if (options.maxLines !== undefined && options.maxLines > 0 && rendered.length > options.maxLines) {
			const omitted = rendered.length - options.maxLines;
			rendered = rendered.slice(0, options.maxLines);
			warnings.push(`内容过长，已省略 ${omitted} 行`);
		}

		out.push({
			uuid: normalized,
			title: title.length > 0 ? title : '（空块）',
			source: {
				path: candidate.location.path,
				line: blockNode?.startLine ?? 0,
				displayPath: toDisplayPath(candidate.location.path, options.graphRoot),
			},
			lineRange,
			size: `${size.lines} 行 / ${size.chars} 字符`,
			lines: rendered,
			warnings,
			depth,
		});

		if (depth >= maxDepth) {
			continue;
		}

		for (const nested of collectNestedRefs(candidate)) {
			collectBlocks(index, nested.uuid, depth + 1, options, nextVisited, out);
		}
	}
}

/**
 * 构建「按 UUID 展开单个块」的视图。
 *
 * 与原文本版的关键差异：顶部给出块标题，紧跟一行**可点击的来源**，
 * 点击直接打开那篇笔记并跳到块的首行。
 */
export function buildBlockExpandView(
	index: GraphIndex,
	uuid: string,
	options: ExpandViewOptions = {},
): ExpandView {
	const blocks: ExpandBlock[] = [];
	collectBlocks(index, uuid, 0, options, new Set(), blocks);

	const flow: ExpandFlowItem[] = blocks.map((block) => ({ type: 'block', block }));

	const first = blocks[0];
	const subtitle = first?.source
		? `${first.source.displayPath}${first.lineRange ? ` · ${first.lineRange}` : ''}`
		: undefined;

	return {
		title: `块 ${uuid.toLowerCase()}`,
		subtitle,
		summary: first?.size,
		flow,
	};
}

/** 一整篇笔记的展开输入。 */
export interface NoteExpandInput {
	/** 文件绝对路径。 */
	path: string;
	/** 原文行。 */
	lines: readonly string[];
	/** 引用命中（行程内）。 */
	references: ReadonlyArray<{ uuid: string; line: number }>;
}

/**
 * 构建「展开整篇笔记」的视图。
 *
 * 结构是**交错**的：原文行原样保留，遇到引用的行之后插入展开块。
 * 这样人和 AI 都能看出「哪一句引用了哪个块」。
 */
export function buildNoteExpandView(
	index: GraphIndex,
	input: NoteExpandInput,
	options: ExpandViewOptions = {},
): ExpandView {
	// 按行号归并引用，同一行同一 UUID 只展开一次。
	const hitsByLine = new Map<number, string[]>();
	for (const hit of input.references) {
		const list = hitsByLine.get(hit.line) ?? [];
		if (!list.includes(hit.uuid)) {
			list.push(hit.uuid);
		}
		hitsByLine.set(hit.line, list);
	}

	const flow: ExpandFlowItem[] = [];

	for (let line = 0; line < input.lines.length; line++) {
		const text = input.lines[line] ?? '';
		const hits = hitsByLine.get(line) ?? [];

		flow.push({ type: 'source', line, text, hasExpansion: hits.length > 0 });

		for (const uuid of hits) {
			const blocks: ExpandBlock[] = [];
			collectBlocks(index, uuid, 0, options, new Set(), blocks);
			for (const block of blocks) {
				flow.push({ type: 'block', block });
			}
		}
	}

	return {
		title: '笔记展开',
		subtitle: toDisplayPath(input.path, options.graphRoot),
		summary: `共 ${input.references.length} 处块引用`,
		flow,
	};
}
