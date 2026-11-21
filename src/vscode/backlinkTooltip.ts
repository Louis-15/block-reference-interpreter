/**
 * 把反链数据拼成可点击的悬停提示。
 *
 * 为什么用 MarkdownString 而不是纯文本：纯文本只能「看」，
 * 用户看到「傲娇」还得自己去文件列表里翻。MarkdownString 支持
 * `command:` 链接，点页面名就能直接跳到引用那一行。
 *
 * `command:` 链接的两个硬性要求（漏掉任何一个链接都会点不动）：
 * 1. `isTrusted` 必须设置，否则 VS Code 拒绝执行任何命令链接；
 * 2. 参数要用 encodeURIComponent(JSON.stringify(args)) 编码，
 *    否则路径里的反斜杠、空格、中文会把链接语法打断。
 */

import * as vscode from 'vscode';

import type { BacklinkTooltipData } from '../core/backlinkBadge';
import { OPEN_BACKLINK_AT_COMMAND, SHOW_BACKLINKS_PANEL_COMMAND } from './backlinkCommands';
import { t } from '../core/i18n';

/**
 * 转义 Markdown 特殊字符。
 *
 * 笔记标题里常见 `[[页面名]]`、`*重点*`、`+`，直接把原文塞进 `[](...)`
 * 会破坏链接语法（显示成字面量甚至整行失效）。
 */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

/** 把参数编码成 command 链接可用的形式。 */
function encodeArgs(args: unknown[]): string {
	return encodeURIComponent(JSON.stringify(args));
}

/** 构建「跳到某个引用位置」的 command 链接。 */
function refLink(text: string, path: string, line: number): string {
	return `[${escapeMarkdown(text)}](command:${OPEN_BACKLINK_AT_COMMAND}?${encodeArgs([path, line])})`;
}

/**
 * 生成徽章悬停提示。
 *
 * 结构（用户实测后确定）：
 * ```
 * ### 引用此块的页面
 * [傲娇](command:...) · 71 举例 › 71.3 毒舌讽刺型
 * [傻白+中二](command:...) · 71 举例 › 71.2 普通女
 *
 * [查看完整反链面板](command:...)
 * ```
 *
 * 每行页面名都是链接，点击直接打开笔记并跳到引用那一行——
 * 比「先开面板再找」少一步操作。
 */
export function buildAnchorTooltip(anchor: {
	tooltip: BacklinkTooltipData;
	uuid: string;
}): vscode.MarkdownString {
	const data = anchor.tooltip;
	const md = new vscode.MarkdownString(undefined, true);

	// 必须显式信任这两个命令，否则 command 链接点击无效且没有任何报错。
	md.isTrusted = { enabledCommands: [OPEN_BACKLINK_AT_COMMAND, SHOW_BACKLINKS_PANEL_COMMAND] };
	md.supportHtml = false;

	const summary = [t('{0} referencing blocks', data.itemCount)];
	if (data.hitCount > data.itemCount) {
		summary.push(t('{0} repeated occurrences inside the same block', data.hitCount));
	}
	md.appendMarkdown(`${t('**Pages referencing this block** ({0})', summary.join(', '))}\n\n`);

	if (data.duplicate) {
		md.appendMarkdown(
			`${t('⚠ This UUID is defined in multiple places; a reference may point to any of them')}\n\n`,
		);
	}

	for (const item of data.items) {
		const link = refLink(item.pageName, item.path, item.line);
		// 面包屑提供上下文：同样引用了这个块，出现在「71.3 毒舌讽刺型」
		// 和「2.1 平时」下面含义完全不同。
		const context =
			item.blockPath.length > 0
				? ` · ${escapeMarkdown(item.blockPath)}`
				: t(' · line {0}', item.line + 1);
		const extra = item.groupCount > 1 ? t(' ({0} on this page)', item.groupCount) : '';
		md.appendMarkdown(`- ${link}${context}${extra}\n`);
	}

	if (data.remaining > 0) {
		md.appendMarkdown(`${t('- {0} more pages not listed', data.remaining)}\n`);
	}

	md.appendMarkdown(
		`\n[${t('Open the full backlinks panel')}](command:${SHOW_BACKLINKS_PANEL_COMMAND}?${encodeArgs([anchor.uuid])})`,
	);

	return md;
}
