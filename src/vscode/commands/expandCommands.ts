/**
 * 展开相关命令。
 *
 * 三个入口共用同一套渲染逻辑，差异只在「展开范围」：
 * - 整篇笔记：把文件里所有块引用就地展开
 * - 光标处引用：只展开光标下的那一个
 * - 按 UUID：给悬停预览里的「展开全文」链接用
 *
 * 输出统一走**网页面板**（不写文件、不留垃圾）：
 * 每个块上方标出它来自哪篇笔记，点击即打开那篇笔记并跳到块的位置。
 *
 * 为什么从只读文本文档换成网页：
 * 文本文档里的链接必须 Ctrl + 单击才响应（VS Code 硬规则），
 * 而这里的来源链接是主要操作路径，必须能左键直接点。
 */

import * as vscode from 'vscode';

import { parseMarkdown } from '../../core/blockParser';
import { renderExpandHtml } from '../../core/expandHtml';
import { buildBlockExpandView, buildNoteExpandView } from '../../core/expandView';
import type { GraphIndex } from '../../core/graphIndex';
import { readConfig } from '../indexService';
import { getBlockTitle } from '../../core/render';
import { locateReferenceAt } from '../../core/refLocator';
import { normalizeUuid } from '../tools/common';
import { ReusableWebviewPanel } from '../reusableWebview';
import { openBacklinkAt } from './backlinkJump';
import type { ReadOnlyContentProvider } from '../readOnlyContent';

/** 展开全文面板的 Webview 类型（同类面板会被复用）。 */
const EXPAND_VIEW_TYPE = 'blockReferenceInterpreter.expandPanel';

/** 命令实现依赖的能力，集中传入便于测试与解耦。 */
export interface CommandDeps {
	getIndex: () => GraphIndex;
	ensureReady: () => Promise<void>;
	getGraphRoot: () => string | undefined;
	log: (message: string) => void;
	/** 只读虚拟文档提供者：反链的文本版面板仍用它。 */
	contentProvider: ReadOnlyContentProvider;
}

/** 统一入口：打开一个展开面板。 */
function showExpandPanel(
	deps: CommandDeps,
	title: string,
	view: ReturnType<typeof buildBlockExpandView>,
): void {
	ReusableWebviewPanel.show(
		EXPAND_VIEW_TYPE,
		title,
		(nonce) => renderExpandHtml(view, { nonce }).html,
		(path, line) => void openBacklinkAt(path, line),
	);
	deps.log(`[展开] 已打开：${title}`);
}

/**
 * 命令：展开当前笔记为可读版。
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
	const document = editor.document;
	const parsed = parseMarkdown(document.uri.fsPath, document.getText());

	if (parsed.references.length === 0) {
		void vscode.window.showInformationMessage('这篇笔记里没有块引用，无需展开。');
		return;
	}

	const config = readConfig();
	const view = buildNoteExpandView(
		deps.getIndex(),
		{
			path: document.uri.fsPath,
			lines: parsed.lines,
			references: parsed.references,
		},
		{
			graphRoot: deps.getGraphRoot(),
			maxDepth: config.maxDepth,
			hideProperties: config.hideProperties,
			stripHeading: config.renderStripHeadingMarks,
		},
	);

	showExpandPanel(deps, `${document.fileName} 展开`, view);
	void vscode.window.showInformationMessage(
		`已展开 ${parsed.references.length} 处块引用。`,
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
	const config = readConfig();
	const view = buildBlockExpandView(deps.getIndex(), normalized, {
		graphRoot: deps.getGraphRoot(),
		maxDepth: config.maxDepth,
		hideProperties: config.hideProperties,
		stripHeading: config.renderStripHeadingMarks,
	});

	showExpandPanel(deps, `块 ${normalized.slice(0, 8)}`, view);

	// 块不存在时给一条明确提示：网页里也有警告，但标签页可能被切到后台。
	const firstBlock = view.flow[0];
	if (firstBlock && firstBlock.type === 'block' && !firstBlock.block.source) {
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
