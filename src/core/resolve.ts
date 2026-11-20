/**
 * 块引用解析编排：UUID → 可直接喂给 AI 的文本。
 *
 * 与 render.ts 的分工：
 * - render.ts 只负责「一个块子树怎么排版」；
 * - 本文件负责「这个块是谁、在哪、有没有歧义、里面的引用要不要继续展开」。
 *
 * 关于嵌套引用为什么采用「末尾追加」而不是「就地替换」：
 * 1. 就地替换需要精确映射渲染后文本与原始行号，而渲染过程会隐藏属性行、去掉列表标记，
 *    映射一旦错位就会把内容插到错误位置；
 * 2. 代码块里的 `((uuid))` 本来就不该展开，就地替换很容易在代码里误伤；
 * 3. 末尾追加能保留原文里的 UUID，AI 可以据此建立「哪句对应哪个展开块」的对应关系。
 */

import { renderBlockTree, measureSubtree, type RenderOptions } from './render';
import type { GraphIndex } from './graphIndex';
import type { BlockLookupResult } from './graphIndex';

/** 解析选项。 */
export interface ResolveOptions extends RenderOptions {
	/** 嵌套引用展开深度，0 表示不展开。 */
	maxDepth?: number;
	/** 输出字符预算。 */
	maxChars?: number;
}

/** 单个 UUID 的解析结果。 */
export interface ResolvedBlock {
	/** 查询用的 UUID（小写）。 */
	uuid: string;
	/** 渲染后的完整文本（含嵌套展开）。 */
	text: string;
	/** 是否因预算被截断。 */
	truncated: boolean;
	/** 目标块是否不存在。 */
	notFound: boolean;
	/** 重复定义数量（0 或 1 表示没有歧义）。 */
	duplicateCount: number;
}

/** 可变的预算计数器，递归过程中共享。 */
interface Budget {
	remaining: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CHARS = 20000;

/** 把绝对路径转成更易读的展示形式（保留最后两级，够定位又不啰嗦）。 */
function shortenPath(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const parts = normalized.split('/');
	if (parts.length <= 2) {
		return normalized;
	}
	return parts.slice(-2).join('/');
}

/** 渲染一个候选块（不含嵌套展开）。 */
function renderCandidate(result: BlockLookupResult, options: ResolveOptions, heading: string): string {
	const block = result.parsed.blocks[result.blockIndex];
	if (!block) {
		return `${heading}\n（块数据缺失）`;
	}

	const size = measureSubtree(result.parsed, result.blockIndex);
	const lines = [
		heading,
		`来源：\`${shortenPath(result.location.path)}\` 第 ${block.startLine + 1}–${block.endLine + 1} 行`,
		`规模：${size.lines} 行 / ${size.chars} 字符`,
		'',
		renderBlockTree(result.parsed, result.blockIndex, options),
	];

	return lines.join('\n');
}

/** 收集块范围内的引用（去重，保持出现顺序）。 */
function collectReferencesWithin(
	index: GraphIndex,
	result: BlockLookupResult,
): Array<{ uuid: string; line: number }> {
	const block = result.parsed.blocks[result.blockIndex];
	if (!block) {
		return [];
	}

	const collected: Array<{ uuid: string; line: number }> = [];
	const seen = new Set<string>();

	for (const hit of result.parsed.references) {
		if (hit.line < block.startLine || hit.line > block.endLine) {
			continue;
		}
		// 同一行内重复引用同一个块时只展开一次，避免输出爆炸。
		const key = `${hit.uuid}@${hit.line}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		collected.push({ uuid: hit.uuid, line: hit.line });
	}

	void index;
	return collected;
}

/**
 * 递归解析单个 UUID。
 *
 * @param visited 当前展开路径上的 UUID 集合，用于循环检测
 */
function resolveInternal(
	index: GraphIndex,
	uuid: string,
	depth: number,
	options: ResolveOptions,
	visited: Set<string>,
	budget: Budget,
): ResolvedBlock {
	const normalized = uuid.toLowerCase();
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

	if (budget.remaining <= 0) {
		return { uuid: normalized, text: '', truncated: true, notFound: false, duplicateCount: 0 };
	}

	if (visited.has(normalized)) {
		return {
			uuid: normalized,
			text: `### 块 \`${normalized}\`\n（循环引用：该块已在当前展开路径中，已跳过）`,
			truncated: false,
			notFound: false,
			duplicateCount: 0,
		};
	}

