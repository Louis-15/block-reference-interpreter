/**
 * 页面标题（`title::`）读取。
 *
 * Tine / Logseq 允许页面在前言区写 `title:: 页面名`。此时**页面名是标题，
 * 不是文件名**——Tine 里侧边栏、反链面板显示的都是 `title::` 的值。
 *
 * 规则对齐 Tine 的 `tine_core::model::page_title_from_preamble`：
 * 取**前言区里第一个非空 `title::`**，前言区止于第一个块。
 * 块内部的 `title::` 属于那个块，不是页面名。
 *
 * 只处理 Markdown 的 `title::`。Org 的 `#+title:` 与 `:title:` 不在本插件范围
 * （插件只注册 `.md`）。
 */

import type { ParsedFile } from './types';

/**
 * 页面属性里的 `title::` 行。
 *
 * 大小写不敏感，与解析器的属性键判定保持一致（`BLOCK_PROPERTY_REGEX` 也允许
 * `Title::`）。值可以为空，空值视为「没有标题」，继续看后面的页面属性。
 */
const PAGE_TITLE_LINE_REGEX = /^\s*title::[ \t]*(.*)$/i;

/**
 * 取页面的 `title::`；没有时返回 `undefined`。
 *
 * `pageProperties` 由 `parseMarkdown` 在遇到第一个块之前收集，
 * 天然满足「标题必须位于第一个块之前」这条约束，无需在这里重新判断位置。
 */
export function getPageTitle(parsed: ParsedFile): string | undefined {
	for (const line of parsed.pageProperties) {
		const match = PAGE_TITLE_LINE_REGEX.exec(line);
		const value = match?.[1]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}
