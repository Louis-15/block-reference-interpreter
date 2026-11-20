/**
 * 悬停内容的统一构建。
 *
 * 为什么抽出来：行内渲染与 HoverProvider 都要显示「块 + 子块」，
 * 两处各写一份必然走偏。抽成一个函数，改一处两边同步。
 *
 * 关于链接位置的取舍：
 * VS Code 的 hover 内容整体放在一个可滚动容器里，**没有** API 能让某个元素
 * 固定悬浮在底部。内容一长，「展开全文 / 反向链接」就会被滚出视野。
 * 所以这里的做法是**顶部和底部各放一份**——滚到哪一端都能点到。
 */

import * as vscode from 'vscode';

import type { BlockLookupResult, GraphIndex } from '../core/graphIndex';
import { getBlockTitle, measureSubtree, renderBlockTree, stripHeadingMarks } from '../core/render';
import { encodeCommandArgs } from './tools/common';

/** 构建悬停内容所需的配置。 */
export interface HoverContentConfig {
	/** 预览显示多少行。 */
	hoverPreviewLines: number;
	/** 渲染时隐藏的属性名。 */
	hideProperties: string[];
	/** 是否去掉标题的 `#` 标记。 */
	stripHeadingMarks: boolean;
}

/** 生成「展开全文 · 反向链接」这一行链接。 */
function buildActionLinks(uuid: string): string {
	const expandLink = `[展开全文](command:blockReferenceInterpreter.expandBlockById?${encodeCommandArgs([uuid])})`;
	const backlinkLink = `[反向链接](command:blockReferenceInterpreter.showBacklinks?${encodeCommandArgs([uuid])})`;
	return `${expandLink} · ${backlinkLink}`;
}

/**
 * 生成某个 UUID 的悬停 Markdown。
 *
 * 覆盖三种情况：
 * - 块存在：写来源、规模、首行标题，再给一段内容预览
 * - 块不存在：明确说「未找到」，并给反链查询入口
 * - 重复定义：列出全部候选，让用户自己判断
 */
export function buildBlockHover(
	index: GraphIndex,
	uuid: string,
	config: HoverContentConfig,
): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = true;
	markdown.supportHtml = false;

	const candidates = index.lookupBlocks(uuid);

	if (candidates.length === 0) {
		markdown.appendMarkdown('**⚠ 未找到该块**\n\n');
		markdown.appendMarkdown(`UUID \`${uuid}\` 没有对应的块。可能已被删除，或引用来自其他图谱。\n\n`);
		markdown.appendMarkdown(
			`[反向链接](command:blockReferenceInterpreter.showBacklinks?${encodeCommandArgs([uuid])})`,
		);
		return markdown;
	}

	if (candidates.length > 1) {
		markdown.appendMarkdown(
			`**⚠ 该 UUID 在 ${candidates.length} 处重复定义**（可能被复制粘贴过），以下是全部候选：\n\n`,
		);
	}

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		if (!candidate) {
			continue;
		}
		const block = candidate.parsed.blocks[candidate.blockIndex];
		if (!block) {
			continue;
		}

		if (candidates.length > 1) {
			markdown.appendMarkdown(`---\n\n**候选 ${candidateIndex + 1} / ${candidates.length}**\n\n`);
		}

		const size = measureSubtree(candidate.parsed, candidate.blockIndex);
		const sourcePath = vscode.workspace.asRelativePath(candidate.location.path, false).replace(/\\/g, '/');
		markdown.appendMarkdown(
			`\`${sourcePath}\` 第 ${block.startLine + 1} 行 · ${size.lines} 行 / ${size.chars} 字符\n\n`,
		);

		const rawTitle = getBlockTitle(block.ownLines[0] ?? '');
		const title = config.stripHeadingMarks ? stripHeadingMarks(rawTitle) : rawTitle;
		markdown.appendMarkdown(`**${title}**\n\n`);

		// 顶部链接：内容很长时用户不用滚到最底下才能操作。
		markdown.appendMarkdown(`${buildActionLinks(uuid)}\n\n`);

		if (config.hoverPreviewLines > 0) {
			const preview = buildPreview(candidate, config);
			if (preview) {
				// 用代码块包裹：既能保留缩进结构，也避免笔记里的 ==高亮== 等语法在 hover 里被渲染。
				markdown.appendCodeblock(preview, 'markdown');
			}

			if (size.lines > config.hoverPreviewLines) {
				markdown.appendMarkdown(`\n（仅显示前 ${config.hoverPreviewLines} 行，完整内容见下方链接）\n\n`);
			}
		}

		// 底部再放一份：内容短时用户视线已经在下方，不必再回到顶部。
		markdown.appendMarkdown(buildActionLinks(uuid));
	}

	return markdown;
}

/**
 * 生成预览文本：渲染整棵子树后按行截断。
 *
 * 预览刻意包含子块：只显示块首行往往是一句概括，「背后的内容」恰恰在子块里。
 */
function buildPreview(candidate: BlockLookupResult, config: HoverContentConfig): string {
	const rendered = renderBlockTree(candidate.parsed, candidate.blockIndex, {
		includeChildren: true,
		hideProperties: config.hideProperties,
		stripHeadingMarks: config.stripHeadingMarks,
	});
	const lines = rendered.split('\n');
	if (lines.length <= config.hoverPreviewLines) {
		return rendered;
	}
	return [...lines.slice(0, config.hoverPreviewLines), '…'].join('\n');
}

/**
 * 取某个 UUID 在行内渲染时显示的标题文本。
 *
 * hover 用它来推算「替换文本的视觉宽度」，从而判断鼠标是否落在这段虚拟文字上。
 * 与 inlineRenderer 的显示规则必须保持一致，否则定位会错位。
 */
export function getInlineTitle(
	index: GraphIndex,
	uuid: string,
	maxTitleLength: number,
	showMissing: boolean,
	stripMarks: boolean,
): string | undefined {
	const candidates = index.lookupBlocks(uuid);

	if (candidates.length === 0) {
		return showMissing ? '⚠ 块不存在' : undefined;
	}

	const first = candidates[0];
	if (!first) {
		return undefined;
	}
	const block = first.parsed.blocks[first.blockIndex];
	if (!block) {
		return undefined;
	}

	let title = getBlockTitle(block.ownLines[0] ?? '');
	if (stripMarks) {
		title = stripHeadingMarks(title);
	}
	if (title.length === 0) {
		title = '（空块）';
	}
	if (candidates.length > 1) {
		title = `${title}（${candidates.length} 处重复）`;
	}

	return truncateTitle(title, maxTitleLength);
}

/** 标题过长会把这行撑爆，截断并加省略号。 */
export function truncateTitle(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength)}…`;
}
