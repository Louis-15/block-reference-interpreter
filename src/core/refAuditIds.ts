/**
 * 单篇笔记的块 ID 位置/格式检查。
 *
 * 复用 M1 的 `buildIdInsertionPlan`：它已经能区分「已有 ID」「无 ID」
 * 以及「ID 不在属性组内 / 多个 ID / 非 UUID / 块尾围栏」等情况。
 * 这里只负责把结果翻译成审计问题。
 */

import { getOpeningFenceState } from './fence';
import { uuidVersion } from './blockIdentity';
import { buildIdInsertionPlan, type ExistingBlockId } from './idInsertion';
import { t } from './i18n';
import type { RefAuditResult } from './refAuditTypes';
import type { BlockNode, ParsedFile } from './types';

/** `id::` 与块首行都顶格，属于历史写法；Tine 可读但容易在迁移时出问题。 */
function hasZeroIndentId(parsed: ParsedFile, block: BlockNode, id: ExistingBlockId): boolean {
	const blockIndent = parsed.lines[block.startLine]?.match(/^[ \t]*/)?.[0] ?? '';
	const idIndent = parsed.lines[id.line]?.match(/^[ \t]*/)?.[0] ?? '';
	return blockIndent.length === 0 && idIndent.length === 0;
}

/** 检查当前文件每个块的 ID 位置/格式。 */
export function auditBlockIds(parsed: ParsedFile, result: RefAuditResult, tabSize: number): void {
	for (let blockIndex = 0; blockIndex < parsed.blocks.length; blockIndex++) {
		const block = parsed.blocks[blockIndex];
		if (!block) {
			continue;
		}

		// 传固定 UUID 只是为了让「无 ID 块」返回 insert；我们只消费 existing。
		const plan = buildIdInsertionPlan(parsed, blockIndex, {
			uuid: '00000000-0000-4000-8000-000000000000',
			tabSize,
		});
		if (plan.kind !== 'existing') {
			continue;
		}

		const firstLine = parsed.lines[block.startLine] ?? '';
		const fenceBlock = getOpeningFenceState(firstLine, tabSize) !== null;

		for (const id of plan.ids) {
			if (id.warnings.includes('multiple-ids')) {
				result.errors.push({
					severity: 'error',
					code: 'multiple-ids',
					message: t(
						'Block at line {0} has multiple id:: properties; it is ambiguous which one is authoritative.',
						block.startLine + 1,
					),
					line: block.startLine,
				});
			}

			if (id.warnings.includes('invalid-id')) {
				result.warnings.push({
					severity: 'warning',
					code: 'invalid-id',
					message: t(
						'Block at line {0} has an id:: value that is not a standard UUID: `{1}`.',
						block.startLine + 1,
						id.value,
					),
					line: id.line,
				});
			}

			if (id.warnings.includes('id-not-in-property-group')) {
				if (fenceBlock) {
					// Tine 对整块代码围栏就是这么写的：能读，但 Logseq 可能不认。
					result.warnings.push({
						severity: 'warning',
						code: 'block-end-id',
						message: t(
							'Block at line {0} has its id:: after the code fence. Tine accepts this, but Logseq may not.',
							block.startLine + 1,
						),
						line: id.line,
					});
				} else {
					result.errors.push({
						severity: 'error',
						code: 'id-not-in-property-group',
						message: t(
							'Block at line {0} has its id:: after body text or child blocks. Move it directly under the block first line.',
							block.startLine + 1,
						),
						line: id.line,
					});
				}
			}

			if (uuidVersion(id.value) === 8) {
				result.warnings.push({
					severity: 'warning',
					code: 'runtime-v8-id',
					message: t(
						'Block at line {0} uses a v8-style UUID (`{1}`). It may be a Tine runtime ID rather than a persistent one.',
						block.startLine + 1,
						id.value,
					),
					line: id.line,
				});
			}

			if (hasZeroIndentId(parsed, block, id)) {
				result.warnings.push({
					severity: 'warning',
					code: 'zero-indent-id',
					message: t(
						'Block at line {0} uses a zero-indent id:: (same indentation as the block bullet). Tine accepts it, but it is easy to break when the block moves.',
						block.startLine + 1,
					),
					line: id.line,
				});
			}
		}
	}
}
