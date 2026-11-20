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

describe('scanReferences embed 引用', () => {
	it('识别标准 embed 并覆盖完整表达式', () => {
		const lines = [`- {{embed ((${UUID_A}))}}`];
		const hits = scanReferences(lines);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.kind).toBe('embed');
		expect(hits[0]?.uuid).toBe(UUID_A);
		// 范围必须从 `{{` 一直到 `}}`，否则渲染会残留外壳
		const line = lines[0] ?? '';
		expect(line.slice(hits[0]!.column, hits[0]!.endColumn)).toBe(`{{embed ((${UUID_A}))}}`);
	});

	it('embed 内部的 UUID 不会被重复计入', () => {
		const hits = scanReferences([`- {{embed ((${UUID_A}))}}`]);
		expect(hits).toHaveLength(1);
	});

	it('支持带空白的 embed 变体', () => {
		const variants = [
			`- {{ embed ((${UUID_A})) }}`,
			`- {{embed  ((${UUID_A}))  }}`,
			`- {{  embed ((${UUID_A}))}}`,
		];
		for (const line of variants) {
			const hits = scanReferences([line]);
			expect(hits, line).toHaveLength(1);
			expect(hits[0]?.kind).toBe('embed');
			expect(hits[0]?.uuid).toBe(UUID_A);
		}
	});

	it('embed 与普通引用混在一行时都能识别', () => {
		const line = `- {{embed ((${UUID_A}))}} 另见 ((${UUID_B}))`;
		const hits = scanReferences([line]);
		expect(hits).toHaveLength(2);
		expect(hits[0]?.kind).toBe('embed');
		expect(hits[0]?.uuid).toBe(UUID_A);
		expect(hits[1]?.kind).toBe('inline');
		expect(hits[1]?.uuid).toBe(UUID_B);
		// 第二个的范围只覆盖 ((uuid))
		expect(line.slice(hits[1]!.column, hits[1]!.endColumn)).toBe(`((${UUID_B}))`);
	});

	it('代码块里的 embed 不算', () => {
		const lines = ['```', `{{embed ((${UUID_A}))}}`, '```'];
		expect(scanReferences(lines)).toHaveLength(0);
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
