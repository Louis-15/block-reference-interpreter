/**
 * 展开相关命令。
 *
 * 三个入口共用同一套渲染逻辑，差异只在「展开范围」：
 * - 整篇笔记：把文件里所有块引用就地展开
 * - 光标处引用：只展开光标下的那一个
 * - 按 UUID：给悬停预览里的「展开全文」链接用
 *
 * 输出统一走「新建未保存标签页」，不是写文件。
 * 这样既能随手看，也不会污染笔记库或留下垃圾文件。
 */

import * as vscode from 'vscode';

import { parseMarkdown } from '../../core/blockParser';
import { buildExpandedNote } from '../../core/expandNote';
import type { GraphIndex } from '../../core/graphIndex';
import { resolveBlock } from '../../core/resolve';
import { readConfig } from '../indexService';
import { getBlockTitle } from '../../core/render';
import { locateReferenceAt } from '../../core/refLocator';
import { normalizeUuid } from '../tools/common';

/** 命令实现依赖的能力，集中传入便于测试与解耦。 */
export interface CommandDeps {
	getIndex: () => GraphIndex;
	ensureReady: () => Promise<void>;
	getGraphRoot: () => string | undefined;
	log: (message: string) => void;
}

/** 把文本作为未保存的 Markdown 文档打开。 */
async function openAsDocument(content: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
	await vscode.window.showTextDocument(document, { preview: false });
}

/** 展开单个 UUID，返回可直接展示的文本。 */
function expandOneBlock(index: GraphIndex, uuid: string): string {
	const config = readConfig();
	return resolveBlock(index, uuid, {
		maxDepth: config.maxDepth,
		maxChars: config.maxOutputChars,
		hideProperties: config.hideProperties,
	}).text;
}

/**
 * 命令：展开当前笔记为 AI 可读版。
 *
 * 用编辑器里的内容而不是磁盘内容：用户可能有未保存的修改，
 * 展开的应该是「他现在看到的这一版」。
 */
export async function expandCurrentNote(deps: CommandDeps): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'markdown') {
		void vscode.window.showWarningMessage('请先打开一个 Markdown 笔记文件。');
		return;
	}

	await deps.ensureReady();
	const index = deps.getIndex();
	const document = editor.document;
	const parsed = parseMarkdown(document.uri.fsPath, document.getText());

	if (parsed.references.length === 0) {
		void vscode.window.showInformationMessage('这篇笔记里没有块引用，无需展开。');
		return;
	}

	const expanded = buildExpandedNote(
		{ lines: parsed.lines, references: parsed.references },
		{
			includeHeader: true,
			fileName: document.fileName,
			resolve: (uuid) => expandOneBlock(index, uuid),
		},
	);

	await openAsDocument(expanded);
	void vscode.window.showInformationMessage(
		`已展开 ${parsed.references.length} 处块引用（新标签页，未保存文件）。`,
	);
}

/**
 * 命令：展开光标处的块引用。
 *
 * 光标不在块引用上时给出明确提示，而不是静默什么都不做——
 * 静默失败会让人以为插件坏了。
 */
export async function expandBlockAtCursor(deps: CommandDeps): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'markdown') {
		void vscode.window.showWarningMessage('请先打开一个 Markdown 笔记文件。');
		return;
	}

	const position = editor.selection.active;
	const lineText = editor.document.lineAt(position.line).text;
	const located = locateReferenceAt(lineText, position.character);

	if (!located) {
		void vscode.window.showWarningMessage(
			'光标不在块引用上。请把光标放到形如 ((uuid)) 的位置再执行，或改用「展开当前笔记」。',
		);
		return;
	}

	await expandBlockById(deps, located.uuid);
}

/**
 * 命令：按 UUID 展开单个块（供悬停预览的「展开全文」链接调用）。
 *
 * @param uuid 可以带 `(( ))` 包裹，会被规范化
 */
