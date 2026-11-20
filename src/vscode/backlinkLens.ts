/**
 * 反链 CodeLens：在块**上方**插入一行「N 条链接引用」。
 *
 * 默认不启用 —— 反链用 `backlinkInlay.ts` 的右侧徽章呈现（更贴近 Tine）。
 * 保留本模块的原因：InlayHint 受 VS Code 全局设置 `editor.inlayHints.enabled`
 * 控制，用户一旦关掉它就完全看不到反链，且没有任何提示。
 * 此时把 `tineBlockRef.backlinks.style` 切成 `lens` 仍能显示。
 */

import * as vscode from 'vscode';

import {
	BacklinkAnchorCache,
	formatAnchorTooltip,
	shouldShowBacklinks,
	type AnchorDeps,
} from './backlinkAnchors';
import { SHOW_BACKLINKS_PANEL_COMMAND } from './backlinkInlay';

export class BacklinkLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly anchors = new BacklinkAnchorCache();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private disposed = false;

	readonly onDidChangeCodeLenses = this.changeEmitter.event;

	constructor(
		private readonly deps: AnchorDeps,
		private readonly isEnabled: () => boolean,
	) {}

	refresh(): void {
		this.anchors.clear();
		this.changeEmitter.fire();
	}

	forgetDocument(uri: vscode.Uri): void {
		this.anchors.forget(uri);
	}

	async provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.CodeLens[]> {
		if (this.disposed || !this.isEnabled()) {
			return [];
		}
		if (!shouldShowBacklinks(document, this.deps)) {
			return [];
		}

		await this.deps.ensureReady();
		if (token.isCancellationRequested || this.disposed) {
			return [];
		}

		const lenses: vscode.CodeLens[] = [];
		for (const anchor of this.anchors.get(document, this.deps)) {
			// CodeLens 占用**块首行上方**的独立一行，因此 range 用该行的起点。
			const range = new vscode.Range(anchor.line, 0, anchor.line, 0);

			const parts = [`$(references) ${anchor.count} 条链接引用`];
			if (anchor.hitCount > anchor.count) {
				parts.push(`（共 ${anchor.hitCount} 次）`);
			}
			if (anchor.duplicate) {
				parts.push('· ⚠ 该 ID 重复');
			}

			lenses.push(
				new vscode.CodeLens(range, {
					title: parts.join(' '),
					tooltip: formatAnchorTooltip(anchor),
					command: SHOW_BACKLINKS_PANEL_COMMAND,
					arguments: [anchor.uuid],
				}),
			);
		}

		return lenses;
	}

	dispose(): void {
		this.disposed = true;
		this.changeEmitter.dispose();
	}
}
