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
import { getBlockTitle, renderBlockTree, stripHeadingMarks } from './render';
import { t } from './i18n';

/**
 * 引用所在块的子树中的一行。
 *
 * 为什么要展开子树：Tine / Logseq 的反链面板不只显示「哪一行引用了它」，
 * 还会把那个块的完整内容（含子块）摆出来。只给一行标题的话，
 * 用户还得自己打开笔记才知道这句话到底在说什么。
 */
export interface BacklinkSubtreeLine {
	/**
	 * 相对引用块标题的缩进层级。
	 *
	 * 0 = 引用块自身的续行（与标题同层），1 = 直接子块，2 = 孙块……
	 */
	depth: number;
	/** 行文本（已去掉 `- ` 标记与前导空白）。 */
	text: string;
	/** 是否为列表项；false 表示块的续行正文。 */
	isListItem: boolean;
}

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
	/** 引用所在块的子树（标题之后的行），用于在面板里完整展示上下文。 */
	subtree: BacklinkSubtreeLine[];
	/** 因超过行数上限而未展开的行数。 */
	subtreeOmitted: number;
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
	/**
	 * 是否展开引用所在块的子树，默认 true。
	 *
	 * 只为拿计数的地方（编辑器内徽章）应传 false：那边只关心数字，
	 * 展开子树是白费力气。
	 */
	includeSubtree?: boolean;
	/** 渲染时隐藏的属性名（`id`、`collapsed` 等）。不传用默认值。 */
	hideProperties?: string[];
	/**
	 * 每个引用块最多展开多少行子树，0 表示不限制（默认）。
	 *
	 * 真实库里 90% 以上的被引用块子树在 20 行内，但不乏 485 行的巨型块。
	 * 需要时可以设个上限避免面板过长。
	 */
	maxSubtreeLines?: number;
}

/**
 * 把 `renderBlockTree` 的多行输出解析成带层级的行。
 *
 * `renderBlockTree` 用「2 空格 × 层级 + `- `」表示列表项，
 * 块的续行正文只有缩进没有 `- `。这里按缩进列数换算层级：
 * 0 列 = 引用块自身的续行，2 列 = 直接子块，4 列 = 孙块……
 */
