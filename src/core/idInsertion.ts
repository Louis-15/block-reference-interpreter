/**
 * 块 ID 插入计划。
 *
 * 这是「生成块引用」的核心纯函数：给定解析结果和块下标，
 * 判断该块是否已有 ID、应该把 `id::` 插到哪一行、缩进多少，
 * 并给出给 AI 的精确补丁文本。它不写文件，也不依赖 vscode。
 *
 * 关键约束（详见 docs/block-ref-generation-plan.md 第 4 章）：
 * - 属性组必须在块首行之后、正文/子块之前；
 * - 块首行本身是代码围栏时，按 Tine 的行为追加到块自身内容末尾；
 * - 已有 ID 一律不重复插入，即使位置不符合 Logseq，也只报告；
 * - AI 补丁统一用 `\n`，人工写入用调用方传入的 `eol`。
 */

import { parseSourceBlockLine } from './blockLine';
import {
	formatIdPropertyLine,
	generateBlockUuid,
	isUuid,
	parseIdPropertyLine,
	toCanonicalUuid,
} from './blockIdentity';
import { getOpeningFenceState, isClosingFence, type MarkdownFenceState } from './fence';
import {
	computePropertyGroup,
	findBlockOwnEndLine,
	locateOwnLines,
	type LocatedOwnLine,
	type PropertyGroupInfo,
} from './idInsertionLocate';
import { buildInsertPatch } from './idInsertionPatch';
import type { BlockLineInfo, BlockNode, ParsedFile } from './types';

/** 已有 ID 的问题标记。 */
export type IdInsertionWarning =
	/** ID 不在块首行之后的连续属性组里（例如写在了正文/子块之后）。 */
	| 'id-not-in-property-group'
	/** ID 值不是规范 UUID，Logseq/Tine 可能不识别。 */
	| 'invalid-id'
	/** 同一块出现多个 `id::`，无法判断哪个是权威 ID。 */
	| 'multiple-ids';

/** 一个已存在的块 ID。 */
export interface ExistingBlockId {
	/** 原始值（已 trim），可能不是合法 UUID。 */
	value: string;
	/** 0-based 文件行号。 */
	line: number;
	/** 是否位于块首行之后的连续属性组内。 */
	inPropertyGroup: boolean;
	/** 值是否为规范 UUID 形态。 */
	validUuid: boolean;
	/** 需要报告给用户/模型的问题。 */
	warnings: IdInsertionWarning[];
}

/** 拒绝插入的原因。 */
export type IdInsertionRejectReason =
	/** 块下标越界。 */
	| 'no-block'
	/** 块首行不是列表行，且不是文件开头的隐式块。 */
	| 'not-list-block'
	/** 文件开头的隐式块（没有 `- ` 前缀），Logseq 不把它当普通块。 */
	| 'implicit'
	/** 目标是页面属性，不属于任何块。 */
	| 'page-property'
	/** 块首行的代码围栏没有闭合，块尾仍在围栏内，没有安全插入点。 */
	| 'unclosed-fence'
	/** 调用方指定的 UUID 不合法。 */
	| 'invalid-uuid'
	/** 生成 UUID 时连续碰撞或生成器失效。 */
	| 'duplicate'
	/** 已有 ID 位置不合法；保留给上层使用，纯函数本身返回 existing + 警告。 */
	| 'id-not-in-property-group'
	/** 解析结果与原文无法对齐；保留给上层使用。 */
	| 'not-indexed';

/** 插入计划。 */
export type IdInsertionPlan =
	| {
			/** 块已经有 ID：不插入，只把现有 ID 和问题报告给调用方。 */
			kind: 'existing';
			ids: ExistingBlockId[];
	  }
	| {
			/** 需要插入一行 `id::`。 */
			kind: 'insert';
			/** 规范化小写 UUID。 */
			uuid: string;
			/**
			 * 新行插入后所在的 0-based 行号。
			 *
			 * 普通块等于属性组最后一行的下一行；
			 * 块尾（代码围栏）等于块自身内容最后一行的下一行。
			 * 可直接用于 `new vscode.Position(line, 0)`。
			 */
			line: number;
			/** 要插入的属性行，不含换行。 */
			propertyLine: string;
			/** `propertyLine + eol`，可直接交给 WorkspaceEdit 插入。 */
			insertText: string;
			/** 人工写入使用的换行符。 */
			eol: '\n' | '\r\n';
			/** 正常在属性组末尾；整块代码围栏时为块自身内容末尾。 */
			position: 'property-group' | 'block-end';
			/** block-end 时为 false：Logseq 可能不识别。 */
			logseqCompatible: boolean;
			/** 给 AI 的补丁旧文本（始终使用 `\n`）。 */
			oldText: string;
			/** 给 AI 的补丁新文本（始终使用 `\n`）。 */
			newText: string;
	  }
	| {
			kind: 'reject';
			reason: IdInsertionRejectReason;
			/** 可选的补充说明，便于工具原样展示给模型/用户。 */
			detail?: string;
	  };

