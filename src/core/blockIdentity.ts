/**
 * 块 ID 与块引用的文本层工具。
 *
 * 职责边界：
 * - 只处理字符串，不读文件、不依赖 vscode，便于在 Node 里直接单测；
 * - 生成必须严格（UUID v4），解析必须宽松（历史数据里有非 UUID、大小写混用）；
 * - 不负责「这个 ID 是否已被占用」的全库判断，查重回调由上层注入。
 */

import { randomUUID } from 'node:crypto';

/** 规范 UUID：8-4-4-4-12 十六进制，大小写不敏感。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 任意 `id::` 属性行。
 *
 * 与 blockParser 的严格 ID 正则刻意分开：
 * - 这里大小写不敏感、值可以是任意字符串，用于「发现已有 ID 并报告问题」；
 * - 严格正则只认规范 UUID，用于「把它当作可引用的块 ID」。
 *
 * 两者混用会让非 UUID 的历史 ID 被漏掉，进而重复插入第二行 `id::`。
 */
const ID_PROPERTY_PATTERN = /^([ \t]*)id::[ \t]*(.*?)[ \t]*$/i;

/** 引用形态。 */
export type BlockRefKind = 'inline' | 'embed';

/** 一行 `id::` 属性的解析结果。 */
export interface ParsedIdProperty {
	/** 整行原文。 */
	raw: string;
	/** 行首空白（Tab / 空格原样保留）。 */
	indent: string;
	/** `id::` 之后的值，已去掉首尾空白；可能为空字符串。 */
	value: string;
}

/** 判断是否为规范 UUID 形态（大小写均可）。 */
export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value.trim());
}

/**
 * 转成小写规范 UUID；不是规范形态时返回 null。
 *
 * 注意：这里只校验「8-4-4-4-12 十六进制」，不限制版本号。
 * 历史笔记里有 v8 形态的运行时 ID，它们仍应能被解析和引用，
 * 只是不应该再被生成为新的持久 ID。
 */
export function toCanonicalUuid(value: string): string | null {
	const trimmed = value.trim();
	return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** 取 UUID 的版本号（第 14 个十六进制字符）；非法 UUID 返回 null。 */
export function uuidVersion(value: string): number | null {
	const canonical = toCanonicalUuid(value);
	if (!canonical) {
		return null;
	}
	return Number.parseInt(canonical.charAt(14), 16);
}

/** 是否为 UUID v4（当前生成策略）。 */
export function isUuidV4(value: string): boolean {
	return uuidVersion(value) === 4;
}

/**
 * 是否为 v8 形态。
 *
 * Tine 运行时块 ID 实测是 v8，它只在会话内有意义、不能落盘。
 * 真实库里有少量历史泄漏的 v8；工具应提示但不应阻断引用。
 */
export function isUuidV8(value: string): boolean {
	return uuidVersion(value) === 8;
}

/** 生成器与查重回调。 */
export interface GenerateBlockUuidOptions {
	/** 判断候选 UUID 是否已被占用；由调用方注入全库查重。 */
	isTaken?: (uuid: string) => boolean;
	/** 自定义生成器，主要供测试注入；默认 `crypto.randomUUID()`。 */
	generate?: () => string;
	/** 最大重试次数，默认 64。 */
	maxAttempts?: number;
}

/**
 * 生成一个未被占用的持久块 ID。
 *
 * 为什么重试而不是直接返回 `randomUUID()`：
 * UUID v4 的碰撞概率极低，但「同一个 UUID 被复制粘贴到两个块」在笔记库里
 * 是真实存在的数据问题。生成时查重能把这类问题挡在写入之前。
 *
 * @throws 生成器连续返回非法值或始终碰撞时抛错，由调用方转成用户可见错误。
 */
export function generateBlockUuid(options: GenerateBlockUuidOptions = {}): string {
	const isTaken = options.isTaken ?? (() => false);
	const generate = options.generate ?? randomUUID;
	const maxAttempts = options.maxAttempts ?? 64;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const candidate = generate().trim().toLowerCase();
		if (!UUID_PATTERN.test(candidate)) {
			continue;
		}
		if (!isTaken(candidate)) {
			return candidate;
		}
	}

	throw new Error(`连续 ${maxAttempts} 次未能生成唯一 UUID`);
}

/** 格式化一行块 ID 属性（不含换行）。 */
export function formatIdPropertyLine(uuid: string, indent = ''): string {
	return `${indent}id:: ${uuid.trim()}`;
}

/**
 * 格式化块引用。
 *
 * 不校验 UUID：人工复制已有 ID 时必须原样输出，
 * 即使它是历史遗留的非 UUID 值（是否允许复制由上层决定并提示）。
 */
export function formatBlockRef(value: string, kind: BlockRefKind = 'inline'): string {
	const id = value.trim();
	return kind === 'embed' ? `{{embed ((${id}))}}` : `((${id}))`;
}

/** 解析一行 `id::` 属性；不是该形态时返回 null。 */
export function parseIdPropertyLine(line: string): ParsedIdProperty | null {
	const match = line.match(ID_PROPERTY_PATTERN);
	if (!match) {
		return null;
	}
	return {
		raw: line,
		indent: match[1] ?? '',
		value: (match[2] ?? '').trim(),
	};
}
