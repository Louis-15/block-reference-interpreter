/**
 * 单篇笔记的块 ID 与引用审计（主流程）。
 *
 * 目标：在 AI 写完笔记后，用一次调用回答「这些 `id::` 和 `((uuid))` 到底有没有问题」。
 *
 * 模块拆分：
 * - `refAuditTypes.ts`：共享类型；
 * - `refAuditScan.ts`：严格扫描 `((...))`（含畸形引用）；
 * - `refAuditIds.ts`：块 ID 位置/格式检查；
 * - 本文件：引用目标检查与汇总。
 *
 * 这一层不依赖 vscode，可在 Node 里直接单测。
 */

import { parseSourceBlockLine } from './blockLine';
import { toCanonicalUuid, uuidVersion } from './blockIdentity';
import { getOpeningFenceState } from './fence';
import type { GraphIndex } from './graphIndex';
import { t } from './i18n';
import { auditBlockIds } from './refAuditIds';
import { scanStrictReferences } from './refAuditScan';
import type { RefAuditOptions, RefAuditResult } from './refAuditTypes';
import { locateOwnLines } from './idInsertionLocate';
import type { ParsedFile } from './types';

export type {
	RefAuditCode,
	RefAuditIssue,
	RefAuditOptions,
	RefAuditResult,
} from './refAuditTypes';

/** 定义位置。 */
interface Definition {
	path: string;
	blockIndex: number;
	startLine: number;
	/** 页首隐式块（没有 `- ` 前缀）。 */
	implicit: boolean;
	/** 块首行本身是代码围栏。 */
	fenceBlock: boolean;
}

/** 该行是否落在某个块**自身内容**的行范围内。 */
function buildOwnLineIndex(parsed: ParsedFile): Set<number> {
	const lines = new Set<number>();
	for (const block of parsed.blocks) {
		// startLine 一定属于该块，即使 ownLines 因异常为空也要计入。
		lines.add(block.startLine);
		for (const entry of locateOwnLines(parsed, block)) {
			lines.add(entry.line);
		}
	}
	return lines;
}

/**
 * 构建 UUID → 定义位置。
 *
 * 当前文件以 `parsed` 为准，索引中的同名旧版本必须排除；
 * 否则 AI 刚在编辑器里加/删的 ID 会被旧索引干扰。
 */
function buildDefinitionMap(parsed: ParsedFile, index: GraphIndex): Map<string, Definition[]> {
	const map = new Map<string, Definition[]>();

	const addFile = (path: string, file: ParsedFile): void => {
		for (const [uuid, blockIndexes] of file.blocksById) {
			const list = map.get(uuid) ?? [];
			for (const blockIndex of blockIndexes) {
				const block = file.blocks[blockIndex];
				if (!block) {
					continue;
				}
				const firstLine = file.lines[block.startLine] ?? '';
				list.push({
					path,
					blockIndex,
					startLine: block.startLine,
					implicit: parseSourceBlockLine(firstLine) === null,
					fenceBlock: getOpeningFenceState(firstLine) !== null,
				});
			}
			map.set(uuid, list);
		}
	};

	addFile(parsed.path, parsed);
	for (const path of index.listFiles()) {
		if (path === parsed.path) {
			continue;
		}
		const file = index.getParsedFile(path);
		if (file) {
			addFile(path, file);
		}
	}

	return map;
}

/**
 * 审计一篇笔记。
 *
 * @param parsed 当前文件的实时解析结果
 * @param index 全库索引；当前文件在索引中的旧版本会被忽略
 */