	const candidates = index.lookupBlocks(normalized);

	if (candidates.length === 0) {
		return {
			uuid: normalized,
			text:
				`### 块 \`${normalized}\`\n` +
				`⚠ 未找到该 UUID 对应的块。可能原因：块已被删除、引用来自其他图谱、或块从未保存过 ID。`,
			truncated: false,
			notFound: true,
			duplicateCount: 0,
		};
	}

	const duplicateCount = candidates.length > 1 ? candidates.length : 0;
	const sections: string[] = [];

	if (duplicateCount > 0) {
		sections.push(
			`### 块 \`${normalized}\`\n` +
				`⚠ 该 UUID 在 ${duplicateCount} 处重复定义，以下是全部候选。` +
				`这通常意味着笔记被复制粘贴过，请以内容判断哪个才是你需要的。`,
		);
	}

	const nextVisited = new Set(visited);
	nextVisited.add(normalized);

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		if (!candidate) {
			continue;
		}

		const heading =
			duplicateCount > 0
				? `#### 候选 ${candidateIndex + 1} / ${candidates.length}`
				: `### 块 \`${normalized}\``;

		const rendered = renderCandidate(candidate, options, heading);
		if (rendered.length > budget.remaining) {
			sections.push(rendered.slice(0, Math.max(budget.remaining, 0)) + '\n（内容过大，已截断）');
			budget.remaining = 0;
			continue;
		}
		budget.remaining -= rendered.length;
		sections.push(rendered);

		// 达到深度上限就不再继续展开。
		if (depth >= maxDepth) {
			continue;
		}

		const nested = collectReferencesWithin(index, candidate);
		if (nested.length === 0) {
			continue;
		}

		const nestedSections: string[] = [];
		for (const reference of nested) {
			if (budget.remaining <= 0) {
				break;
			}
			const child = resolveInternal(index, reference.uuid, depth + 1, options, nextVisited, budget);
			if (!child.text) {
				continue;
			}
			// 用引用发生的位置做小标题，帮助 AI 对应「这句里的引用指向哪」。
			nestedSections.push(
				`##### ↳ 第 ${reference.line + 1} 行引用 \`${reference.uuid}\` 的展开`,
				child.text,
			);
		}

		if (nestedSections.length > 0) {
			sections.push('', '**该块子树内还引用了以下块：**', '', ...nestedSections);
		}
	}

	const text = sections.join('\n\n');
	return {
		uuid: normalized,
		text,
		truncated: budget.remaining <= 0,
		notFound: false,
		duplicateCount,
	};
}

/** 解析一个 UUID，返回可直接展示/喂给 AI 的文本。 */
export function resolveBlock(index: GraphIndex, uuid: string, options: ResolveOptions = {}): ResolvedBlock {
	const budget: Budget = { remaining: options.maxChars ?? DEFAULT_MAX_CHARS };
	return resolveInternal(index, uuid, 0, options, new Set(), budget);
}

/** 批量解析多个 UUID。 */
export function resolveBlocks(index: GraphIndex, uuids: readonly string[], options: ResolveOptions = {}): ResolvedBlock[] {
	const budget: Budget = { remaining: options.maxChars ?? DEFAULT_MAX_CHARS };
	const results: ResolvedBlock[] = [];
	for (const uuid of uuids) {
		if (budget.remaining <= 0) {
			results.push({
				uuid: uuid.toLowerCase(),
				text: '（本次调用的输出预算已用尽，未解析该 UUID）',
				truncated: true,
				notFound: false,
				duplicateCount: 0,
			});
			continue;
		}
		results.push(resolveInternal(index, uuid, 0, options, new Set(), budget));
	}
	return results;
}
