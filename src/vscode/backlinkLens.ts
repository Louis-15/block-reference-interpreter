/**
 * 反链 CodeLens：在「被引用的块」上方显示「N 条链接引用」。
 *
 * 为什么用 CodeLens 而不是装饰器：
 * Tine / Logseq 的反链是**常驻可见**的，用户扫一眼就知道这个块被谁用过。
 * 装饰器只能改行内文字（会破坏编辑），而 CodeLens 是插在行与行之间的独立一行，
 * 既醒目又不碰原文。
 *
 * 为什么只对「有反链的块」显示：
 * 真实笔记库统计——1263 个带 ID 块里只有 952 个被引用过，而它们只分布在
 * 283 / 1164 个文件里。也就是说 76% 的笔记完全不会多出任何一行。
 * 如果无条件显示，用户打开任何一篇都是满屏噪声。
 */

import * as vscode from 'vscode';

import { parseMarkdown } from '../core/blockParser';
import type { GraphIndex } from '../core/graphIndex';
import { buildBacklinkReport } from '../core/backlinkReport';

/** 命令：打开反链面板。 */
export const SHOW_BACKLINKS_PANEL_COMMAND = 'blockReferenceInterpreter.showBacklinksPanel';

/** 单个块的反链计数。 */
interface LensEntry {
	uuid: string;
	/** 引用条目数（按引用块合并后）。 */
	count: number;
	/** 原始命中次数，用于「同一块内重复引用」的提示。 */
	hitCount: number;
	/** 该 UUID 是否重复定义。 */
	duplicate: boolean;
}

/** 按文档版本缓存的解析结果，避免每次重算块树。 */
interface DocumentCache {
	version: number;
	entries: LensEntry[];
}

export interface BacklinkLensDeps {
	getIndex: () => GraphIndex;
	ensureReady: () => Promise<void>;
	isIndexedFile: (filePath: string) => boolean;
	/** 是否启用 CodeLens（读配置）。 */
	isEnabled: () => boolean;
	log: (message: string) => void;
}

export class BacklinkLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly cache = new Map<string, DocumentCache>();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;

	readonly onDidChangeCodeLenses = this.changeEmitter.event;

	constructor(private readonly deps: BacklinkLensDeps) {}

	/** 让 VS Code 重新询问 CodeLens（索引或配置变化后调用）。 */
	refresh(): void {
		this.cache.clear();
		this.changeEmitter.fire();
	}

	async provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.CodeLens[]> {
		if (this.disposed || !this.deps.isEnabled()) {
			return [];
		}
		if (document.languageId !== 'markdown' || document.uri.scheme !== 'file') {
			return [];
		}
		if (!this.deps.isIndexedFile(document.uri.fsPath)) {
			return [];
		}

		// 索引可能还在建，等它就绪再算，否则初次打开会静默没有任何 CodeLens。
		await this.deps.ensureReady();
		if (token.isCancellationRequested || this.disposed) {
			return [];
		}

		const entries = this.getEntries(document);
		if (entries.length === 0 || token.isCancellationRequested) {
			return [];
		}

		const lenses: vscode.CodeLens[] = [];
		for (const entry of entries) {
			// 用块首行的行号定位，CodeLens 会显示在该行**上方**。
			const range = new vscode.Range(entry.line, 0, entry.line, 0);

			const parts = [`$(references) ${entry.count} 条链接引用`];
			if (entry.hitCount > entry.count) {
				// 同一块里引用多次时，条目数会小于命中数，说清楚免得用户疑惑。
				parts.push(`（共 ${entry.hitCount} 次）`);
			}
			if (entry.duplicate) {
				parts.push('· ⚠ 该 ID 重复');
			}

			const command: vscode.Command = {
				title: parts.join(' '),
				tooltip: `点击查看哪些页面引用了这个块\n${entry.uuid}`,
				command: SHOW_BACKLINKS_PANEL_COMMAND,
				arguments: [entry.uuid],
			};

			lenses.push(new vscode.CodeLens(range, command));
		}

		return lenses;
	}

	/**
	 * 取出当前文档里「有反链的块」及其计数。
	 *
	 * 用编辑器内容而不是磁盘内容：用户可能刚写了新引用还没保存，
	 * 这时磁盘版本没有那条引用，CodeLens 会显示过期数字。
	 */
	private getEntries(document: vscode.TextDocument): Array<LensEntry & { line: number }> {
		const key = document.uri.toString();
		const cached = this.cache.get(key);
		if (cached && cached.version === document.version) {
			return cached.entries as Array<LensEntry & { line: number }>;
		}

		const parsed = parseMarkdown(document.uri.fsPath, document.getText());
		const index = this.deps.getIndex();
		const result: Array<LensEntry & { line: number }> = [];

		for (const block of parsed.blocks) {
			if (!block.id) {
				continue;
			}

			try {
				const report = buildBacklinkReport(index, block.id);
				if (report.itemCount === 0) {
					// 没人引用就什么都不显示——真实库里绝大多数块属于这一类。
					continue;
				}

				result.push({
					uuid: block.id,
					line: block.startLine,
					count: report.itemCount,
					hitCount: report.hitCount,
					duplicate: report.definitions.length > 1,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.deps.log(`[错误] 统计块 ${block.id} 的反链失败：${message}`);
			}
		}

		this.cache.set(key, { version: document.version, entries: result });

		// 简单容量控制：文档关掉时会主动清理，这里只是兜底防泄漏。
		if (this.cache.size > 50) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}

		return result;
	}

	/** 文档关闭时清掉缓存，避免同一路径重开时拿到旧版本号对应的旧数据。 */
	forgetDocument(uri: vscode.Uri): void {
		this.cache.delete(uri.toString());
	}

	dispose(): void {
		this.disposed = true;
		this.changeEmitter.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}
