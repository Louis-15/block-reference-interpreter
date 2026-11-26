/**
 * 按标题/内容搜索块。
 *
 * 用途：AI 想引用一个「已经存在但没有 ID」的块时，先用这个函数找到候选，
 * 再调用 `#blockMakeRef` 补 ID。搜索必须返回足够定位的信息：
 * 文件、行号、面包屑、块标题、UUID 或「需要补 ID」。
 *
 * 这一层不依赖 vscode；调用方可以传入 `overrides`，用编辑器里的实时文本
 * 覆盖索引中的旧版本（AI 刚写的内容往往还没保存）。
 */

import { buildBlockPath } from './blockPath';
import type { GraphIndex } from './graphIndex';
import { parseIdPropertyLine, toCanonicalUuid } from './blockIdentity';
import { locateOwnLines } from './idInsertionLocate';
import { getBlockTitle } from './render';
import type { BlockNode, ParsedFile } from './types';

/** 搜索选项。 */
export interface BlockSearchOptions {
	/** 查询词；空格分隔多个词，全部命中才算匹配。 */
	query: string;
	/** 只搜索指定文件；不传则全库。 */
	filePath?: string;
	/** 最多返回条数，默认 10，最大 30。 */
	limit?: number;
	/** 是否匹配块自身全部内容（`ownLines`），默认只匹配块首行。 */
	includeContent?: boolean;
	/** 面包屑最多保留几级祖先，默认 3。 */
	pathDepth?: number;
	/** 用实时解析结果覆盖索引中的同名文件（通常是当前打开的文档）。 */
	overrides?: Map<string, ParsedFile>;
}

/** 一条搜索候选。 */
export interface BlockSearchCandidate {
	/** 文件路径。 */
	path: string;
	/** 块在文件 blocks 数组中的下标。 */
	blockIndex: number;
	/** 块首行行号（0-based）。 */
	startLine: number;
	/** 块首行正文（去掉 `- ` 与标题标记）。 */
	title: string;
	/** 规范 UUID；块没有 ID 时为 undefined。 */
	uuid?: string;
	/** 有 `id::` 但不是规范 UUID 时的原值。 */
	invalidId?: string;
	/** 块完全没有 `id::`。 */
	needsId: boolean;
	/** 祖先路径（面包屑），不含自身。 */
	pathText: string;
	/** 子块总数（递归）。 */
	subtreeSize: number;
	/** 命中位置：标题或内容。 */
	matchedIn: 'title' | 'content';
	/** 内容命中时的真实行号（0-based）。 */
	contentLine?: number;
	/** 相关度评分，仅用于排序。 */
	score: number;
}

/** 把查询词切成小写词条；空查询返回空数组。 */
function splitTerms(query: string): string[] {
	return query
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0);
}

/** 递归统计子块数量。 */
function countSubtree(parsed: ParsedFile, blockIndex: number): number {
	let count = 0;
	const stack = [...(parsed.blocks[blockIndex]?.children ?? [])];
	while (stack.length > 0) {
		const index = stack.pop();
		if (index === undefined) {
			continue;
		}
		count++;
		stack.push(...(parsed.blocks[index]?.children ?? []));
	}
	return count;
}

/**
 * 取块内任意一个 `id::` 值（宽松扫描）。
 *
 * 不能只看 `BlockNode.id`：它只接受规范 UUID，非标准历史 ID 会被漏掉，
 * 搜索工具就会把「已有 ID」误报成「需要补 ID」。
 */
function findAnyId(block: BlockNode): string | undefined {
	for (let index = 1; index < block.ownLines.length; index++) {
		const parsed = parseIdPropertyLine(block.ownLines[index] ?? '');
		if (parsed && parsed.value.length > 0) {
			return parsed.value;
		}
	}
	return undefined;
}

/** 评分：完全相等 > 前缀 > 包含；内容命中分值更低。 */
function scoreCandidate(titleLower: string, allInTitle: boolean, allInContent: boolean, terms: string[]): number {
	const joined = terms.join(' ');
	if (allInTitle) {
		if (titleLower.trim() === joined) {
			return 100;
		}
		if (titleLower.trim().startsWith(joined)) {
			return 80;
		}
		return 60;
	}
	if (allInContent) {
		return 30;
	}
	return 0;
}

/**
 * 搜索块。
 *
 * 匹配规则：
 * - 所有查询词都出现在标题里，或都出现在块自身内容里；
 * - 标题命中优先于内容命中；
 * - 结果按评分、路径、行号稳定排序。
 */
export function searchBlocks(index: GraphIndex, options: BlockSearchOptions): BlockSearchCandidate[] {
	const terms = splitTerms(options.query);
	if (terms.length === 0) {
		return [];
	}

	const limit = Math.max(1, Math.min(options.limit ?? 10, 30));
	const paths = options.filePath
		? [options.filePath]
		: [...new Set([...index.listFiles(), ...(options.overrides?.keys() ?? [])])];

	const candidates: BlockSearchCandidate[] = [];

	for (const path of paths) {
		const parsed = options.overrides?.get(path) ?? index.getParsedFile(path);
		if (!parsed) {
			continue;
		}

		for (let blockIndex = 0; blockIndex < parsed.blocks.length; blockIndex++) {
			const block = parsed.blocks[blockIndex];
			if (!block) {
				continue;
			}

			const title = getBlockTitle(block.ownLines[0] ?? '');
			const titleLower = title.toLowerCase();
			const allInTitle = terms.every((term) => titleLower.includes(term));

			const contentText = options.includeContent ? block.ownLines.join('\n').toLowerCase() : '';
			const allInContent =
				options.includeContent === true && terms.every((term) => contentText.includes(term));

			if (!allInTitle && !allInContent) {
				continue;
			}

			let contentLine: number | undefined;
			let matchedIn: 'title' | 'content' = 'title';
			if (!allInTitle) {
				matchedIn = 'content';
				const located = locateOwnLines(parsed, block);
				contentLine = located.find(
					(entry, index2) =>
						index2 > 0 && terms.every((term) => entry.text.toLowerCase().includes(term)),
				)?.line;
			}

			const anyId = findAnyId(block);
			const uuid = block.id;
			const invalidId = anyId && !uuid ? anyId : undefined;

			candidates.push({
				path,
				blockIndex,
				startLine: block.startLine,
				title,
				uuid,
				invalidId,
				needsId: anyId === undefined,
				pathText: buildBlockPath(parsed, blockIndex, {
					maxDepth: options.pathDepth ?? 3,
				}),
				subtreeSize: countSubtree(parsed, blockIndex),
				matchedIn,
				contentLine,
				score: scoreCandidate(titleLower, allInTitle, allInContent, terms),
			});
		}
	}

	candidates.sort(
		(a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine,
	);
	return candidates.slice(0, limit);
}

/** 把候选的 UUID 统一成规范形态；用于工具层快速判断。 */
export function candidateUuid(candidate: BlockSearchCandidate): string | undefined {
	return candidate.uuid ? toCanonicalUuid(candidate.uuid) ?? candidate.uuid : undefined;
}
