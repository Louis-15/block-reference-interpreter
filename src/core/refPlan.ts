/**
 * 块引用落点计划（纯函数）。
 *
 * 解决的问题：AI 手写引用行时最容易错三件事 —— 缩进层级不对、`((` 前面漏空格、
 * 以及插到了错误的位置（插进别人的子块里）。这三件事全靠模型自觉，实测下来
 * 一定会出错，而且错了在本扩展里看不出来（能扫到），回到 Tine 才变成死链。
 *
 * 所以这里一次性算好「插在哪一行之后」「缩进多少」「每行写什么」，
 * 工具直接把结果当补丁发出去，AI 只负责原样应用。
 *
 * 不依赖 vscode：位置用普通数字表达，便于普通 Node 单测覆盖。
 */

import { formatBlockRef } from './blockIdentity';
import { buildInsertLinesPatch } from './idInsertionPatch';
import type { ParsedFile } from './types';

/** 一条要写进引用区的引用。 */
export interface RefTargetEntry {
	/** 目标块的规范 UUID（小写）。 */
	uuid: string;
	/** 引用前面的说明文字，可空。 */
	label?: string;
	/** 引用形态。 */
	kind: 'inline' | 'embed';
}

/** 插入位置相对锚点块的关系。 */
export type RefInsertPosition = 'child' | 'sibling';

/** 计算成功的插入计划。 */
export interface RefBlockPlan {
	/** 新行插在这一行之后（0-based）。 */
	insertAfterLine: number;
	/** 要插入的文本行。 */
	lines: string[];
	/** 实际使用的缩进（原文片段，可能是 Tab）。 */
	indent: string;
	/** 可直接交给编辑工具的补丁。 */
	oldText: string;
	newText: string;
}

/** 计算失败的原因。 */
export type RefBlockPlanReject = {
	reason: 'no-block' | 'no-targets';
	detail?: string;
};

/** 取一行开头的空白（Tab 保持 Tab，不做列数展开）。 */
function leadingWhitespace(line: string): string {
	const match = /^[ \t]*/.exec(line);
	return match ? match[0] : '';
}

/**
 * 推断文件使用的一级缩进单位。
 *
 * 优先找文件里真实存在的「子块相对父块」的缩进差，找不到再退回两个空格。
 * 直接假设 4 空格或 Tab 都会在另一类文件里出错，而缩进一旦错了，
 * 引用行就会变成别的块的子块 —— 这类错误比格式错更难发现。
 */
function guessIndentUnit(parsed: ParsedFile): string {
	for (const block of parsed.blocks) {
		if (block.parent < 0) {
			continue;
		}
		const parent = parsed.blocks[block.parent];
		if (!parent) {
			continue;
		}
		const parentRaw = leadingWhitespace(parsed.lines[parent.startLine] ?? '');
		const childRaw = leadingWhitespace(parsed.lines[block.startLine] ?? '');
		if (childRaw.length > parentRaw.length && childRaw.startsWith(parentRaw)) {
			return childRaw.slice(parentRaw.length);
		}
	}
	return '  ';
}

/** 计算锚点块的子块缩进：有子块就用真实子块缩进，没有就按单位补一级。 */
function resolveChildIndent(parsed: ParsedFile, blockIndex: number, parentRaw: string): string {
	const block = parsed.blocks[blockIndex];
	const firstChild = block?.children[0];
	if (firstChild !== undefined) {
		const childLine = parsed.blocks[firstChild]?.startLine;
		if (childLine !== undefined) {
			const childRaw = leadingWhitespace(parsed.lines[childLine] ?? '');
			if (childRaw.length > parentRaw.length && childRaw.startsWith(parentRaw)) {
				return childRaw;
			}
		}
	}
	return parentRaw + guessIndentUnit(parsed);
}

/**
 * 生成引用块插入计划。
 *
 * @param parsed 目标（落点）文件的解析结果
 * @param blockIndex 锚点块在 `parsed.blocks` 中的下标
 * @param targets 要写入的引用
 * @param position `child` 作为锚点块的子块追加，`sibling` 作为其同级块追加
 */
export function buildRefBlockPlan(
	parsed: ParsedFile,
	blockIndex: number,
	targets: readonly RefTargetEntry[],
	position: RefInsertPosition = 'child',
): RefBlockPlan | RefBlockPlanReject {
	const block = parsed.blocks[blockIndex];
	if (!block) {
		return { reason: 'no-block' };
	}
	if (targets.length === 0) {
		return { reason: 'no-targets' };
	}

	const anchorLine = parsed.lines[block.startLine] ?? '';
	const parentRaw = leadingWhitespace(anchorLine);
	const indent = position === 'child' ? resolveChildIndent(parsed, blockIndex, parentRaw) : parentRaw;

	const lines = targets.map((target) => {
		const label = target.label?.trim() ?? '';
		const reference = formatBlockRef(target.uuid, target.kind);
		// label 与引用之间必须留一个空格：Tine / Logseq 只识别行首或空白之后的引用。
		// 由代码保证，避免模型手写时漏掉。
		return `${indent}- ${label.length > 0 ? `${label} ` : ''}${reference}`;
	});

	const patch = buildInsertLinesPatch(parsed.lines, block.endLine, lines);
	return {
		insertAfterLine: block.endLine,
		lines,
		indent,
		oldText: patch.oldText,
		newText: patch.newText,
	};
}
