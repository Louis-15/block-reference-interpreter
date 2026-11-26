/**
 * 行内渲染：把编辑器里的 `((uuid))` 直接显示成目标块的首行文本。
 *
 * 效果对齐 Tine / Logseq 的原生行为：引用不再是裸 UUID，而是「那个块讲的是什么」。
 * 子块**不在行内显示**（会把行撑爆），鼠标悬停时才展开块 + 子块（见 hoverProvider）。
 *
 * 三种模式（`tineBlockRef.inlineRender.mode`）：
 * - `activeLine`（默认）：**光标所在行显示真实 `((uuid))` 原文**，其他行显示标题。
 *   这是唯一同时满足「视觉接近 Tine」和「可编辑」的方案——VS Code 没有
 *   替换文本的 API，只要把原文压成 0 宽度，鼠标就再也点不到引用右侧、
 *   选不中、也无法在行尾回车新建块。光标一进这一行就还原原文，用户始终
 *   能在真实字符上定位。
 * - `replace`：所有行都隐藏原文、只显示标题。视觉最干净，但上述编辑问题无解。
 * - `append`：保留原文，在后面追加 `〔标题〕`。光标行为完全正常。
 *
 * 实现原理：用 decoration 把原文 `((uuid))` 的字符宽度压成 0
 * （`font-size: 0` 注入到 textDecoration 里），再在同一个 range 上挂
 * `after` attachment 显示标题。
 *
 * 被发现一次（曾被隐藏），所以是可选项而不是默认。
 */

import * as vscode from 'vscode';

import { splitLines } from '../core/blockParser';
import { t } from '../core/i18n';
import type { GraphIndex } from '../core/graphIndex';
import { detectGraphRoot, isGraphContentFile, nodePathProbe } from '../core/graphLocator';
import {
	modeDependsOnSelection,
	planInlineDecorations,
	type InlineRenderItem,
} from '../core/inlineDecoration';
import { scanReferences } from '../core/refScanner';
import type { ReferenceHit } from '../core/types';
import { getInlineTitle } from './hoverContent';
import { readConfig } from './indexService';
/** 文档改动后的防抖时长：连续输入时只在停下来之后重渲染一次。 */
const DEBOUNCE_MS = 180;

/** 单个文档的扫描缓存。 */
interface ReferenceCacheEntry {
	version: number;
	references: ReferenceHit[];
}

export class BlockReferenceInlineRenderer implements vscode.Disposable {
	/** 隐藏原文用的装饰类型。 */
	private readonly hiddenType: vscode.TextEditorDecorationType;
	/** 挂替换文本用的装饰类型。 */
	private readonly replacementType: vscode.TextEditorDecorationType;

