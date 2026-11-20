/**
 * 反链 InlayHint：在被引用块所在行的**行尾**显示 `🔗 2`。
 *
 * 为什么从 CodeLens 换过来：CodeLens 插在块**上方**独立一行，
 * 视觉上像是「这一行的标题」，而反链其实是这一行的属性。
 * Tine / Logseq 也都是把反链计数贴在块行尾，本模块与之对齐。
 *
 * InlayHint 相比装饰器的关键优势是**可点击**：点一下就打开反链面板。
 * 装饰器的 after 文本只能看不能点。
 */

import * as vscode from 'vscode';

import { formatAnchorLabel } from '../core/backlinkBadge';
import { BacklinkAnchorCache, shouldShowBacklinks, type AnchorDeps } from './backlinkAnchors';
import { buildAnchorTooltip } from './backlinkTooltip';

export class BacklinkInlayProvider implements vscode.InlayHintsProvider, vscode.Disposable {
	private readonly anchors = new BacklinkAnchorCache();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private disposed = false;

	readonly onDidChangeInlayHints = this.changeEmitter.event;

	constructor(
		private readonly deps: AnchorDeps,
		private readonly isEnabled: () => boolean,
	) {}

	/** 让 VS Code 重新询问 InlayHint（索引或配置变化后调用）。 */
	refresh(): void {
		this.anchors.clear();
		this.changeEmitter.fire();
	}

	/** 文档关闭时清缓存。 */
	forgetDocument(uri: vscode.Uri): void {
		this.anchors.forget(uri);
	}

	async provideInlayHints(
		document: vscode.TextDocument,
		range: vscode.Range,
		token: vscode.CancellationToken,
	): Promise<vscode.InlayHint[]> {
		if (this.disposed || !this.isEnabled()) {
			return [];
		}
		if (!shouldShowBacklinks(document, this.deps)) {
			return [];
		}

		// 索引可能还在建，等它就绪再算，否则初次打开会静默什么都没有。
		await this.deps.ensureReady();
		if (token.isCancellationRequested || this.disposed) {
			return [];
		}

		const all = this.anchors.get(document, this.deps);
		if (all.length === 0) {
			return [];
		}

		// VS Code 传进来的 range 是当前可见区域（加少量缓冲）。
		// 只返回可见范围内的 hint，滚动长文档时才不会一次算上千个。
		const hints: vscode.InlayHint[] = [];
		for (const anchor of all) {
			if (anchor.line < range.start.line || anchor.line > range.end.line) {
				continue;
			}
			if (token.isCancellationRequested) {
				return hints;
			}

			const lineText = document.lineAt(anchor.line).text;

			/*
			 * label 用纯字符串，**不**挂 `InlayHintLabelPart.command`。
			 *
			 * 挂了 command 之后 VS Code 会在悬停框底部自动追加一行
			 * 「执行命令 (ctrl + 点击)」，而那个命令和悬停框里的
			 * 「查看完整反链面板」链接指向同一个位置，属于纯噪声。
			 * 更关键的是 InlayHint 的 command 本来就必须按 Ctrl 才响应，
			 * 便利性远不如直接点悬停框里的链接。
			 */
			const hint = new vscode.InlayHint(
				new vscode.Position(anchor.line, lineText.length),
				formatAnchorLabel(anchor),
				// Type 会给徽章底色，比纯文本更醒目，也更像 Tine 的计数标记。
				vscode.InlayHintKind.Type,
			);

			// 与行内正文拉开一点距离，否则会紧贴最后一个字。
			hint.paddingLeft = true;

			/*
			 * 只设 hint 级 tooltip，**不要**再给 label part 设 tooltip。
			 * 两处都设会让悬停框把同一段文字显示两遍（实测踩过）。
			 */
			hint.tooltip = buildAnchorTooltip(anchor);

			hints.push(hint);
		}

		return hints;
	}

	dispose(): void {
		this.disposed = true;
		this.changeEmitter.dispose();
	}
}
