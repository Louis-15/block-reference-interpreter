/**
 * 反链面板：把「谁引用了这个块」渲染成一个只读标签页。
 *
 * 与现有 QuickPick 命令（`showBacklinks`）的分工：
 * - QuickPick 用来**跳转**：一次选一条，回车直达引用位置；
 * - 本面板用来**通读**：一次看到全部引用及其上下文，像 Tine 的反链区。
 *
 * 为什么不合并成一个：两种交互的目标不同，合起来会变成
 * 「先看一堆列表再决定跳哪」的冗长流程。
 */

import * as vscode from 'vscode';

import { buildBacklinkReport, renderBacklinkReport } from '../../core/backlinkReport';
import { readConfig } from '../indexService';
import { normalizeUuid } from '../tools/common';
import { openReadOnlyContent } from '../readOnlyContent';
import type { CommandDeps } from './expandCommands';

/**
 * 打开指定块的反链面板。
 *
 * @param uuid 目标块 UUID；不传时依次尝试「光标所在引用」与「输入框」
 */
export async function showBacklinksPanel(deps: CommandDeps, uuid?: string): Promise<void> {
	let normalized = uuid ? normalizeUuid(uuid) : '';

	if (!normalized) {
		// 从 CodeLens 进来时一定有 uuid；手动执行命令时走这条路。
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
	});

	const content = renderBacklinkReport(report, {
		graphRoot: deps.getGraphRoot(),
		maxItemsPerGroup: config.backlinkItemsPerPage,
		purpose: 'panel',
	});

	// 无引用时也打开面板：面板里写清了「块是否存在」，
	// 这比弹一条转瞬即逝的提示更有用（用户能回头再看）。
	await openReadOnlyContent(deps.contentProvider, `反链 ${normalized.slice(0, 8)}`, content);

	if (report.definitions.length === 0) {
		void vscode.window.showWarningMessage(`块 ${normalized} 不存在（可能已被删除）。`);
	}
}
