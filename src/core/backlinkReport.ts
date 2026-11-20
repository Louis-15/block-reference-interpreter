/**
 * 反向链接报告。
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
 * 这一层不依赖 `vscode`，可在 Node 里直接单测。
 */

import { buildBlockPath } from './blockPath';
import type { BacklinkEntry, GraphIndex } from './graphIndex';
import { cleanReferenceLine } from './refText';
import { getBlockTitle, stripHeadingMarks } from './render';

/** 一条引用（按「引用所在块」合并后的结果）。 */
export interface BacklinkItem {
	/** 引用所在文件（绝对路径）。 */
	path: string;
	/** 引用所在块在文件 blocks 数组里的下标；-1 表示定位失败。 */
	blockIndex: number;
	/** 被引用文本出现的行号（0-based），取该块内第一次出现的行。 */
	line: number;
	/** 该块内出现的全部引用形态。 */
	kinds: Array<'inline' | 'embed'>;
	/** 该块内引用出现的次数。 */
	count: number;
	/** 引用所在块的标题（块首行正文）。 */
	blockTitle: string;
	/** 引用所在行的原文，用于面包屑为空时兜底展示。 */
	lineText: string;
	/** 引用所在块的祖先路径（不含自身）；没有祖先时为空字符串。 */
	blockPath: string;
}

/** 同一个文件内的全部引用。 */
export interface BacklinkGroup {
	/** 文件绝对路径。 */
	path: string;
	/** 该文件内的引用条目。 */
	items: BacklinkItem[];
	/** 条目数（供 CodeLens 与排序使用）。 */
	count: number;
}

/** 目标块的定义位置。 */
export interface BacklinkDefinition {
	/** 文件绝对路径。 */
	path: string;
	/** 块首行行号（0-based）。 */
	line: number;
	/** 块首行正文。 */
	title: string;
}

/** 完整的反链报告。 */
export interface BacklinkReport {
	/** 规范化的 UUID（小写）。 */
	uuid: string;
	/** 定义位置。空数组表示块不存在（悬空引用）。 */
	definitions: BacklinkDefinition[];
	/** 按页面分组的引用。 */
	groups: BacklinkGroup[];
	/** 引用条目总数（已按块合并）。 */
	itemCount: number;
	/** 原始命中次数（同一块里出现两次就算两次）。 */
	hitCount: number;
	/** 涉及的页面数。 */
	fileCount: number;
}

/** 生成报告时的选项。 */
export interface BacklinkReportOptions {
	/** 是否去掉标题里的 `#` 标记，默认 true（给人看的场景）。 */
	stripHeading?: boolean;
	/** 路径最多保留几级祖先，默认 3——太长的面包屑在窄面板里会被折断。 */
	maxPathDepth?: number;
}

/**
 * 把一个文件内的多条命中合并为按块去重的条目。
 *
 * 为什么要合并：块引用常在同一个块里成对出现（例如一句里引用两次同一个块）。
 * 不合并的话面板会连续列出两条一模一样的上下文，用户会以为数据重复了。
 */
