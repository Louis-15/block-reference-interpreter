/**
 * 只读虚拟文档：把生成的内容显示成「关掉不会问你要不要保存」的标签页。
 *
 * 为什么不能直接用 `workspace.openTextDocument({ content })`：
 * 那种方式创建的是 untitled 文档，关标签页时 VS Code 一定会弹「是否保存」。
 * 扩展没有任何 API 能抑制这个提示。
 *
 * 真正的解决方式是注册一个**只读的虚拟文件系统**：
 * - `registerFileSystemProvider(..., { isReadonly: true })` 声明为只读；
 * - VS Code 不会让用户编辑，文档永远不会变「脏」；
 * - 关闭时因此不会提示保存。
 *
 * 这样既保留了文本编辑器的完整体验（语法高亮、查找、选中、复制），
 * 又不会产生任何磁盘文件。
 */

import * as vscode from 'vscode';

import { t } from '../core/i18n';

/** 自定义 scheme。加前缀是为了避免与其他扩展的 scheme 冲突。 */
export const VIRTUAL_SCHEME = 'tine-blockref';

/** 一个虚拟文档条目。 */
interface VirtualEntry {
	content: string;
	/** 显示用的标题（不含扩展名）。 */
	title: string;
	/** 该文档上的可点击链接。 */
	links: ReadOnlyLink[];
}

/**
 * 只读文档上的一条可点击链接。
 *
 * 用「坐标 + 命令」而不是 Markdown `[文字](command:...)` 语法：
 * 面板是纯文本编辑器里的只读文档，写成 Markdown 语法会把一长串 URI
 * 直接糊在正文中，既难读又会被误编辑。
 */
export interface ReadOnlyLink {
	/** 0-based 行号。 */
	line: number;
	/** 0-based 起始列。 */
	startColumn: number;
	/** 0-based 结束列（不含）。 */
	endColumn: number;
	/** 点击时执行的命令。 */
	command: string;
	/** 命令参数。 */
	arguments: unknown[];
	/** 悬停说明。 */
	tooltip?: string;
}

export class ReadOnlyContentProvider implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly entries = new Map<string, VirtualEntry>();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	/** 递增序号：保证同名内容每次展开都得到独立 URI，不会串内容。 */
	private sequence = 0;

	readonly onDidChangeFile = this.changeEmitter.event;

	/** 内容都是内存里现算的，不存在外部变化，监听直接返回空实现。 */
	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	stat(uri: vscode.Uri): vscode.FileStat {
		const entry = this.entries.get(uri.toString());
		if (!entry) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: Date.now(),
			// size 用 UTF-8 字节数，避免中文被按字符数算错。
			size: Buffer.byteLength(entry.content, 'utf8'),
		};
	}

	readDirectory(): [string, vscode.FileType][] {
		// 没有目录结构，所有文档都平铺在根下。
		return [];
	}

	readFile(uri: vscode.Uri): Uint8Array {
		const entry = this.entries.get(uri.toString());
		if (!entry) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return Buffer.from(entry.content, 'utf8');
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions(
			t('The Block Reference Interpreter virtual document system does not support creating directories'),
		);
	}

	writeFile(): void {
		// 只读：抛 NoPermissions 而不是静默忽略，这样若真有写入尝试能立刻暴露。
		throw vscode.FileSystemError.NoPermissions(
			t('Block Reference Interpreter virtual documents are read-only'),
		);
	}

	delete(): void {
		throw vscode.FileSystemError.NoPermissions(
			t('Block Reference Interpreter virtual documents cannot be deleted'),
		);
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions(
			t('Block Reference Interpreter virtual documents cannot be renamed'),
		);
	}

	/**
	 * 登记一份内容并返回可打开的 URI。
	 *
	 * URI 里带递增序号：同一个块连续展开两次会得到两个独立标签页，
	 * 否则第二次会命中已存在的文档、显示上一次的旧内容。
	 *
	 * @param title 标签页显示的名字（不含 .md）
	 * @param content 文本内容
	 * @param links 该文档上需要变成可点击的片段
	 */
	register(title: string, content: string, links: ReadOnlyLink[] = []): vscode.Uri {
		const safeTitle = sanitizeFileName(title);
		this.sequence += 1;
		const suffix = this.sequence.toString(36);
		const uri = vscode.Uri.parse(`${VIRTUAL_SCHEME}:/${encodeURIComponent(safeTitle)}-${suffix}.md`);
		this.entries.set(uri.toString(), { content, title: safeTitle, links });
		return uri;
	}

	/**
	 * 取某份虚拟文档上的链接。
	 *
	 * 返回 `undefined` 表示这不是本 provider 管理的文档，
	 * 调用方据此跳过，不要当成「没有链接」处理。
	 */
	getLinks(uri: vscode.Uri): ReadOnlyLink[] | undefined {
		return this.entries.get(uri.toString())?.links;
	}

	/** 清理某份内容（文档关闭时调用，避免长会话累积内存）。 */
	release(uri: vscode.Uri): void {
		this.entries.delete(uri.toString());
	}

	dispose(): void {
		this.entries.clear();
		this.changeEmitter.dispose();
	}
}

/** 文件名里不能出现的字符替换掉，否则 URI 解析会出问题。 */
function sanitizeFileName(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > 0 ? cleaned : 'block-reference';
}

/**
 * 以只读方式打开一份内容。
 *
 * @param links 该文档上需要变成可点击的片段
 * @returns 打开成功返回 true
 */
export async function openReadOnlyContent(
	provider: ReadOnlyContentProvider,
	title: string,
	content: string,
	links: ReadOnlyLink[] = [],
): Promise<boolean> {
	const uri = provider.register(title, content, links);
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });
		return true;
	} catch {
		// 打开失败时回滚登记，避免留下悬空条目。
		provider.release(uri);
		return false;
	}
}
