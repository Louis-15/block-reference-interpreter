/**
 * 回车 / 块内换行：让 VS Code 的编辑手感对齐 Tine / Logseq。
 *
 * 两个入口：
 * - 回车：拦截全局 `type` 命令里的换行字符；
 * - Shift+Enter：注册独立命令，并在 package.json 里绑定快捷键。
 *
 * 为什么必须拦截 `type`：VS Code 没有「编辑器按键事件」API，
 * `type` 是唯一能在字符真正插入文档前插手的地方。拦截时必须保证：
 * - 判断是同步的（解析结果按文档版本缓存），否则输入会明显延迟；
 * - 任何不满足条件的情况都立刻回退到默认行为，绝不吞掉普通输入。
 */

import * as vscode from 'vscode';

import { parseMarkdown } from '../core/blockParser';
import { buildBlockEnterPlan, buildSoftBreakPlan } from '../core/blockSplit';
import { t } from '../core/i18n';
import type { ParsedFile } from '../core/types';
import { readConfig } from './indexService';

/** Shift+Enter 命令 ID；package.json 的 keybindings 必须与之一致。 */
export const SOFT_BREAK_COMMAND = 'blockReferenceInterpreter.insertSoftBreak';

/** 依赖：只需要知道文件是否在索引范围内，以及日志出口。 */
export interface EnterBehaviorDeps {
	isIndexedFile: (filePath: string) => boolean;
	log: (message: string) => void;
}

interface ParseCacheEntry {
	version: number;
	parsed: ParsedFile;
}

/**
 * 注册回车与块内换行。
 *
 * @returns 释放函数；扩展停用时必须调用，否则 `type` 命令会继续指向旧实现。
 */
export function registerEnterBehavior(deps: EnterBehaviorDeps): vscode.Disposable {
	const cache = new Map<string, ParseCacheEntry>();

	const getParsed = (document: vscode.TextDocument): ParsedFile => {
		const key = document.uri.toString();
		const cached = cache.get(key);
		if (cached && cached.version === document.version) {
			return cached.parsed;
		}
		const parsed = parseMarkdown(document.uri.fsPath, document.getText());
		cache.set(key, { version: document.version, parsed });
		if (cache.size > 20) {
			const firstKey = cache.keys().next().value;
			if (firstKey !== undefined) {
				cache.delete(firstKey);
			}
		}
		return parsed;
	};

	/** 该编辑器是否应当由本插件接管（只有 Tine 图谱里的 Markdown）。 */
	const shouldHandle = (editor: vscode.TextEditor | undefined): editor is vscode.TextEditor => {
		if (!editor) {
			return false;
		}
		const document = editor.document;
		if (document.languageId !== 'markdown' || document.uri.scheme !== 'file') {
			return false;
		}
		if (!readConfig().enterSplitBlock) {
			return false;
		}
		return deps.isIndexedFile(document.uri.fsPath);
	};

	const typeCommand = vscode.commands.registerCommand('type', async (args: { text?: string }) => {
		if (args?.text === '\n' && tryEnterBlock(getParsed, shouldHandle, deps)) {
			return;
		}
		await vscode.commands.executeCommand('default:type', args);
	});

	const softBreakCommand = vscode.commands.registerCommand(SOFT_BREAK_COMMAND, async () => {
		if (!trySoftBreak(getParsed, shouldHandle, deps)) {
			// 不是 Tine 笔记、或当前上下文不该接管时，恢复 VS Code 原生 Shift+Enter。
			await vscode.commands.executeCommand('editor.action.insertLineAfter');
		}
	});

	return {
		dispose(): void {
			cache.clear();
			typeCommand.dispose();
			softBreakCommand.dispose();
		},
	};
}

/** 取当前编辑器、判断是否接管、并解析文档；任一步不满足就返回 undefined。 */
function prepare(
	getParsed: (document: vscode.TextDocument) => ParsedFile,
	shouldHandle: (editor: vscode.TextEditor | undefined) => editor is vscode.TextEditor,
	deps: EnterBehaviorDeps,
): { editor: vscode.TextEditor; parsed: ParsedFile } | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!shouldHandle(editor)) {
		return undefined;
	}
	// 有选区时交回默认行为，避免吞掉用户选中的文本。
	if (!editor.selection.isEmpty) {
		return undefined;
	}

	try {
		return { editor, parsed: getParsed(editor.document) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.log(t('[Enter] Parsing failed, falling back to the default behaviour: {0}', message));
		return undefined;
	}
}

/** 尝试拆块。返回值表示是否已处理。 */
function tryEnterBlock(
	getParsed: (document: vscode.TextDocument) => ParsedFile,
	shouldHandle: (editor: vscode.TextEditor | undefined) => editor is vscode.TextEditor,
	deps: EnterBehaviorDeps,
): boolean {
	const prepared = prepare(getParsed, shouldHandle, deps);
	if (!prepared) {
		return false;
	}
	const { editor, parsed } = prepared;
	const position = editor.selection.active;

	const plan = buildBlockEnterPlan(parsed, position.line, position.character, {
		hasSelection: false,
	});

	if (plan.kind === 'reject') {
		// 不满足条件时静默放行，避免每次在代码块/表格里回车都刷日志。
		return false;
	}

	if (plan.kind === 'plain-newline') {
		const target = plan.atLineEnd
			? editor.document.lineAt(position.line).range.end
			: position;
		applyInsert(editor, target, plan.insertText, deps, t('[Enter] Failed to insert a newline'));
		return true;
	}

	// 立刻返回 true，避免 default:type 再插入一个换行；
	// edit 是异步的，但用户感知的是最终结果。
	applyInsert(editor, position, plan.insertText, deps, t('[Enter] Failed to insert a new block'));
	return true;
}

/** 执行一次插入编辑。 */
function applyInsert(
	editor: vscode.TextEditor,
	position: vscode.Position,
	insertText: string,
	deps: EnterBehaviorDeps,
	failureMessage: string,
): void {
	void editor
		.edit(
			(builder) => {
				builder.insert(position, insertText);
			},
			{ undoStopBefore: true, undoStopAfter: false },
		)
		.then((applied) => {
			if (!applied) {
				deps.log(failureMessage);
			}
		});
}

/** 尝试块内换行。返回值表示是否已处理。 */
function trySoftBreak(
	getParsed: (document: vscode.TextDocument) => ParsedFile,
	shouldHandle: (editor: vscode.TextEditor | undefined) => editor is vscode.TextEditor,
	deps: EnterBehaviorDeps,
): boolean {
	const prepared = prepare(getParsed, shouldHandle, deps);
	if (!prepared) {
		return false;
	}
	const { editor, parsed } = prepared;
	const position = editor.selection.active;

	const plan = buildSoftBreakPlan(parsed, position.line, position.character, {
		hasSelection: false,
	});

	if (plan.kind === 'reject') {
		return false;
	}

	if (plan.kind === 'plain-newline') {
		const target = plan.atLineEnd
			? editor.document.lineAt(position.line).range.end
			: position;
		applyInsert(editor, target, plan.insertText, deps, t('[Enter] Failed to insert a newline'));
		return true;
	}

	applyInsert(editor, position, plan.insertText, deps, t('[Enter] Failed to insert a soft line break'));
	return true;
}
