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
			return textResult('（调用已取消）');
		}

		const input = options.input;
		const rawIds = Array.isArray(input.blockIds) ? input.blockIds : [];
		const uuids = [...new Set(rawIds.map(normalizeUuid).filter((id) => id.length > 0))];

		if (uuids.length === 0) {
			return textResult('未收到有效的块 UUID。请传入形如 `66c73a56-ddda-44d2-80dd-009e44406fd4` 的 ID。');
		}
		if (uuids.length > 20) {
			return textResult(`一次最多查询 20 个 UUID，本次收到 ${uuids.length} 个。请分成多次调用。`);
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

		const summary: string[] = [`本次读取 ${uuids.length} 个块。`];
		if (missing.length > 0) {
			summary.push(`其中 ${missing.length} 个未找到：${missing.join('、')}。这些引用可能已失效。`);
		}
		if (ambiguous.length > 0) {
			summary.push(`其中 ${ambiguous.length} 个存在重复定义：${ambiguous.join('、')}。已列出全部候选。`);
		}
		if (results.some((result) => result.truncated)) {
			summary.push('部分输出因超出字符预算被截断，如需完整内容请用更小的 batch 或 compact 模式。');
		}

		return textResult([...summary, '', ...sections].join('\n\n'));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ReadBlockInput>,
	): Promise<vscode.PreparedToolInvocation> {
		const count = Array.isArray(options.input.blockIds) ? options.input.blockIds.length : 0;
		return {
			invocationMessage: `正在读取 ${count} 个块引用的内容`,
		};
	}
}
