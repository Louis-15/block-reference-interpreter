/**
 * 块的祖先路径（面包屑）。
 *
 * 为什么需要：反链面板只显示「pages/傲娇.md 第 12 行 · 行内引用」信息量太低，
 * 用户看不出这条引用出现在笔记的哪个位置。Tine / Logseq 的反链面板都会
 * 显示 `71 举例 › 71.3 毒舌讽刺型` 这样的路径，本模块负责生成同样的东西。
 *
 * 这一层刻意不依赖 `vscode`，可在 Node 里直接单测。
 */

import { getBlockTitle, stripHeadingMarks } from './render';
import { stripReferenceMarks } from './refText';
import type { ParsedFile } from './types';

/** 路径生成选项。 */
export interface BlockPathOptions {
	/** 分隔符，默认 ` › `（与 Tine 一致）。 */
	separator?: string;
	/** 是否把块自身的标题也放进路径末尾，默认 false。 */
	includeSelf?: boolean;
	/** 最多保留几级祖先（从最近的开始留），默认不限制。 */
	maxDepth?: number;
	/** 是否去掉标题里的 `#` 标记，默认 true。 */
	stripHeading?: boolean;
}

/**
 * 取某个块的祖先标题链，从**根到父**排列。
 *
 * 实现要点：
 * - 沿 `BlockNode.parent` 向上走，最后 `unshift` 保证顺序是根在前；
 * - 用 `visited` 防环——理论上块树不会有环，但 `parent` 是指向下标的裸数字，
 *   一旦上游解析出错就可能形成环，这里不能让整个面板卡死；
 * - 空标题（空块）直接跳过，否则路径里会出现 `a ›  › b` 这种空洞；
 * - **纯引用块也跳过**：真实库里存在「整块内容就是一个 ((uuid))」的块，
 *   把它放进面包屑会让用户看到一串 UUID。洗净后为空即视为无标题。
 */
export function buildBlockAncestorTitles(
	parsed: ParsedFile,
	blockIndex: number,
	options: { includeSelf?: boolean; maxDepth?: number; stripHeading?: boolean } = {},
): string[] {
	const stripHeading = options.stripHeading !== false;
	const titles: string[] = [];
	const visited = new Set<number>();

	let current = options.includeSelf ? blockIndex : (parsed.blocks[blockIndex]?.parent ?? -1);

	while (current >= 0 && !visited.has(current)) {
		visited.add(current);
		const block = parsed.blocks[current];
		if (!block) {
			break;
		}

		const raw = getBlockTitle(block.ownLines[0] ?? '');
		// 先剥引用外壳再判断是否为空：纯 `((uuid))` 的块不该进面包屑。
		const withoutRefs = stripReferenceMarks(raw);
		const title = stripHeading ? stripHeadingMarks(withoutRefs) : withoutRefs;
		if (title.length > 0) {
			titles.unshift(title);
		}

		current = block.parent;
	}

	// maxDepth 保留**最近**的几级，因为靠近引用的上下文更关键。
	if (options.maxDepth !== undefined && options.maxDepth > 0 && titles.length > options.maxDepth) {
		return titles.slice(titles.length - options.maxDepth);
	}

	return titles;
}

/** 把祖先标题链拼成一行路径字符串。找不到祖先时返回空字符串。 */
export function buildBlockPath(
	parsed: ParsedFile,
	blockIndex: number,
	options: BlockPathOptions = {},
): string {
	const titles = buildBlockAncestorTitles(parsed, blockIndex, {
		includeSelf: options.includeSelf,
		maxDepth: options.maxDepth,
		stripHeading: options.stripHeading,
	});
	return titles.join(options.separator ?? ' › ');
}
