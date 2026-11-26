/**
 * 反向链接报告的渲染。
 *
 * 两个用途、两种输出：
 * - `renderBacklinkReport`：给 AI 工具的 Markdown，保留行号与引用类型等机器友好信息；
 * - `renderBacklinkPanel`：给人的只读面板，返回文本 + 可点击链接坐标。
 *
 * 两者共用同一份 `BacklinkReport`，所以计数与排序永远一致。
 */

import { t } from './i18n';
import { cleanReferenceLine } from './refText';
import { toDisplayPath, toPageName } from './backlinkReportText';
import type {
	BacklinkPanelContent,
	BacklinkPanelLink,
	BacklinkReport,
	RenderBacklinkReportOptions,
} from './backlinkReportTypes';

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
