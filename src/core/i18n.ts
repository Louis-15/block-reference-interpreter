/**
 * 国际化支持：core 层的可注入翻译器。
 *
 * 为什么不是直接 import { l10n } from 'vscode'：
 * core 层的立身之本是不依赖 vscode，320 项测试才能在 plain Node 下跑完。
 * 一旦这里引入 vscode，整套测试就再也跑不起来。
 *
 * 因此 core 只认这个抽象接口，由调用方注入实现：
 * - 扩展运行时：src/vscode/l10nSetup.ts 注入 vscode.l10n.t
 * - 单元测试：注入一份中文查表，让既有的中文断言继续有效
 *
 * 约定与 VS Code 官方一致：**源码里的 message 一律是英文**，
 * 其他语言放在 l10n/bundle.l10n.{locale}.json 里以英文原文为 key。
 * 这样用户语言的 bundle 缺失时回退到英文，而不是回退到没人看得懂的中文。
 */

/** 翻译函数签名。占位符用 `{0}`、`{1}`，与 vscode.l10n 保持一致。 */
export type Translator = (message: string, ...args: Array<string | number>) => string;

/**
 * 把 `{0}` 形式的占位符替换为实参。
 *
 * 只处理数字占位符，不做任何转义或格式化——保持与 vscode.l10n 的行为一致，
 * 避免出现「源码里看着一样、运行时结果不同」的分歧。
 * 缺失的实参保留原样，方便排查漏传参数。
 */
function interpolate(message: string, args: Array<string | number>): string {
	if (args.length === 0) {
		return message;
	}
	return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? placeholder : String(value);
	});
}

/** 默认实现：不做翻译，只做插值。英文环境下等价于直通。 */
const passthrough: Translator = (message, ...args) => interpolate(message, args);

let current: Translator = passthrough;

/**
 * 当前界面语言（BCP 47，例如 `en`、`zh-cn`）。
 *
 * Webview 的 `<html lang>` 需要它来决定断词与字体回退——中文页面标成 `en`
 * 会选到不含中文字形的字体栈，字形难看。core 层不依赖 vscode，因此同样由
 * 上层注入。
 */
let currentLocale = 'en';

/** 设置界面语言。vscode 层在 activate 时注入 `vscode.env.language`。 */
export function setLocale(locale: string): void {
	currentLocale = locale || 'en';
}

/** 读取当前界面语言，供生成 HTML 的模块拼 `lang` 属性。 */
export function locale(): string {
	return currentLocale;
}

/**
 * 替换全局翻译器。
 *
 * 之所以用模块级可变状态而不是给每个函数加 `t` 参数：core 里 124 处文案分散在
 * 8 个文件中，改签名要动所有调用链（含测试），收益却只是「更纯粹」。
 * 代价是测试之间需要重置，已由 resetTranslator 覆盖。
 */
export function setTranslator(next: Translator): void {
	current = next;
}

/** 恢复默认的直通实现。测试的 afterEach 里调用。 */
export function resetTranslator(): void {
	current = passthrough;
	currentLocale = 'en';
}

/**
 * 翻译一条文案。
 *
 * 源码中写作 `t('No notes found in the graph directory.')`，
 * 中文 bundle 里以该英文原文为 key 提供译文。
 */
export function t(message: string, ...args: Array<string | number>): string {
	return current(message, ...args);
}
