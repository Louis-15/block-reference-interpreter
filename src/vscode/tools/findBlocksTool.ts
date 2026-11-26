/**
 * 工具：按标题/内容查找块。
 *
 * 用途：AI 想引用一个已有块时，先找到它的 UUID；没有 ID 的块则拿到
 * 文件 + 行号，再调用 `#blockMakeRef` 补 ID。
 *
 * 搜索会合并「索引中的其他文件」与「已打开文档的实时文本」，
 * 避免 AI 刚写的内容在搜索里看不见。
 */

import * as vscode from 'vscode';

import { searchBlocks } from '../../core/blockSearch';
import type { GraphIndex } from '../../core/graphIndex';
import { t } from '../../core/i18n';
import { readConfig } from '../indexService';
import { collectOpenMarkdownOverrides } from '../documentText';
import { normalizeFilePath, textResult, toDisplayPath } from './common';

export interface FindBlocksInput {
	/** 查询词；空格分隔多个词，全部命中才算匹配。 */
	query: string;
	/** 只搜索指定文件；相对路径按图谱根解析。 */
	filePath?: string;
	/** 最多返回多少条，默认 10，最大 30。 */
	limit?: number;
	/** 是否搜索块正文（`ownLines`），默认只搜索块首行。 */
	includeContent?: boolean;
}

export class FindBlocksTool implements vscode.LanguageModelTool<FindBlocksInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<FindBlocksInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		await this.ensureReady();
		if (token.isCancellationRequested) {
			return textResult(t('(call cancelled)'));
		}

		const query = typeof options.input.query === 'string' ? options.input.query.trim() : '';
		if (query.length === 0) {
			return textResult(
				t('The query parameter is missing. Pass a block title or a phrase from the block.'),
			);
		}

		const graphRoot = this.getGraphRoot();
		const targetPath = options.input.filePath
			? normalizeFilePath(options.input.filePath, graphRoot)
			: undefined;

		const candidates = searchBlocks(this.getIndex(), {
			query,
			filePath: targetPath,
			limit: options.input.limit ?? 10,
			includeContent: options.input.includeContent ?? false,
			pathDepth: readConfig().backlinkPathDepth,
			overrides: collectOpenMarkdownOverrides(),
		});

		if (candidates.length === 0) {
			return textResult(
				t('No block matched "{0}". Try a shorter query, or set includeContent: true to search block bodies.', query),
			);
		}

		const lines: string[] = [
			t('Found {0} candidate block(s) for "{1}".', candidates.length, query),
			'',
		];

		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index];
			if (!candidate) {
				continue;
			}
			const displayPath = toDisplayPath(candidate.path, graphRoot);
			lines.push(
				t(
					'{0}. {1}:{2}  block "{3}"',
					index + 1,
					displayPath,
					candidate.startLine + 1,
					candidate.title || t('(empty block)'),
				),
			);

			if (candidate.pathText) {
				lines.push(`   ${t('Path: {0}', candidate.pathText)}`);
			}
			lines.push(`   ${t('Subtree: {0} descendant block(s)', candidate.subtreeSize)}`);

			if (candidate.uuid) {
				lines.push(`   ${t('ID: {0}', candidate.uuid)}`);
			} else if (candidate.invalidId) {
				lines.push(
					`   ${t('Invalid ID: {0} (not a standard UUID; fix it before relying on it)', candidate.invalidId)}`,
				);
			} else {
				lines.push(
					`   ${t('No id:: yet. Call #blockMakeRef with this file and line to add one.')}`,
				);
			}

			if (candidate.matchedIn === 'content' && candidate.contentLine !== undefined) {
				lines.push(`   ${t('Matched in body at line {0}.', candidate.contentLine + 1)}`);
			}
			lines.push('');
		}

		return textResult(lines.join('\n').trimEnd());
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<FindBlocksInput>,
	): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: t('Searching blocks for "{0}"', options.input.query ?? ''),
		};
	}
}
