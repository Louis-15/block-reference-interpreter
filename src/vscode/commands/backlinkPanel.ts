/**
 * 反链面板：把「谁引用了这个块」渲染成面板。
 *
 * 两种呈现方式（`tineBlockRef.backlinks.panel`）：
 * - `html`（默认）：Webview。**左键单击**块名即可跳转，样式接近 Tine；
 * - `text`：只读文本文档。必须 Ctrl + 单击，但支持 Ctrl+F 查找与自由复制。
 *
 * 为什么默认 Webview：用户反馈「必须按 Ctrl 才能跳转」不顺手，
 * 而文本编辑器里的链接强制要求修饰键（VS Code 硬规则），
 * 只有 Webview 里的 `<a>` 能左键直接触发。
 *
 * 与 QuickPick 命令（`showBacklinks`）的分工：
 * - QuickPick 用来**跳转**：一次选一条，回车直达引用位置；
 * - 面板用来**通读**：一次看到全部引用及其上下文。
 */

import * as vscode from 'vscode';

import { buildBacklinkReport, renderBacklinkPanel } from '../../core/backlinkReport';
import type { BacklinkReport } from '../../core/backlinkReport';
import { readConfig } from '../indexService';
import { normalizeUuid } from '../tools/common';
import { openReadOnlyContent } from '../readOnlyContent';
import { BacklinkPanelView } from '../backlinkPanelView';
import { OPEN_BACKLINK_AT_COMMAND } from '../backlinkCommands';
import { openBacklinkAt } from './backlinkJump';
import type { CommandDeps } from './expandCommands';

/**
 * 打开指定块的反链面板。
 *
 * @param uuid 目标块 UUID；不传时弹输入框
 */
export async function showBacklinksPanel(deps: CommandDeps, uuid?: string): Promise<void> {
	let normalized = uuid ? normalizeUuid(uuid) : '';

	if (!normalized) {
		// 从徽章/命令两种入口进来；徽章一定有 uuid，手动执行时走这条路。
		const raw = await vscode.window.showInputBox({
			title: '查看块的反向链接',
			prompt: '输入块 UUID（可带 (( )) 包裹）',
			placeHolder: '66c73a56-ddda-44d2-80dd-009e44406fd4',
			ignoreFocusOut: true,
		});
		if (!raw) {
			return;
		}
		normalized = normalizeUuid(raw);
	}

	if (!normalized) {
		return;
	}

	await deps.ensureReady();

	const config = readConfig();
	const report = buildBacklinkReport(deps.getIndex(), normalized, {
		maxPathDepth: config.backlinkPathDepth,
		// 面板要展示引用处的完整上下文，所以保留子树。
		includeSubtree: true,
		hideProperties: config.hideProperties,
		maxSubtreeLines: config.backlinkSubtreeLines,
	});
	const graphRoot = deps.getGraphRoot();
	const title = `反链 ${normalized.slice(0, 8)}`;

	if (config.backlinkPanelStyle === 'text') {
		await showAsTextPanel(deps, report, title, graphRoot, config.backlinkItemsPerPage);
	} else {
		BacklinkPanelView.show(title, report, graphRoot, config.backlinkItemsPerPage, (path, line) =>
			void openBacklinkAt(path, line),
		);
	}

	if (report.definitions.length === 0) {
		void vscode.window.showWarningMessage(`块 ${normalized} 不存在（可能已被删除）。`);
	}
}

/**
 * 只读文本版面板（Ctrl + 单击跳转）。
 *
 * 保留这一版的原因：文本编辑器支持 Ctrl+F 查找与自由复制，
 * 引用特别多时按关键词筛比在网页里翻更快。
 */
async function showAsTextPanel(
	deps: CommandDeps,
	report: BacklinkReport,
	title: string,
	graphRoot: string | undefined,
	maxItemsPerGroup: number,
): Promise<void> {
	const panel = renderBacklinkPanel(report, {
		graphRoot,
		maxItemsPerGroup,
		purpose: 'panel',
	});

	// 坐标 → 可点击链接由 virtualDocumentLinks 负责，正文保持纯文本。
	const links = panel.links.map((spec) => ({
		line: spec.line,
		startColumn: spec.startColumn,
		endColumn: spec.endColumn,
		command: OPEN_BACKLINK_AT_COMMAND,
		arguments: [spec.path, spec.targetLine],
		tooltip: spec.tooltip,
	}));

	await openReadOnlyContent(deps.contentProvider, title, panel.text, links);
}
