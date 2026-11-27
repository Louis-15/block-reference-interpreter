/**
 * 工具：生成新的 Tine / Logseq 块 ID。
 *
 * 只生成 UUID 与文本片段，不写文件。AI 拿到 `id::` 行与引用文本后，
 * 用自己的编辑工具写入笔记；这样仍保留 Copilot 的接受/拒绝栏。
 */

import * as vscode from 'vscode';

import {
	formatBlockRef,
	formatIdPropertyLine,
	generateBlockUuid,
} from '../../core/blockIdentity';
import type { GraphIndex } from '../../core/graphIndex';
import { t } from '../../core/i18n';
import { collectOpenMarkdownOverrides, collectTakenUuids } from '../documentText';
import { textResult } from './common';

export interface NewIdInput {
	/** 需要几个新 ID，1–20，默认 1。 */
	count?: number;
	/** 可选标签，按顺序对应每个 UUID，降低 AI 把 UUID 对应错块的概率。 */
	labels?: string[];
}

export class NewIdTool implements vscode.LanguageModelTool<NewIdInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<NewIdInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		await this.ensureReady();
		if (token.isCancellationRequested) {
			return textResult(t('(call cancelled)'));
		}

		const rawCount = options.input.count ?? 1;
		const count = Math.max(1, Math.min(Math.floor(rawCount), 20));
		const labels = Array.isArray(options.input.labels) ? options.input.labels : [];

		// 已打开文档的实时内容也要算占用：AI 可能刚写了 id:: 但还没保存。
		const overrides = collectOpenMarkdownOverrides();
		const taken = collectTakenUuids(this.getIndex(), { overrides });

		const lines: string[] = [
			t('Fresh Tine/Logseq block IDs (UUID v4). No file was modified.'),
			'',
		];

		for (let index = 0; index < count; index++) {
			const uuid = generateBlockUuid({ isTaken: (value) => taken.has(value) });
			// 同一批里后续生成的 ID 也不能重复。
			taken.add(uuid);

			const label = labels[index]?.trim();
			lines.push(label ? t('{0}. {1}', index + 1, label) : t('{0}.', index + 1));
			lines.push(t('UUID: {0}', uuid));
			lines.push(
				t(
					'Property line (place it immediately under the block first line, two spaces deeper than the block bullet):',
				),
			);
			lines.push(`  ${formatIdPropertyLine(uuid)}`);
			lines.push(t('Inline reference:'));
			lines.push(`  ${formatBlockRef(uuid)}`);
			lines.push(t('Embed:'));
			lines.push(`  ${formatBlockRef(uuid, 'embed')}`);
			lines.push('');
		}

		lines.push(
			t('Placement rules:'),
			t('- Put id:: on its own line, immediately after the block first line.'),
			t('- Indent it two spaces deeper than the block bullet; keep tabs as tabs.'),
			t('- Put it before body text and child blocks.'),
			t(
				'- If the new block first line is a code fence (for example `- ```js`), put id:: after the closing fence and before child blocks; Logseq may not recognize it there.',
			),
			t(
				'- A reference only works at the start of a line or right after a space. When it follows text, put a space before `((` or `{{embed`; otherwise Tine / Logseq will not render it.',
			),
			t('- Do not make up UUIDs; always use the values returned by this tool.'),
		);

		return textResult(lines.join('\n'));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<NewIdInput>,
	): Promise<vscode.PreparedToolInvocation> {
		const count = options.input.count ?? 1;
		return {
			invocationMessage: t('Generating {0} new block IDs', count),
		};
	}
}
