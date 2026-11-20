import { describe, expect, it } from 'vitest';

import { isBlankLine, isSourceBlockLine, lineIndentColumns, measureIndentColumns, parseSourceBlockLine } from '../core/blockLine';

describe('measureIndentColumns', () => {
	it('普通空格按 1 列计算', () => {
		expect(measureIndentColumns('   ')).toBe(3);
	});

	it('制表符对齐到下一个制表位，而不是算 1 列', () => {
		expect(measureIndentColumns('\t')).toBe(4);
		expect(measureIndentColumns('\t\t')).toBe(8);
	});

	it('空格与制表符混用时按制表位对齐', () => {
		// 2 个空格后接一个 tab：列数 2，补到 4，再接 tab 到 8
		expect(measureIndentColumns('  \t')).toBe(4);
		expect(measureIndentColumns('     \t')).toBe(8);
	});

	it('空串为 0 列', () => {
		expect(measureIndentColumns('')).toBe(0);
	});
});

describe('parseSourceBlockLine', () => {
	it('识别普通列表行', () => {
		expect(parseSourceBlockLine('- 内容')).toEqual({ leadingWhitespace: '', content: '内容' });
	});

	it('识别缩进列表行并返回缩进原文', () => {
		expect(parseSourceBlockLine('\t- 子块')).toEqual({ leadingWhitespace: '\t', content: '子块' });
	});

	it('识别空块（行尾直接结束）', () => {
		expect(parseSourceBlockLine('-')).toEqual({ leadingWhitespace: '', content: '' });
	});

	it('识别仅含尾部空白的空块', () => {
		expect(parseSourceBlockLine('-   ')).toEqual({ leadingWhitespace: '', content: '' });
	});

	it('水平线不能被当成空块', () => {
		expect(parseSourceBlockLine('---')).toBeNull();
		expect(parseSourceBlockLine('- - -')).toBeNull();
		expect(parseSourceBlockLine('----')).toBeNull();
	});

	it('星号与加号列表不算块', () => {
		expect(parseSourceBlockLine('* 内容')).toBeNull();
		expect(parseSourceBlockLine('+ 内容')).toBeNull();
	});

	it('普通正文不算块', () => {
		expect(parseSourceBlockLine('这是正文')).toBeNull();
	});
});

describe('lineIndentColumns', () => {
	it('统计行首空白的列数', () => {
		expect(lineIndentColumns('\t\t- x')).toBe(8);
		expect(lineIndentColumns('    - x')).toBe(4);
		expect(lineIndentColumns('- x')).toBe(0);
	});
});

describe('isBlankLine', () => {
	it('空格、制表符、回车都算空行', () => {
		expect(isBlankLine('   ')).toBe(true);
		expect(isBlankLine('\t')).toBe(true);
		expect(isBlankLine('')).toBe(true);
		expect(isBlankLine(' x ')).toBe(false);
	});
});

describe('isSourceBlockLine', () => {
	it('与 parseSourceBlockLine 判定一致', () => {
		expect(isSourceBlockLine('- a')).toBe(true);
		expect(isSourceBlockLine('---')).toBe(false);
	});
});
