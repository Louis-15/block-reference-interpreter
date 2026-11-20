/**
 * 只读虚拟文档的可点击链接。
 *
 * 为什么需要单独的 DocumentLinkProvider：
 * 反链面板是在**纯文本编辑器**里打开的只读 .md。文本编辑器不会把
 * `[文字](command:...)` 渲染成可点击链接——那套 Markdown 语法只在
 * Markdown 预览里生效，写进正文反而会把一长串 URI 糊在用户眼前。
 *
 * `DocumentLink` 是 VS Code 专门为这种情况提供的机制：
 * 由一个 Range 指定哪几个字符变成链接，正文本身完全不受影响。
 *
 * 交互上：编辑器里的链接遵循 VS Code 统一规则，**Ctrl + 单击**才触发，
 * 目的是防止用户点光标或拖选文字时误跳转。
 */

import * as vscode from 'vscode';

import type { ReadOnlyContentProvider } from './readOnlyContent';

export class VirtualDocumentLinkProvider implements vscode.DocumentLinkProvider {
	constructor(private readonly provider: ReadOnlyContentProvider) {}

	provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
		const specs = this.provider.getLinks(document.uri);
		if (!specs || specs.length === 0) {
			return [];
		}

		const links: vscode.DocumentLink[] = [];

		for (const spec of specs) {
			// 文档可能比登记的坐标短（理论上不会，但索引来自另一时刻的数据）。
			// 越界就跳过这一条，不能让整个 provider 抛错导致所有链接失效。
			if (spec.line < 0 || spec.line >= document.lineCount) {
				continue;
			}
			const lineLength = document.lineAt(spec.line).text.length;
			if (spec.startColumn < 0 || spec.endColumn > lineLength) {
				continue;
			}

			const range = new vscode.Range(spec.line, spec.startColumn, spec.line, spec.endColumn);

			/*
			 * target 用 `command:` URI 而不是文件 URI：
			 * 跳转需要「打开文件 + 定位行 + 滚动到视野」三步，
			 * 光有文件 URI 只能打开文件、停在第一行。
			 */
			const encodedArgs = encodeURIComponent(JSON.stringify(spec.arguments));
			const target = vscode.Uri.parse(`command:${spec.command}?${encodedArgs}`);

			const link = new vscode.DocumentLink(range, target);
			if (spec.tooltip) {
				link.tooltip = spec.tooltip;
			}

			links.push(link);
		}

		return links;
	}
}
