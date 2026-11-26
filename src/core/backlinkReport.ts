/**
 * 反向链接报告（构建层）。
 *
 * 把 `GraphIndex.findBacklinks()` 输出的扁平列表整理成「按页面分组」的结构，
 * 供三个地方共用：
 * - 编辑器内的 CodeLens 计数
 * - 反链面板（只读文档）
 * - AI 工具 `#blockBacklinks` 的文本输出
 *
 * 为什么不各自实现一遍：三处如果各写各的排序与去重规则，
 * 用户会看到「CodeLens 说 3 条、面板列 4 条」这类前后不一致的问题。
 *
 * 模块拆分：
 * - `backlinkReportTypes.ts`：共享类型；
 * - `backlinkReportText.ts`：路径工具；
 * - `backlinkReportRender.ts`：文本与面板渲染；
 * - 本文件：构建报告，并 re-export 其余模块的公开 API。
 *
 * 这一层不依赖 `vscode`，可在 Node 里直接单测。
 */

import { buildBlockPath } from './blockPath';
import type { BacklinkEntry, GraphIndex } from './graphIndex';
import { getBlockTitle, renderBlockTree, stripHeadingMarks } from './render';
import type {
	BacklinkGroup,
	BacklinkItem,
	BacklinkReport,
	BacklinkReportOptions,
	BacklinkSubtreeLine,
} from './backlinkReportTypes';

export type {
	BacklinkDefinition,
	BacklinkGroup,
	BacklinkItem,
	BacklinkPanelContent,
	BacklinkPanelLink,
	BacklinkReport,
	BacklinkReportOptions,
	BacklinkSubtreeLine,
	RenderBacklinkReportOptions,
} from './backlinkReportTypes';
export { toDisplayPath, toPageName } from './backlinkReportText';
export { renderBacklinkPanel, renderBacklinkReport } from './backlinkReportRender';

/**
 * 把 `renderBlockTree` 的多行输出解析成带层级的行。
 *
 * `renderBlockTree` 用「2 空格 × 层级 + `- `」表示列表项，
 * 块的续行正文只有缩进没有 `- `。这里按缩进列数换算层级：
 * 0 列 = 引用块自身的续行，2 列 = 直接子块，4 列 = 孙块……
 */
function parseSubtreeLines(
	treeText: string,
	maxLines: number,
): { lines: BacklinkSubtreeLine[]; omitted: number } {
	const rawLines = treeText.split('\n');
	// 第一行是块自身标题，已在 blockTitle 里，跳过。
	const rest = rawLines.slice(1);

	const lines: BacklinkSubtreeLine[] = [];

	for (const raw of rest) {
		if (raw.trim() === '') {
			continue;
		}

		const leading = /^[ \t]*/.exec(raw)?.[0].length ?? 0;
		// 制表符按 4 列展开后再算层级，否则 tab 缩进的块层级会算错。
		const columns = raw.slice(0, leading).replace(/\t/g, '    ').length;
		// 缩进单位固定 2 空格（renderBlockTree 的默认 indentUnit）。
		const depth = Math.max(0, Math.floor(columns / 2));

		const body = raw.slice(leading);
		const isListItem = body.startsWith('- ');
		const text = (isListItem ? body.slice(2) : body).trimEnd();
		if (text.trim() === '') {
			continue;
		}

		if (maxLines > 0 && lines.length >= maxLines) {
			// 达到上限：统计剩余行数后停止。
			const omitted = rest.length - lines.length;
			return { lines, omitted };
		}

		lines.push({ depth, text, isListItem });
	}

	return { lines, omitted: 0 };
}

/**
 * 把一个文件内的多条命中合并为按块（或按行）去重的条目。
 *
 * 为什么要合并：块引用常在同一个块里成对出现（例如一句里引用两次同一个块）。
 * 不合并的话面板会连续列出两条一模一样的上下文，用户会以为数据重复了。
 *
 * 为什么块外引用要按行区分：`blockIndex < 0` 表示该引用不在任何块内
 * （例如文件末尾顶格的裸 `((uuid))` 行）。这些行的 `blockIndex` 全是 -1，
 * 若直接当 key，会把多行不相关的引用合并成同一条，看起来就像
 * 「同块内重复引用 N 次」——这是错误结论。
 */
