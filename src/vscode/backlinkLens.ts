/**
 * 反链 CodeLens：在块**上方**插入一行「N 条链接引用」。
 *
 * 默认不启用 —— 反链用 `backlinkInlay.ts` 的行尾徽章呈现（更贴近 Tine）。
 * 保留本模块的原因：InlayHint 受 VS Code 全局设置 `editor.inlayHints.enabled`
 * 控制，用户一旦关掉它就完全看不到反链，且没有任何提示。
 * 此时把 `tineBlockRef.backlinks.style` 切成 `lens` 仍能显示。
 */

import * as vscode from 'vscode';

import { formatTooltipText } from '../core/backlinkBadge';
import { t } from '../core/i18n';
import { BacklinkAnchorCache, shouldShowBacklinks, type AnchorDeps } from './backlinkAnchors';
import { SHOW_BACKLINKS_PANEL_COMMAND } from './backlinkCommands';

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

			const parts = [t('$(references) {0} link references', anchor.count)];
			if (anchor.hitCount > anchor.count) {
				parts.push(t(' ({0} in total)', anchor.hitCount));
			}
			if (anchor.duplicate) {
				parts.push(t('· ⚠ This ID is duplicated'));
			}

			lenses.push(
				new vscode.CodeLens(range, {
					title: parts.join(' '),
					// CodeLens 的 tooltip 只接受 string，拿不到可点击链接。
					tooltip: formatTooltipText(anchor.tooltip),
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
