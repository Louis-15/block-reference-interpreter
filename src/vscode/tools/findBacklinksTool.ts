/**
 * 工具：查询块的反向链接。
 *
 * 等价于 Tine 的 `tine refs --block <uuid>`，但走内存索引，
 * 在 Windows 上可用（Tine 自己的 CLI 读命令在该平台不可用）。
 */

import * as vscode from 'vscode';

import { buildBacklinkReport, renderBacklinkReport } from '../../core/backlinkReport';
import type { GraphIndex } from '../../core/graphIndex';
import { readConfig } from '../indexService';
import { normalizeUuid, textResult } from './common';
import { t } from '../../core/i18n';

export interface FindBacklinksInput {
	/** 目标块的 UUID。 */
	blockId: string;
	/** 最多返回多少条，默认 50。 */
	limit?: number;
}

export class FindBacklinksTool implements vscode.LanguageModelTool<FindBacklinksInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<FindBacklinksInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		await this.ensureReady();
		if (token.isCancellationRequested) {
			return textResult(t('(call cancelled)'));
		}

		const uuid = normalizeUuid(options.input.blockId ?? '');
		if (!uuid) {
			return textResult(
				t('The blockId parameter is missing. Pass the block UUID, for example `66c73a56-ddda-44d2-80dd-009e44406fd4`.'),
			);
		}

		const index = this.getIndex();
		const graphRoot = this.getGraphRoot();
		const limit = Math.max(1, Math.min(options.input.limit ?? 50, 200));

		// 与编辑器内的反链面板共用同一套分组与排序，避免「面板说 3 条、工具说 4 条」。
		const report = buildBacklinkReport(index, uuid, {
			maxPathDepth: readConfig().backlinkPathDepth,
		});
		const text = renderBacklinkReport(report, {
			graphRoot,
			maxItemsPerGroup: limit,
			// AI 工具必须给硬预算：只限组内条数挡不住「被上百个页面各引用一次」。
			maxTotalItems: limit,
			purpose: 'tool',
		});

		return textResult(text);
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: t('Looking up backlinks for the block') };
	}
}
