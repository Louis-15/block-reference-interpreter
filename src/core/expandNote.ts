/**
 * 「把整篇笔记展开成 AI 可读版」的纯逻辑。
 *
 * 与 resolve.ts 的区别：
 * - resolve.ts 是「给一个 UUID，返回它的内容」；
 * - 本文件是「给一整篇原文，把所有块引用就地展开后返回新文本」。
 *
 * 输出格式刻意做成显式标记而不是 Markdown 引用块：
 * AI 读 Markdown 时会把 `>` 当成引用语义，反而模糊了「这是展开内容」这件事。
 * 用 `── ... ──` 这种分隔线，模型和人都能一眼看出边界。
 */

import type { ReferenceHit } from './types';

/** 展开时用的原文与命中信息。 */
export interface ExpandNoteInput {
	/** 原始行。 */
	lines: readonly string[];
	/** 引用命中（应已包含行列号）。 */
	references: readonly ReferenceHit[];
}

/** 展开选项。 */
export interface ExpandNoteOptions {
	/** 解析单个 UUID 的回调；返回空串时该处只保留原文。 */
	resolve: (uuid: string) => string;
	/** 是否在文件头部加一段说明。 */
	includeHeader?: boolean;
	/** 头部说明里的文件名（用于让人知道这是哪篇笔记的展开版）。 */
	fileName?: string;
}

/** 生成展开标记的开始行。 */
function expandStartMarker(uuid: string): string {
	return `── 块引用 ((${uuid})) 展开 ──`;
}

/** 生成展开标记的结束行。 */
function expandEndMarker(): string {
	return '── 展开结束 ──';
}

/**
 * 把所有块引用就地展开。
 *
 * 处理策略：
 * - 引用所在的原始行原样保留（不篡改笔记正文，UUID 仍可追溯）；
 * - 在该行之后插入展开内容；
 * - 同一行多个引用依次插入；
 * - 已在扫描阶段排除的假阳性（代码块、行内代码、frontmatter）不会出现在 references 里，
 *   因此代码示例不会被破坏。
 */
export function buildExpandedNote(input: ExpandNoteInput, options: ExpandNoteOptions): string {
	const hitsByLine = new Map<number, ReferenceHit[]>();
	for (const hit of input.references) {
		const existing = hitsByLine.get(hit.line);
		if (existing) {
			existing.push(hit);
		} else {
			hitsByLine.set(hit.line, [hit]);
		}
	}

	const out: string[] = [];

	if (options.includeHeader) {
		const name = options.fileName ?? '当前笔记';
		// 刻意不用 `>` 引用块：AI 会把引用块当成「被引用的他人内容」，
		// 而这里是本文档自身的说明，用普通段落语义更准。
		out.push(
			`<!-- 本文件由「块引用解释器」生成：${name} 的 AI 可读版 -->`,
			'',
			`**说明**：原文中的 \`((uuid))\` 块引用已在下方就地展开，原文行保持不变。全文共 ${input.references.length} 处块引用。`,
			'',
			'---',
			'',
		);
	}

	for (let lineNumber = 0; lineNumber < input.lines.length; lineNumber++) {
		out.push(input.lines[lineNumber] ?? '');

		const hits = hitsByLine.get(lineNumber);
		if (!hits || hits.length === 0) {
			continue;
		}

		// 同一行重复引用同一个 UUID 时只展开一次，避免输出翻倍。
		const expanded = new Set<string>();
		for (const hit of hits) {
			if (expanded.has(hit.uuid)) {
				continue;
			}
			expanded.add(hit.uuid);

			const content = options.resolve(hit.uuid);
			if (!content) {
				continue;
			}

			out.push('', expandStartMarker(hit.uuid), content, expandEndMarker(), '');
		}
	}

	return out.join('\n');
}
