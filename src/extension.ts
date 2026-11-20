/**
 * 扩展激活入口：只负责「注册」，具体逻辑都在各自模块里。
 *
 * 这样拆的原因是：每加一个能力都要往这里添一行注册，
 * 如果把实现也堆进来，这个文件会迅速膨胀到难以维护。
 */

import * as vscode from 'vscode';

import {
	expandBlockAtCursor,
	expandBlockById,
	expandCurrentNote,
	showBacklinks,
	showBacklinksAtCursor,
	type CommandDeps,
} from './vscode/commands/expandCommands';
import { showBacklinksPanel } from './vscode/commands/backlinkPanel';
import { openBacklinkAt } from './vscode/commands/backlinkJump';
import { OPEN_BACKLINK_AT_COMMAND, SHOW_BACKLINKS_PANEL_COMMAND } from './vscode/backlinkCommands';
import { BacklinkInlayProvider } from './vscode/backlinkInlay';
import { BacklinkLensProvider } from './vscode/backlinkLens';
import { BlockReferenceHoverProvider } from './vscode/hoverProvider';
import { IndexService, readConfig } from './vscode/indexService';
import { BlockReferenceInlineRenderer, describeInlineRenderer } from './vscode/inlineRenderer';
import { ReadOnlyContentProvider, VIRTUAL_SCHEME } from './vscode/readOnlyContent';
import { VirtualDocumentLinkProvider } from './vscode/virtualDocumentLinks';
import { FindBacklinksTool } from './vscode/tools/findBacklinksTool';
import { ReadBlockTool } from './vscode/tools/readBlockTool';
import { ReadNoteTool } from './vscode/tools/readNoteTool';

/** 输出通道名，便于用户在输出面板里筛。 */
const OUTPUT_CHANNEL_NAME = '块引用解释器';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const log = (message: string): void => {
		output.appendLine(message);
	};

	const indexService = new IndexService(log);
	context.subscriptions.push(output);
	context.subscriptions.push({ dispose: () => indexService.dispose() });

	// 只读虚拟文档：展开内容用它显示，关标签页时不会问「是否保存」。
	const contentProvider = new ReadOnlyContentProvider();
	context.subscriptions.push(contentProvider);
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(VIRTUAL_SCHEME, contentProvider, { isReadonly: true }),
	);

	// 只读文档上的可点击链接（反链面板的块名）。
	// 文本编辑器不认 Markdown 的 [](...) 语法，必须走 DocumentLink。
	context.subscriptions.push(
		vscode.languages.registerDocumentLinkProvider(
			{ scheme: VIRTUAL_SCHEME },
			new VirtualDocumentLinkProvider(contentProvider),
		),
	);
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((document) => {
			if (document.uri.scheme === VIRTUAL_SCHEME) {
				contentProvider.release(document.uri);
			}
		}),
	);

	const deps: CommandDeps = {
		getIndex: () => indexService.getIndex(),
		ensureReady: () => indexService.ensureReady(),
		getGraphRoot: () => indexService.getGraphRoot(),
		log,
		contentProvider,
	};

	registerCommands(context, indexService, deps, output);
	registerHover(context, deps);
	registerInlineRenderer(context, indexService, deps, log);
	registerBacklinkMarkers(context, indexService, deps, log);
	registerLanguageModelTools(context, indexService, log);

	// 后台初始化：不阻塞激活，用到索引的功能会自己 await。
	indexService.initialize();
}

/**
 * 注册全部命令。
 *
 * 命令 ID 必须与 package.json 的 `contributes.commands` 一一对应，
 * 否则命令会注册成功但不出现在命令面板里。
 */
function registerCommands(
	context: vscode.ExtensionContext,
	indexService: IndexService,
	deps: CommandDeps,
	output: vscode.OutputChannel,
): void {
	const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	};

	register('blockReferenceInterpreter.expandCurrentNote', () => expandCurrentNote(deps));
	register('blockReferenceInterpreter.expandBlockAtCursor', () => expandBlockAtCursor(deps));

	// hover 里的链接会带一个 UUID 参数，因此这里必须原样透传。
	register('blockReferenceInterpreter.expandBlockById', (uuid) =>
		expandBlockById(deps, typeof uuid === 'string' ? uuid : undefined),
	);
	register('blockReferenceInterpreter.showBacklinks', (uuid) =>
		showBacklinks(deps, typeof uuid === 'string' ? uuid : undefined),
	);
	register('blockReferenceInterpreter.showBacklinksAtCursor', () => showBacklinksAtCursor(deps));

	// CodeLens / 行尾徽章与手动命令共用同一个面板入口。
	register(SHOW_BACKLINKS_PANEL_COMMAND, (uuid) =>
		showBacklinksPanel(deps, typeof uuid === 'string' ? uuid : undefined),
	);

	// 悬停列表里点页面名时调用：直接跳到引用那一行。
	register(OPEN_BACKLINK_AT_COMMAND, (targetPath, line) =>
		openBacklinkAt(
			typeof targetPath === 'string' ? targetPath : '',
			typeof line === 'number' ? line : 0,
		),
	);

	register('blockReferenceInterpreter.rebuildIndex', async () => {
		// 完成提示统一由 indexService 的右下角通知负责，这里只显示进度，避免弹两次。
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: '块引用解释器：重建索引' },
			() => indexService.rebuild({ notify: true }),
		);
	});

	register('blockReferenceInterpreter.selectGraphRoot', async () => {
		// switchTo → rebuild 会自动弹出索引结果提示；用户取消选择时 switchTo 不会被调用，也就不会误报。
		await indexService.selectGraphRoot();
	});

	register('blockReferenceInterpreter.showLog', () => output.show(true));
}