/** 插入计划选项。 */
export interface IdInsertionOptions {
	/** 指定 UUID；不传则生成 v4。主要用于测试和「重新生成」场景。 */
	uuid?: string;
	/** 候选 UUID 是否已被占用；生成时用于全库查重。 */
	isUuidTaken?: (uuid: string) => boolean;
	/** 自定义 UUID 生成器（测试用）。 */
	generateUuid?: () => string;
	/** 生成重试次数。 */
	maxUuidAttempts?: number;
	/** 制表位宽度，必须与解析器一致。 */
	tabSize?: number;
	/** 人工写入使用的换行符；AI 补丁始终用 `\n`。 */
	eol?: '\n' | '\r\n';
}

/**
 * 为指定块生成 `id::` 插入计划。
 *
 * @param parsed 文件解析结果
 * @param blockIndex 目标块在 `parsed.blocks` 中的下标
 * @param options 插入选项
 */
export function buildIdInsertionPlan(
	parsed: ParsedFile,
	blockIndex: number,
	options: IdInsertionOptions = {},
): IdInsertionPlan {
	const block = parsed.blocks[blockIndex];
	if (!block) {
		return { kind: 'reject', reason: 'no-block' };
	}

	const firstLine = parsed.lines[block.startLine] ?? '';
	const tabSize = options.tabSize ?? 4;
	const eol = options.eol ?? '\n';

	const located = locateOwnLines(parsed, block);
	if (located.length === 0) {
		// 保守拒绝：行号对不上时继续猜测，可能把 id:: 插进别的块。
		return {
			kind: 'reject',
			reason: 'not-indexed',
			detail: '块自身行与原文无法对齐',
		};
	}

	const propertyGroup = computePropertyGroup(block, located);
	const existingIds = collectExistingIds(located, propertyGroup, tabSize);
	if (existingIds.length > 0) {
		// 已有 ID 一律不重复写：即使位置不对、值非法、甚至块本身是
		// 不适合生成新 ID 的隐式块，也只报告，让用户/模型决定是否修复。
		return { kind: 'existing', ids: existingIds };
	}

	const blockLine = parseSourceBlockLine(firstLine);
	if (!blockLine) {
		// 解析器只会在「文件开头、栈为空」时创建无 `- ` 前缀的隐式块；
		// 这类块在 Logseq 里不是普通块，不能安全地加属性。
		return {
			kind: 'reject',
			reason: block.parent === -1 ? 'implicit' : 'not-list-block',
		};
	}

	let uuid: string;
	if (options.uuid !== undefined) {
		const canonical = toCanonicalUuid(options.uuid);
		if (!canonical) {
			return { kind: 'reject', reason: 'invalid-uuid', detail: options.uuid };
		}
		uuid = canonical;
	} else {
		try {
			uuid = generateBlockUuid({
				isTaken: options.isUuidTaken,
				generate: options.generateUuid,
				maxAttempts: options.maxUuidAttempts,
			});
		} catch (error) {
			return {
				kind: 'reject',
				reason: 'duplicate',
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	const firstLineFence = getOpeningFenceState(firstLine, tabSize);
	if (firstLineFence) {
		return planBlockEnd(parsed, block, blockLine, firstLineFence, uuid, eol, tabSize);
	}

	return planPropertyGroup(parsed, blockLine, propertyGroup, uuid, eol);
}

/** 收集块内全部 `id::`，并标记位置/格式问题。 */
function collectExistingIds(
	located: LocatedOwnLine[],
	propertyGroup: PropertyGroupInfo,
	tabSize: number,
): ExistingBlockId[] {
	const ids: ExistingBlockId[] = [];

	// 必须跳过代码围栏内部：`id::` 在围栏里是代码示例，不是块属性。
	// `ownLines` 原样包含围栏内的每一行，若直接扫描会把示例当成已有 ID，
	// 导致真正需要补 ID 的块被误判为 existing。
	let fence: MarkdownFenceState | null = null;

	for (let index = 0; index < located.length; index++) {
		const entry = located[index];
		if (!entry) {
			continue;
		}

		if (index === 0) {
			// 块首行本身可能是围栏开头（`- ```js`）。
			fence = getOpeningFenceState(entry.text, tabSize);
			continue;
		}

		if (fence) {
			if (isClosingFence(entry.text, fence, tabSize)) {
				fence = null;
			}
			continue;
		}

		const opening = getOpeningFenceState(entry.text, tabSize);
		if (opening) {
			fence = opening;
			continue;
		}

		const parsedId = parseIdPropertyLine(entry.text);
		if (!parsedId) {
			continue;
		}
		ids.push({
			value: parsedId.value,
			line: entry.line,
			inPropertyGroup: propertyGroup.lines.has(entry.line),
			validUuid: isUuid(parsedId.value),
			warnings: [],
		});
	}

	const multiple = ids.length > 1;
	for (const id of ids) {
		if (!id.validUuid) {
			id.warnings.push('invalid-id');
		}
		if (!id.inPropertyGroup) {
			id.warnings.push('id-not-in-property-group');
		}
		if (multiple) {
			id.warnings.push('multiple-ids');
		}
	}

	return ids;
}

/** 正常块：插入到属性组末尾、正文/子块之前。 */
function planPropertyGroup(
	parsed: ParsedFile,
	blockLine: BlockLineInfo,
	propertyGroup: PropertyGroupInfo,
	uuid: string,
	eol: '\n' | '\r\n',
): IdInsertionPlan {
	const insertAfterLine = propertyGroup.endLine;
	// 有属性行时跟随它的缩进，保持属性组连续（含历史零缩进写法）；
	// 没有属性行时用「块前导空白 + 两个空格」。
	const indent = propertyGroup.indent ?? `${blockLine.leadingWhitespace}  `;
	const propertyLine = formatIdPropertyLine(uuid, indent);
	const patch = buildInsertPatch(parsed.lines, insertAfterLine, propertyLine);

	return {
		kind: 'insert',
		uuid,
		line: insertAfterLine + 1,
		propertyLine,
		insertText: propertyLine + eol,
		eol,
		position: 'property-group',
		logseqCompatible: true,
		oldText: patch.oldText,
		newText: patch.newText,
	};
}

/**
 * 块首行本身就是代码围栏：追加到块自身内容末尾、子块之前。
 *
 * 这是 Tine 的同款行为（已用 `tine ref` 实测）。Logseq 的属性窗口
 * 在正文处已经关闭，可能不识别；所以必须带 `logseqCompatible: false`。
 */
function planBlockEnd(
	parsed: ParsedFile,
	block: BlockNode,
	blockLine: BlockLineInfo,
	fence: MarkdownFenceState,
	uuid: string,
	eol: '\n' | '\r\n',
	tabSize: number,
): IdInsertionPlan {
	const ownEndLine = findBlockOwnEndLine(parsed, block);

	let closed = false;
	for (let line = block.startLine + 1; line <= ownEndLine; line++) {
		if (isClosingFence(parsed.lines[line] ?? '', fence, tabSize)) {
			closed = true;
			break;
		}
	}
	if (!closed) {
		// 没闭合时「块尾」仍在围栏内，追加进去会被当成代码内容，必须拒绝。
		return { kind: 'reject', reason: 'unclosed-fence' };
	}

	const insertAfterLine = ownEndLine;
	const indent = `${blockLine.leadingWhitespace}  `;
	const propertyLine = formatIdPropertyLine(uuid, indent);
	const patch = buildInsertPatch(parsed.lines, insertAfterLine, propertyLine);

	return {
		kind: 'insert',
		uuid,
		line: insertAfterLine + 1,
		propertyLine,
		insertText: propertyLine + eol,
		eol,
		position: 'block-end',
		logseqCompatible: false,
		oldText: patch.oldText,
		newText: patch.newText,
	};
}