function mergeHits(
	parsed: import('./types').ParsedFile,
	entries: BacklinkEntry[],
	options: BacklinkReportOptions,
): BacklinkItem[] {
	const byBlock = new Map<string, BacklinkItem>();

	for (const entry of entries) {
		const key =
			entry.blockIndex >= 0 ? `block:${entry.blockIndex}` : `line:${entry.hit.line}`;
		const existing = byBlock.get(key);

		if (existing) {
			existing.count += 1;
			if (!existing.kinds.includes(entry.hit.kind)) {
				existing.kinds.push(entry.hit.kind);
			}
			continue;
		}

		const block = entry.blockIndex >= 0 ? parsed.blocks[entry.blockIndex] : undefined;
		const rawTitle = block ? getBlockTitle(block.ownLines[0] ?? '') : entry.lineText.trim();
		const blockTitle = options.stripHeading === false ? rawTitle : stripHeadingMarks(rawTitle);

		// 展开子树：让面板能像 Tine 一样显示引用处的完整上下文。
		let subtree: BacklinkSubtreeLine[] = [];
		let subtreeOmitted = 0;
		if ((options.includeSubtree ?? true) && entry.blockIndex >= 0) {
			try {
				const treeText = renderBlockTree(parsed, entry.blockIndex, {
					stripHeadingMarks: options.stripHeading !== false,
					hideProperties: options.hideProperties,
				});
				const parsedTree = parseSubtreeLines(treeText, options.maxSubtreeLines ?? 0);
				subtree = parsedTree.lines;
				subtreeOmitted = parsedTree.omitted;
			} catch {
				// 子树渲染失败不应该让整个面板挂掉，降级为只显示标题。
				subtree = [];
				subtreeOmitted = 0;
			}
		}

		byBlock.set(key, {
			path: entry.path,
			blockIndex: entry.blockIndex,
			line: entry.hit.line,
			kinds: [entry.hit.kind],
			count: 1,
			blockTitle,
			lineText: entry.lineText,
			subtree,
			subtreeOmitted,
			blockPath: buildBlockPath(parsed, entry.blockIndex, {
				maxDepth: options.maxPathDepth ?? 3,
				stripHeading: options.stripHeading !== false,
			}),
		});
	}

	return [...byBlock.values()];
}

/**
 * 构建反链报告。
 *
 * 当前文件应以实时解析结果为准（`index.updateFile` 已保证这一点），
 * 否则 AI 刚写未保存的引用会看不到。
 */
export function buildBacklinkReport(
	index: GraphIndex,
	uuid: string,
	options: BacklinkReportOptions = {},
): BacklinkReport {
	const normalized = uuid.toLowerCase();
	const definitions = index.lookupBlocks(normalized).map((result) => {
		const block = result.parsed.blocks[result.blockIndex];
		const rawTitle = block ? getBlockTitle(block.ownLines[0] ?? '') : '';
		return {
			path: result.location.path,
			line: block?.startLine ?? 0,
			title: options.stripHeading === false ? rawTitle : stripHeadingMarks(rawTitle),
		};
	});

	const entries = index.findBacklinks(normalized);

	// 先按文件分组，再逐文件合并同块内的重复命中。
	const byFile = new Map<string, BacklinkEntry[]>();
	for (const entry of entries) {
		const list = byFile.get(entry.path);
		if (list) {
			list.push(entry);
		} else {
			byFile.set(entry.path, [entry]);
		}
	}

	const groups: BacklinkGroup[] = [];
	for (const [path, fileEntries] of byFile) {
		const parsed = index.getParsedFile(path);
		if (!parsed) {
			// 文件在两次查询之间被移出索引，跳过而不是抛错。
			continue;
		}
		const items = mergeHits(parsed, fileEntries, options).sort((a, b) => a.line - b.line);
		groups.push({ path, items, count: items.length });
	}

	groups.sort((a, b) => (b.count - a.count) || a.path.localeCompare(b.path));

	let itemCount = 0;
	for (const group of groups) {
		itemCount += group.count;
	}

	return {
		uuid: normalized,
		definitions,
		groups,
		itemCount,
		hitCount: entries.length,
		fileCount: groups.length,
	};
}