/** 注册悬停预览（显示块 + 子块）。 */
function registerHover(context: vscode.ExtensionContext, deps: CommandDeps): void {
	const provider = new BlockReferenceHoverProvider(
		deps.getIndex,
		deps.ensureReady,
		deps.getGraphRoot,
		deps.log,
	);

	context.subscriptions.push(
		// 只对 Markdown 生效；provider 内部还会再判断是否在图谱目录内。
		vscode.languages.registerHoverProvider([{ language: 'markdown' }], provider),
	);
	deps.log('[悬停] 已注册 Markdown 悬停预览提供者');

	// 文档关闭时释放该文档的扫描缓存，避免长会话里缓存越积越多。
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((document) => provider.forget(document)),
	);
}

/** 注册行内渲染：把 ((uuid)) 显示成目标块标题。 */
function registerInlineRenderer(
	context: vscode.ExtensionContext,
	indexService: IndexService,
	deps: CommandDeps,
	log: (message: string) => void,
): void {
	const renderer = new BlockReferenceInlineRenderer(
		deps.getIndex,
		deps.ensureReady,
		deps.getGraphRoot,
		log,
		indexService.onDidChange,
	);
	context.subscriptions.push(renderer);

	// 索引就绪后补渲染一次：激活时 visibleTextEditors 可能还没有内容，
	// 或索引尚未建好导致首轮渲染不出东西。
	void deps
		.ensureReady()
		.then(() => renderer.renderAllVisible())
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			log(`[错误] 首轮行内渲染失败：${message}`);
		});

	log(`[渲染] ${describeInlineRenderer()}`);
}

/**
 * 注册反链标记（右侧徽章或块上方 CodeLens）。
 *
 * 这是「像 Tine 那样在页面里看到反链」的落地方式：
 * 默认在每个被引用过的块**行尾**显示 `🔗 2`，点击打开完整面板。
 */
function registerBacklinkMarkers(
	context: vscode.ExtensionContext,
	indexService: IndexService,
	deps: CommandDeps,
	log: (message: string) => void,
): void {
	const anchorDeps = {
		getIndex: deps.getIndex,
		ensureReady: deps.ensureReady,
		isIndexedFile: (filePath: string) => indexService.isIndexedFile(filePath),
		log,
	};

	const inlay = new BacklinkInlayProvider(anchorDeps, () => readConfig().backlinkStyle === 'inline');
	const lens = new BacklinkLensProvider(anchorDeps, () => readConfig().backlinkStyle === 'lens');
	context.subscriptions.push(inlay, lens);

	context.subscriptions.push(
		vscode.languages.registerInlayHintsProvider({ language: 'markdown', scheme: 'file' }, inlay),
		vscode.languages.registerCodeLensProvider({ language: 'markdown', scheme: 'file' }, lens),
	);

	const refreshAll = (): void => {
		inlay.refresh();
		lens.refresh();
	};

	// 索引变了必须主动刷新：引用来自**别的文件**，当前文档版本号不变，
	// 不刷新的话用户刚在别处加了一条引用，这边还是旧数字。
	context.subscriptions.push(indexService.onDidChange(refreshAll));

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('tineBlockRef.backlinks')) {
				refreshAll();
			}
		}),
	);

	// 文档关闭时清缓存，避免同一路径重开拿到旧数据。
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((document) => {
			inlay.forgetDocument(document.uri);
			lens.forgetDocument(document.uri);
		}),
	);

	// 索引就绪后补刷新一次：激活时索引还没建好，首轮查询会全部落空。
	void deps
		.ensureReady()
		.then(refreshAll)
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			log(`[错误] 反链标记首轮刷新失败：${message}`);
		});

	log('[反链] 已注册反链标记（块行尾显示 🔗 N，点击打开反链面板）');
}

/**
 * 注册三个 AI 工具。
 *
 * 单独抽出来是为了在 `vscode.lm` 不可用（旧版 VS Code）时安静降级：
 * 命令与悬停功能仍然能用，只是 AI 拿不到工具。
 */
function registerLanguageModelTools(
	context: vscode.ExtensionContext,
	indexService: IndexService,
	log: (message: string) => void,
): void {
	if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
		log('[提示] 当前 VS Code 版本不支持 Language Model Tool，AI 工具未注册。命令功能不受影响。');
		return;
	}

	const getIndex = () => indexService.getIndex();
	const ensureReady = () => indexService.ensureReady();
	const getGraphRoot = () => indexService.getGraphRoot();

	try {
		context.subscriptions.push(
			vscode.lm.registerTool('tineBlockRef_readBlock', new ReadBlockTool(getIndex, ensureReady)),
			vscode.lm.registerTool('tineBlockRef_readNote', new ReadNoteTool(getIndex, ensureReady, getGraphRoot)),
			vscode.lm.registerTool(
				'tineBlockRef_findBacklinks',
				new FindBacklinksTool(getIndex, ensureReady, getGraphRoot),
			),
		);
		log('[工具] 已注册 3 个 AI 工具：readBlock / readNote / findBacklinks');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`[错误] 注册 AI 工具失败：${message}`);
	}
}

export function deactivate(): void {
	// 资源都在 context.subscriptions 里统一释放，这里无需额外处理。
}
