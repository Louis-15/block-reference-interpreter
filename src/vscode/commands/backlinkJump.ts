/**
 * 跳转到某个笔记位置。
 *
 * 被三处共用：反链面板的块名链接、反链悬停列表的页面名、展开全文的「来源」链接。
 *
 * 为什么跳转时要**选中整行**而不是只放一个光标：
 * 笔记本体是满屏白字，光标也是一条白色竖线，落进去几乎看不见。
 * 选中状态有整行蓝色背景，一眼就能确认「跳对了没有」。
 */

import * as vscode from 'vscode';

import { t } from '../../core/i18n';

/**
 * 打开某文件的指定行，并选中该行。
 *
 * @param targetPath 目标文件绝对路径
 * @param line 0-based 行号；会选中这一整行
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
		void vscode.window.showWarningMessage(
			t('Cannot open file: {0} (it may have been moved or deleted)', targetPath),
		);
		return;
	}

	const editor = await vscode.window.showTextDocument(document, { preview: false });

	// 文档可能比记忆中的行号短（文件在索引之后被删减过），越界时夹到末行。
	const lineIndex = Math.min(safeLine, Math.max(0, document.lineCount - 1));

	// 选中整行：从行首到行尾（不含换行符，否则会多带一行进选区）。
	const lineRange = document.lineAt(lineIndex).range;
	editor.selection = new vscode.Selection(lineRange.start, lineRange.end);

	// 先设置选区再显式滚动：只用 selection 时，若目标刚好在视野下沿，
	// VS Code 可能不滚动，用户仍看不到高亮。
	editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
