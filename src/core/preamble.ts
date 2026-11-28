/**
 * 前言区（preamble）跳过：frontmatter 与文件开头的页面属性。
 *
 * 为什么单独成模块：
 * - 这段逻辑只跑一次、位于解析最前面，与「逐行构建块树」无关；
 * - `blockParser.ts` 已逼近 400 行警戒线；
 * - 「哪里是第一个块」在 Tine 语义里是一条独立规则（页面属性必须位于第一个块之前），
 *   独立出来后更容易和 Tine 的 `page_title_from_preamble` 对照。
 */

import { isBlankLine } from './blockLine';

/**
 * 页面属性行（文件开头、非列表、形如 `key:: value`）。
 *
 * `[^-\s]` 排除了列表行与水平线，避免把 `- xxx` 误判成属性。
 */
const PAGE_PROPERTY_REGEX = /^\s*[^-\s].*?::\s*.*$/;

/** 跳过前言区后的结果。 */
export interface PreambleResult {
	/** 第一个块所在行（0-based）；整篇都是前言区时等于 `lines.length`。 */
	startLine: number;
	/** 文件开头的页面属性行原文，供 `title::` 等用途读取。 */
	pageProperties: string[];
}

/**
 * 跳过 frontmatter 与文件开头的页面属性，返回第一个块的位置。
 *
 * 两阶段的顺序不能颠倒：frontmatter 必须在页面属性之前跳过，
 * 否则 `---` 里的 `title:` 会被当成页面属性 `title::` 的近亲（虽然后者要求双冒号，
 * 但 `key:: value` 形态在 YAML 里也可能出现）。
 */
export function skipPreamble(lines: readonly string[]): PreambleResult {
	const pageProperties: string[] = [];
	let lineNumber = 0;

	// ---------- 第一阶段：跳过 frontmatter ----------
	if (lines.length > 0 && (lines[0] ?? '').trim() === '---') {
		lineNumber = 1;
		while (lineNumber < lines.length) {
			const trimmed = (lines[lineNumber] ?? '').trim();
			lineNumber++;
			if (trimmed === '---' || trimmed === '...') {
				break;
			}
		}
	}

	// ---------- 第二阶段：跳过文件开头的页面属性 ----------
	// 这些行属于「页面」而不是某个块，收集起来供来源展示与页面名读取使用。
	while (lineNumber < lines.length) {
		const line = lines[lineNumber] ?? '';
		if (isBlankLine(line)) {
			lineNumber++;
			continue;
		}
		if (PAGE_PROPERTY_REGEX.test(line)) {
			pageProperties.push(line);
			lineNumber++;
			continue;
		}
		break;
	}

	return { startLine: lineNumber, pageProperties };
}
