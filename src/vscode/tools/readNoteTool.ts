/**
 * 工具：读取整篇笔记并把块引用就地展开。
 *
 * 为什么需要它：AI 用内置读文件工具只能看到 `((uuid))` 原文。
 * 这个工具一次性返回「带完整上下文」的版本，让 AI 不必先读文件、再逐个查 UUID，
 * 少一次工具调用就少一轮等待，也避免模型忘记查引用。
 *
 * 全程只在内存里拼字符串，不写任何文件。
 */

import * as vscode from 'vscode';

import { parseMarkdown } from '../../core/blockParser';
import { buildExpandedNoteWithBudget } from '../../core/expandNote';
import type { GraphIndex } from '../../core/graphIndex';
import { resolveBlock } from '../../core/resolve';
import { readFileText, readConfig } from '../indexService';
import { getBlockTitle } from '../../core/render';
import { normalizeFilePath, textResult, toDisplayPath, truncate } from './common';
import { t } from '../../core/i18n';

export interface ReadNoteInput {
	/** 笔记文件路径；相对路径按图谱根解析。 */
	filePath: string;
	/**
	 * 输出模式：
	 * - `expand`（默认）整篇展开块引用
	 * - `list` 只列引用清单
	 * - `both` 两者都要
	 */
	mode?: 'expand' | 'list' | 'both';
	/** 是否包含子块，默认 true。 */
	includeChildren?: boolean;
	/** 嵌套引用展开深度；不传则用配置值。 */
	maxDepth?: number;
}

/**
 * 最终兜底截断时的额外余量。
 *
 * 内部预算已经把总量控制在 `maxOutputChars` 附近，但尾部那段
 * 「以下 N 处未展开」的提示必须保住——它一旦被切掉，
 * 模型就会误以为拿到的是完整内容，进而给出片面结论。
 */
const tailReserveMargin = 600;

/** 引用清单里一项的可读描述。 */
function describeReference(index: GraphIndex, uuid: string): string {
	const candidates = index.lookupBlocks(uuid);
	if (candidates.length === 0) {
		return t('⚠ The target block does not exist (it may have been deleted)');
	}
	const first = candidates[0];
	if (!first) {
		return t('(block data missing)');
	}
	const block = first.parsed.blocks[first.blockIndex];
	const title = block ? getBlockTitle(block.ownLines[0] ?? '') : '';
	const suffix = candidates.length > 1 ? t(' ({0} more duplicate definitions)', candidates.length - 1) : '';
	return `→ ${title}${suffix}`;
}

export class ReadNoteTool implements vscode.LanguageModelTool<ReadNoteInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReadNoteInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		await this.ensureReady();
		if (token.isCancellationRequested) {
			return textResult(t('(call cancelled)'));
		}

		const input = options.input;
		if (!input.filePath || input.filePath.trim().length === 0) {
			return textResult(
				t('The filePath parameter is missing. Pass the absolute path of the note, or a path relative to the graph root, for example `pages/some-note.md`.'),
			);
		}

		const graphRoot = this.getGraphRoot();
		const absolutePath = normalizeFilePath(input.filePath, graphRoot);
		const config = readConfig();
		const index = this.getIndex();
		const mode = input.mode ?? 'expand';

		// 如果这个文件正被打开且有未保存修改，优先用编辑器里的内容，
		// 因为用户问的通常是「他现在看到的这一版」。
		const content = await this.readContent(absolutePath);
		if (content === undefined) {
			return textResult(
				t('Cannot read file: {0}\n', absolutePath) +
					t('Check that the path is correct. The graph root is: {0}', graphRoot ?? t('(not detected)')),
			);
		}

		const parsed = parseMarkdown(absolutePath, content);
		const displayPath = toDisplayPath(absolutePath, graphRoot);
		const referenceCount = parsed.references.length;

		/**
		 * 引用多时自动附带清单。
		 *
		 * 理由：模型只看展开内容时，无法知道「还有哪些引用没展开」。
		 * 清单很短（每行几十字符），不会挤占多少预算，
		 * 却能让模型在需要时精准地再调 `blockRef`。
		 */
		const autoListThreshold = 8;
		const shouldList =
			mode === 'list' || mode === 'both' || (mode === 'expand' && referenceCount > autoListThreshold);

		const parts: string[] = [
			t('# Note: {0}', displayPath),
			t('{0} source lines, {1} block references in total.', parsed.lines.length, referenceCount),
		];

		if (shouldList) {
			const listLines = parsed.references.map(
				(hit) => t('- line {0} `{1}` {2}', hit.line + 1, hit.uuid, describeReference(index, hit.uuid)),
			);
			parts.push(
				listLines.length > 0
					? t('## Block reference list\n\n{0}', listLines.join('\n'))
					: t('## Block reference list\n\n(this file has no block references)'),
			);
		}

		let expandedInfo = '';
		if (mode === 'expand' || mode === 'both') {
			/**
			 * 预算要扣掉三部分：
			 * - 清单与头部已占用的字符
			 * - 尾部「未展开」提示的预留（否则最终兜底截断会把提示切掉，
			 *   模型就不知道内容是不完整的）
			 */
			const usedByHead = parts.join('\n\n').length + 200;
			const tailReserve = 600;
			const remainingBudget = Math.max(config.maxOutputChars - usedByHead - tailReserve, 2000);

			const result = buildExpandedNoteWithBudget(
				{ lines: parsed.lines, references: parsed.references },
				{
					includeHeader: false,
					fileName: displayPath,
					maxChars: remainingBudget,
					resolve: (uuid) =>
						resolveBlock(index, uuid, {
							includeChildren: input.includeChildren ?? true,
							maxDepth: input.maxDepth ?? config.maxDepth,
							// 单个块也给个上限，避免一篇笔记里有一个超大块就把预算吃光。
							maxChars: Math.min(remainingBudget, 8000),
							hideProperties: config.hideProperties,
						}).text,
				},
			);

			parts.push(t('## Expanded content\n\n{0}', result.text));

			if (result.skipped.length > 0) {
				expandedInfo =
					t('Expanded {0} references; {1} more were not expanded because of the output budget. ', result.expandedCount, result.skipped.length) +
					t('The full list is in the block reference list above; read them by UUID with blockRef when needed.');
			} else {
				expandedInfo = t('All {0} references were expanded.', result.expandedCount);
			}
		}

		if (expandedInfo) {
			parts.splice(2, 0, expandedInfo);
		}

		// 最终兜底：即使内部预算已控制，仍防一手极端情况（如单个块异常巨大）。
		return textResult(truncate(parts.join('\n\n'), config.maxOutputChars + tailReserveMargin));
	}

	/** 读文件内容：编辑器有未保存修改时用编辑器内容。 */
	private async readContent(absolutePath: string): Promise<string | undefined> {
		for (const document of vscode.workspace.textDocuments) {
			if (document.uri.fsPath === absolutePath) {
				return document.getText();
			}
		}

		try {
			return await readFileText(absolutePath);
		} catch {
			return undefined;
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ReadNoteInput>,
	): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: t('Reading the note and expanding block references: {0}', options.input.filePath),
		};
	}
}
