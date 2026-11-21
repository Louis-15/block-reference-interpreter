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
import { t } from './i18n';
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
		return `${heading}\n${t('(block data missing)')}`;
	}

	const size = measureSubtree(result.parsed, result.blockIndex);
	const lines = [
		heading,
		t('Source: `{0}` lines {1}–{2}', shortenPath(result.location.path), block.startLine + 1, block.endLine + 1),
		t('Size: {0} lines / {1} characters', size.lines, size.chars),
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
			text: t(
				'### Block `{0}`\n(circular reference: this block is already in the current expansion path, skipped)',
				normalized,
			),
			truncated: false,
			notFound: false,
			duplicateCount: 0,
		};
	}

	const candidates = index.lookupBlocks(normalized);

	if (candidates.length === 0) {
		return {
			uuid: normalized,
			text: t(
				'### Block `{0}`\n⚠ No block found for this UUID. Possible reasons: the block was deleted, the reference comes from another graph, or the block never had a saved ID.',
				normalized,
			),
			truncated: false,
			notFound: true,
			duplicateCount: 0,
		};
	}

	const duplicateCount = candidates.length > 1 ? candidates.length : 0;
	const sections: string[] = [];

	if (duplicateCount > 0) {
		sections.push(
			t(
				'### Block `{0}`\n⚠ This UUID is defined in {1} places; all candidates are listed below. This usually means the note was copied and pasted — use the content to judge which one you need.',
				normalized,
				duplicateCount,
			),
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
				? t('#### Candidate {0} / {1}', candidateIndex + 1, candidates.length)
				: t('### Block `{0}`', normalized);

		const rendered = renderCandidate(candidate, options, heading);
		if (rendered.length > budget.remaining) {
			sections.push(
				rendered.slice(0, Math.max(budget.remaining, 0)) + '\n' + t('(content too large, truncated)'),
			);
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
				t('##### ↳ Expansion of the reference at line {0} `{1}`', reference.line + 1, reference.uuid),
				child.text,
			);
		}

		if (nestedSections.length > 0) {
			sections.push('', t('**The following blocks are also referenced inside this block subtree:**'), '', ...nestedSections);
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
				text: t('(output budget for this call is exhausted; this UUID was not resolved)'),
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
