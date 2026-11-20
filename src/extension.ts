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
import { BlockReferenceHoverProvider } from './vscode/hoverProvider';
import { IndexService } from './vscode/indexService';
import { BlockReferenceInlineRenderer, describeInlineRenderer } from './vscode/inlineRenderer';
import { ReadOnlyContentProvider, VIRTUAL_SCHEME } from './vscode/readOnlyContent';
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