export async function expandBlockById(deps: CommandDeps, uuid?: string): Promise<void> {
	const raw = uuid ?? (await vscode.window.showInputBox({
		title: '展开块引用',
		prompt: '输入块 UUID（可带 (( )) 包裹）',
		placeHolder: '66c73a56-ddda-44d2-80dd-009e44406fd4',
		ignoreFocusOut: true,
	}));

	if (!raw) {
		return;
	}

	const normalized = normalizeUuid(raw);
	if (!normalized) {
		void vscode.window.showWarningMessage('UUID 为空，已取消。');
		return;
	}

	await deps.ensureReady();
	const text = expandOneBlock(deps.getIndex(), normalized);
	await openAsDocument(text);

	if (text.includes('未找到该 UUID')) {
		void vscode.window.showWarningMessage(`未找到块 ${normalized}，可能已被删除。`);
	}
}

/**
 * 命令：查看光标处块引用的反向链接。
 *
 * 光标不在引用上时，让用户手动粘贴 UUID，避免只能干等。
 */
export async function showBacklinksAtCursor(deps: CommandDeps): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const position = editor?.selection.active;

	let uuid: string | undefined;
	if (editor && position) {
		const lineText = editor.document.lineAt(position.line).text;
		uuid = locateReferenceAt(lineText, position.character)?.uuid;
	}

	await showBacklinks(deps, uuid);
}

/** 命令：查看指定 UUID 的反向链接。 */
export async function showBacklinks(deps: CommandDeps, uuid?: string): Promise<void> {
	let normalized = uuid ? normalizeUuid(uuid) : '';

	if (!normalized) {
		const raw = await vscode.window.showInputBox({
			title: '查看块的反向链接',
			prompt: '输入块 UUID（可带 (( )) 包裹）',
			placeHolder: '66c73a56-ddda-44d2-80dd-009e44406fd4',
			ignoreFocusOut: true,
		});
		if (!raw) {
			return;
		}
		normalized = normalizeUuid(raw);
	}

	if (!normalized) {
		return;
	}

	await deps.ensureReady();
	const index = deps.getIndex();
	const entries = index.findBacklinks(normalized);
	const definitions = index.lookupBlocks(normalized);

	if (entries.length === 0) {
		const detail = definitions.length === 0
			? '该 UUID 对应的块也不存在（可能已被删除）。'
			: '该块存在，但没有任何笔记引用它。';
		void vscode.window.showInformationMessage(`没有找到对 ${normalized} 的引用。${detail}`);
		return;
	}

	const items: Array<vscode.QuickPickItem & { target?: vscode.Uri; line?: number }> = entries.map((entry) => {
		const relative = vscode.workspace.asRelativePath(entry.path, false).replace(/\\/g, '/');
		const parsed = index.getParsedFile(entry.path);
		const block = parsed && entry.blockIndex >= 0 ? parsed.blocks[entry.blockIndex] : undefined;
		const context = block ? getBlockTitle(block.ownLines[0] ?? '') : entry.lineText.trim();

		return {
			label: `$(file) ${relative}:${entry.hit.line + 1}`,
			description: entry.hit.kind === 'embed' ? '嵌入引用' : '行内引用',
			detail: context.slice(0, 160),
			target: vscode.Uri.file(entry.path),
			line: entry.hit.line,
		};
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: `块 ${normalized} 的反向链接（${entries.length} 处）`,
		placeHolder: '选择一处引用即可跳转',
		matchOnDetail: true,
	});

	if (!picked?.target || picked.line === undefined) {
		return;
	}

	const document = await vscode.workspace.openTextDocument(picked.target);
	const targetEditor = await vscode.window.showTextDocument(document, { preview: false });
	const targetPosition = new vscode.Position(picked.line, 0);
	targetEditor.selection = new vscode.Selection(targetPosition, targetPosition);
	targetEditor.revealRange(
		new vscode.Range(targetPosition, targetPosition),
		vscode.TextEditorRevealType.InCenterIfOutsideViewport,
	);
}