export function auditReferences(
	parsed: ParsedFile,
	index: GraphIndex,
	options: RefAuditOptions = {},
): RefAuditResult {
	const tabSize = options.tabSize ?? 4;
	const result: RefAuditResult = {
		errors: [],
		warnings: [],
		referenceCount: 0,
		idCount: parsed.blocksById.size,
		malformedCount: 0,
		ok: true,
	};

	const definitions = buildDefinitionMap(parsed, index);
	const references = scanStrictReferences(parsed.lines, tabSize);
	const ownLines = buildOwnLineIndex(parsed);

	const filter =
		options.blockIds && options.blockIds.length > 0
			? new Set(
					options.blockIds
						.map((value) => toCanonicalUuid(value))
						.filter((value): value is string => value !== null),
				)
			: undefined;

	for (const reference of references) {
		if (reference.wrapped) {
			result.malformedCount++;
			result.errors.push({
				severity: 'error',
				code: 'malformed-reference',
				message: t(
					'Line {0} contains a malformed block reference `{1}`: it is wrapped in extra parentheses.',
					reference.line + 1,
					`((${reference.value}))`,
				),
				line: reference.line,
			});
			continue;
		}

		const canonical = toCanonicalUuid(reference.value);
		if (!canonical) {
			result.malformedCount++;
			result.errors.push({
				severity: 'error',
				code: 'malformed-reference',
				message: t(
					'Line {0} contains a malformed block reference `(({1}))`; the value is not a standard UUID.',
					reference.line + 1,
					reference.value,
				),
				line: reference.line,
			});
			continue;
		}

		result.referenceCount++;
		if (filter && !filter.has(canonical)) {
			continue;
		}

		/*
		 * 引用不在任何块内：多半是顶格的裸引用行（没有 `- ` 前缀）。
		 * Tine / Logseq 的内容块必须是 `- ...`，这类行不会被当成块内引用，
		 * 反链面板也拿不到块上下文。只报警告，因为历史文件里确实可能存在。
		 */
		if (!ownLines.has(reference.line)) {
			result.warnings.push({
				severity: 'warning',
				code: 'reference-outside-block',
				message: t(
					'Line {0} is a reference outside any block. Tine / Logseq only treat `- ...` lines as blocks, so this reference has no block context. Prefix the line with `- ` if it should be a block.',
					reference.line + 1,
				),
				line: reference.line,
				uuid: canonical,
			});
		}

		const targets = definitions.get(canonical) ?? [];
		if (targets.length === 0) {
			result.errors.push({
				severity: 'error',
				code: 'dangling-reference',
				message: t(
					'Line {0} references `{1}`, but no block defines that UUID.',
					reference.line + 1,
					canonical,
				),
				line: reference.line,
				uuid: canonical,
			});
			continue;
		}

		if (targets.length > 1) {
			const locations = targets
				.map((target) => `${target.path}:${target.startLine + 1}`)
				.join(', ');
			result.errors.push({
				severity: 'error',
				code: 'duplicate-uuid',
				message: t(
					'UUID `{0}` is defined in {1} places ({2}); the reference is ambiguous.',
					canonical,
					targets.length,
					locations,
				),
				line: reference.line,
				uuid: canonical,
			});
			continue;
		}

		const target = targets[0];
		if (!target) {
			continue;
		}

		if (target.implicit) {
			result.errors.push({
				severity: 'error',
				code: 'implicit-block-reference',
				message: t(
					'UUID `{0}` points to a page-leading implicit block without a `- ` prefix ({1}:{2}); Logseq does not treat it as a normal block.',
					canonical,
					target.path,
					target.startLine + 1,
				),
				line: reference.line,
				path: target.path,
				uuid: canonical,
			});
		}

		if (target.fenceBlock) {
			result.warnings.push({
				severity: 'warning',
				code: 'block-end-id',
				message: t(
					'UUID `{0}` points to a block whose first line is a code fence ({1}:{2}); its id:: sits at the block end and Logseq may not parse it.',
					canonical,
					target.path,
					target.startLine + 1,
				),
				line: reference.line,
				path: target.path,
				uuid: canonical,
			});
		}

		if (uuidVersion(canonical) === 8) {
			result.warnings.push({
				severity: 'warning',
				code: 'runtime-v8-id',
				message: t(
					'UUID `{0}` has the v8 shape, which looks like a Tine runtime ID rather than a persistent ID.',
					canonical,
				),
				line: reference.line,
				uuid: canonical,
			});
		}
	}

	auditBlockIds(parsed, result, tabSize);
	result.ok = result.errors.length === 0;
	return result;
}
