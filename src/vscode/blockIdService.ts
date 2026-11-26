/**
 * 人工命令：复制当前块的引用 / 嵌入引用。
 *
 * 行为与 Tine 的「复制块引用」一致：
 * 1. 光标所在块没有 `id::` 时，先插入一行 `id::`；
 * 2. 保存文档（Tine 也是先落盘再复制，避免引用指向未保存的 ID）；
 * 3. 把 `((uuid))` 或 `{{embed ((uuid))}}` 写入剪贴板。
 *
 * 与 AI 路径的区别：这里是用户主动触发的，所以插件直接写文件；
 * AI 工具仍然只返回补丁，由 AI 自己的编辑工具落盘。
 */

import * as vscode from 'vscode';

import { findDeepestBlockAtLine, parseMarkdown } from '../core/blockParser';
import { formatBlockRef } from '../core/blockIdentity';
import type { GraphIndex } from '../core/graphIndex';
import { t } from '../core/i18n';
import { buildIdInsertionPlan } from '../core/idInsertion';
import { describeIdInsertionReject } from './blockRefMessages';
import { collectOpenMarkdownOverrides, collectTakenUuids } from './documentText';

/** 引用形态。 */
export type BlockRefKind = 'inline' | 'embed';

/** 人工命令依赖。 */
export interface BlockRefDeps {
	getIndex: () => GraphIndex;
	/** 文件是否在 include 范围内、且不在 exclude 范围内。 */
	isIndexedFile: (filePath: string) => boolean;
	ensureReady: () => Promise<void>;
	log: (message: string) => void;
}

function showError(message: string): void {
	void vscode.window.showErrorMessage(message);
}

function showWarning(message: string): void {
	void vscode.window.showWarningMessage(message);
}

/** 写剪贴板并给出成功提示；失败时明确报错。 */
async function copyToClipboard(text: string, kind: BlockRefKind): Promise<void> {
	try {
		await vscode.env.clipboard.writeText(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		showError(t('Failed to write to the clipboard: {0}', message));
		return;
	}

	void vscode.window.showInformationMessage(
		kind === 'embed' ? t('Block embed copied: {0}', text) : t('Block reference copied: {0}', text),
	);
}

/**
 * 复制当前块的引用。
 *
 * @param deps 索引与索引范围判断
 * @param kind `inline` 生成 `((uuid))`，`embed` 生成 `{{embed ((uuid))}}`
 */
export async function copyBlockReference(deps: BlockRefDeps, kind: BlockRefKind): Promise<void> {
	try {
		await deps.ensureReady();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		showError(t('Failed to build the block index: {0}', message));
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		showError(t('Open a Markdown note first.'));
		return;
	}
	const document = editor.document;

	// 虚拟文档（展开视图）和只读文档不能补 id::。
	if (document.uri.scheme !== 'file') {
		showError(t('This command only works on files on disk.'));
		return;
	}
	if (document.languageId !== 'markdown') {
		showError(t('This command only works on Markdown files.'));
		return;
	}
	try {
		// TextDocument 没有 isReadonly；只能问文件系统权限。
		// 权限查询失败时不阻断，交给 applyEdit / save 给出最终错误。
		const stat = await vscode.workspace.fs.stat(document.uri);
		if (((stat.permissions ?? 0) & vscode.FilePermission.Readonly) !== 0) {
			showError(t('This note is read-only.'));
			return;
		}
	} catch {
		// 忽略：部分文件系统不返回 permissions。
	}
	if (!deps.isIndexedFile(document.uri.fsPath)) {
		showError(t('This note is not in the indexed Tine graph.'));
		return;
	}

	const selection = editor.selection;
	if (!selection.isEmpty && selection.start.line !== selection.end.line) {
		void vscode.window.showInformationMessage(
			t('Multi-line selection is not supported yet; using the active line.'),
		);
	}

	const line = selection.active.line;
	const parsed = parseMarkdown(document.uri.fsPath, document.getText());
	const blockIndex = findDeepestBlockAtLine(parsed, line);
	const block = blockIndex >= 0 ? parsed.blocks[blockIndex] : undefined;
	if (!block) {
		showError(t('Line {0} is not inside a block.', line + 1));
		return;
	}

	const eol: '\n' | '\r\n' = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const taken = collectTakenUuids(deps.getIndex(), {
		current: parsed,
		currentPath: document.uri.fsPath,
		overrides: collectOpenMarkdownOverrides(),
	});

	const plan = buildIdInsertionPlan(parsed, blockIndex, {
		isUuidTaken: (uuid) => taken.has(uuid),
		tabSize: 4,
		eol,
	});

	if (plan.kind === 'reject') {
		deps.log(
			t(
				'[Copy] Rejected at {0}:{1} ({2})',
				document.uri.fsPath,
				block.startLine + 1,
				plan.reason,
			),
		);
		showError(describeIdInsertionReject(plan.reason, plan.detail));
		return;
	}

	if (plan.kind === 'existing') {
		const valid = plan.ids.find((id) => id.validUuid);
		if (!valid) {
			showError(
				t(
					'This block has no valid UUID: {0}. Fix its id:: first.',
					plan.ids.map((id) => id.value).join(', '),
				),
			);
			return;
		}

		await copyToClipboard(formatBlockRef(valid.value, kind), kind);

		if (plan.ids.some((id) => id.warnings.includes('multiple-ids'))) {
			showWarning(t('This block has multiple id:: properties; using {0}.', valid.value));
		}
		if (plan.ids.some((id) => id.warnings.includes('id-not-in-property-group'))) {
			showWarning(
				t(
					'This block has an id:: outside the property group. The reference may not work in Logseq.',
				),
			);
		}
		return;
	}

	/*
	 * 走到这里说明需要补 id::，会修改并保存文档。
	 * 文档可能包含 AI 刚写、尚未接受的编辑；保存会把它们一并落盘，
	 * 所以必须先明确提示一次，用户取消就完全不写。
	 */
	if (document.isDirty) {
		const confirm = t('Save and copy');
		const choice = await vscode.window.showWarningMessage(
			t('This note has unsaved changes. Saving will also save them. Continue?'),
			{ modal: true },
			confirm,
		);
		if (choice !== confirm) {
			deps.log(t('[Copy] Cancelled because the document has unsaved changes'));
			return;
		}
	}

	if (document.isClosed) {
		showError(t('The document was closed before the reference could be added.'));
		return;
	}

	const edit = new vscode.WorkspaceEdit();
	if (plan.line >= document.lineCount) {
		// 文件末尾且没有尾随换行：插到最后一行行尾，避免多出一个空行。
		const lastLine = document.lineAt(document.lineCount - 1);
		edit.insert(document.uri, lastLine.range.end, eol + plan.propertyLine);
	} else {
		edit.insert(document.uri, new vscode.Position(plan.line, 0), plan.propertyLine + eol);
	}

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		showError(t('Failed to apply the edit. The reference was not copied.'));
		return;
	}

	const saved = await document.save();
	if (!saved) {
		showError(t('Failed to save the note. The reference was not copied.'));
		return;
	}

	await copyToClipboard(formatBlockRef(plan.uuid, kind), kind);

	if (!plan.logseqCompatible) {
		showWarning(
			t(
				'Block copied, but this block starts with a code fence: id:: was placed after the closing fence. Logseq may not recognize it.',
			),
		);
	} else {
		void vscode.window.showInformationMessage(
			t('Block copied. Note: id:: was added and the file was saved.'),
		);
	}

	deps.log(
		t(
			'[Copy] Added id:: at {0}:{1} and copied the reference',
			document.uri.fsPath,
			plan.line + 1,
		),
	);
}
