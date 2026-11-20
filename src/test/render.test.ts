import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import { getBlockTitle, measureSubtree, renderBlockTree, stripHeadingMarks } from '../core/render';

const ID = '678bcfae-dea4-4cee-8c7f-ea71ff0b3c0b';

const SAMPLE = [
	'- # 2 导演一人身兼两角',
	'  collapsed:: true',
	`  id:: ${ID}`,
	'\t- 即驱动人物有双重身份。',
	'\t  tags:: 谍战',
	'\t\t- [[机关算尽]]',
].join('\n');

describe('getBlockTitle', () => {
	it('去掉列表标记与首尾空白', () => {
		expect(getBlockTitle('- 内容  ')).toBe('内容');
		expect(getBlockTitle('\t- 缩进内容')).toBe('缩进内容');
	});

	it('空块返回空串', () => {
		expect(getBlockTitle('-')).toBe('');
	});
});

describe('renderBlockTree', () => {
	it('根块首行不带列表标记，子块保留标记', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const text = renderBlockTree(parsed, 0);
		const lines = text.split('\n');

		expect(lines[0]).toBe('# 2 导演一人身兼两角');
		expect(lines.some((line) => line.trimStart().startsWith('- 即驱动人物有双重身份。'))).toBe(true);
		expect(lines.some((line) => line.trim() === '- [[机关算尽]]')).toBe(true);
	});

	it('隐藏 id:: 与 collapsed::', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const text = renderBlockTree(parsed, 0);
		expect(text).not.toContain('id::');
		expect(text).not.toContain('collapsed::');
	});

	it('保留其他属性（可能有语义）', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const text = renderBlockTree(parsed, 0);
		expect(text).toContain('tags:: 谍战');
	});

	it('子块逐层增加缩进', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const lines = renderBlockTree(parsed, 0).split('\n');
		const childLine = lines.find((line) => line.includes('即驱动人物'));
		const grandChildLine = lines.find((line) => line.includes('机关算尽'));

		expect(childLine?.startsWith('  - ')).toBe(true);
		expect(grandChildLine?.startsWith('    - ')).toBe(true);
	});

	it('includeChildren=false 时只输出块自身', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const text = renderBlockTree(parsed, 0, { includeChildren: false });
		expect(text).toContain('导演一人身兼两角');
		expect(text).not.toContain('即驱动人物');
		expect(text).not.toContain('机关算尽');
	});

	it('compact 模式只输出各块首行', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const text = renderBlockTree(parsed, 0, { compact: true });
		const lines = text.split('\n');
		expect(lines[0]).toBe('# 2 导演一人身兼两角');
		expect(text).toContain('即驱动人物有双重身份。');
		// 续行属性被省略
		expect(text).not.toContain('tags:: 谍战');
	});

	it('制表符缩进被展开为空格', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const text = renderBlockTree(parsed, 0);
		expect(text).not.toContain('\t');
	});

	it('块不存在时返回空串', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		expect(renderBlockTree(parsed, 999)).toBe('');
	});

	it('自定义隐藏属性列表', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const text = renderBlockTree(parsed, 0, { hideProperties: ['tags'] });
		expect(text).not.toContain('tags::');
		// 恢复默认隐藏集合之外的属性不再隐藏 id（因为覆盖了列表）
		expect(text).toContain('id::');
	});
});

describe('stripHeadingMarks', () => {
	it('去掉各级标题标记', () => {
		expect(stripHeadingMarks('# 一级标题')).toBe('一级标题');
		expect(stripHeadingMarks('## 3.1 棋子觉醒/背叛')).toBe('3.1 棋子觉醒/背叛');
		expect(stripHeadingMarks('###### 六级')).toBe('六级');
	});

	it('没有空格的 #标签 不当作标题', () => {
		// Logseq 的 tag 语法是 #标签，去掉会破坏语义。
		expect(stripHeadingMarks('#标签')).toBe('#标签');
		expect(stripHeadingMarks('##标签')).toBe('##标签');
	});

	it('普通正文不受影响', () => {
		expect(stripHeadingMarks('普通内容')).toBe('普通内容');
		expect(stripHeadingMarks('')).toBe('');
	});

	it('7 个以上的 # 不匹配（CommonMark 最多 6 级）', () => {
		expect(stripHeadingMarks('####### 太多')).toBe('####### 太多');
	});

	it('只去掉行首标记，正文中间的 # 保留', () => {
		expect(stripHeadingMarks('## 标题 #1')).toBe('标题 #1');
	});
});

describe('renderBlockTree 标题标记', () => {
	const content = ['- ## 3.1 小节标题', '\t- 子块内容'].join('\n');

	it('默认保留标题标记', () => {
		const parsed = parseMarkdown('x.md', content);
		expect(renderBlockTree(parsed, 0).split('\n')[0]).toBe('## 3.1 小节标题');
	});

	it('stripHeadingMarks=true 时去掉标题标记', () => {
		const parsed = parseMarkdown('x.md', content);
		expect(renderBlockTree(parsed, 0, { stripHeadingMarks: true }).split('\n')[0]).toBe('3.1 小节标题');
	});

	it('子块的标题标记也一并去掉', () => {
		const parsed = parseMarkdown('x.md', ['- 父块', '\t- ## 子块标题'].join('\n'));
		const text = renderBlockTree(parsed, 0, { stripHeadingMarks: true });
		expect(text).toContain('- 子块标题');
		expect(text).not.toContain('##');
	});
});

describe('measureSubtree', () => {
	it('统计块自身与全部后代的行数', () => {
		const parsed = parseMarkdown('x.md', SAMPLE);
		const size = measureSubtree(parsed, 0);
		// 根块 3 行 + 子块 2 行 + 孙块 1 行 = 6
		expect(size.lines).toBe(6);
		expect(size.chars).toBeGreaterThan(0);
	});
});
