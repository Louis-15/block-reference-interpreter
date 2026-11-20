/**
 * 通用 Webview 面板宿主。
 *
 * 为什么抽出来：反链面板与「展开全文」面板需要完全相同的三件事——
 * 单例复用（不把编辑器标签页挤满）、CSP nonce、把网页里的点击转成扩展命令。
 * 各写一份迟早会出现「一处支持跳转、另一处不支持」的割裂。
 *
 * 关于非受信内容的安全约束：
 * - Webview 默认禁止内联脚本，脚本必须带 nonce；
 * - `localResourceRoots` 传空数组，网页不能加载任何本地文件；
 * - 内容全部由扩展生成并做 HTML 转义，不渲染笔记里的原始 HTML。
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

/** 网页发回扩展的跳转消息。 */
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

/**
 * 生成 CSP nonce。
 *
 * 用 `crypto.randomBytes` 而不是固定串或 `Math.random`：nonce 的强度
 * 直接决定网页里能否被注入执行恶意脚本。
 */
export function createNonce(): string {
	return randomBytes(24).toString('base64url');
}

/** 面板渲染回调：给定 nonce 返回 HTML。 */
export type RenderHtml = (nonce: string) => string;

/**
 * 一个可复用的 Webview 面板。
 *
 * 同名面板（按 `viewType` 区分）全局只保留一个：连续查看多个块或多次展开时，
 * 复用同一个标签页替换内容，而不是开一堆。
 */
export class ReusableWebviewPanel implements vscode.Disposable {
	private static readonly registry = new Map<string, ReusableWebviewPanel>();

	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly viewType: string,
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
				ReusableWebviewPanel.registry.delete(this.viewType);
			},
			undefined,
			this.disposables,
		);
	}

	/**
	 * 显示（或复用）一个面板。
	 *
	 * @param viewType Webview 类型标识，同类型的面板会被复用
	 * @param title 标签页标题
	 * @param render 渲染回调，接收 nonce 返回完整 HTML
	 * @param onJump 网页里点击跳转时的实现
	 */
	static show(
		viewType: string,
		title: string,
		render: RenderHtml,
		onJump: (path: string, line: number) => void,
	): void {
		const existing = ReusableWebviewPanel.registry.get(viewType);
		if (existing) {
			existing.panel.title = title;
			existing.panel.webview.html = render(createNonce());
			existing.panel.reveal(undefined, false);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			viewType,
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

		const instance = new ReusableWebviewPanel(viewType, panel, onJump);
		ReusableWebviewPanel.registry.set(viewType, instance);
		panel.webview.html = render(createNonce());
	}

	/** 关闭某类面板（供测试或外部清理用）。 */
	static close(viewType: string): void {
		ReusableWebviewPanel.registry.get(viewType)?.panel.dispose();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}
