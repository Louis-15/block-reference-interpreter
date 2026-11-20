/**
 * 悬停内容的统一构建。
 *
 * 为什么抽出来：行内渲染与 HoverProvider 都要显示「块 + 子块」，
 * 两处各写一份必然走偏。抽成一个函数，改一处两边同步。
 *
 * 布局策略（围绕一个硬限制设计）：
 * VS Code 的 hover 只能返回**一个** MarkdownString，全部内容渲染在同一个
 * 有最大高度的滚动容器里，没有任何 API 能生成独立的悬浮容器。
 * 既然无法「固定」按钮，那就让内容**根本不需要滚动**：
 * 预览行数默认压到 6 行，整体高度远低于容器上限，
 * 于是底部的按钮永远可见，鼠标不必滚动即可点击。
 * 行数可由 `tineBlockRef.hoverPreviewLines` 调整；
 * 调得过大时仍可能出现滚动，那是配置取舍而非布局缺陷。
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

/**
 * 生成底部的操作行。
 *
 * 只放「展开全文」一个链接。
 *
 * 为什么不再放「反向链接」：被引块的来源文件与行号已经显示在悬停最上方，
 * 用户点过去就能看到，再挂一个反链入口属于重复信息。
 * 反向链接功能本身保留为独立命令（命令面板可调）。
 *
 * 为什么不再手写 `（Ctrl+Click）`：
 * VS Code 会为 DocumentLink 自动追加 `(ctrl + 单击)` 提示。
 * 自己再写一遍就变成两行重复说明。
 */
function buildExpandLink(uuid: string): string {
	return `[展开全文](command:blockReferenceInterpreter.expandBlockById?${encodeCommandArgs([uuid])})`;
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
		markdown.appendMarkdown(`UUID \`${uuid}\` 没有对应的块。可能已被删除，或引用来自其他图谱。`);
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

		if (config.hoverPreviewLines > 0) {
			const preview = buildPreview(candidate, config, title);
			if (preview) {
				// 用代码块包裹：既能保留缩进结构，也避免笔记里的 ==高亮== 等语法在 hover 里被渲染。
				markdown.appendCodeblock(preview, 'markdown');
			}
		}

		// 按钮放最后；前面刻意不写「已截断」提示——来源行已有总行数，
		// 「展开全文」本身也说明了还有更多内容，再占一行不划算。
		markdown.appendMarkdown(`\n${buildExpandLink(uuid)}`);
	}

	return markdown;
}

/**
 * 生成预览文本：渲染整棵子树后按行截断。
 *
 * 预览刻意包含子块：只显示块首行往往是一句概括，「背后的内容」恰恰在子块里。
 *
 * @param displayedTitle 上方已经单独用粗体显示过的标题。
 *   渲染结果的第一行与它重复，这里直接跳过——悬停框的每一行高度都很宝贵。
 */
function buildPreview(
	candidate: BlockLookupResult,
	config: HoverContentConfig,
	displayedTitle: string,
): string {
	const rendered = renderBlockTree(candidate.parsed, candidate.blockIndex, {
		includeChildren: true,
		hideProperties: config.hideProperties,
		stripHeadingMarks: config.stripHeadingMarks,
	});

	const lines = rendered.split('\n');
	if ((lines[0] ?? '').trim() === displayedTitle.trim()) {
		lines.shift();
	}

	// 去掉开头因跳过标题而产生的空行。
	while (lines.length > 0 && (lines[0] ?? '').trim() === '') {
		lines.shift();
	}

	if (lines.length === 0) {
		return '';
	}
	if (lines.length <= config.hoverPreviewLines) {
		return lines.join('\n');
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