	private readonly disposables: vscode.Disposable[] = [];
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly cache = new Map<string, ReferenceCacheEntry>();
	/** 每个编辑器上次渲染时的活动行，用于避免选择变化导致的无意义重绘。 */
	private readonly lastActiveLines = new Map<string, string>();
	private disposed = false;

	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
		private readonly log: (message: string) => void,
		private readonly onDidIndexChange?: vscode.Event<void>,
	) {
		this.hiddenType = vscode.window.createTextEditorDecorationType({
			// `textDecoration` 会被直接拼进 style，所以可以注入额外的 CSS。
			// font-size: 0 让字符宽度归零；color: transparent 是双保险。
			textDecoration: 'none; font-size: 0; color: transparent;',
		});

		this.replacementType = vscode.window.createTextEditorDecorationType({
			// 样式全部走 per-range 的 after，这里留空避免与悬停装饰冲突。
		});

		this.registerListeners();
	}

	private registerListeners(): void {
		const { window, workspace } = vscode;

		// 编辑器切换 / 可见编辑器变化：立即重渲染（不需要防抖，用户能感知延迟）。
		this.disposables.push(
			window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					void this.renderEditor(editor);
				}
			}),
			window.onDidChangeVisibleTextEditors(() => {
				void this.renderAllVisible();
			}),
		);

		// 文档内容变化：防抖后重渲染。
		this.disposables.push(
			workspace.onDidChangeTextDocument((event) => {
				if (event.contentChanges.length === 0) {
					return;
				}
				this.scheduleRender(event.document);
			}),
			workspace.onDidCloseTextDocument((document) => {
				this.cache.delete(document.uri.toString());
				this.lastActiveLines.delete(document.uri.toString());
			}),
		);

		/**
		 * 光标移动：`activeLine` 模式要把活动行还原成真实原文。
		 *
		 * 必须监听 selection 而不是 document：内容没变，变的只是「哪一行该显示原文」。
		 * 只在活动行集合真的变化时重绘，否则按住方向键移动光标会疯狂重设装饰。
		 */
		this.disposables.push(
			window.onDidChangeTextEditorSelection((event) => {
				if (!modeDependsOnSelection(readConfig().inlineRenderMode)) {
					return;
				}
				const signature = selectionLinesSignature(event.textEditor);
				const key = event.textEditor.document.uri.toString();
				if (this.lastActiveLines.get(key) === signature) {
					return;
				}
				this.lastActiveLines.set(key, signature);
				void this.renderEditor(event.textEditor);
			}),
		);

		// 配置变化：重渲染（开关、标题长度上限都可能改）。
		this.disposables.push(
			workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('tineBlockRef')) {
					void this.renderAllVisible();
				}
			}),
		);

		// 索引变化：外部（Tine）改了被引用的目标文件时，引用方文件本身没变，
		// 但显示的标题必须跟着更新，否则用户会看到过期内容。
		if (this.onDidIndexChange) {
			this.disposables.push(
				this.onDidIndexChange(() => {
					void this.renderAllVisible();
				}),
			);
		}
	}

	/** 防抖后渲染指定文档对应的可见编辑器。 */
	private scheduleRender(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		const timer = setTimeout(() => {
			this.timers.delete(key);
			if (this.disposed) {
				return;
			}
			for (const editor of vscode.window.visibleTextEditors) {
				if (editor.document.uri.toString() === key) {
					void this.renderEditor(editor);
				}
			}
		}, DEBOUNCE_MS);

		this.timers.set(key, timer);
	}

	/** 渲染全部可见编辑器。 */
	async renderAllVisible(): Promise<void> {
		if (this.disposed) {
			return;
		}
		await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.renderEditor(editor)));
	}

	/** 渲染单个编辑器。 */
	private async renderEditor(editor: vscode.TextEditor): Promise<void> {
		if (this.disposed) {
			return;
		}

		try {
			await this.doRender(editor);
		} catch (error) {
			// 渲染失败不应该打断编辑：记日志后放弃这一轮，
			// 下一次文本/编辑器事件会自然重试。
			const message = error instanceof Error ? error.message : String(error);
			this.log(t('[Error] Inline rendering failed for {0}: {1}', editor.document.uri.fsPath, message));
		}
	}

	private async doRender(editor: vscode.TextEditor): Promise<void> {
		const document = editor.document;

		// 非 Markdown、或不在图谱目录内，一律清空装饰并返回。
		// 清空很重要：用户切到别的文件时，上一个文件的装饰不能残留。
		if (!this.shouldRender(document)) {
			this.clear(editor);
			return;
		}

		const config = readConfig();
		if (!config.inlineRenderEnabled) {
			this.clear(editor);
			return;
		}

		// 索引可能还没建好；await 之后用户才能看到内容。
		await this.ensureReady();
		if (this.disposed || editor.document.version !== document.version) {
			// 等待期间文档被改过，这一轮结果已过期，交给下一次事件处理。
			return;
		}

		const references = this.getReferences(document);
		if (references.length === 0) {
			this.clear(editor);
			return;
		}
		const index = this.getIndex();
		const items: InlineRenderItem[] = [];

		for (const hit of references) {
			// 与悬停预览共用同一套标题规则，避免「行内显示的」和「hover 推算的」不一致，
			// 那样会导致视觉范围判定错位。
			const title = getInlineTitle(
				index,
				hit.uuid,
				config.inlineRenderMaxTitleLength,
				config.inlineRenderShowMissing,
				config.renderStripHeadingMarks,
			);
			if (title === undefined) {
				continue;
			}

			items.push({
				uuid: hit.uuid,
				line: hit.line,
				// 用扫描器给出的完整范围：embed 时包含 `{{embed ` 与 `}}`，
				// 这样替换后不会残留外壳。
				start: hit.column,
				end: hit.endColumn,
				text: title,
				missing: index.lookupBlocks(hit.uuid).length === 0,
			});
		}

		this.apply(editor, items);
	}

	/** 判断该文档是否应该渲染。 */
	private shouldRender(document: vscode.TextDocument): boolean {
		if (document.languageId !== 'markdown') {
			return false;
		}
		if (document.uri.scheme !== 'file') {
			// 未保存的新文档（untitled）也允许渲染的话，路径判断会失败，直接跳过。
			return false;
		}
		const graphRoot = this.getGraphRoot() ?? detectGraphRoot(document.uri.fsPath, nodePathProbe) ?? undefined;
		if (!graphRoot) {
			return false;
		}
		return isGraphContentFile(document.uri.fsPath, graphRoot);
	}

	/** 应用装饰。 */
	private apply(editor: vscode.TextEditor, items: InlineRenderItem[]): void {
		const config = readConfig();
		const linkColor = new vscode.ThemeColor('textLink.foreground');
		const missingColor = new vscode.ThemeColor('errorForeground');

		// 活动行：光标与所有选区覆盖到的行。这些行要显示真实 `((uuid))`，
		// 否则用户无法把光标定位到引用右侧，也无法选中或编辑引用。
		const activeLines = modeDependsOnSelection(config.inlineRenderMode)
			? collectSelectionLines(editor)
			: undefined;

		const slots = planInlineDecorations(items, config.inlineRenderMode, activeLines);

		const hiddenOptions: vscode.DecorationOptions[] = [];
		const replacementOptions: vscode.DecorationOptions[] = [];

		for (const slot of slots) {
			const range = new vscode.Range(slot.item.line, slot.item.start, slot.item.line, slot.item.end);

			if (slot.hide) {
				hiddenOptions.push({ range });
			}
			if (slot.contentText === undefined) {
				continue;
			}

			replacementOptions.push({
				range,
				renderOptions: {
					after: {
						contentText: slot.contentText,
						color: slot.item.missing ? missingColor : linkColor,
						textDecoration: 'none; text-decoration: underline; text-underline-offset: 2px;',
						margin: '0',
					},
				},
			});
		}

		editor.setDecorations(this.hiddenType, hiddenOptions);
		editor.setDecorations(this.replacementType, replacementOptions);

		// 记录本次实际渲染的活动行，供 selection 监听做差量判断。
		this.lastActiveLines.set(
			editor.document.uri.toString(),
			selectionLinesSignature(editor),
		);
	}

	/** 清空装饰。 */
	private clear(editor: vscode.TextEditor): void {
		editor.setDecorations(this.hiddenType, []);
		editor.setDecorations(this.replacementType, []);
	}

	/** 取文档引用命中（带版本缓存）。 */
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

		if (this.cache.size > 50) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}

		return references;
	}

	dispose(): void {
		this.disposed = true;

		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;

		// decoration type 也要释放，否则重装插件后旧样式可能残留。
		this.hiddenType.dispose();
		this.replacementType.dispose();
	}
}

/** 供日志使用：让调用方知道渲染器已启用。 */
export function describeInlineRenderer(): string {
	return t('Inline rendering enabled (debounce {0}ms)', DEBOUNCE_MS);
}

/** 收集编辑器里所有光标与选区覆盖到的行号。 */
function collectSelectionLines(editor: vscode.TextEditor): Set<number> {
	const lines = new Set<number>();
	for (const selection of editor.selections) {
		// 选区可能跨很多行（Ctrl+A 时是全文），这里只关心「哪些行要显示原文」，
		// 数量上限由文档行数决定，不会失控。
		for (let line = selection.start.line; line <= selection.end.line; line++) {
			lines.add(line);
		}
	}
	return lines;
}

/** 活动行集合的紧凑签名，用于判断是否需要重绘。 */
function selectionLinesSignature(editor: vscode.TextEditor): string {
	return editor.selections
		.map((selection) => `${selection.start.line}-${selection.end.line}`)
		.join(',');
}
