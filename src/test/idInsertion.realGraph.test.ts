/**
 * 真实笔记库的 ID 插入计划测试（只读）。
 *
 * 目的：用真实数据验证「已有 ID 不会被重复插入」「无 ID 块的插入点
 * 确实落在正文/子块之前」以及「首行代码围栏不会被写进围栏内部」。
 *
 * 安全约束：
 * - 只读文件，绝不写入；
 * - 笔记库可能正在被 Tine 编辑，数量断言用下限；
 * - 目录不存在时整个文件跳过。
 *
 * 可通过环境变量 TINE_GRAPH_ROOT 指向别的图谱。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseMarkdown, isBlockPropertyLine } from '../core/blockParser';
import { toCanonicalUuid } from '../core/blockIdentity';
import { getOpeningFenceState } from '../core/fence';
import { buildIdInsertionPlan } from '../core/idInsertion';

const GRAPH_ROOT = process.env.TINE_GRAPH_ROOT ?? 'd:\\扁舟听雨工作室\\网文创作理论';
const TEST_UUID = '11111111-1111-4111-8111-111111111111';

/** 列举 pages/ 与 journals/ 一级目录下的 Markdown 文件（与插件默认 include 一致）。 */
function listMarkdownFiles(root: string): string[] {
	const files: string[] = [];
	for (const directory of ['pages', 'journals']) {
		const full = path.join(root, directory);
		if (!fs.existsSync(full)) {
			continue;
		}
		for (const name of fs.readdirSync(full)) {
			if (name.toLowerCase().endsWith('.md')) {
				files.push(path.join(full, name));
			}
		}
	}
	return files;
}

const graphExists = fs.existsSync(path.join(GRAPH_ROOT, 'pages'));

describe.skipIf(!graphExists)('真实笔记库 ID 插入计划（只读）', () => {
	it('所有已有 ID 的块都返回 existing，且能找到原始 ID', () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		let checked = 0;
		let positionWarnings = 0;
		let invalidIds = 0;
		const failures: string[] = [];

		for (const filePath of files) {
			const parsed = parseMarkdown(filePath, fs.readFileSync(filePath, 'utf8'));
			for (let index = 0; index < parsed.blocks.length; index++) {
				const block = parsed.blocks[index];
				if (!block?.id) {
					continue;
				}
				checked++;

				const plan = buildIdInsertionPlan(parsed, index, { uuid: block.id });
				if (plan.kind !== 'existing') {
					const detail = plan.kind === 'reject' ? `/${plan.reason}` : '';
					failures.push(`${filePath}:${block.startLine + 1} -> ${plan.kind}${detail}`);
					continue;
				}

				// 解析器识别出的 block.id 必须能在「宽松扫描」里找到，
				// 否则说明两套解析规则已经漂移，生成时可能重复插入。
				if (!plan.ids.some((id) => toCanonicalUuid(id.value) === block.id)) {
					failures.push(`${filePath}:${block.startLine + 1} 找不到 ${block.id}`);
				}
				if (plan.ids.some((id) => id.warnings.includes('id-not-in-property-group'))) {
					positionWarnings++;
				}
				if (plan.ids.some((id) => id.warnings.includes('invalid-id'))) {
					invalidIds++;
				}
			}
		}

		expect(checked).toBeGreaterThan(500);
		expect(failures).toEqual([]);
		console.log(
			`[ID 插入计划] 已有 ID 块 ${checked} 个 / 位置警告 ${positionWarnings} / 非法 ID ${invalidIds}`,
		);
	}, 60000);

	it('抽样无 ID 块：插入行在正文/子块之前，缩进符合规则', () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		let sampled = 0;
		const failures: string[] = [];

		for (const filePath of files) {
			if (sampled >= 200) {
				break;
			}
			const parsed = parseMarkdown(filePath, fs.readFileSync(filePath, 'utf8'));

			for (let index = 0; index < parsed.blocks.length && sampled < 200; index++) {
				const block = parsed.blocks[index];
				if (!block || block.id) {
					continue;
				}

				const firstLine = parsed.lines[block.startLine] ?? '';
				const blockLine = /^([ \t]*)-/.exec(firstLine);
				if (!blockLine) {
					// 隐式块会被拒绝，不在抽样范围内。
					continue;
				}

				const plan = buildIdInsertionPlan(parsed, index, { uuid: TEST_UUID });
				if (plan.kind === 'reject') {
					failures.push(`${filePath}:${block.startLine + 1} reject ${plan.reason}`);
					continue;
				}
				if (plan.kind !== 'insert') {
					failures.push(`${filePath}:${block.startLine + 1} unexpected ${plan.kind}`);
					continue;
				}

				sampled++;

				// 第一个直接子块的行号；没有子块时用块尾的下一行。
				const firstChildStart =
					block.children.length > 0
						? Math.min(
								...block.children.map(
									(childIndex) => parsed.blocks[childIndex]?.startLine ?? block.endLine,
								),
							)
						: block.endLine + 1;

				if (plan.line <= block.startLine || plan.line > firstChildStart) {
					failures.push(
						`${filePath}:${block.startLine + 1} line ${plan.line} 越界（子块 ${firstChildStart}）`,
					);
				}

				if (plan.position === 'block-end') {
					if (plan.logseqCompatible) {
						failures.push(`${filePath}:${block.startLine + 1} block-end 却标记 logseqCompatible`);
					}
					continue;
				}

				// 有属性行时跟随它的缩进；没有属性行时默认「块前导空白 + 2 空格」。
				const nextLine = parsed.lines[block.startLine + 1] ?? '';
				const hasProperty = isBlockPropertyLine(nextLine) && nextLine.trim().length > 0;
				const expectedIndent = hasProperty
					? nextLine.match(/^[ \t]*/)?.[0] ?? ''
					: `${blockLine[1] ?? ''}  `;
				if (plan.propertyLine !== `${expectedIndent}id:: ${TEST_UUID}`) {
					failures.push(
						`${filePath}:${block.startLine + 1} 缩进不符: ${JSON.stringify(plan.propertyLine)}`,
					);
				}
			}
		}

		expect(sampled).toBeGreaterThan(50);
		expect(failures).toEqual([]);
		console.log(`[ID 插入计划] 抽样无 ID 块 ${sampled} 个`);
	}, 90000);

	it('块首行是代码围栏时：只允许 block-end 或 unclosed-fence', () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		let checked = 0;
		const failures: string[] = [];

		for (const filePath of files) {
			const parsed = parseMarkdown(filePath, fs.readFileSync(filePath, 'utf8'));
			for (let index = 0; index < parsed.blocks.length; index++) {
				const block = parsed.blocks[index];
				if (!block) {
					continue;
				}
				const firstLine = parsed.lines[block.startLine] ?? '';
				if (!getOpeningFenceState(firstLine)) {
					continue;
				}
				checked++;

				const plan = buildIdInsertionPlan(parsed, index, { uuid: TEST_UUID });
				if (plan.kind === 'insert' && plan.position !== 'block-end') {
					failures.push(`${filePath}:${block.startLine + 1} position ${plan.position}`);
				}
				if (plan.kind === 'reject' && plan.reason !== 'unclosed-fence') {
					failures.push(`${filePath}:${block.startLine + 1} reject ${plan.reason}`);
				}
			}
		}

		expect(failures).toEqual([]);
		console.log(`[ID 插入计划] 首行围栏块 ${checked} 个`);
	}, 60000);
});
