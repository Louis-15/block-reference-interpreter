/**
 * 索引服务：把纯逻辑的 GraphIndex 接到 VS Code 的文件系统与工作区生命周期上。
 *
 * 职责：
 * 1. 找到 Tine 图谱根目录（配置优先，其次自动探测工作区）；
 * 2. 按 include/exclude 规则列出 Markdown 文件并建索引；
 * 3. 监听文件变更做增量更新；
 * 4. 对外提供「等待索引就绪」的 Promise，避免 hover/工具在索引还没建好时拿到空结果。
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { GraphIndex } from '../core/graphIndex';
import { matchSimpleGlob } from '../core/globMatch';
import { detectGraphRoot, nodePathProbe } from '../core/graphLocator';
import type { IndexStats } from '../core/types';

/**
 * 编辑器内容变化的防抖时长。
 *
 * 250ms 是「打字停顿时长」与「索引及时性」的折中：
 * 太短会在连续输入时反复解析同一文件，太长会让刚写完的引用迟迟查不到。
 * 单文件解析约 0.3ms，所以即使防抖触发多次也不构成性能问题。
 */
const INDEX_DEBOUNCE_MS = 250;

/** 配置读取小工具，集中处理默认值，避免各处散落 getConfiguration 调用。 */
export function readConfig() {
	const config = vscode.workspace.getConfiguration('tineBlockRef');
	return {
		graphRoot: config.get<string>('graphRoot', '').trim(),
		include: config.get<string[]>('include', ['pages/**/*.md', 'journals/**/*.md']),
		exclude: config.get<string[]>('exclude', [
			'logseq/**',
			'.tine-trash/**',
			'**/bak/**',
			'**/.recycle/**',
			'**/node_modules/**',
			'**/.git/**',
		]),
		maxDepth: config.get<number>('maxDepth', 3),
		maxOutputChars: config.get<number>('maxOutputChars', 20000),
		hoverPreviewLines: config.get<number>('hoverPreviewLines', 6),
		hideProperties: config.get<string[]>('hideProperties', ['id', 'collapsed']),
		inlineRenderEnabled: config.get<boolean>('inlineRender.enabled', true),
		inlineRenderMode: config.get<string>('inlineRender.mode', 'replace'),
		inlineRenderMaxTitleLength: config.get<number>('inlineRender.maxTitleLength', 60),
		inlineRenderShowMissing: config.get<boolean>('inlineRender.showMissing', true),
		renderStripHeadingMarks: config.get<boolean>('render.stripHeadingMarks', true),
		showIndexNotification: config.get<boolean>('showIndexNotification', true),
		backlinkStyle: config.get<string>('backlinks.style', 'inline'),
		backlinkPanelStyle: config.get<string>('backlinks.panel', 'html'),
		backlinkSubtreeLines: config.get<number>('backlinks.subtreeLines', 0),
		backlinkItemsPerPage: config.get<number>('backlinks.itemsPerPage', 20),
		backlinkPathDepth: config.get<number>('backlinks.pathDepth', 3),
	};
}

export class IndexService {
	private readonly index = new GraphIndex();
	private readonly disposables: vscode.Disposable[] = [];

	private graphRoot: string | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;
	private readyPromise: Promise<void> | undefined;
	private indexing = false;
	/** 工作区/配置监听是否已挂上（避免 initialize 被多次调用时重复挂）。 */
	private listenersAttached = false;
	/**
	 * 每个「未保存文档」的防抖定时器。
	 *
	 * 按文档分桶是必要的：用户可能同时编辑两个笔记，
	 * 共用一个定时器会让后一次编辑把前一次的更新取消掉。
	 */
	private readonly documentTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** 是否已释放，防止 dispose 之后定时器回调还在改索引。 */
	private disposed = false;

