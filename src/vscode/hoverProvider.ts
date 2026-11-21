/**
 * 悬停预览：鼠标停在块引用上时显示被引块的真实内容（块 + 全部子块）。
 *
 * **定位难点**（这是行内渲染引入的新问题）：
 * 开启行内渲染后，原文 `((uuid))` 的字符宽度被压成 0，视觉上显示的是叠加的替换文本。
 * 用户把鼠标放在替换文字上时，VS Code 换算出的字符偏移会落在引用范围**之后**，
 * 严格按 `[start, end)` 判定就会全部失配，hover 完全失效。
 *
 * 所以这里的定位分两步：
 * 1. 精确命中：字符位置真实落在 `((uuid))` 内；
 * 2. 视觉命中：把范围向右扩展到「替换文本的视觉宽度」，
 *    覆盖鼠标停在虚拟文字上的情况。
 *
 * 另外，`inlineRenderer` 会给装饰器本身也挂 `hoverMessage` 作为双保险——
 * 万一某些布局下 VS Code 把 hover 事件算在 attachment 上，也仍然有内容可看。
 */

import * as vscode from 'vscode';

import { splitLines } from '../core/blockParser';
import type { GraphIndex } from '../core/graphIndex';
import { detectGraphRoot, isGraphContentFile, nodePathProbe } from '../core/graphLocator';
import { findHoverTarget } from '../core/hoverLocator';
import { scanReferences } from '../core/refScanner';
import { locateAllReferences } from '../core/refLocator';
import type { ReferenceHit } from '../core/types';
import { readConfig } from './indexService';
import { buildBlockHover, getInlineTitle } from './hoverContent';
import { t } from '../core/i18n';

/** 单个文档的扫描缓存。 */
interface DocumentCache {
	version: number;
	references: ReferenceHit[];
}

export class BlockReferenceHoverProvider implements vscode.HoverProvider {
	private readonly cache = new Map<string, DocumentCache>();

	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
		/** 诊断日志出口。悬停是「静默失败」最难查的功能，任何一条返回 undefined 的路径都要留痕。 */
		private readonly log?: (message: string) => void,
	) {}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined> {
		/**
		 * 整体包 try/catch。
		 *
		 * VS Code 会静默吞掉 HoverProvider 抛出的异常——扩展作者只能看到
		 * 「悬停没反应」，没有任何错误信息。这里必须自己抓，否则无从排查。
		 */
		try {
			return await this.doProvideHover(document, position, token);
		} catch (error) {
			const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
			this.log?.(t('[Error] Hover handling failed: {0}', message));
			return undefined;
		}
	}

	private async doProvideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined> {
		if (document.languageId !== 'markdown') {
			return undefined;
		}

		// 只对图谱内的笔记生效：其他 Markdown 文件里出现 ((uuid)) 多半是无关文本。
		const detectedRoot = detectGraphRoot(document.uri.fsPath, nodePathProbe) ?? undefined;
		const graphRoot = this.getGraphRoot() ?? detectedRoot;
		if (!graphRoot) {
			this.log?.(t('[Hover skipped] No graph root found: {0}', document.uri.fsPath));
			return undefined;
		}
		if (!isGraphContentFile(document.uri.fsPath, graphRoot)) {
			this.log?.(
				t(
					'[Hover skipped] File is not under pages/ or journals/: {0} (graph root {1})',
					document.uri.fsPath,
					graphRoot,
				),
			);
			return undefined;
		}

		const lineText = document.lineAt(position.line).text;
		const lineReferences = locateAllReferences(lineText);
		if (lineReferences.length === 0) {
			return undefined;
		}

		// 二次确认：该位置不在代码块/行内代码/frontmatter 内。
		// 直接复用整篇扫描结果，避免自己再实现一遍围栏状态机。
		const confirmedRefs = this.getReferences(document);

		const config = readConfig();
		const index = this.getIndex();

		// 视觉范围判定需要索引里的标题长度，所以先确保索引就绪。
		await this.ensureReady();
		if (token.isCancellationRequested) {
			this.log?.(t('[Hover skipped] Cancelled while waiting for the index'));
			return undefined;
		}

		const target = findHoverTarget(
			lineReferences,
			position.character,
			(reference) => {
				// 二次确认：该位置不在代码块/行内代码/frontmatter 内。
				// 比对起点与 UUID，而不比对长度——长度会因 embed 与普通引用而不同。
				const isRealReference = confirmedRefs.some(
					(hit) =>
						hit.line === position.line && hit.column === reference.start && hit.uuid === reference.uuid,
				);
				if (!isRealReference) {
					// 这是最容易出问题的一步：两套正则（refScanner / refLocator）
					// 只要有一处不一致，这里就会静默全部失配。
					this.log?.(
						t(
							'[Hover mismatch] line {0} column {1} uuid={2}: refLocator found the reference but refScanner has no matching entry in its whole-document result',
							position.line + 1,
							reference.start,
							reference.uuid,
						),
					);
					return undefined;
				}

				// 悬空引用：行内是否显示「⚠ 块不存在」取决于配置，
				// 但**无论显示与否，hover 都要能响应**——否则用户永远发现不了失效引用。
				if (index.lookupBlocks(reference.uuid).length === 0) {
					return config.inlineRenderShowMissing ? t('⚠ Block not found') : '';
				}

				const title = getInlineTitle(
					index,
					reference.uuid,
					config.inlineRenderMaxTitleLength,
					true,
					config.renderStripHeadingMarks,
				);
				if (title === undefined) {
					this.log?.(t('[Hover skipped] Cannot get the title: uuid={0}', reference.uuid));
				}
				return title;
			},
			{
				enabled: config.inlineRenderEnabled,
				replaceMode: config.inlineRenderMode !== 'append',
			},
		);

		if (!target) {
			return undefined;
		}

		// 高亮范围覆盖到视觉宽度，让「鼠标所在的那段文字」整体有反馈。
		const visualEnd = Math.max(target.reference.end, target.visualEnd);
		const range = new vscode.Range(position.line, target.reference.start, position.line, visualEnd);

		const markdown = buildBlockHover(index, target.reference.uuid, {
			hoverPreviewLines: config.hoverPreviewLines,
			hideProperties: config.hideProperties,
			stripHeadingMarks: config.renderStripHeadingMarks,
		});

		return new vscode.Hover(markdown, range);
	}

	/** 取文档的引用命中（带版本号缓存）。 */
	private getReferences(document: vscode.TextDocument): ReferenceHit[] {
		const key = document.uri.toString();
		const cached = this.cache.get(key);
		if (cached && cached.version === document.version) {
			return cached.references;
		}

		// 用与解析器相同的切行逻辑：统一处理 CRLF 与 BOM，
		// 否则行号/列号可能与索引里的解析结果错位。
		const references = scanReferences(splitLines(document.getText()));
		this.cache.set(key, { version: document.version, references });

		// 简单上限：避免长期打开大量文档导致缓存膨胀。
		if (this.cache.size > 50) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}

		return references;
	}

	/** 文档关闭时清掉缓存。 */
	forget(document: vscode.TextDocument): void {
		this.cache.delete(document.uri.toString());
	}
}
