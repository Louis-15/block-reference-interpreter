/**
 * 测试用的中文翻译器。
 *
 * 单元测试断言的是中文输出（例如「反链面板应显示『还有 N 个页面未列出』」），
 * 而源码里的 message 已统一改成英文。若让测试跟着改英文断言，会失去
 * 「中文用户看到的确实是这段中文」这层保障，也会让 700 多条断言全部重写。
 *
 * 因此测试统一注入真实的中文 bundle：既验证了文案，也顺带验证了
 * bundle 的 key 与源码里的英文原文一一对应——拼错一个字母，测试立刻红。
 */

import fs from 'node:fs';
import path from 'node:path';

import { resetTranslator, setTranslator } from '../core/i18n';

const BUNDLE_PATH = path.resolve(__dirname, '../../l10n/bundle.l10n.zh-cn.json');

/** 占位符插值。与 core/i18n 的默认实现保持同样的语义。 */
function interpolate(message: string, args: Array<string | number>): string {
	if (args.length === 0) {
		return message;
	}
	return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? placeholder : String(value);
	});
}

let bundled: Record<string, string> = {};

/**
 * 注入中文 bundle，之后 `t()` 返回中文。
 *
 * 未收录的 key 回退到英文原文——这正是运行时英文用户看到的行为，
 * 也方便发现「忘了往 bundle 里加条目」。
 */
export function installChineseTranslator(): void {
	if (Object.keys(bundled).length === 0) {
		bundled = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8')) as Record<string, string>;
	}
	setTranslator((message, ...args) => interpolate(bundled[message] ?? message, args));
}

/** 恢复英文直通。需要断言英文输出的用例单独调用。 */
export function uninstallTranslator(): void {
	resetTranslator();
}

/** 读取 bundle 原文，供校验条目完整性的用例使用。 */
export function readChineseBundle(): Record<string, string> {
	if (Object.keys(bundled).length === 0) {
		bundled = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8')) as Record<string, string>;
	}
	return bundled;
}
