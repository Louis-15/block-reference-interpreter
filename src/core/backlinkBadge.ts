/**
 * 反链徽章的显示数据。
 *
 * 放在 core 层而不是 vscode 层的原因：这是纯数据整理，混在依赖 `vscode`
 * 的模块里就没法单测了。真正拼 MarkdownString 的部分在 `vscode/backlinkTooltip.ts`。
 */

import type { BacklinkReport } from './backlinkReport';
import { toPageName } from './backlinkReport';
import { t } from './i18n';

/** 悬停列表里的一条引用。 */
export interface BacklinkTooltipItem {
	/** 页面名（文件名去掉 .md），作为链接文字。 */
	pageName: string;
	/** 引用所在文件的绝对路径，跳转时用。 */
	path: string;
	/** 引用所在行（0-based），跳转时用。 */
	line: number;
	/** 引用所在块的祖先路径；没有祖先时为空字符串。 */
	blockPath: string;
	/** 该页面内这一组引用共有几条（同一页面多次引用时用于提示）。 */
	groupCount: number;
}

/** 徽章悬停时展示的全部数据。 */
export interface BacklinkTooltipData {
	/** 引用块数（按引用块合并后）。 */
	itemCount: number;
	/** 原始命中次数，大于 itemCount 说明同一块内重复引用。 */
	hitCount: number;
	/** UUID 是否在多个位置重复定义。 */
	duplicate: boolean;
	/** 按页面分组、每组取第一条的引用清单。 */
	items: BacklinkTooltipItem[];
	/** 因超限而未列出的页面数。 */
	remaining: number;
}

/** 一个被引用块的锚点信息。 */
export interface BacklinkAnchor {
	/** 块 UUID（小写）。 */
	uuid: string;
	/** 块首行行号（0-based）。 */
	line: number;
	/** 引用条目数（按引用块合并后）。 */
	count: number;
	/** 原始命中次数。 */
	hitCount: number;
	/** 该 UUID 是否在多个位置重复定义。 */
	duplicate: boolean;
	/** 悬停列表的数据。 */
	tooltip: BacklinkTooltipData;
}

/**
 * 生成行尾徽章的文字。
 *
 * 用 `🔗 2` 这种紧凑写法是刻意的：徽章贴在行尾，写全「2 条链接引用」
 * 会把长行的可读性拖垮。真正的信息在悬停列表里。
 */
export function formatAnchorLabel(
	anchor: Pick<BacklinkAnchor, 'count' | 'duplicate'>,
): string {
	return anchor.duplicate ? `🔗 ${anchor.count} ⚠` : `🔗 ${anchor.count}`;
}

/**
 * 从报告里整理出悬停列表数据。
 *
 * 每个**页面**只出一行（取该页第一条引用），而不是每个引用块一行。
 * 原因：悬停框宽度有限，同一页面出现好几次会把列表撑得很长，
 * 而用户真正想看的是「有哪些页面用了我」。
 *
 * @param maxItems 最多列几个页面，超出部分计入 remaining
 */
export function buildTooltipData(report: BacklinkReport, maxItems = 8): BacklinkTooltipData {
	const items: BacklinkTooltipItem[] = [];

	for (const group of report.groups) {
		if (items.length >= maxItems) {
			break;
		}
		const first = group.items[0];
		if (!first) {
			continue;
		}

		items.push({
			pageName: toPageName(group.path),
			path: group.path,
			line: first.line,
			blockPath: first.blockPath,
			groupCount: group.count,
		});
	}

	return {
		itemCount: report.itemCount,
		hitCount: report.hitCount,
		duplicate: report.definitions.length > 1,
		items,
		remaining: Math.max(0, report.groups.length - items.length),
	};
}

/** 从报告构建一个完整锚点。 */
export function buildAnchorFromReport(
	report: BacklinkReport,
	line: number,
	maxItems = 8,
): BacklinkAnchor {
	return {
		uuid: report.uuid,
		line,
		count: report.itemCount,
		hitCount: report.hitCount,
		duplicate: report.definitions.length > 1,
		tooltip: buildTooltipData(report, maxItems),
	};
}

/**
 * 生成纯文本版悬停说明。
 *
 * 给 CodeLens 用：`vscode.CodeLens` 的 `tooltip` 只接受 `string`，
 * 不支持 MarkdownString，因此那条备选路径拿不到可点击链接。
 * 行尾徽章（InlayHint）走 `vscode/backlinkTooltip.ts` 的富文本版本。
 */
export function formatTooltipText(data: BacklinkTooltipData): string {
	const lines = [t('{0} referencing blocks mention this block', data.itemCount)];

	if (data.hitCount > data.itemCount) {
		lines.push(t('Repeated references inside the same block, {0} occurrences in total', data.hitCount));
	}
	if (data.duplicate) {
		lines.push(t('⚠ This UUID is defined in multiple places'));
	}

	for (const item of data.items) {
		const context = item.blockPath.length > 0 ? item.blockPath : t('line {0}', item.line + 1);
		lines.push(`· ${item.pageName} — ${context}`);
	}
	if (data.remaining > 0) {
		lines.push(t('· {0} more pages not listed', data.remaining));
	}

	lines.push(t('Click to open the full backlinks panel'));
	return lines.join('\n');
}
