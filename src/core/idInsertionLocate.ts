/**
 * 块自身行的定位与属性组识别。
 *
 * `BlockNode.ownLines` 只保存文本，不保存行号；而插入 `id::` 必须精确到行。
 * 这一层负责把「块自身行」对齐回文件真实行号，并找出块首行之后
 * 连续的属性组。它不生成补丁、不写文件。
 */

import { isBlankLine } from './blockLine';
import { isBlockPropertyLine } from './blockParser';
import type { BlockNode, ParsedFile } from './types';

/** 块自身行在文件中的真实位置。 */
export interface LocatedOwnLine {
	line: number;
	text: string;
}

/** 块首行之后的连续属性组。 */
export interface PropertyGroupInfo {
	/** 属性组最后一行的文件行号；没有属性行时等于块首行行号。 */
	endLine: number;
	/** 第一个属性行的缩进；没有属性行为 null。 */
	indent: string | null;
	/** 属性组包含的文件行号集合。 */
	lines: Set<number>;
}

/**
 * 把 `block.ownLines` 对齐到文件真实行号。
 *
 * `ownLines` 是文件行的有序子序列（子块行、被丢弃的尾部空行不在其中），
 * 所以按顺序在 `[startLine, endLine]` 内查找即可，不需要改解析器结构。
 *
 * 对不上时返回空数组，由调用方拒绝写入；宁可不写，也不能把属性插错块。
 */
export function locateOwnLines(parsed: ParsedFile, block: BlockNode): LocatedOwnLine[] {
	const first = block.ownLines[0];
	if (first === undefined) {
		return [];
	}
	if (block.ownLines.length === 1) {
		return [{ line: block.startLine, text: first }];
	}

	const result: LocatedOwnLine[] = [];
	let cursor = block.startLine;
	for (const text of block.ownLines) {
		let found = -1;
		for (let line = cursor; line <= block.endLine; line++) {
			if ((parsed.lines[line] ?? '') === text) {
				found = line;
				break;
			}
		}
		if (found === -1) {
			return [];
		}
		result.push({ line: found, text });
		cursor = found + 1;
	}
	return result;
}

/**
 * 计算块首行之后的连续属性组。
 *
 * 属性组必须连续：空行、正文、子块都会终止它。
 * 这也正好符合 Logseq 的规则——属性只认块首行之后连续的那一段。
 */
export function computePropertyGroup(
	block: BlockNode,
	located: LocatedOwnLine[],
): PropertyGroupInfo {
	let endLine = block.startLine;
	let indent: string | null = null;
	const lines = new Set<number>();

	for (let index = 1; index < located.length; index++) {
		const entry = located[index];
		if (!entry) {
			break;
		}
		if (isBlankLine(entry.text)) {
			break;
		}
		if (!isBlockPropertyLine(entry.text)) {
			break;
		}
		endLine = entry.line;
		indent ??= entry.text.match(/^[ \t]*/)?.[0] ?? '';
		lines.add(entry.line);
	}

	return { endLine, indent, lines };
}

/** 块自身内容的最后一行（不含子块）。 */
export function findBlockOwnEndLine(parsed: ParsedFile, block: BlockNode): number {
	let end = block.endLine;
	for (const childIndex of block.children) {
		const child = parsed.blocks[childIndex];
		if (child && child.startLine > block.startLine) {
			end = Math.min(end, child.startLine - 1);
		}
	}
	return end;
}
