import { describe, expect, it } from 'vitest';

import { buildExpandedNote, buildExpandedNoteWithBudget } from '../core/expandNote';
import { scanReferences } from '../core/refScanner';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

/** 构造一份含两处引用的笔记。 */
function makeNote(): { lines: string[]; references: ReturnType<typeof scanReferences> } {
	const lines = [
		`- 第一条，参见 ((${UUID_A}))`,
		'- 中间内容',
		`- 第二条，参见 ((${UUID_B}))`,
	];
	return { lines, references: scanReferences(lines) };
}

describe('buildExpandedNoteWithBudget 基础', () => {
	it('展开所有引用并原样保留原文行', () => {
		const note = makeNote();
		const result = buildExpandedNoteWithBudget(note, {
			resolve: (uuid) => `内容-${uuid.slice(0, 4)}`,
		});

		expect(result.expandedCount).toBe(2);
		expect(result.skipped).toHaveLength(0);
		// 原文行必须保留
		expect(result.text).toContain(`- 第一条，参见 ((${UUID_A}))`);
		expect(result.text).toContain(`- 第二条，参见 ((${UUID_B}))`);
		// 展开内容必须插入
		expect(result.text).toContain('内容-1111');
		expect(result.text).toContain('内容-2222');
	});

	it('同一行重复引用同一 UUID 只展开一次', () => {
		const lines = [`- ((${UUID_A})) 和 ((${UUID_A}))`];
		const result = buildExpandedNoteWithBudget(
			{ lines, references: scanReferences(lines) },
			{ resolve: () => 'X' },
		);
		expect(result.expandedCount).toBe(1);
	});

	it('includeHeader 会加说明头部', () => {
		const note = makeNote();
		const result = buildExpandedNoteWithBudget(note, {
			resolve: () => 'X',
			includeHeader: true,
			fileName: 'test.md',
		});
		expect(result.text).toContain('块引用解读工具');
		expect(result.text).toContain('test.md');
		expect(result.text).toContain('全文共 2 处块引用');
	});
});

describe('buildExpandedNoteWithBudget 预算控制', () => {
	it('超出预算时停止展开并记录未展开项', () => {
		const note = makeNote();
		const result = buildExpandedNoteWithBudget(note, {
			// 预算极小：第一处展开后就会超
			maxChars: 60,
			resolve: () => '内容'.repeat(40),
		});

		expect(result.expandedCount).toBeLessThan(2);
		expect(result.skipped.length).toBeGreaterThan(0);
		// 未展开项必须带行号，方便模型定点补读
		expect(result.skipped[0]?.line).toBeGreaterThanOrEqual(0);
	});

	it('截断时输出里必须有明确提示与补救指引', () => {
		const note = makeNote();
		const result = buildExpandedNoteWithBudget(note, {
			maxChars: 60,
			resolve: () => '内容'.repeat(40),
		});

		expect(result.text).toContain('未展开');
		expect(result.text).toContain('blockRef');
		// 行号要写出来
		expect(result.text).toContain('行号');
	});

	it('预算充足时不出现截断提示', () => {
		const note = makeNote();
		const result = buildExpandedNoteWithBudget(note, {
			maxChars: 100000,
			resolve: () => '短内容',
		});
		expect(result.skipped).toHaveLength(0);
		expect(result.text).not.toContain('未展开');
	});

	it('不传 maxChars 时全部展开（供人看）', () => {
		const note = makeNote();
		const result = buildExpandedNoteWithBudget(note, {
			resolve: () => '内容'.repeat(5000),
		});
		expect(result.expandedCount).toBe(2);
		expect(result.skipped).toHaveLength(0);
	});

	it('resolve 返回空串时该处不插入内容也不计数', () => {
		const note = makeNote();
		const result = buildExpandedNoteWithBudget(note, { resolve: () => '' });
		expect(result.expandedCount).toBe(0);
	});
});

describe('buildExpandedNote 兼容封装', () => {
	it('只返回文本', () => {
		const note = makeNote();
		const text = buildExpandedNote(note, { resolve: () => '内容' });
		expect(typeof text).toBe('string');
		expect(text).toContain('内容');
	});
});
