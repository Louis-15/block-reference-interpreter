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
import { detectGraphRoot, nodePathProbe } from '../core/graphLocator';
import type { IndexStats } from '../core/types';

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
	};
}

export class IndexService {
	private readonly index = new GraphIndex();
	private readonly disposables: vscode.Disposable[] = [];

	private graphRoot: string | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;
	private readyPromise: Promise<void> | undefined;
	private indexing = false;

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
		this.readyPromise = this.doInitialize().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`[错误] 索引初始化失败：${message}`);
		});
	}

	private async doInitialize(): Promise<void> {
		const root = await this.resolveGraphRoot();
		if (!root) {
			this.log(
				'[提示] 未找到 Tine 图谱根目录。请用命令「块引用：选择 Tine 图谱目录」指定，或在设置里填 tineBlockRef.graphRoot。',
			);
			return;
		}

		this.graphRoot = root;
		this.log(`[索引] 图谱根目录：${root}`);
		await this.rebuild();
		this.attachWatcher();
	}

	/** 解析图谱根：配置值优先，其次从工作区文件夹向上探测。 */
	private async resolveGraphRoot(): Promise<string | undefined> {
		const configured = readConfig().graphRoot;
		if (configured) {
			return configured;
		}

		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const detected = detectGraphRoot(folder.uri.fsPath, nodePathProbe);
			if (detected) {
				return detected;
			}
		}

		return undefined;
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

		await vscode.workspace
			.getConfiguration('tineBlockRef')
			.update('graphRoot', folder.fsPath, vscode.ConfigurationTarget.Global);
		this.graphRoot = folder.fsPath;
		this.disposeWatcher();
		this.readyPromise = this.rebuild().then(() => {
			this.attachWatcher();
		});
		await this.readyPromise;
	}

	/** 全量重建索引。 */
	async rebuild(): Promise<IndexStats> {
		if (this.indexing) {
			// 并发重建没有意义，直接返回当前统计，避免重复扫全库。
			return this.index.getStats();
		}
		if (!this.graphRoot) {
			await this.resolveAndSetRoot();
		}
		if (!this.graphRoot) {
			return this.index.getStats();
		}

		this.indexing = true;
		const startedAt = Date.now();
		try {
			const files = await this.listMarkdownFiles(this.graphRoot);
			const stats = await this.index.rebuild(files, (filePath) => readFileText(filePath));
			this.log(
				`[索引] 完成：文件 ${stats.fileCount} / 块 ${stats.blockCount} / 带 ID ${stats.idBlockCount} / ` +
					`引用 ${stats.referenceCount} / 重复 ID ${stats.duplicateIdCount} / 解析 ${stats.elapsedMs}ms / 总 ${Date.now() - startedAt}ms`,
			);
			this.changeEmitter.fire();
			return stats;
		} finally {
			this.indexing = false;
		}
	}

	private async resolveAndSetRoot(): Promise<void> {
		const root = await this.resolveGraphRoot();
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

		watcher.onDidChange((uri) => void update(uri));
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

	/** 判断文件是否位于 include 范围内、且不在 exclude 范围内。 */
	private isIndexedFile(filePath: string): boolean {
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

/**
 * 极简 glob 匹配（只支持 `**`、`*` 与字面量）。
 *
 * 不引入第三方 glob 库：这里只用于「文件是否在索引范围」这种粗判定，
 * 精确匹配交给 `vscode.workspace.findFiles`。多一个依赖不值得。
 */
export function matchSimpleGlob(target: string, pattern: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, '/');
	let regexSource = '';
	for (let index = 0; index < normalizedPattern.length; index++) {
		const char = normalizedPattern[index];
		if (char === '*') {
			if (normalizedPattern[index + 1] === '*') {
				// `**/` 允许零层或多层目录
				if (normalizedPattern[index + 2] === '/') {
					regexSource += '(?:.*/)?';
					index += 2;
				} else {
					regexSource += '.*';
					index += 1;
				}
			} else {
				regexSource += '[^/]*';
			}
			continue;
		}
		if (char === '?') {
			regexSource += '[^/]';
			continue;
		}
		regexSource += char !== undefined ? char.replace(/[.+^${}()|[\]\\]/g, '\\$&') : '';
	}

	try {
		return new RegExp(`^${regexSource}$`, 'i').test(target);
	} catch {
		return false;
	}
}