	/**
	 * 索引内容变化事件。
	 *
	 * 用来驱动「行内渲染」刷新：当 Tine 在外部改了某个被引用块，
	 * 引用方的文件本身没变，但显示的标题需要更新。
	 * 没有这个事件，用户会看到过期的旧标题。
	 */
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly log: (message: string) => void) {}

	/** 后台初始化：探测图谱根、全量建索引、挂监听器。失败只记日志不抛出。 */
	initialize(): void {
		/**
		 * 监听器必须在探测之前挂上。
		 *
		 * 否则「启动时没找到图谱 → 用户随后打开了一个笔记库文件夹」这条路径会失效：
		 * 没有监听器就没人通知我们去重新探测，用户只能手动执行重建索引命令。
		 */
		this.attachWorkspaceListeners();

		this.readyPromise = this.doInitialize().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`[错误] 索引初始化失败：${message}`);
		});
	}

	private async doInitialize(): Promise<void> {
		const root = this.resolveGraphRoot();
		if (!root) {
			this.log(
				'[提示] 未找到 Tine 图谱根目录。\n' +
					'        打开一个包含 pages/ 与 logseq/ 的笔记库文件夹后会自动识别；\n' +
					'        也可以用命令「块引用：选择 Tine 图谱目录」手动指定。',
			);
			return;
		}

		this.graphRoot = root;
		this.log(`[索引] 图谱根目录：${root}`);
		await this.rebuild();
		this.attachWatcher();
	}

	/**
	 * 解析图谱根：配置值优先，其次从工作区自动探测。
	 *
	 * 从 async 改成同步：探测本身只是几次 statSync，没有真正的异步工作，
	 * 之前套 async 会让人误以为需要 await，反而容易在调用处漏写。
	 */
	private resolveGraphRoot(): string | undefined {
		const configured = readConfig().graphRoot;
		if (configured) {
			// 配置了但目录不存在时明确告知，避免用户对着空索引干等。
			if (!nodePathProbe.isDirectory(configured)) {
				this.log(
					`[警告] 配置的图谱目录不存在：${configured}\n` +
						`        请执行命令「块引用：选择 Tine 图谱目录」重新指定。`,
				);
			}
			return configured;
		}

		return this.detectFromWorkspace();
	}

	/**
	 * 从当前工作区自动探测图谱根目录。
	 *
	 * 探测顺序（先精确后兜底）：
	 * 1. 当前编辑器所在文件向上找 —— 用户正在看的笔记属于哪个图谱，就用哪个；
	 * 2. 逐个工作区文件夹向上找 —— 覆盖「刚打开文件夹、还没打开任何文件」的情况。
	 *
	 * 优先第 1 条的原因：同时打开多个笔记库时，用户意图通常是「我正在编辑的这个」，
	 * 而不是「文件夹列表里的第一个」。
	 */
	private detectFromWorkspace(): string | undefined {
		const active = vscode.window.activeTextEditor?.document.uri;
		if (active && active.scheme === 'file') {
			const fromActive = detectGraphRoot(active.fsPath, nodePathProbe);
			if (fromActive) {
				return fromActive;
			}
		}

		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const detected = detectGraphRoot(folder.uri.fsPath, nodePathProbe);
			if (detected) {
				return detected;
			}
		}

		return undefined;
	}

	/**
	 * 挂「工作区文件夹变化」与「配置变化」的监听。
	 *
	 * 这两个监听解决了两个实际问题：
	 * 1. 启动时没有笔记库，之后用户才打开一个 → 需要重新探测；
	 * 2. 用户改了 `tineBlockRef.graphRoot` / include / exclude → 索引要跟着变。
	 *
	 * 没有它们，用户每次换笔记库都得手动执行「重建索引」。
	 */
	private attachWorkspaceListeners(): void {
		if (this.listenersAttached) {
			return;
		}
		this.listenersAttached = true;

		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				void this.handleWorkspaceFoldersChanged();
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				void this.handleConfigurationChanged(event);
			}),
		);

		this.attachDocumentListeners();
	}

	/**
	 * 监听编辑器里的内容变化（含**未保存**）。
	 *
	 * 为什么必须单独挂这一层：
	 * FileSystemWatcher 只监听磁盘。用户在编辑器里新增一个带 `id::` 的块、
	 * 或新增一个 `((uuid))` 引用，只要还没保存，磁盘没变、watcher 不触发，
	 * 索引里就没有这个块 —— 表现为「刚写的引用一悬停就显示未找到」。
	 *
	 * 加上这层后：改一个字（防抖 250ms）索引就跟上，不需要先保存。
	 */
	private attachDocumentListeners(): void {
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				// 纯选区变化、折叠等也会触发该事件，只有真正改了文本才处理。
				if (event.contentChanges.length === 0) {
					return;
				}
				if (!this.shouldTrackDocument(event.document)) {
					return;
				}
				this.scheduleDocumentUpdate(event.document);
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (document.uri.scheme !== 'file') {
					return;
				}
				void this.revertDocumentToDisk(document);
			}),
		);
	}

	/** 判断某个文档是否应由内存内容驱动索引。 */
	private shouldTrackDocument(document: vscode.TextDocument): boolean {
		// 排除只读虚拟文档（展开全文用的 tine-blockref: 方案）与其他非文件协议。
		if (document.uri.scheme !== 'file') {
			return false;
		}
		if (!document.uri.fsPath.toLowerCase().endsWith('.md')) {
			return false;
		}
		return this.isIndexedFile(document.uri.fsPath);
	}

	/** 防抖后把某个文档的内存内容写进索引。 */
	private scheduleDocumentUpdate(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		const existing = this.documentTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		const timer = setTimeout(() => {
			this.documentTimers.delete(key);
			if (this.disposed) {
				return;
			}
			try {
				this.index.updateFile(document.uri.fsPath, document.getText());
				this.changeEmitter.fire();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`[错误] 更新未保存文档索引失败 ${document.uri.fsPath}：${message}`);
			}
		}, INDEX_DEBOUNCE_MS);

		this.documentTimers.set(key, timer);
	}

	/**
	 * 文档关闭后用磁盘内容覆盖索引。
	 *
	 * 场景：用户在编辑器里加了一个块，然后关掉不保存（或撤销）。
	 * 若不回滚，索引里会残留一个磁盘上不存在的块，
	 * 表现为「这个块明明能搜到，但文件里没有」。
	 */
	private async revertDocumentToDisk(closed: vscode.TextDocument): Promise<void> {
		if (this.disposed || !this.graphRoot) {
			return;
		}

		const filePath = closed.uri.fsPath;

		// 关掉文档时必须取消挂起的防抖回调：
		// 否则它会在回滚之后才执行，用内存里的旧文本把磁盘版本重新覆盖回去。
		const pending = this.documentTimers.get(closed.uri.toString());
		if (pending) {
			clearTimeout(pending);
			this.documentTimers.delete(closed.uri.toString());
		}

		// 分屏时同一文件可能有另一个编辑器还开着，此时内存内容仍然有效，不能回滚。
		const stillOpen = vscode.workspace.textDocuments.some(
			(other) => other !== closed && other.uri.scheme === 'file' && other.uri.fsPath === filePath,
		);
		if (stillOpen) {
			return;
		}

		if (!this.isIndexedFile(filePath)) {
			return;
		}

		try {
			const content = await readFileText(filePath);
			this.index.updateFile(filePath, content);
		} catch {
			// 文件已被删除：交给 watcher 的 onDidDelete 处理即可。
			this.index.removeFile(filePath);
		}
		this.changeEmitter.fire();
	}

	/** 打开 / 关闭文件夹后的处理。 */
	private async handleWorkspaceFoldersChanged(): Promise<void> {
		// 用户显式配置了图谱目录时以配置为准，不因为换了工作区就擅自切换。
		const configured = readConfig().graphRoot;
		if (configured) {
			if (configured !== this.graphRoot && nodePathProbe.isDirectory(configured)) {
				await this.switchTo(configured, '工作区变化，改用配置的图谱目录');
			}
			return;
		}

		const detected = this.detectFromWorkspace();

		if (!detected) {
			/**
			 * 新工作区里没有图谱。
			 *
			 * 分两种情况，不能一律清空：
			 * - 旧的图谱目录已不属于当前任何工作区 → 确实该清空，否则会残留上一份笔记的数据；
			 * - 旧的图谱仍在某个工作区里（只是没被探测到） → 保留，避免误清。
			 */
			if (this.graphRoot && !this.isUnderAnyWorkspaceFolder(this.graphRoot)) {
				this.log('[索引] 当前工作区不含 Tine 图谱，已清空索引。');
				this.index.clear();
				this.graphRoot = undefined;
				this.disposeWatcher();
				this.changeEmitter.fire();
			}
			return;
		}

		if (detected === this.graphRoot) {
			// 图谱没变，无需重建。
			return;
		}

		await this.switchTo(detected, '检测到新的 Tine 图谱目录');
	}

	/** 配置变化后的处理。 */
	private async handleConfigurationChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
		const rootChanged = event.affectsConfiguration('tineBlockRef.graphRoot');
		const scopeChanged =
			event.affectsConfiguration('tineBlockRef.include') ||
			event.affectsConfiguration('tineBlockRef.exclude');

		if (!rootChanged && !scopeChanged) {
			return;
		}

		if (rootChanged) {
			const configured = readConfig().graphRoot;

			if (configured && configured !== this.graphRoot) {
				await this.switchTo(configured, '图谱目录设置已更改');
				return;
			}

			if (!configured) {
				// 配置被清空 → 回到自动探测。
				const detected = this.detectFromWorkspace();
				if (detected) {
					await this.switchTo(detected, '已清空图谱目录配置，改为自动探测');
					return;
				}
				if (this.graphRoot) {
					this.log('[索引] 图谱目录配置已清空且未探测到新图谱，索引保持不变。');
				}
				return;
			}
		}

		if (scopeChanged) {
			await this.rebuild();
		}
	}

	/** 判断某路径是否位于当前任一个工作区文件夹之内。 */
	private isUnderAnyWorkspaceFolder(target: string): boolean {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const relative = path.relative(folder.uri.fsPath, target);
			// 不以 .. 开头即为「在其内部或就是它本身」。
			if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 切换到指定图谱根并重建索引。
	 *
	 * `readyPromise` 一并替换：否则并发调用 `ensureReady()` 的悬停/工具
	 * 会等到「旧索引建完」就返回，拿到的是上一个笔记库的数据。
	 */
	private async switchTo(root: string, reason: string): Promise<void> {
		this.log(`[索引] ${reason}：${root}`);
		this.graphRoot = root;
		this.disposeWatcher();

		this.readyPromise = (async () => {
			await this.rebuild();
			this.attachWatcher();
		})().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`[错误] 切换图谱目录失败：${message}`);
		});

		await this.readyPromise;
	}

	/** 等待首次索引完成（供工具/hover 调用）。 */
	async ensureReady(): Promise<void> {
		if (!this.readyPromise) {
			this.initialize();
		}
		await this.readyPromise;
	}

	getIndex(): GraphIndex {
		return this.index;
	}

	getGraphRoot(): string | undefined {
		return this.graphRoot;
	}

	/** 让用户手动选择图谱目录（写入用户设置）。 */
	async selectGraphRoot(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: '设为 Tine 图谱根目录',
			title: '选择包含 pages/ 与 logseq/ 的 Tine 图谱文件夹',
		});

		const folder = picked?.[0];
		if (!folder) {
			return;
		}

		/**
		 * 先切换并重建，再写设置。
		 *
		 * 顺序有意义：写设置会触发 `onDidChangeConfiguration`，
		 * 而那个监听器看到 `configured !== graphRoot` 会再切一次。
		 * 先切换让两者相等，监听器就自然跳过，不会重复建索引。
		 */
		await this.switchTo(folder.fsPath, '手动选择图谱目录');

		await vscode.workspace
			.getConfiguration('tineBlockRef')
			.update('graphRoot', folder.fsPath, vscode.ConfigurationTarget.Global);
	}

	/**
	 * 全量重建索引。
	 *
	 * @param options.notify 是否在完成后弹出右下角提示；默认 true。
	 *   文件监听触发的增量更新不走这里，所以不会每次编辑都弹窗。
	 */
	async rebuild(options: { notify?: boolean } = {}): Promise<IndexStats> {
		if (this.indexing) {
			// 并发重建没有意义，直接返回当前统计，避免重复扫全库。
			return this.index.getStats();
		}
		if (!this.graphRoot) {
			this.resolveAndSetRoot();
		}
		if (!this.graphRoot) {
			return this.index.getStats();
		}

		this.indexing = true;
		const startedAt = Date.now();
		try {
			const files = await this.listMarkdownFiles(this.graphRoot);

			// 一个文件都没找到，几乎一定是路径配错了，而不是"笔记库恰好为空"。
			// 不提示的话，用户只会看到工具报「未找到块」，完全不知道是索引没建起来。
			if (files.length === 0) {
				this.log(
					`[警告] 图谱根目录下没有匹配到任何 Markdown 文件：${this.graphRoot}\n` +
						`        请确认该目录下有 pages/ 或 journals/，或在设置中修改 tineBlockRef.graphRoot。`,
				);
			}

			const stats = await this.index.rebuild(files, (filePath) => readFileText(filePath));
			this.log(
				`[索引] 完成：文件 ${stats.fileCount} / 块 ${stats.blockCount} / 带 ID ${stats.idBlockCount} / ` +
					`引用 ${stats.referenceCount} / 重复 ID ${stats.duplicateIdCount} / 解析 ${stats.elapsedMs}ms / 总 ${Date.now() - startedAt}ms`,
			);
			this.changeEmitter.fire();

			if (options.notify !== false) {
				this.notifyIndexReady(stats, files.length);
			}

			return stats;
		} finally {
			this.indexing = false;
		}
	}

	/**
	 * 右下角提示索引已完成。
	 *
	 * 用 `showInformationMessage` 而不是只写日志：用户装完插件后没有任何反馈，
	 * 会怀疑「到底有没有生效」。一条能看见的提示是最直接的确认。
	 *
	 * 注意：只有全量重建才提示。文件保存触发的增量更新不提示，
	 * 否则每改一个字就弹一次，会非常烦。
	 */
	private notifyIndexReady(stats: IndexStats, fileCount: number): void {
		if (!readConfig().showIndexNotification) {
			return;
		}

		if (fileCount === 0) {
			void vscode.window.showWarningMessage(
				`块引用解读工具：图谱目录里没有找到笔记（${this.graphRoot}）。请检查图谱目录设置。`,
			);
			return;
		}

		const seconds = (stats.elapsedMs / 1000).toFixed(1);
		void vscode.window.showInformationMessage(
			`块引用索引已建立：${stats.fileCount} 个文件 / ${stats.idBlockCount} 个带 ID 块 / ` +
				`${stats.referenceCount} 处引用（${seconds}s）`,
		);
	}

	private resolveAndSetRoot(): void {
		const root = this.resolveGraphRoot();
		if (root) {
			this.graphRoot = root;
		}
	}

	/** 列出参与索引的 Markdown 文件（绝对路径）。 */
	private async listMarkdownFiles(root: string): Promise<string[]> {
		const config = readConfig();
		const rootUri = vscode.Uri.file(root);
		const files: string[] = [];

		for (const pattern of config.include) {
			const uris = await vscode.workspace.findFiles(
				new vscode.RelativePattern(rootUri, pattern),
				// 排除模式同样相对图谱根，避免把 logseq/ 回收站扫进来。
				config.exclude.length > 0 ? `{${config.exclude.join(',')}}` : undefined,
				20000,
			);
			for (const uri of uris) {
				files.push(uri.fsPath);
			}
		}

		// 去重：多个 include 模式可能命中同一文件。
		return [...new Set(files)];
	}

	/** 挂文件监听，做增量更新。 */
	private attachWatcher(): void {
		if (!this.graphRoot) {
			return;
		}

		this.disposeWatcher();
		const pattern = new vscode.RelativePattern(vscode.Uri.file(this.graphRoot), '**/*.md');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);

		const update = async (uri: vscode.Uri): Promise<void> => {
			if (!this.isIndexedFile(uri.fsPath)) {
				return;
			}
			try {
				const content = await readFileText(uri.fsPath);
				this.index.updateFile(uri.fsPath, content);
				this.changeEmitter.fire();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`[错误] 增量更新失败 ${uri.fsPath}：${message}`);
			}
		};

		/**
		 * 磁盘变化时，若该文件在编辑器里有未保存修改，**不能**用磁盘内容覆盖索引。
		 *
		 * 竞态场景：用户保存后立刻继续打字（未保存），此时 watcher 才收到
		 * 「保存」那次变更。若照单全收，索引会被回退到保存时的旧版本，
		 * 用户刚敲的内容要等下一次防抖才恢复，中间这段时间查询结果会不对。
		 */
		const hasDirtyEditor = (filePath: string): boolean =>
			vscode.workspace.textDocuments.some(
				(document) =>
					document.uri.scheme === 'file' && document.uri.fsPath === filePath && document.isDirty,
			);

		watcher.onDidChange((uri) => {
			if (hasDirtyEditor(uri.fsPath)) {
				// 内存内容更新，磁盘版本已过期，忽略这次磁盘事件。
				return;
			}
			void update(uri);
		});
		watcher.onDidCreate((uri) => void update(uri));
		watcher.onDidDelete((uri) => {
			if (this.isIndexedFile(uri.fsPath)) {
				this.index.removeFile(uri.fsPath);
				this.changeEmitter.fire();
			}
		});

		this.watcher = watcher;
		this.disposables.push(watcher);
	}

	/**
	 * 判断文件是否位于 include 范围内、且不在 exclude 范围内。
	 *
	 * 公开这个方法是必要的：反链 CodeLens 需要知道「当前文档是否参与索引」，
	 * 否则在 `logseq/` 里的备份文件上也会显示反链，而那些文件根本不进索引。
	 */
	isIndexedFile(filePath: string): boolean {
		if (!this.graphRoot) {
			return false;
		}
		// 必须相对于「图谱根」而不是「工作区根」计算：
		// 用户可能把 VS Code 打开在图谱的父目录，两者不是一回事。
		const relative = path.relative(this.graphRoot, filePath).replace(/\\/g, '/');
		if (relative.startsWith('..')) {
			return false;
		}
		const config = readConfig();
		const inInclude = config.include.some((pattern) => matchSimpleGlob(relative, pattern));
		if (!inInclude) {
			return false;
		}
		return !config.exclude.some((pattern) => matchSimpleGlob(relative, pattern));
	}

	private disposeWatcher(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
	}

	dispose(): void {
		this.disposed = true;

		// 先清定时器：否则清理完索引之后，挂起的回调还会往里写数据。
		for (const timer of this.documentTimers.values()) {
			clearTimeout(timer);
		}
		this.documentTimers.clear();

		this.disposeWatcher();
		this.changeEmitter.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}

/** 读取文件为 UTF-8 文本。 */
export async function readFileText(filePath: string): Promise<string> {
	const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
	return new TextDecoder('utf-8').decode(data);
}
