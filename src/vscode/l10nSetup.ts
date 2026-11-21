/**
 * 把界面语言接入 core 层的翻译抽象。
 *
 * 为什么自己读 bundle 而不用 `vscode.l10n.t`：
 * 后者只会按 **VS Code 的界面语言** 选择 bundle，扩展无法让它改用别的语言。
 * 而本扩展提供了 `tineBlockRef.language` 设置，允许用户单独指定本扩展的语言。
 * 要做到这一点，只能自己加载 `l10n/bundle.l10n.{locale}.json` 并查表。
 *
 * 已知边界：`package.nls.json` 那部分（命令标题、设置项名称与描述）仍然只能跟随
 * VS Code 界面语言——那些字符串由编辑器渲染命令面板与设置页时读取，
 * 扩展没有运行时改写它们的接口。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { setLocale, setTranslator, type Translator } from '../core/i18n';

/** 语言设置的取值。`auto` 表示跟随 VS Code 界面语言。 */
export type LanguageSetting = 'auto' | 'en' | 'zh-cn';

/** 本扩展实际发布过翻译 bundle 的 locale 标识。 */
const BUNDLED_LOCALES = ['zh-cn'] as const;

/** 已加载的 bundle 缓存，避免每次重装翻译器都读盘。 */
const bundleCache = new Map<string, Record<string, string>>();

/** 占位符插值，语义与 core/i18n 的默认实现保持一致。 */
function interpolate(message: string, args: Array<string | number>): string {
	if (args.length === 0) {
		return message;
	}
	return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? placeholder : String(value);
	});
}

/**
 * 把任意来源的语言标识归一到「我们真的有 bundle 的那个」。
 *
 * `env.language` 可能是 `zh-cn`、`zh-CN`，语言包也可能是 `zh-hans` 这类变体。
 * 繁体（`zh-hant` / `zh-tw`）刻意不归一：简体译文给繁体用户看并不合适，
 * 宁可回退英文原文。
 */
function resolveBundledLocale(language: string): string | undefined {
	const normalized = language.toLowerCase();
	if ((BUNDLED_LOCALES as readonly string[]).includes(normalized)) {
		return normalized;
	}
	const [primary, variant] = normalized.split('-');
	if (primary === 'zh' && variant !== 'hant' && variant !== 'tw' && variant !== 'hk') {
		return 'zh-cn';
	}
	return undefined;
}

/** 读取并缓存某个 locale 的 bundle；文件不存在时返回 undefined。 */
function loadBundle(extensionRoot: string, localeId: string): Record<string, string> | undefined {
	const cached = bundleCache.get(localeId);
	if (cached) {
		return cached;
	}
	const file = path.join(extensionRoot, 'l10n', `bundle.l10n.${localeId}.json`);
	try {
		const table = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
		bundleCache.set(localeId, table);
		return table;
	} catch {
		return undefined;
	}
}

/** 读取当前的语言设置。 */
export function readLanguageSetting(): LanguageSetting {
	const value = vscode.workspace.getConfiguration('tineBlockRef').get<string>('language', 'auto');
	return value === 'en' || value === 'zh-cn' ? value : 'auto';
}

/**
 * 安装翻译器。必须在 activate 的最早处调用，core 层的所有 `t()` 都依赖它。
 *
 * 语言优先级：显式设置 > VS Code 界面语言。目标语言没有 bundle 时回退到源码里的
 * 英文原文——英文界面的正常路径就是这样，不需要额外的 en bundle。
 */
export function installTranslator(context: vscode.ExtensionContext): void {
	const setting = readLanguageSetting();
	const effective = setting === 'auto' ? vscode.env.language : setting;
	setLocale(effective);

	const bundled = resolveBundledLocale(effective);
	const table = bundled ? loadBundle(context.extensionUri.fsPath, bundled) : undefined;

	if (!table) {
		const passthrough: Translator = (message, ...args) => interpolate(message, args);
		setTranslator(passthrough);
		return;
	}

	setTranslator((message, ...args) => interpolate(table[message] ?? message, args));
}

/**
 * 把 package.nls 里的清单文案取出来，供需要复用的地方使用。
 *
 * 这部分跟随的是 **VS Code 界面语言**，不受 `tineBlockRef.language` 影响。
 */
export function manifestMessage(key: string): string {
	const value: unknown = vscode.l10n.bundle?.[key];
	return typeof value === 'string' ? value : key;
}