function mergeHits(
	parsed: import('./types').ParsedFile,
	entries: BacklinkEntry[],
	options: BacklinkReportOptions,
): BacklinkItem[] {
	const byBlock = new Map<number, BacklinkItem>();

	for (const entry of entries) {
		const key = entry.blockIndex;
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

		byBlock.set(key, {
			path: entry.path,
			blockIndex: entry.blockIndex,
			line: entry.hit.line,
			kinds: [entry.hit.kind],
			count: 1,
			blockTitle,
			lineText: entry.lineText,
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
 * 排序规则（固定，保证三处展示一致）：
 * 1. 页面按引用条目数**降序** —— 引用最多的页面通常是主题页，最该先看到；
 * 2. 条目数相同的页面按路径字母序，避免「同样的数据每次打开顺序都不同」；
 * 3. 页面内按行号升序，符合阅读顺序。
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

/** 渲染报告时的选项。 */
export interface RenderBacklinkReportOptions {
	/** 图谱根目录，用于把绝对路径转成 `pages/xxx.md`。不传则显示原路径。 */
	graphRoot?: string;
	/** 每组最多显示几条，默认不限制。 */
	maxItemsPerGroup?: number;
	/**
	 * 全部组加起来的条目上限，默认不限制。
	 *
	 * 这是给 AI 工具用的硬预算：只限制「每组条数」挡不住「被 100 个页面各引用 1 次」
	 * 这种分散情况，输出照样会爆掉模型上下文。
	 */
	maxTotalItems?: number;
	/** 是否输出「定义位置」与统计头，默认 true。 */
	includeHeader?: boolean;
	/** 面板用途标记（影响文案），默认 `panel`。 */
	purpose?: 'panel' | 'tool';
}

/** 把绝对路径转成相对图谱根的显示路径。 */
function toDisplayPath(filePath: string, graphRoot?: string): string {
	if (!graphRoot) {
		return filePath.replace(/\\/g, '/');
	}
	const normalizedRoot = graphRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	const normalizedPath = filePath.replace(/\\/g, '/');
	if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/')) {
		return normalizedPath.slice(normalizedRoot.length + 1);
	}
	return normalizedPath;
}

/** 取文件名（不含目录与扩展名），用作「页面名」。 */
function toPageName(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	const base = normalized.slice(normalized.lastIndexOf('/') + 1);
	return base.replace(/\.md$/i, '');
}

/**
 * 把报告渲染成 Markdown 文本。
 *
 * 用 Markdown 而不是纯文本：面板是只读文档，Markdown 能提供标题层级，
 * 而且在 VS Code 的 Markdown 预览里也能看清结构。
 */
export function renderBacklinkReport(
	report: BacklinkReport,
	options: RenderBacklinkReportOptions = {},
): string {
	const purpose = options.purpose ?? 'panel';
	const lines: string[] = [];

	if (options.includeHeader !== false) {
		lines.push(`# 块 \`${report.uuid}\` 的反向链接`, '');

		if (report.definitions.length === 0) {
			lines.push('> ⚠ 该 UUID 对应的块不存在（可能已被删除）。以下引用均为**悬空引用**。');
		} else if (report.definitions.length > 1) {
			lines.push(`> ⚠ 该 UUID 在 ${report.definitions.length} 处重复定义，引用可能指向其中任意一个。`);
		}

		if (report.definitions.length > 0) {
			const first = report.definitions[0];
			if (first) {
				lines.push(
					`**定义位置**：\`${toDisplayPath(first.path, options.graphRoot)}\` 第 ${first.line + 1} 行`,
					`**块内容**：${first.title}`,
				);
			}
		}

		if (report.itemCount > 0) {
			const hitNote = report.hitCount > report.itemCount
				? `（同一块内重复出现共 ${report.hitCount} 次）`
				: '';
			lines.push(
				'',
				`**引用统计**：${report.fileCount} 个页面 / ${report.itemCount} 个引用块${hitNote}`,
			);
		}
		lines.push('');
	}

	if (report.itemCount === 0) {
		lines.push('没有任何笔记引用这个块。');
		return lines.join('\n');
	}

	const maxItems = options.maxItemsPerGroup;
	const maxTotal = options.maxTotalItems;
	let emitted = 0;
	let truncatedByTotal = false;

	for (const group of report.groups) {
		if (truncatedByTotal) {
			break;
		}

		const relative = toDisplayPath(group.path, options.graphRoot);
		const pageName = toPageName(group.path);
		lines.push(`## ${pageName}`, '', `\`${relative}\` · ${group.count} 处引用`, '');

		const shown = maxItems === undefined ? group.items : group.items.slice(0, maxItems);
		for (const item of shown) {
			// 总预算优先：即使这一组还没到组内上限，总量超了也要停。
			if (maxTotal !== undefined && emitted >= maxTotal) {
				truncatedByTotal = true;
				break;
			}

			const kindText = item.kinds.includes('embed')
				? (item.kinds.includes('inline') ? '行内引用 + 嵌入引用' : '嵌入引用')
				: '行内引用';
			const countText = item.count > 1 ? `，本块内 ${item.count} 次` : '';
			const positionText = `第 ${item.line + 1} 行 · ${kindText}${countText}`;

			if (item.blockPath.length > 0) {
				// 有祖先路径时：第一行给位置（面包屑），第二行给行号与类型。
				// 不再重复输出块自身标题 —— 真实库里引用行往往就是一行 `((uuid))`，
				// 照搬只会让面板充满无意义的 UUID。
				lines.push(`- ${item.blockPath}`, `  - ${positionText}`);
			} else {
				// 顶层块没有面包屑，用引用行清洗后的文字兜底。
				const cleaned = cleanReferenceLine(item.lineText);
				lines.push(`- ${cleaned || item.blockTitle || '（顶层块）'}`, `  - ${positionText}`);
			}
			emitted++;
		}

		if (!truncatedByTotal && maxItems !== undefined && group.items.length > maxItems) {
			lines.push(`- （本页还有 ${group.items.length - maxItems} 处未显示）`);
		}

		lines.push('');
	}

	if (truncatedByTotal && maxTotal !== undefined) {
		lines.push(
			`- （已达显示上限 ${maxTotal} 条，共 ${report.itemCount} 条。扩大 limit 参数可看到更多，上限 200。）`,
			'',
		);
	}

	if (purpose === 'tool') {
		lines.push(
			'---',
			'提示：路径中的 `›` 表示块在笔记里的层级位置，便于判断这条引用出现在什么上下文中。',
		);
	}

	return lines.join('\n');
}
