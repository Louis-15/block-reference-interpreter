/**
 * 反链锚点收集：找出「当前文档里哪些块被引用过、各被引用几次」。
 *
 * 为什么单独抽一层：右侧 InlayHint 与块上方 CodeLens 需要完全相同的判断，
 * 各写一份迟早会出现「上方说 2 条、右侧说 3 条」这种自相矛盾。
 */

import * as vscode from 'vscode';

import { parseMarkdown } from '../core/blockParser';
import { buildAnchorFromReport, type BacklinkAnchor } from '../core/backlinkBadge';
import { buildBacklinkReport } from '../core/backlinkReport';
import type { GraphIndex } from '../core/graphIndex';

export type { BacklinkAnchor };

/** 悬停列表最多列几个页面。 */
const MAX_TOOLTIP_PAGES = 8;

/** 锚点收集所需的依赖。 */
export interface AnchorDeps {
	getIndex: () => GraphIndex;
	ensureReady: () => Promise<void>;
	isIndexedFile: (filePath: string) => boolean;
	log: (message: string) => void;
}

interface AnchorCache {
	version: number;
	anchors: BacklinkAnchor[];
}

/**
 * 锚点缓存。
 *
 * 按 `document.version` 缓存 —— VS Code 在滚动时会反复调用
 * `provideInlayHints`，每次都重算块树会让滚动明显掉帧。
 */
export class BacklinkAnchorCache {
	private readonly cache = new Map<string, AnchorCache>();

	/**
	 * 取出当前文档的全部锚点。
	 *
	 * 用编辑器内容而不是磁盘内容：用户可能刚写了新引用还没保存，
	 * 这时磁盘版本没有那条引用，计数会是过期的。
	 */
	get(document: vscode.TextDocument, deps: AnchorDeps): BacklinkAnchor[] {
		const key = document.uri.toString();
		const cached = this.cache.get(key);
		if (cached && cached.version === document.version) {
			return cached.anchors;
		}

		const anchors = this.collect(document, deps);
		this.cache.set(key, { version: document.version, anchors });

		// 简单容量控制：文档关闭时会主动清理，这里只是兜底防泄漏。
		if (this.cache.size > 50) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}

		return anchors;
	}

	private collect(document: vscode.TextDocument, deps: AnchorDeps): BacklinkAnchor[] {
		const parsed = parseMarkdown(document.uri.fsPath, document.getText());
		const index = deps.getIndex();
		const anchors: BacklinkAnchor[] = [];

		for (const block of parsed.blocks) {
			if (!block.id) {
				continue;
			}

			try {
				const report = buildBacklinkReport(index, block.id);
				// 没人引用就什么都不显示——真实库里绝大多数块属于这一类。
				if (report.itemCount === 0) {
					continue;
				}

				anchors.push(buildAnchorFromReport(report, block.startLine, MAX_TOOLTIP_PAGES));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.log(`[错误] 统计块 ${block.id} 的反链失败：${message}`);
			}
		}

		return anchors;
	}

	/** 索引或配置变化后必须整体失效：引用来自别的文件，文档版本号不会变。 */
	clear(): void {
		this.cache.clear();
	}

	/** 文档关闭时清掉该文档缓存。 */
	forget(uri: vscode.Uri): void {
		this.cache.delete(uri.toString());
	}
}

/** 判断当前文档是否应该显示反链标记。 */
export function shouldShowBacklinks(
	document: vscode.TextDocument,
	deps: AnchorDeps,
): boolean {
	if (document.uri.scheme !== 'file') {
		return false;
	}
	if (document.languageId !== 'markdown') {
		return false;
	}
	return deps.isIndexedFile(document.uri.fsPath);
}
