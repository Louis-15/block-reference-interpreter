import { describe, expect, it } from 'vitest';

import { matchSimpleGlob } from '../core/globMatch';

describe('matchSimpleGlob 基本匹配', () => {
	it('字面量精确匹配', () => {
		expect(matchSimpleGlob('pages/a.md', 'pages/a.md')).toBe(true);
		expect(matchSimpleGlob('pages/b.md', 'pages/a.md')).toBe(false);
	});

	it('大小写不敏感', () => {
		expect(matchSimpleGlob('Pages/A.MD', 'pages/a.md')).toBe(true);
	});
});

describe('matchSimpleGlob 单星号', () => {
	it('不跨目录', () => {
		expect(matchSimpleGlob('pages/a.md', 'pages/*.md')).toBe(true);
		expect(matchSimpleGlob('pages/sub/a.md', 'pages/*.md')).toBe(false);
	});

	it('可以匹配空串', () => {
		expect(matchSimpleGlob('pages/.md', 'pages/*.md')).toBe(true);
	});
});

describe('matchSimpleGlob 双星号', () => {
	it('**/ 允许零层目录（这是插件默认 include 的关键场景）', () => {
		expect(matchSimpleGlob('pages/a.md', 'pages/**/*.md')).toBe(true);
	});

	it('**/ 允许任意层目录', () => {
		expect(matchSimpleGlob('pages/sub/a.md', 'pages/**/*.md')).toBe(true);
		expect(matchSimpleGlob('pages/a/b/c/a.md', 'pages/**/*.md')).toBe(true);
	});

	it('裸 ** 跨目录匹配', () => {
		expect(matchSimpleGlob('anything/at/all.md', '**')).toBe(true);
	});

	it('**/*.md 匹配任意深度的 md', () => {
		expect(matchSimpleGlob('a.md', '**/*.md')).toBe(true);
		expect(matchSimpleGlob('x/y/a.md', '**/*.md')).toBe(true);
	});
});

describe('matchSimpleGlob 插件的默认规则', () => {
	const include = ['pages/**/*.md', 'journals/**/*.md'];

	it('pages 下的笔记命中', () => {
		expect(include.some((p) => matchSimpleGlob('pages/思想.md', p))).toBe(true);
	});

	it('journals 下的笔记命中', () => {
		expect(include.some((p) => matchSimpleGlob('journals/2026_01_01.md', p))).toBe(true);
	});

	it('logseq 下的文件不命中', () => {
		expect(include.some((p) => matchSimpleGlob('logseq/pages/a.md', p))).toBe(false);
	});

	it('根目录的 md 不命中', () => {
		expect(include.some((p) => matchSimpleGlob('readme.md', p))).toBe(false);
	});

	it('exclude 规则能挡住回收站', () => {
		const exclude = ['logseq/**', '.tine-trash/**', '**/bak/**', '**/.recycle/**'];
		expect(exclude.some((p) => matchSimpleGlob('logseq/.recycle/pages_x.md', p))).toBe(true);
		expect(exclude.some((p) => matchSimpleGlob('.tine-trash/a.md', p))).toBe(true);
		expect(exclude.some((p) => matchSimpleGlob('pages/bak/a.md', p))).toBe(true);
		expect(exclude.some((p) => matchSimpleGlob('pages/a.md', p))).toBe(false);
	});
});

describe('matchSimpleGlob 转义与健壮性', () => {
	it('正则元字符按字面量处理', () => {
		expect(matchSimpleGlob('pages/a+b.md', 'pages/a+b.md')).toBe(true);
		expect(matchSimpleGlob('pages/axb.md', 'pages/a+b.md')).toBe(false);
	});

	it('文件名带括号也能匹配', () => {
		expect(matchSimpleGlob('pages/误解（原因）.md', 'pages/**/*.md')).toBe(true);
	});

	it('问号匹配单个非分隔符字符', () => {
		expect(matchSimpleGlob('pages/a.md', 'pages/?.md')).toBe(true);
		expect(matchSimpleGlob('pages/ab.md', 'pages/?.md')).toBe(false);
	});

	it('反斜杠分隔的模式也能用', () => {
		expect(matchSimpleGlob('pages/a.md', 'pages\\**\\*.md')).toBe(true);
	});

	it('反斜杠分隔的目标路径也能用', () => {
		expect(matchSimpleGlob('pages\\a.md', 'pages/**/*.md')).toBe(true);
	});
});
