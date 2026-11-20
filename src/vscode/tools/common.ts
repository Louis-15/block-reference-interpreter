/**
 * Language Model Tool 的公共工具函数。
 *
 * 工具拿到的输入来自模型的自然语言推断，不能假设格式规整：
 * 模型可能把 UUID 写成 `((...))`、可能带引号、可能给相对路径。
 * 这里统一做规范化，避免每个工具各写一套。
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

/** 把工具结果包成 VS Code 能识别的文本结果。 */
export function textResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * 规范化块 UUID。
 *
 * 接受这些写法：
 * - `66c73a56-ddda-44d2-80dd-009e44406fd4`
 * - `((66c73a56-ddda-44d2-80dd-009e44406fd4))`
 * - `（（66c73a56-...））`（全角）
 * - 带首尾引号或空白
 */
export function normalizeUuid(input: string): string {
	let value = input.trim();
	value = value.replace(/^["'`]+|["'`]+$/g, '');

	// 成对剥掉半角/全角括号，最多剥一层。
	if (value.startsWith('((') && value.endsWith('))')) {
		value = value.slice(2, -2);
	} else if (value.startsWith('（（') && value.endsWith('））')) {
		value = value.slice(2, -2);
	}

	return value.trim().toLowerCase();
}

/**
 * 规范化文件路径。
 *
 * 模型有时给绝对路径，有时给「相对图谱根」的路径（如 `pages/xxx.md`），
 * 有时给 `[[页面名]]`。这里只处理路径形态，页面名解析不在本插件范围内。
 */
export function normalizeFilePath(input: string, graphRoot: string | undefined): string {
	let value = input.trim();
	value = value.replace(/^["']+|["']+$/g, '');

	if (path.isAbsolute(value)) {
		return path.normalize(value);
	}

	if (graphRoot) {
		return path.normalize(path.join(graphRoot, value));
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		return path.normalize(path.join(folder.uri.fsPath, value));
	}

	return path.normalize(value);
}

/** 把绝对路径转成「相对图谱根」的展示形式，输出给模型时更简洁。 */
export function toDisplayPath(absolutePath: string, graphRoot: string | undefined): string {
	if (!graphRoot) {
		return absolutePath.replace(/\\/g, '/');
	}
	const relative = path.relative(graphRoot, absolutePath).replace(/\\/g, '/');
	return relative.startsWith('..') ? absolutePath.replace(/\\/g, '/') : relative;
}

/** 截断过长文本，并明确告知被截断。 */
export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n\n（输出超过 ${maxChars} 字符上限，已截断）`;
}

/**
 * 把命令参数编码成 VS Code command URI 的 query 形式。
 *
 * VS Code 要求参数是 URI 编码后的 JSON 数组，否则点击链接会静默失败。
 */
export function encodeCommandArgs(args: unknown[]): string {
	return encodeURIComponent(JSON.stringify(args));
}
