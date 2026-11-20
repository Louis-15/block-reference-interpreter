/**
 * 反链面板（Webview 版）。
 *
 * 为什么用 Webview 而不是只读文本文档：
 * 文本文档里的链接（DocumentLink）和 InlayHint 的 command **都强制要求**
 * Ctrl + 单击 —— 这是 VS Code 的硬规则，因为单击在文本编辑器里代表
 * 「定位光标 / 开始拖选」。Webview 里的 `<a>` 是真正的网页元素，
 * 左键单击即可，不需要修饰键。
 *
 * 代价是失去文本编辑器的查找（Ctrl+F）与选中复制能力。
 * 需要那些能力时把 `tineBlockRef.backlinks.panel` 切到 `text`。
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { renderBacklinkHtml } from '../core/backlinkHtml';
import type { BacklinkReport } from '../core/backlinkReport';

/** Webview 发回扩展的消息。 */
interface JumpMessage {
	type: 'jump';
	path: string;
	line: number;
}

/** 判断收到的消息是否是跳转请求。 */
function isJumpMessage(value: unknown): value is JumpMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const message = value as Partial<JumpMessage>;
	return (
		message.type === 'jump' &&
		typeof message.path === 'string' &&
		typeof message.line === 'number'
	);
}

export class BacklinkPanelView implements vscode.Disposable {
	/**
	 * 全局只保留一个面板。
	 *
	 * 用单例的原因：连续查看多个块的反链时，开一堆标签页会把编辑器挤满，
	 * 而用户同一时刻只会关注一个块。再次打开时直接替换内容。
	 */
	private static current: BacklinkPanelView | undefined;

	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly onJump: (path: string, line: number) => void,
	) {
		this.panel.webview.onDidReceiveMessage(
			(message: unknown) => {
				if (isJumpMessage(message)) {
					this.onJump(message.path, message.line);
				}
			},
			undefined,
			this.disposables,
		);

		this.panel.onDidDispose(
			() => {
				this.dispose();
				BacklinkPanelView.current = undefined;
			},
			undefined,
			this.disposables,
		);
	}

	/**
	 * 显示（或复用）一个反链面板。
	 *
	 * @param report 已构建好的反链报告
	 * @param graphRoot 图谱根，用于把绝对路径压成显示路径
	 * @param maxItemsPerGroup 每组最多显示几条
	 * @param onJump 点击链接时的跳转实现
	 */
	static show(
		title: string,
		report: BacklinkReport,
		graphRoot: string | undefined,
		maxItemsPerGroup: number | undefined,
		onJump: (path: string, line: number) => void,
	): BacklinkPanelView {
		if (BacklinkPanelView.current) {
			BacklinkPanelView.current.panel.title = title;
			BacklinkPanelView.current.render(report, graphRoot, maxItemsPerGroup);
			BacklinkPanelView.current.panel.reveal(undefined, false);
			return BacklinkPanelView.current;
		}

		const panel = vscode.window.createWebviewPanel(
			'blockReferenceInterpreter.backlinkPanel',
			title,
			// Beside 打开，避免覆盖用户正在看的笔记。
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				// 切走标签再回来时保留滚动位置，否则每次回来都跳回顶部。
				retainContextWhenHidden: true,
				localResourceRoots: [],
			},
		);

		const view = new BacklinkPanelView(panel, onJump);
		BacklinkPanelView.current = view;
		view.render(report, graphRoot, maxItemsPerGroup);
		return view;
	}

	/** 关闭面板（供测试或外部清理用）。 */
	static closeCurrent(): void {
		BacklinkPanelView.current?.panel.dispose();
	}

	private render(
		report: BacklinkReport,
		graphRoot: string | undefined,
		maxItemsPerGroup: number | undefined,
	): void {
		const nonce = createNonce();
		const { html } = renderBacklinkHtml(report, { nonce, graphRoot, maxItemsPerGroup });
		this.panel.webview.html = html;
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}

/**
 * 生成 CSP nonce。
 *
 * VS Code 的 Webview 默认禁止内联脚本，必须靠 nonce 授权本扩展自己的脚本。
 * 用 `crypto.randomBytes` 而不是固定串或 `Math.random`：nonce 的强度
 * 直接决定笔记内容里混入的恶意脚本能否执行。
 */
function createNonce(): string {
	return randomBytes(24).toString('base64url');
}
