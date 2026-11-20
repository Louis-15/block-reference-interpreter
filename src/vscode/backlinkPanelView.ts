/**
 * 反链面板：把报告渲染成可点击的网页。
 *
 * 这里只负责「数据 → HTML」这一层，面板生命周期（单例、CSP nonce、
 * 跳转消息）由 `ReusableWebviewPanel` 统一托管 ——
 * 反链与展开全文两个面板共用同一套宿主，行为不会分叉。
 */

import { renderBacklinkHtml } from '../core/backlinkHtml';
import type { BacklinkReport } from '../core/backlinkReport';
import { ReusableWebviewPanel } from './reusableWebview';

/** 反链面板的 Webview 类型（同类面板会被复用）。 */
const BACKLINK_VIEW_TYPE = 'blockReferenceInterpreter.backlinkPanel';

/**
 * 显示（或复用）反链面板。
 *
 * @param title 标签页标题
 * @param report 已构建好的反链报告
 * @param graphRoot 图谱根，用于把绝对路径压成显示路径
 * @param maxItemsPerGroup 每组最多显示几条
 * @param onJump 点击链接时的跳转实现
 */
export function showBacklinkPanelView(
	title: string,
	report: BacklinkReport,
	graphRoot: string | undefined,
	maxItemsPerGroup: number | undefined,
	onJump: (path: string, line: number) => void,
): void {
	ReusableWebviewPanel.show(
		BACKLINK_VIEW_TYPE,
		title,
		(nonce) => renderBacklinkHtml(report, { nonce, graphRoot, maxItemsPerGroup }).html,
		onJump,
	);
}

/** 关闭当前反链面板（供测试或外部清理用）。 */
export function closeBacklinkPanel(): void {
	ReusableWebviewPanel.close(BACKLINK_VIEW_TYPE);
}
