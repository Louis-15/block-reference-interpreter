/**
 * 工具：按 UUID 读取块内容。
 *
 * 这是「让 AI 读懂块引用」的主入口。AI 在笔记里看到 `((uuid))` 时调用它，
 * 就能拿到该块及其全部子树的真实文本——全程在内存里完成，不产生任何文件。
 */

import * as vscode from 'vscode';

import type { GraphIndex } from '../../core/graphIndex';
import { resolveBlocks } from '../../core/resolve';
import { readConfig } from '../indexService';
import { normalizeUuid, textResult } from './common';
import { t } from '../../core/i18n';

export interface ReadBlockInput {
	/** 要读取的块 UUID，可一次传多个。 */
	blockIds: string[];
	/** 是否包含子块，默认 true。 */
	includeChildren?: boolean;
	/** 紧凑模式：每个块只输出首行正文。 */
	compact?: boolean;
	/** 嵌套引用展开深度；不传则用配置值。 */
	maxDepth?: number;
}

export class ReadBlockTool implements vscode.LanguageModelTool<ReadBlockInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReadBlockInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		await this.ensureReady();
		if (token.isCancellationRequested) {
			return textResult(t('(call cancelled)'));
		}

		const input = options.input;
		const rawIds = Array.isArray(input.blockIds) ? input.blockIds : [];
		const uuids = [...new Set(rawIds.map(normalizeUuid).filter((id) => id.length > 0))];

		if (uuids.length === 0) {
			return textResult(
				t('No valid block UUID received. Pass an ID such as `66c73a56-ddda-44d2-80dd-009e44406fd4`.'),
			);
		}
		if (uuids.length > 20) {
			return textResult(
				t('At most 20 UUIDs per call; received {0}. Please split into several calls.', uuids.length),
			);
		}

		const config = readConfig();
		const index = this.getIndex();

		const results = resolveBlocks(index, uuids, {
			includeChildren: input.includeChildren ?? true,
			compact: input.compact ?? false,
			maxDepth: input.maxDepth ?? config.maxDepth,
			maxChars: config.maxOutputChars,
			hideProperties: config.hideProperties,
		});

		const sections = results.map((result) => result.text);
		const missing = results.filter((result) => result.notFound).map((result) => result.uuid);
		const ambiguous = results.filter((result) => result.duplicateCount > 0).map((result) => result.uuid);

		const summary: string[] = [t('Read {0} blocks.', uuids.length)];
		if (missing.length > 0) {
			summary.push(
				t('{0} of them were not found: {1}. These references may be stale.', missing.length, missing.join(', ')),
			);
		}
		if (ambiguous.length > 0) {
			summary.push(
				t(
					'{0} of them have duplicate definitions: {1}. All candidates are listed.',
					ambiguous.length,
					ambiguous.join(', '),
				),
			);
		}
		if (results.some((result) => result.truncated)) {
			summary.push(
				t('Part of the output was truncated to fit the character budget. For the full content, use a smaller batch or compact mode.'),
			);
		}

		return textResult([...summary, '', ...sections].join('\n\n'));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ReadBlockInput>,
	): Promise<vscode.PreparedToolInvocation> {
		const count = Array.isArray(options.input.blockIds) ? options.input.blockIds.length : 0;
		return {
			invocationMessage: t('Reading {0} block references', count),
		};
	}
}
