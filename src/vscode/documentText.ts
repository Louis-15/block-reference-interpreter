/**
 * 编辑器实时文本与全库查重的共享工具。
 *
 * AI 写笔记时，内容往往还没保存：只查 `GraphIndex` 会看不到刚写的 `id::`
 * 或引用。这里统一「编辑器优先、磁盘兜底」，并让所有工具用同一套查重逻辑。
 */

import * as vscode from 'vscode';

import { parseMarkdown } from '../core/blockParser';
import type { GraphIndex } from '../core/graphIndex';
import type { ParsedFile } from '../core/types';
import { readFileText } from './indexService';

/** 按绝对路径查找已打开的文档。 */
export function findOpenDocument(filePath: string): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find(
		(document) => document.uri.scheme === 'file' && document.uri.fsPath === filePath,
	);
}

/**
 * 读取文件当前文本：已打开且有未保存修改时用编辑器内容，否则读磁盘。
 *
 * 返回 undefined 表示文件不存在或不可读；调用方负责给出可读错误。
 */
export async function readCurrentText(filePath: string): Promise<string | undefined> {
	const open = findOpenDocument(filePath);
	if (open) {
		return open.getText();
	}
	try {
		return await readFileText(filePath);
	} catch {
		return undefined;
	}
}

/**
 * 收集所有打开的 Markdown 文档的实时解析结果。
 *
 * 只遍历已打开文档，不扫描整个工作区：数量小、且正好覆盖「AI 刚写但未保存」
 * 的场景。路径统一用 `fsPath`，与 `GraphIndex` 的键保持一致。
 */
export function collectOpenMarkdownOverrides(): Map<string, ParsedFile> {
	const overrides = new Map<string, ParsedFile>();
	for (const document of vscode.workspace.textDocuments) {
		if (document.uri.scheme !== 'file' || document.languageId !== 'markdown') {
			continue;
		}
		overrides.set(
			document.uri.fsPath,
			parseMarkdown(document.uri.fsPath, document.getText()),
		);
	}
	return overrides;
}

/** 查重选项。 */
export interface TakenUuidOptions {
	/** 当前正在处理的文件解析结果；会覆盖索引中的旧版本。 */
	current?: ParsedFile;
	/** 当前文件路径；索引遍历时排除它。 */
	currentPath?: string;
	/** 已打开文档的实时解析结果。 */
	overrides?: Map<string, ParsedFile>;
}

/**
 * 收集全库已占用的 UUID。
 *
 * 三个来源缺一不可：
 * 1. 索引中的其他文件（已保存的历史内容）；
 * 2. 已打开文档的实时内容（AI 刚写、尚未保存的 ID）；
 * 3. 当前文件的实时解析结果（可能还没进索引）。
 *
 * 当前文件在索引中的旧版本必须排除，否则删掉的 ID 仍会被当成占用。
 */
export function collectTakenUuids(index: GraphIndex, options: TakenUuidOptions = {}): Set<string> {
	const { current, currentPath, overrides } = options;
	const taken = new Set<string>();

	for (const path of index.listFiles()) {
		if (currentPath && path === currentPath) {
			continue;
		}
		const parsed = overrides?.get(path) ?? index.getParsedFile(path);
		for (const uuid of parsed?.blocksById.keys() ?? []) {
			taken.add(uuid);
		}
	}

	for (const [path, parsed] of overrides ?? []) {
		if (currentPath && path === currentPath) {
			continue;
		}
		for (const uuid of parsed.blocksById.keys()) {
			taken.add(uuid);
		}
	}

	for (const uuid of current?.blocksById.keys() ?? []) {
		taken.add(uuid);
	}

	return taken;
}
