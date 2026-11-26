/**
 * 工具：为指定块生成「引用它」所需的 ID 与补丁。
 *
 * 这是 M2 的核心：AI 不需要自己猜 `id::` 该插在哪一行。工具返回
 * `uuid`、引用文本、精确的 `oldText/newText` 补丁（以及 unified diff 兜底），
 * 由 AI 用自己的编辑工具落盘，因此仍会出现 Copilot 的接受/拒绝栏。
 *
 * 不写文件。
 */

import * as vscode from 'vscode';

import { findDeepestBlockAtLine, parseMarkdown } from '../../core/blockParser';
import { formatBlockRef } from '../../core/blockIdentity';
import type { GraphIndex } from '../../core/graphIndex';
import { t } from '../../core/i18n';
import { buildIdInsertionPlan } from '../../core/idInsertion';
import { buildInsertionDiff } from '../../core/idInsertionPatch';
import { getBlockTitle } from '../../core/render';
import { describeIdInsertionReject } from '../blockRefMessages';
import { collectOpenMarkdownOverrides, collectTakenUuids, readCurrentText } from '../documentText';
import { normalizeFilePath, textResult, toDisplayPath } from './common';

export interface MakeRefInput {
	/** 笔记文件路径；相对路径按图谱根解析。 */
	filePath: string;
	/** 1-based 行号；块内任意行都可以，工具会取包含该行的最深块。 */
	line: number;
	/** 目标块首行文本（去掉 `- ` 后的标题，或原始首行），用于校验目标未变。 */
	expectedFirstLine: string;
	/** 引用形态，默认 inline。 */
	kind?: 'inline' | 'embed';
}

export class MakeRefTool implements vscode.LanguageModelTool<MakeRefInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<MakeRefInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		await this.ensureReady();
		if (token.isCancellationRequested) {
			return textResult(t('(call cancelled)'));
		}

		const input = options.input;
		if (!input.filePath || input.filePath.trim().length === 0) {
			return textResult(
				t('The filePath parameter is missing. Pass the note path, absolute or relative to the graph root.'),
			);
		}
		const expected = typeof input.expectedFirstLine === 'string' ? input.expectedFirstLine.trim() : '';
		if (expected.length === 0) {
			return textResult(
				t('The expectedFirstLine parameter is missing. Pass the target block first line so the tool can verify it.'),
			);
		}
		if (!Number.isFinite(input.line) || input.line < 1) {
			return textResult(t('The line parameter must be a 1-based line number.'));
		}

		const graphRoot = this.getGraphRoot();
		const absolutePath = normalizeFilePath(input.filePath, graphRoot);
		const content = await readCurrentText(absolutePath);
		if (content === undefined) {
			return textResult(
				t('Cannot read file: {0}\nCheck that the path is correct. The graph root is: {1}', absolutePath, graphRoot ?? t('(not detected)')),
			);
		}

		const parsed = parseMarkdown(absolutePath, content);
		const lineIndex = input.line - 1;
		if (lineIndex >= parsed.lines.length) {
			return textResult(
				t('Line {0} is beyond the end of the file ({1} lines).', input.line, parsed.lines.length),
			);
		}

		const blockIndex = findDeepestBlockAtLine(parsed, lineIndex);
		if (blockIndex < 0) {
			return textResult(
				t('Line {0} is not inside a block. Put the cursor inside the target block and retry.', input.line),
			);
		}

		const block = parsed.blocks[blockIndex];
		if (!block) {
			return textResult(t('No block was found at line {0}.', input.line));
		}

		const actualFirstLine = parsed.lines[block.startLine] ?? '';
		const actualTitle = getBlockTitle(actualFirstLine).trim();
		if (expected !== actualTitle && expected !== actualFirstLine.trim()) {
			return textResult(
				t(
					'Target mismatch at line {0}. Expected "{1}", but the block first line is "{2}". Re-read the file and retry with the exact first line.',
					block.startLine + 1,
					expected,
					actualTitle || actualFirstLine,
				),
			);
		}

		const kind = input.kind === 'embed' ? 'embed' : 'inline';
		const displayPath = toDisplayPath(absolutePath, graphRoot);

		const overrides = collectOpenMarkdownOverrides();
		const taken = collectTakenUuids(this.getIndex(), {
			current: parsed,
			currentPath: absolutePath,
			overrides,
		});

		const plan = buildIdInsertionPlan(parsed, blockIndex, {
			isUuidTaken: (uuid) => taken.has(uuid),
			tabSize: 4,
			// AI 补丁统一用 \n；这里不需要 document.eol。
			eol: '\n',
		});

		if (plan.kind === 'reject') {
			return textResult(
				t('Cannot create a reference for this block.\n{0}', describeIdInsertionReject(plan.reason, plan.detail)),
			);
		}

		if (plan.kind === 'existing') {
			const valid = plan.ids.find((id) => id.validUuid);
			if (!valid) {
				const values = plan.ids.map((id) => id.value).join(', ');
				return textResult(
					t(
						'This block already has an id::, but it is not a standard UUID: {0}. Fix the ID before referencing it.',
						values,
					),
				);
			}

			const warnings = [...new Set(plan.ids.flatMap((id) => id.warnings))];
			const lines = [
				t('File: {0}', displayPath),
				t('Target: line {0}, block "{1}"', block.startLine + 1, actualTitle || actualFirstLine),
				t('Existing ID: {0}', valid.value),
				t('Reference: {0}', formatBlockRef(valid.value, kind)),
			];
			if (warnings.length > 0) {
				lines.push(t('Warnings: {0}', warnings.join(', ')));
			}
			return textResult(lines.join('\n'));
		}

		const insertAfterLine = plan.line - 1;
		const diff = buildInsertionDiff(displayPath, parsed.lines, insertAfterLine, plan.propertyLine);
		const lines = [
			t('File: {0}', displayPath),
			t('Target: line {0}, block "{1}"', block.startLine + 1, actualTitle || actualFirstLine),
			t('New ID: {0}', plan.uuid),
			t('Reference: {0}', formatBlockRef(plan.uuid, kind)),
			t('Position: {0}', plan.position),
			t('Logseq compatible: {0}', plan.logseqCompatible ? t('yes') : t('no')),
			'',
			t('Patch (apply it with your own file editing tool; do not change anything else):'),
			'oldText:',
			plan.oldText,
			'newText:',
			plan.newText,
			'',
			t('Unified diff (fallback):'),
			diff,
			'',
			t(
				'Instructions: apply the patch, then write the reference with your editing tool, then call #blockCheck to verify the result.',
			),
		];

		if (plan.position === 'block-end') {
			lines.push(
				t(
					'Warning: this block starts with a code fence, so id:: is placed after the closing fence. Tine accepts this, but Logseq may not.',
				),
			);
		}

		return textResult(lines.join('\n'));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<MakeRefInput>,
	): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: t('Preparing a block reference for line {0}', options.input.line ?? 0),
		};
	}
}
