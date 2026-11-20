import { describe, expect, it } from 'vitest';

import { locateAllReferences, locateReferenceAt } from '../core/refLocator';

const UUID = '66c73a56-ddda-44d2-80dd-009e44406fd4';
const UUID2 = '678bcfae-dea4-4cee-8c7f-ea71ff0b3c0b';

describe('locateReferenceAt', () => {
	const line = `- 参见 ((${UUID})) 这一节`;

	it('列号落在括号范围内时命中', () => {
		const start = line.indexOf('((');
		const located = locateReferenceAt(line, start);
		expect(located).not.toBeNull();
		expect(located?.uuid).toBe(UUID);
		expect(located?.start).toBe(start);
		expect(located?.end).toBe(start + UUID.length + 4);
	});

	it('列号落在 UUID 中间也命中', () => {
		const start = line.indexOf('((');
		expect(locateReferenceAt(line, start + 10)?.uuid).toBe(UUID);
	});

	it('恰好落在最后一个字符（右括号）上命中', () => {
		const start = line.indexOf('((');
		expect(locateReferenceAt(line, start + UUID.length + 3)?.uuid).toBe(UUID);
	});

	it('紧贴引用之后的位置不命中（end 是开区间）', () => {
		const start = line.indexOf('((');
		expect(locateReferenceAt(line, start + UUID.length + 4)).toBeNull();
	});

	it('普通文字上不命中', () => {
		expect(locateReferenceAt(line, 2)).toBeNull();
	});

	it('行内多个引用分别命中正确的那个', () => {
		const two = `((${UUID})) 和 ((${UUID2}))`;
		expect(locateReferenceAt(two, 0)?.uuid).toBe(UUID);
		const second = two.indexOf(UUID2);
		expect(locateReferenceAt(two, second)?.uuid).toBe(UUID2);
	});

	it('全角括号也能定位', () => {
		const fullwidth = `参见 （（${UUID}）） 完`;
		const located = locateReferenceAt(fullwidth, fullwidth.indexOf('（（'));
		expect(located?.uuid).toBe(UUID);
	});

	it('过短的伪 UUID 不命中', () => {
		expect(locateReferenceAt('((abc))', 3)).toBeNull();
	});

	it('大小写混合的 UUID 归一化为小写', () => {
		const upper = `((${UUID.toUpperCase()}))`;
		expect(locateReferenceAt(upper, 3)?.uuid).toBe(UUID);
	});
});

describe('locateAllReferences', () => {
	it('返回全部引用及其列范围', () => {
		const line = `((${UUID})) 和 ((${UUID2}))`;
		const all = locateAllReferences(line);
		expect(all).toHaveLength(2);
		expect(all[0]?.uuid).toBe(UUID);
		expect(all[1]?.uuid).toBe(UUID2);
		expect(all[1]?.start).toBe(line.indexOf(UUID2) - 2);
	});

	it('无引用时返回空数组', () => {
		expect(locateAllReferences('普通文本')).toEqual([]);
	});
});
