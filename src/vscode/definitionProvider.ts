/**
 * 跳转到定义：把 `((uuid))` 变成「可跳转的引用」。
 *
 * 用户按 F12 或在引用上 Ctrl+Click，直接跳到目标块所在文件与行。
 * 这是行内渲染的配套功能——视觉上引用已经是「那个块的内容」了，
 * 那就应该像超链接一样点得进去。
 *
 * 关于定位容差：
 * 行内渲染会把原文 `((uuid))` 的字符宽度压成 0，视觉上显示的是叠加的替换文本。
 * 用户点在那段替换文本上时，VS Code 换算出的字符偏移可能落在引用范围之后。
 * 因此这里采用「优先精确命中，否则取同行最近的引用」的策略，
 * 牺牲一点精确性换取可用性——否则用户会觉得"点了没反应"。
 */

import * as vscode from 'vscode';

import type { GraphIndex } from '../core/graphIndex';
import { locateAllReferences, locateReferenceAt } from '../core/refLocator';

export class BlockReferenceDefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
	) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[] | undefined> {
		if (document.languageId !== 'markdown' || document.uri.scheme !== 'file') {
			return undefined;
		}

		const lineText = document.lineAt(position.line).text;

		// 先精确命中：光标真正落在 ((uuid)) 覆盖的字符上。
		let uuid = locateReferenceAt(lineText, position.character)?.uuid;

		// 退化：同一行上取距离最近的引用（应对"点在替换文本上"的情况）。
		if (!uuid) {
			uuid = findNearestReference(lineText, position.character);
		}

		if (!uuid) {
			return undefined;
		}

		await this.ensureReady();
		if (token.isCancellationRequested) {
			return undefined;
		}

		const candidates = this.getIndex().lookupBlocks(uuid);
		if (candidates.length === 0) {
			// 悬空引用没有定义可跳，返回 undefined 让 VS Code 自己处理。
			return undefined;
		}

		return candidates.map((candidate) => {
			const block = candidate.parsed.blocks[candidate.blockIndex];
			const line = block?.startLine ?? 0;
			const range = new vscode.Range(line, 0, line, 0);
			return new vscode.Location(vscode.Uri.file(candidate.location.path), range);
		});
	}
}

/**
 * 在一行内找距离指定列最近的引用。
 *
 * 阈值 120 字符是经验值：替换文本一般不会比原文长太多，
 * 设太大反而会误命中同行另一个无关引用。
 */
function findNearestReference(line: string, character: number): string | undefined {
	const all = locateAllReferences(line);
	if (all.length === 0) {
		return undefined;
	}

	let best: { uuid: string; distance: number } | undefined;
	for (const reference of all) {
		// 引用范围到目标列的最近距离（落在范围内距离为 0）。
		const distance =
			character < reference.start
				? reference.start - character
				: character >= reference.end
					? character - reference.end + 1
					: 0;
		if (!best || distance < best.distance) {
			best = { uuid: reference.uuid, distance };
		}
	}

	if (!best || best.distance > 120) {
		return undefined;
	}
	return best.uuid;
}
