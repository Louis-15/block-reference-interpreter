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
import { buildExpandedNote } from '../../core/expandNote';
import type { GraphIndex } from '../../core/graphIndex';
import { resolveBlock } from '../../core/resolve';
import { readFileText, readConfig } from '../indexService';
import { getBlockTitle } from '../../core/render';
import { normalizeFilePath, textResult, toDisplayPath, truncate } from './common';

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

/** 引用清单里一项的可读描述。 */
function describeReference(index: GraphIndex, uuid: string): string {
	const candidates = index.lookupBlocks(uuid);
	if (candidates.length === 0) {
		return `⚠ 目标块不存在（可能已删除）`;
	}
	const first = candidates[0];
	if (!first) {
		return `（块数据缺失）`;
	}
	const block = first.parsed.blocks[first.blockIndex];
	const title = block ? getBlockTitle(block.ownLines[0] ?? '') : '';
	const suffix = candidates.length > 1 ? `（另有 ${candidates.length - 1} 处重复定义）` : '';
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
			return textResult('（调用已取消）');
		}

		const input = options.input;
		if (!input.filePath || input.filePath.trim().length === 0) {
			return textResult('缺少 filePath 参数。请传入笔记的绝对路径或相对图谱根的路径，例如 `pages/某个笔记.md`。');
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
				`无法读取文件：${absolutePath}\n` +
					`请确认路径是否正确。图谱根目录是：${graphRoot ?? '（未识别）'}`,
			);
		}

		const parsed = parseMarkdown(absolutePath, content);
		const displayPath = toDisplayPath(absolutePath, graphRoot);
		const header = [
			`# 笔记：${displayPath}`,
			`原文 ${parsed.lines.length} 行，共 ${parsed.references.length} 处块引用。`,
		].join('\n');

		const parts: string[] = [header];

		if (mode === 'list' || mode === 'both') {
			const listLines = parsed.references.map(
				(hit) =>
					`- 第 ${hit.line + 1} 行 \`${hit.uuid}\` ${describeReference(index, hit.uuid)}`,
			);
			parts.push(
				listLines.length > 0
					? `## 块引用清单\n\n${listLines.join('\n')}`
					: '## 块引用清单\n\n（本文件没有块引用）',
			);
		}

		if (mode === 'expand' || mode === 'both') {
			const expanded = buildExpandedNote(
				{ lines: parsed.lines, references: parsed.references },
				{
					includeHeader: false,
					fileName: displayPath,
					resolve: (uuid) =>
						resolveBlock(index, uuid, {
							includeChildren: input.includeChildren ?? true,
							maxDepth: input.maxDepth ?? config.maxDepth,
							maxChars: config.maxOutputChars,
							hideProperties: config.hideProperties,
						}).text,
				},
			);
			parts.push(`## 展开内容\n\n${expanded}`);
		}

		// 整篇展开可能很长，最后再兜一层总长限制。
		return textResult(truncate(parts.join('\n\n'), config.maxOutputChars * 2));
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
			invocationMessage: `正在读取笔记并展开块引用：${options.input.filePath}`,
		};
	}
}
