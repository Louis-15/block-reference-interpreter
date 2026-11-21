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
import { t } from '../../core/i18n';

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
	deps.log(t('[Expand] Opened: {0}', title));
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
		void vscode.window.showWarningMessage(t('Open a Markdown note file first.'));
		return;
	}

	await deps.ensureReady();
	const document = editor.document;
	const parsed = parseMarkdown(document.uri.fsPath, document.getText());

	if (parsed.references.length === 0) {
		void vscode.window.showInformationMessage(t('This note has no block references, nothing to expand.'));
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

	showExpandPanel(deps, t('{0} expansion', document.fileName), view);
	void vscode.window.showInformationMessage(
		t('Expanded {0} block references.', parsed.references.length),
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
		void vscode.window.showWarningMessage(t('Open a Markdown note file first.'));
		return;
	}

	const position = editor.selection.active;
	const lineText = editor.document.lineAt(position.line).text;
	const located = locateReferenceAt(lineText, position.character);

	if (!located) {
		void vscode.window.showWarningMessage(
			t('The cursor is not on a block reference. Place it on something like ((uuid)) and try again, or use "Expand Current Note" instead.'),
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
		title: t('Expand a block reference'),
		prompt: t('Enter a block UUID (a (( )) wrapper is accepted)'),
		placeHolder: '66c73a56-ddda-44d2-80dd-009e44406fd4',
		ignoreFocusOut: true,
	}));

	if (!raw) {
		return;
	}

	const normalized = normalizeUuid(raw);
	if (!normalized) {
		void vscode.window.showWarningMessage(t('The UUID is empty; cancelled.'));
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

	showExpandPanel(deps, t('Block {0}', normalized.slice(0, 8)), view);

	// 块不存在时给一条明确提示：网页里也有警告，但标签页可能被切到后台。
	const firstBlock = view.flow[0];
	if (firstBlock && firstBlock.type === 'block' && !firstBlock.block.source) {
		void vscode.window.showWarningMessage(t('Block {0} not found; it may have been deleted.', normalized));
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
			title: t('Show backlinks for a block'),
			prompt: t('Enter a block UUID (a (( )) wrapper is accepted)'),
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
			? t('The block for this UUID does not exist either (it may have been deleted).')
			: t('The block exists, but no note references it.');
		void vscode.window.showInformationMessage(
			t('No references found for {0}. {1}', normalized, detail),
		);
		return;
	}

	const items: Array<vscode.QuickPickItem & { target?: vscode.Uri; line?: number }> = entries.map((entry) => {
		const relative = vscode.workspace.asRelativePath(entry.path, false).replace(/\\/g, '/');
		const parsed = index.getParsedFile(entry.path);
		const block = parsed && entry.blockIndex >= 0 ? parsed.blocks[entry.blockIndex] : undefined;
		const context = block ? getBlockTitle(block.ownLines[0] ?? '') : entry.lineText.trim();

		return {
			label: `$(file) ${relative}:${entry.hit.line + 1}`,
			description: entry.hit.kind === 'embed' ? t('embedded reference') : t('inline reference'),
			detail: context.slice(0, 160),
			target: vscode.Uri.file(entry.path),
			line: entry.hit.line,
		};
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: t('Backlinks for block {0} ({1} references)', normalized, entries.length),
		placeHolder: t('Select a reference to jump to it'),
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
