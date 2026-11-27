import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import { buildRefBlockPlan } from '../core/refPlan';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/** 解析内容并返回「块首行行号 → 块下标」的查找器。 */
function parseFile(content: string) {
	const parsed = parseMarkdown('pages/a.md', content);
	const indexOf = (startLine: number): number => {
		const found = parsed.blocks.findIndex((block) => block.startLine === startLine);
		if (found < 0) {
			throw new Error(`块没有找到: 行 ${startLine}`);
		}
		return found;
	};
	return { parsed, indexOf };
}

describe('引用块插入计划', () => {
	it('作为子块追加，缩进沿用真实子块', () => {
		const { parsed, indexOf } = parseFile(
			['- 父块', '\t- 已有子块', '- 别的块'].join('\n'),
		);

		const plan = buildRefBlockPlan(parsed, indexOf(0), [{ uuid: UUID_A, kind: 'inline' }], 'child');
		if ('reason' in plan) {
			throw new Error('不应该被拒绝');
		}

		expect(plan.indent).toBe('\t');
		expect(plan.lines).toEqual([`\t- ((${UUID_A}))`]);
		// 插在父块子树末尾之后：第 1 行（0-based）之后
		expect(plan.insertAfterLine).toBe(1);
	});

	it('没有子块时按文件里的缩进单位补一级', () => {
		const { parsed, indexOf } = parseFile(
			['- 父块', '- 另一个父块', '  - 两空格子块'].join('\n'),
		);

		const plan = buildRefBlockPlan(parsed, indexOf(0), [{ uuid: UUID_A, kind: 'inline' }], 'child');
		if ('reason' in plan) {
			throw new Error('不应该被拒绝');
		}

		// 文件里真实存在两空格缩进，应当被推断为单位，而不是硬编码 4 空格
		expect(plan.indent).toBe('  ');
	});

	it('sibling 模式与锚点块同缩进', () => {
		const { parsed, indexOf } = parseFile(['- 父块', '\t- 子块', '\t\t- 孙块'].join('\n'));

		const plan = buildRefBlockPlan(parsed, indexOf(1), [{ uuid: UUID_A, kind: 'inline' }], 'sibling');
		if ('reason' in plan) {
			throw new Error('不应该被拒绝');
		}

		expect(plan.indent).toBe('\t');
	});

	it('label 与引用之间自动留空格（Tine 只识别行首或空白后的引用）', () => {
		const { parsed, indexOf } = parseFile('- 引用区');

		const plan = buildRefBlockPlan(
			parsed,
			indexOf(0),
			[{ uuid: UUID_A, label: '行内引用：', kind: 'inline' }],
			'child',
		);
		if ('reason' in plan) {
			throw new Error('不应该被拒绝');
		}

		// 关键断言：即使 label 以全角冒号结尾，引用前面也必须有一个空格
		expect(plan.lines[0]).toBe(`  - 行内引用： ((${UUID_A}))`);
		expect(plan.lines[0]).toContain('： ((');
	});

	it('embed 形态带上宏外壳', () => {
		const { parsed, indexOf } = parseFile('- 引用区');

		const plan = buildRefBlockPlan(parsed, indexOf(0), [{ uuid: UUID_B, kind: 'embed' }], 'child');
		if ('reason' in plan) {
			throw new Error('不应该被拒绝');
		}

		expect(plan.lines[0]).toBe(`  - {{embed ((${UUID_B}))}}`);
	});

	it('补丁能唯一匹配，且新文本包含插入行', () => {
		const { parsed, indexOf } = parseFile(
			['- 引用区', '- 结尾块', '- 结尾块'].join('\n'),
		);

		const plan = buildRefBlockPlan(parsed, indexOf(0), [{ uuid: UUID_A, kind: 'inline' }], 'child');
		if ('reason' in plan) {
			throw new Error('不应该被拒绝');
		}

		expect(plan.oldText).toBe('- 引用区');
		expect(plan.newText).toBe(`- 引用区\n  - ((${UUID_A}))`);
	});

	it('没有目标时拒绝，而不是插入空内容', () => {
		const { parsed, indexOf } = parseFile('- 引用区');

		const plan = buildRefBlockPlan(parsed, indexOf(0), [], 'child');
		expect('reason' in plan && plan.reason).toBe('no-targets');
	});

	it('块下标越界时拒绝', () => {
		const { parsed } = parseFile('- 引用区');

		const plan = buildRefBlockPlan(parsed, 99, [{ uuid: UUID_A, kind: 'inline' }], 'child');
		expect('reason' in plan && plan.reason).toBe('no-block');
	});
});