function parseSubtreeLines(treeText: string, maxLines: number): {
	lines: BacklinkSubtreeLine[];
	omitted: number;
} {
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
export function toPageName(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	const base = normalized.slice(normalized.lastIndexOf('/') + 1);
	return base.replace(/\.md$/i, '');
}

/**
 * 把报告渲染成 Markdown 文本。
 *
 * 用 Markdown 而不是纯文本：面板是只读文档，Markdown 能提供标题层级，
 * 而且在 VS Code 的 Markdown 预览里也能看清结构。
 *
 * 注意：这里是**给 AI 工具**用的版本，保留行号与引用类型等机器友好的信息。
 * 面板（给人看、要可点击）走 `renderBacklinkPanel`。
 */
export function renderBacklinkReport(
	report: BacklinkReport,
	options: RenderBacklinkReportOptions = {},
): string {
	const purpose = options.purpose ?? 'panel';
	const lines: string[] = [];

	if (options.includeHeader !== false) {
		lines.push(t('# Backlinks for block `{0}`', report.uuid), '');

		if (report.definitions.length === 0) {
			lines.push(
				t('> ⚠ The block for this UUID does not exist (it may have been deleted). All references below are **dangling**.'),
			);
		} else if (report.definitions.length > 1) {
			lines.push(
				t(
					'> ⚠ This UUID is defined in {0} places; a reference may point to any of them.',
					report.definitions.length,
				),
			);
		}

		if (report.definitions.length > 0) {
			const first = report.definitions[0];
			if (first) {
				lines.push(
					t(
						'**Defined at**: `{0}` line {1}',
						toDisplayPath(first.path, options.graphRoot),
						first.line + 1,
					),
					t('**Block content**: {0}', first.title),
				);
			}
		}

		if (report.itemCount > 0) {
			const hitNote =
				report.hitCount > report.itemCount
					? t(' ({0} repeated occurrences inside the same block)', report.hitCount)
					: '';
			lines.push(
				'',
				t(
					'**Reference count**: {0} pages / {1} referencing blocks{2}',
					report.fileCount,
					report.itemCount,
					hitNote,
				),
			);
		}
		lines.push('');
	}

	if (report.itemCount === 0) {
		lines.push(t('No note references this block.'));
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
		lines.push(
			t('## {0}', pageName),
			'',
			t('`{0}` · {1} references', relative, group.count),
			'',
		);

		const shown = maxItems === undefined ? group.items : group.items.slice(0, maxItems);
		for (const item of shown) {
			// 总预算优先：即使这一组还没到组内上限，总量超了也要停。
			if (maxTotal !== undefined && emitted >= maxTotal) {
				truncatedByTotal = true;
				break;
			}

			const kindText = item.kinds.includes('embed')
				? item.kinds.includes('inline')
					? t('inline + embedded reference')
					: t('embedded reference')
				: t('inline reference');
			const countText = item.count > 1 ? t(', {0} times inside this block', item.count) : '';
			const positionText = t('line {0} · {1}{2}', item.line + 1, kindText, countText);

			if (item.blockPath.length > 0) {
				// 有祖先路径时：第一行给位置（面包屑），第二行给行号与类型。
				// 不再重复输出块自身标题 —— 真实库里引用行往往就是一行 `((uuid))`，
				// 照搬只会让面板充满无意义的 UUID。
				lines.push(`- ${item.blockPath}`, `  - ${positionText}`);
			} else {
				// 顶层块没有面包屑，用引用行清洗后的文字兜底。
				const cleaned = cleanReferenceLine(item.lineText);
				lines.push(`- ${cleaned || item.blockTitle || t('(top-level block)')}`, `  - ${positionText}`);
			}
			emitted++;
		}

		if (!truncatedByTotal && maxItems !== undefined && group.items.length > maxItems) {
			lines.push(t('- ({0} more references on this page not shown)', group.items.length - maxItems));
		}

		lines.push('');
	}

	if (truncatedByTotal && maxTotal !== undefined) {
		lines.push(
			t(
				'- (display limit of {0} reached; {1} in total. Increase the limit parameter to see more, up to 200.)',
				maxTotal,
				report.itemCount,
			),
			'',
		);
	}

	if (purpose === 'tool') {
		lines.push(
			'---',
			t(
				'Note: the `›` in a path separates the block hierarchy levels inside the note, which helps judge the context this reference appears in.',
			),
		);
	}

	return lines.join('\n');
}

/** 面板里一条可点击链接的位置与目标。 */
export interface BacklinkPanelLink {
	/** 链接所在行（0-based）。 */
	line: number;
	/** 链接起始列（0-based，含）。 */
	startColumn: number;
	/** 链接结束列（0-based，不含）。 */
	endColumn: number;
	/** 跳转目标文件绝对路径。 */
	path: string;
	/** 跳转目标行（0-based）。 */
	targetLine: number;
	/** 悬停说明，补回被省略的行号与引用类型。 */
	tooltip: string;
}

/** 面板内容与其上的链接位置。 */
export interface BacklinkPanelContent {
	/** 完整文本。 */
	text: string;
	/** 需要变成可点击链接的片段。 */
	links: BacklinkPanelLink[];
}

/**
 * 渲染**给人看**的反链面板。
 *
 * 与 `renderBacklinkReport`（AI 工具用）的关键差异：
 * 每个引用位置的第二行不再写「第 N 行 · 行内引用」，而是显示**被引用块的文字**，
 * 并且这一行是可点击的——点它直接打开引用所在笔记并跳过去。
 *
 * 为什么行号不直接印在正文里：一块被 5 处引用时，每处都重复印「第 N 行」
 * 会挤掉真正有用的信息（被引用的是哪个块）。行号改放到链接的 tooltip 里，
 * 需要时悬停一下就能看到，界面还干净。
 *
 * 为什么返回链接坐标而不是在文本里写 Markdown 链接语法：
 * 面板是**纯文本编辑器**里打开的只读 .md，`[文字](command:...)` 那样写
 * 会把一长串 URI 直接糊在正文中，既难读又会被误编辑。
 * 坐标交给 `DocumentLinkProvider` 渲染成真正的可点击链接，正文保持干净。
 */
export function renderBacklinkPanel(
	report: BacklinkReport,
	options: RenderBacklinkReportOptions = {},
): BacklinkPanelContent {
	const lines: string[] = [];
	const links: BacklinkPanelLink[] = [];

	const push = (text: string): void => {
		lines.push(text);
	};

	if (options.includeHeader !== false) {
		push(t('# Backlinks for block `{0}`', report.uuid));
		push('');

		if (report.definitions.length === 0) {
			push(
				t('> ⚠ The block for this UUID does not exist (it may have been deleted). All references below are **dangling**.'),
			);
		} else if (report.definitions.length > 1) {
			push(
				t('> ⚠ This UUID is defined in {0} places; a reference may point to any of them.', report.definitions.length),
			);
		}

		const first = report.definitions[0];
		if (first) {
			push(
				t('**Defined at**: `{0}` line {1}', toDisplayPath(first.path, options.graphRoot), first.line + 1),
			);
			push(t('**Block content**: {0}', first.title));
		}

		if (report.itemCount > 0) {
			const hitNote =
				report.hitCount > report.itemCount
					? t(' ({0} repeated occurrences inside the same block)', report.hitCount)
					: '';
			push('');
			push(
				t('**Reference count**: {0} pages / {1} referencing blocks{2}', report.fileCount, report.itemCount, hitNote),
			);
			push('');
			push(t('Click a block title below to jump to the reference.'));
		}
		push('');
	}

	if (report.itemCount === 0) {
		push(t('No note references this block.'));
		return { text: lines.join('\n'), links };
	}

	// 这一行将成为每处引用的链接文字。悬空引用没有块，退回行号保证仍可点击。
	const targetTitle = report.definitions[0]?.title ?? '';

	const maxItems = options.maxItemsPerGroup;
	const maxTotal = options.maxTotalItems;
	let emitted = 0;
	let truncatedByTotal = false;

	for (const group of report.groups) {
		if (truncatedByTotal) {
			break;
		}

		const relative = toDisplayPath(group.path, options.graphRoot);
		push(`## ${toPageName(group.path)}`);
		push('');
		push(t('`{0}` · {1} references', relative, group.count));
		push('');

		const shown = maxItems === undefined ? group.items : group.items.slice(0, maxItems);
		for (const item of shown) {
			if (maxTotal !== undefined && emitted >= maxTotal) {
				truncatedByTotal = true;
				break;
			}

			const hasPath = item.blockPath.length > 0;
			if (hasPath) {
				push(`- ${item.blockPath}`);
			}

			// 引用块标题缩进一级，体现它是面包屑最后那一级的子块。
			const prefix = hasPath ? '    ' : '  ';
			const linkText = targetTitle.length > 0 ? targetTitle : t('line {0}', item.line + 1);

			const kindText = item.kinds.includes('embed')
				? item.kinds.includes('inline')
					? t('inline + embedded reference')
					: t('embedded reference')
				: t('inline reference');
			const countText = item.count > 1 ? t(', {0} times inside this block', item.count) : '';

			links.push({
				line: lines.length,
				startColumn: prefix.length,
				endColumn: prefix.length + linkText.length,
				path: item.path,
				targetLine: item.line,
				tooltip: t('{0} line {1} · {2}{3}', relative, item.line + 1, kindText, countText),
			});

			push(prefix + linkText);

			// 子树按层级缩进，与 Tine 的反链面板一致。
			const baseIndent = prefix + '  ';
			for (const sub of item.subtree) {
				const indent = baseIndent + '  '.repeat(Math.min(sub.depth + 1, 8));
				push(`${indent}${sub.isListItem ? '- ' : ''}${sub.text}`);
			}
			if (item.subtreeOmitted > 0) {
				push(`${baseIndent}  ${t('… {0} more lines not expanded', item.subtreeOmitted)}`);
			}

			emitted++;
		}

		if (!truncatedByTotal && maxItems !== undefined && group.items.length > maxItems) {
			push(t('- ({0} more references on this page not shown)', group.items.length - maxItems));
		}

		push('');
	}

	if (truncatedByTotal && maxTotal !== undefined) {
		push(t('- (display limit of {0} reached; {1} in total.)', maxTotal, report.itemCount));
		push('');
	}

	return { text: lines.join('\n'), links };
}
