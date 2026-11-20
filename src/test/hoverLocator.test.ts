import { describe, expect, it } from 'vitest';

import { findHoverTarget, type HoverLayout } from '../core/hoverLocator';
import { locateAllReferences } from '../core/refLocator';

const UUID = '66c73a56-ddda-44d2-80dd-009e44406fd4';
const SOURCE_WIDTH = UUID.length + 4; // 40

/** 构造一行：前缀 + ((uuid)) + 后缀。 */
function makeLine(prefix = '', suffix = ''): string {
	return `${prefix}((${UUID}))${suffix}`;
}

const REPLACE: HoverLayout = { enabled: true, replaceMode: true };
const APPEND: HoverLayout = { enabled: true, replaceMode: false };
const OFF: HoverLayout = { enabled: false, replaceMode: true };

/** 固定返回标题的取值函数。 */
const fixedTitle = (title: string) => () => title;

describe('findHoverTarget 渲染关闭时', () => {
	const line = makeLine('参见 ', ' 结束');
	const refs = locateAllReferences(line);
	const start = line.indexOf('((');

	it('落在引用内命中', () => {
		expect(findHoverTarget(refs, start + 5, fixedTitle('标题'), OFF)?.reference.uuid).toBe(UUID);
	});

	it('落在引用之后不命中', () => {
		expect(findHoverTarget(refs, start + SOURCE_WIDTH, fixedTitle('标题'), OFF)).toBeUndefined();
	});

	it('落在前缀里不命中', () => {
		expect(findHoverTarget(refs, 1, fixedTitle('标题'), OFF)).toBeUndefined();
	});
});

describe('findHoverTarget replace 模式', () => {
	it('标题比原文短时，视觉范围按标题宽度算', () => {
		const line = makeLine('参见 ', ' 结束');
		const refs = locateAllReferences(line);
		const start = line.indexOf('((');
		const title = '短标题'; // 3 字符

		// 引用起点 + 3 列之内命中
		expect(findHoverTarget(refs, start + 2, fixedTitle(title), REPLACE)).toBeDefined();
		// 超出视觉宽度（但仍在原文宽度内，因为原文被隐藏了）→ 仍应命中原文范围
		expect(findHoverTarget(refs, start + SOURCE_WIDTH - 1, fixedTitle(title), REPLACE)).toBeDefined();
	});

	it('标题比原文长时，视觉范围延伸到标题末尾', () => {
		const line = makeLine('参见 ', ' 结束');
		const refs = locateAllReferences(line);
		const start = line.indexOf('((');
		// 标题 60 字符，远长于原文 40
		const title = '长'.repeat(60);

		// 落在替换文本末端（原文范围之外）仍命中
		expect(findHoverTarget(refs, start + 55, fixedTitle(title), REPLACE)).toBeDefined();
		// 超出替换文本末端不命中
		expect(findHoverTarget(refs, start + 61, fixedTitle(title), REPLACE)).toBeUndefined();
	});

	it('visualEnd 至少覆盖到原文末尾，不能只按标题宽度算', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		const title = '一二三四五';
		const target = findHoverTarget(refs, 0, fixedTitle(title), REPLACE);
		// replace 模式下字符宽度被压成 0，VS Code 算出的鼠标位置可能落在原文末尾。
		// 视觉边界必须覆盖到 reference.end，否则 character === end 时两个判定都失败。
		expect(target?.visualEnd).toBe(SOURCE_WIDTH);
	});

	it('鼠标位置等于 reference.end 时仍然命中（回归：曾导致 hover 全失效）', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		const title = '标题';

		// 这是真实场景：原文被 font-size:0 隐藏后，鼠标在其上时
		// VS Code 换算出的位置常常就是 end。
		expect(findHoverTarget(refs, SOURCE_WIDTH, fixedTitle(title), REPLACE)).toBeDefined();
	});

	it('标题很短时，落在隐藏原文任意位置都命中', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		const title = '标题';
		for (const column of [0, 1, 10, 20, SOURCE_WIDTH - 1, SOURCE_WIDTH]) {
			expect(findHoverTarget(refs, column, fixedTitle(title), REPLACE), `列 ${column}`).toBeDefined();
		}
	});

	it('超出原文末尾之后不命中', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		expect(findHoverTarget(refs, SOURCE_WIDTH + 1, fixedTitle('标题'), REPLACE)).toBeUndefined();
	});
});

describe('findHoverTarget append 模式', () => {
	it('视觉范围包含原文 + 〔标题〕', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		const title = '标题';

		// 原文 40 + 标题 2 + 括号 2 = 44
		const target = findHoverTarget(refs, 0, fixedTitle(title), APPEND);
		expect(target?.visualEnd).toBe(SOURCE_WIDTH + title.length + 2);
	});

	it('落在追加部分命中', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		const title = '标题文字';
		expect(findHoverTarget(refs, SOURCE_WIDTH + 3, fixedTitle(title), APPEND)).toBeDefined();
	});

	it('超出追加部分不命中', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		const title = '标题';
		expect(findHoverTarget(refs, SOURCE_WIDTH + title.length + 3, fixedTitle(title), APPEND)).toBeUndefined();
	});
});

describe('findHoverTarget 多引用', () => {
	const line = `((${UUID})) 中间 ((${UUID}))`;
	const refs = locateAllReferences(line);

	it('命中鼠标所在的那一处（取最靠右的重叠起点）', () => {
		const secondStart = line.lastIndexOf('((');
		const target = findHoverTarget(refs, secondStart + 5, fixedTitle('标题'), REPLACE);
		expect(target?.reference.start).toBe(secondStart);
	});

	it('两处之间的空白不命中（视觉范围不重叠时）', () => {
		const target = findHoverTarget(refs, SOURCE_WIDTH + 2, fixedTitle('短'), REPLACE);
		expect(target).toBeUndefined();
	});
});

describe('findHoverTarget 过滤', () => {
	it('titleOf 返回 undefined 的引用被忽略', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		expect(findHoverTarget(refs, 5, () => undefined, REPLACE)).toBeUndefined();
	});

	it('空引用列表返回 undefined', () => {
		expect(findHoverTarget([], 0, fixedTitle('x'), REPLACE)).toBeUndefined();
	});

	it('titleOf 返回空串表示无替换文本，按原文宽度计算', () => {
		const line = makeLine();
		const refs = locateAllReferences(line);
		// 空串场景用于「悬空引用且未开启提示」：行内保留原文，hover 仍需响应。
		const target = findHoverTarget(refs, 5, fixedTitle(''), REPLACE);
		expect(target?.visualEnd).toBe(SOURCE_WIDTH);
		// 紧贴引用之后不命中
		expect(findHoverTarget(refs, SOURCE_WIDTH + 1, fixedTitle(''), REPLACE)).toBeUndefined();
	});
});
