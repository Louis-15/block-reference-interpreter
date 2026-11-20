/**
 * 引用文本清洗测试。
 *
 * 这块的风险全在「误伤」上：正则太宽会把正常文字吃掉，
 * 太严又会把损坏的 ID 漏回面包屑。所以两个方向都要钉住。
 */

import { describe, expect, it } from 'vitest';

import { cleanReferenceLine, stripReferenceMarks } from '../core/refText';

const UUID = '6780f110-d8e8-489f-be72-d2b3dbbc5668';

describe('stripReferenceMarks', () => {
	it('剥掉纯行内引用，剩空字符串', () => {
		expect(stripReferenceMarks(`(( ${UUID} ))`)).toBe('');
		expect(stripReferenceMarks(`((${UUID}))`)).toBe('');
	});

	it('保留引用前后的文字', () => {
		expect(stripReferenceMarks(`2、 ((${UUID}))`)).toBe('2、');
		expect(stripReferenceMarks(`看这个 ((${UUID})) 就懂了`)).toBe('看这个  就懂了');
	});

	it('embed 外壳被完整剥掉，不留 {{embed }} 残骸', () => {
		const result = stripReferenceMarks(`{{embed ((${UUID}))}}`);
		expect(result).toBe('');
		expect(result).not.toContain('embed');
		expect(result).not.toContain('{{');
	});

	it('embed 带空白变体也能剥', () => {
		expect(stripReferenceMarks(`{{ embed (( ${UUID} )) }}`)).toBe('');
	});

	it('同一行多个引用全部剥掉', () => {
		expect(stripReferenceMarks(`(( ${UUID} )) 和 (( ${UUID} ))`)).toBe('和');
	});

	it('损坏的 ID（含点号）也能剥掉，不漏回面包屑', () => {
		// 真实库里存在这种被手工改坏的 ID
		expect(stripReferenceMarks('((65cc96fb-1.a7-4f00-9999-aaaaaaaaaaaa))')).toBe('');
	});

	it('不会误伤普通文字', () => {
		expect(stripReferenceMarks('普通的标题')).toBe('普通的标题');
		expect(stripReferenceMarks('函数调用 foo(a, b)')).toBe('函数调用 foo(a, b)');
		expect(stripReferenceMarks('双括号不是引用：((短))')).toBe('双括号不是引用：((短))');
		expect(stripReferenceMarks('# 71.3 毒舌讽刺型')).toBe('# 71.3 毒舌讽刺型');
	});

	it('不会误伤 [[页面链接]]', () => {
		expect(stripReferenceMarks('普通[[傻白+中二]]女')).toBe('普通[[傻白+中二]]女');
	});

	it('空字符串安全', () => {
		expect(stripReferenceMarks('')).toBe('');
	});
});

describe('cleanReferenceLine', () => {
	it('剥掉列表标记与引用，只留文字', () => {
		expect(cleanReferenceLine(`- 2、 ((${UUID}))`)).toBe('2、');
	});

	it('纯引用行清洗后为空', () => {
		expect(cleanReferenceLine(`- ((${UUID}))`)).toBe('');
		expect(cleanReferenceLine(`\t\t- {{embed ((${UUID}))}}`)).toBe('');
	});

	it('保留缩进之外的正文', () => {
		expect(cleanReferenceLine(`\t\t- 一段说明 ((${UUID}))`)).toBe('一段说明');
	});

	it('没有列表标记时也能处理', () => {
		expect(cleanReferenceLine(`((${UUID})) 后面的字`)).toBe('后面的字');
	});
});
