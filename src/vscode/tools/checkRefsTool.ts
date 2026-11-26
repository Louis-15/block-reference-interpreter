/**
 * 工具：校验一篇笔记的块 ID 与引用。
 *
 * 只读：返回错误/警告清单，不修改任何文件。AI 应用补丁后调用它，
 * 有错误就先修，再继续写笔记。
 */

import * as vscode from 'vscode';

import type { GraphIndex } from '../../core/graphIndex';
import { t } from '../../core/i18n';
import { parseMarkdown } from '../../core/blockParser';
import { auditReferences, type RefAuditIssue } from '../../core/refAudit';
import { readCurrentText } from '../documentText';
import { normalizeFilePath, normalizeUuid, textResult, toDisplayPath } from './common';

export interface CheckRefsInput {
	/** 笔记文件路径；相对路径按图谱根解析。 */
	filePath: string;
	/** 只检查这些 UUID 的引用；不传则检查全部。 */
	blockIds?: string[];
}

/** 把问题列表渲染成紧凑的文本。 */
function renderIssues(title: string, issues: RefAuditIssue[], graphRoot: string | undefined): string[] {
	if (issues.length === 0) {
		return [];
	}

	const sorted = [...issues].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	const lines = [title];
	for (const issue of sorted) {
		const location =
			issue.path && issue.path.length > 0
				? `${toDisplayPath(issue.path, graphRoot)}:${(issue.line ?? 0) + 1}`
				: issue.line !== undefined
					? `${(issue.line ?? 0) + 1}`
					: '';
		lines.push(`- ${location ? `${location} ` : ''}[${issue.code}] ${issue.message}`);
	}
	lines.push('');
	return lines;
}

export class CheckRefsTool implements vscode.LanguageModelTool<CheckRefsInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CheckRefsInput>,
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

		const graphRoot = this.getGraphRoot();
		const absolutePath = normalizeFilePath(input.filePath, graphRoot);
		const content = await readCurrentText(absolutePath);
		if (content === undefined) {
			return textResult(
				t('Cannot read file: {0}\nCheck that the path is correct. The graph root is: {1}', absolutePath, graphRoot ?? t('(not detected)')),
			);
		}

		const parsed = parseMarkdown(absolutePath, content);
		const blockIds = Array.isArray(input.blockIds)
			? input.blockIds.map((value) => normalizeUuid(value)).filter((value) => value.length > 0)
			: undefined;

		// 当前文件以实时文本为准；其他文件仍查索引。
		const result = auditReferences(parsed, this.getIndex(), {
			blockIds,
			tabSize: 4,
		});

		const displayPath = toDisplayPath(absolutePath, graphRoot);
		const header = result.ok
			? t('Audit of {0}: OK', displayPath)
			: t(
					'Audit of {0}: {1} error(s), {2} warning(s)',
					displayPath,
					result.errors.length,
					result.warnings.length,
				);

		const lines: string[] = [header, ''];
		lines.push(...renderIssues(t('Errors:'), result.errors, graphRoot));
		lines.push(...renderIssues(t('Warnings:'), result.warnings, graphRoot));
		lines.push(
			t(
				'Summary: {0} reference(s), {1} block ID(s), {2} malformed reference(s).',
				result.referenceCount,
				result.idCount,
				result.malformedCount,
			),
		);

		return textResult(lines.join('\n').trimEnd());
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: t('Checking block IDs and references') };
	}
}
