import { describe, expect, it } from 'vitest';

import { extractUuidsFromLine, scanReferences } from '../core/refScanner';

const UUID_A = '66c73a56-ddda-44d2-80dd-009e44406fd4';
const UUID_B = '678bcfae-dea4-4cee-8c7f-ea71ff0b3c0b';

describe('scanReferences 基础', () => {
	it('识别行内块引用并给出位置', () => {
		const lines = [`- 参见 ((${UUID_A})) 这一节`];
		const hits = scanReferences(lines);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.uuid).toBe(UUID_A);
		expect(hits[0]?.line).toBe(0);
		expect(hits[0]?.column).toBe(lines[0]?.indexOf('(('));
		expect(hits[0]?.kind).toBe('inline');
	});

	it('一行内多个引用全部识别', () => {
		const hits = scanReferences([`- ((${UUID_A})) 与 ((${UUID_B}))`]);
		expect(hits.map((hit) => hit.uuid)).toEqual([UUID_A, UUID_B]);
	});

	it('跨行引用分别记录行号', () => {
		const hits = scanReferences([`- ((${UUID_A}))`, '- 中间', `- ((${UUID_B}))`]);
		expect(hits.map((hit) => hit.line)).toEqual([0, 2]);
	});

	it('UUID 统一转小写', () => {
		const hits = scanReferences([`- ((${UUID_A.toUpperCase()}))`]);
		expect(hits[0]?.uuid).toBe(UUID_A);
	});

	it('识别 embed 形态', () => {
		const hits = scanReferences([`- {{embed ((${UUID_A}))}}`]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.kind).toBe('embed');
	});
});

describe('scanReferences 假阳性排除', () => {
	it('行内代码里的引用不算', () => {
		expect(scanReferences([`- 示例 \`((${UUID_A}))\` 结束`])).toHaveLength(0);
	});

	it('代码围栏里的引用不算', () => {
		const lines = ['- 代码：', '\t```', `\t- ((${UUID_A}))`, '\t```'];
		expect(scanReferences(lines)).toHaveLength(0);
	});

	it('围栏结束后的引用照常识别', () => {
		const lines = ['```', `((${UUID_A}))`, '```', `- ((${UUID_B}))`];
		const hits = scanReferences(lines);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.uuid).toBe(UUID_B);
	});

	it('frontmatter 里的引用不算', () => {
		const lines = ['---', `aliases: ["((${UUID_A}))"]`, '---', `- ((${UUID_B}))`];
		const hits = scanReferences(lines);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.uuid).toBe(UUID_B);
	});

	it('全角括号引用也能识别', () => {
		const hits = scanReferences([`- 参见 （（${UUID_A}））`]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.uuid).toBe(UUID_A);
	});

	it('过短的伪 UUID 不算块引用', () => {
		expect(scanReferences(['- 参见 ((abc))'])).toHaveLength(0);
	});
});

describe('extractUuidsFromLine', () => {
	it('按出现顺序返回 UUID', () => {
		expect(extractUuidsFromLine(`((${UUID_A})) somewhere ((${UUID_B}))`)).toEqual([UUID_A, UUID_B]);
	});

	it('忽略行内代码', () => {
		expect(extractUuidsFromLine(`\`((${UUID_A}))\` ((${UUID_B}))`)).toEqual([UUID_B]);
	});
});
