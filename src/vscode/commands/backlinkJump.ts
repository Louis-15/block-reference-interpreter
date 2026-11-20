/**
 * 反链的跳转命令。
 *
 * 从悬停列表点页面名时会调用 `openBacklinkAt`：直接打开那个笔记文件，
 * 把光标放到引用所在行并滚动到视野中央。
 *
 * 为什么不复用现有的 `showBacklinks`（QuickPick）：那条路径要用户
 * 先在列表里选一次，而悬停列表里用户已经"选"过了——再弹一次是多余的。
 */

import * as vscode from 'vscode';

/**
 * 打开某文件的指定行。
 *
 * @param targetPath 目标文件绝对路径
 * @param line 0-based 行号
 */
export async function openBacklinkAt(targetPath: string, line: number): Promise<void> {
	if (!targetPath) {
		return;
	}

	const safeLine = Math.max(0, line);

	let document: vscode.TextDocument;
	try {
		document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
	} catch {
		// 文件可能刚被删掉，或路径来自旧索引。
		void vscode.window.showWarningMessage(`无法打开文件：${targetPath}（可能已被移动或删除）`);
		return;
	}

	const editor = await vscode.window.showTextDocument(document, { preview: false });

	// 文档可能比记忆中的行号短（文件在索引之后被删减过），越界时夹到末行。
	const lineIndex = Math.min(safeLine, Math.max(0, document.lineCount - 1));
	const position = new vscode.Position(lineIndex, 0);

	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(
		new vscode.Range(position, position),
		vscode.TextEditorRevealType.InCenterIfOutsideViewport,
	);
}
