/**
 * 文档链接：让渲染后的块引用变成真正可 Ctrl+Click 的链接。
 *
 * 为什么需要它：
 * 行内渲染把 `((uuid))` 显示成了「目标块标题」，视觉上已经像链接，
 * 但装饰器的 attachment 是纯视觉元素，VS Code 不提供任何点击回调。
 * DocumentLink 是唯一能把文本范围变成可点击链接的官方 API，
 * 交互方式也与用户对链接的预期一致（Ctrl+Click，悬停时显示下划线）。
 *
 * 链接目标用 command URI，点击后执行「展开全文」——
 * 这正是用户想要的行为：看到标题，想看全部就点它。
 *
 * 与 DefinitionProvider 的分工：
 * - Ctrl+Click → 展开全文（本文件）
 * - F12          → 跳到目标块所在位置（definitionProvider.ts）
 */

import * as vscode from 'vscode';

import type { GraphIndex } from '../core/graphIndex';
import { locateAllReferences } from '../core/refLocator';
import { encodeCommandArgs } from './tools/common';

export class BlockReferenceDocumentLinkProvider implements vscode.DocumentLinkProvider {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
	) {}

	async provideDocumentLinks(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.DocumentLink[]> {
		// 只处理真实文件：展开出来的只读虚拟文档里不再重复加链接，
		// 否则用户点开一份展开内容后，里面又是满屏可点链接，容易迷路。
		if (document.languageId !== 'markdown' || document.uri.scheme !== 'file') {
			return [];
		}

		await this.ensureReady();
		if (token.isCancellationRequested) {
			return [];
		}

		const index = this.getIndex();
		const links: vscode.DocumentLink[] = [];

		for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
			const lineText = document.lineAt(lineNumber).text;
			// 快速跳过：绝大多数行不含块引用，没必要做正则。
			if (!lineText.includes('((') && !lineText.includes('（（')) {
				continue;
			}

			for (const reference of locateAllReferences(lineText)) {
				// 只给「能解析到目标块」的引用加链接；
				// 悬空引用点了也没内容，加链接反而是误导。
				if (index.lookupBlocks(reference.uuid).length === 0) {
					continue;
				}

				const link = new vscode.DocumentLink(
					new vscode.Range(lineNumber, reference.start, lineNumber, reference.end),
					vscode.Uri.parse(
						`command:blockReferenceInterpreter.expandBlockById?${encodeCommandArgs([reference.uuid])}`,
					),
				);
				// tooltip 会作为独立一行显示在悬停内容末尾。
				// 提示文字已经写进悬停里的按钮行了，这里不再重复，
				// 但又不能留空——空值会让 VS Code 回退显示 `command:...` 原始 URI，更难看。
				link.tooltip = ' ';
				links.push(link);
			}
		}

		return links;
	}
}
