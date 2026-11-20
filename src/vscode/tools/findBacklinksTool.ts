/**
 * 工具：查询块的反向链接。
 *
 * 等价于 Tine 的 `tine refs --block <uuid>`，但走内存索引，
 * 在 Windows 上可用（Tine 自己的 CLI 读命令在该平台不可用）。
 */

import * as vscode from 'vscode';

import type { GraphIndex } from '../../core/graphIndex';
import { getBlockTitle } from '../../core/render';
import { normalizeUuid, textResult, toDisplayPath } from './common';

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
			return textResult('（调用已取消）');
		}

		const uuid = normalizeUuid(options.input.blockId ?? '');
		if (!uuid) {
			return textResult('缺少 blockId 参数。请传入块的 UUID，例如 `66c73a56-ddda-44d2-80dd-009e44406fd4`。');
		}

		const index = this.getIndex();
		const graphRoot = this.getGraphRoot();
		const limit = Math.max(1, Math.min(options.input.limit ?? 50, 200));

		const backlinks = index.findBacklinks(uuid);
		const definitions = index.lookupBlocks(uuid);

		const lines: string[] = [];
		lines.push(`# 块 \`${uuid}\` 的反向链接`);

		if (definitions.length === 0) {
			lines.push('', '⚠ 该 UUID 对应的块不存在（可能已被删除）。以下引用均为悬空引用。');
		} else if (definitions.length > 1) {
			lines.push('', `⚠ 该 UUID 在 ${definitions.length} 处重复定义，引用可能指向其中任意一个。`);
		} else {
			const first = definitions[0];
			if (first) {
				const block = first.parsed.blocks[first.blockIndex];
				const title = block ? getBlockTitle(block.ownLines[0] ?? '') : '';
				lines.push(
					'',
					`定义位置：\`${toDisplayPath(first.location.path, graphRoot)}\` 第 ${(block?.startLine ?? 0) + 1} 行`,
					`块内容首行：${title}`,
				);
			}
		}

		if (backlinks.length === 0) {
			lines.push('', '没有任何笔记引用这个块。');
			return textResult(lines.join('\n'));
		}

		lines.push('', `## 引用位置（共 ${backlinks.length} 处，显示前 ${Math.min(limit, backlinks.length)} 处）`, '');

		for (const entry of backlinks.slice(0, limit)) {
			const displayPath = toDisplayPath(entry.path, graphRoot);
			const parsed = index.getParsedFile(entry.path);
			const containingBlock = parsed && entry.blockIndex >= 0 ? parsed.blocks[entry.blockIndex] : undefined;
			const context = containingBlock ? getBlockTitle(containingBlock.ownLines[0] ?? '') : entry.lineText.trim();

			lines.push(
				`- \`${displayPath}\` 第 ${entry.hit.line + 1} 行（${entry.hit.kind === 'embed' ? '嵌入引用' : '行内引用'}）`,
				`  所在块：${context.slice(0, 120)}`,
			);
		}

		if (backlinks.length > limit) {
			lines.push('', `（还有 ${backlinks.length - limit} 处未显示，可用 limit 参数扩大范围，上限 200）`);
		}

		return textResult(lines.join('\n'));
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: '正在查询块的反向链接' };
	}
}
