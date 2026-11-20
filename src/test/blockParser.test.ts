import { describe, expect, it } from 'vitest';

import { findDeepestBlockAtLine, parseMarkdown, splitLines } from '../core/blockParser';
import { getBlockTitle } from '../core/render';

const UUID_A = '678bcfae-dea4-4cee-8c7f-ea71ff0b3c0b';
const UUID_B = '678bcfae-b490-491d-8b92-2e65c09cdd9e';

/** 与真实笔记库结构一致的样例（取自 pages/2驱动方分类、剧情模式.md 的前半部分）。 */
const SAMPLE = [
	'- # 1 两方对立（最常见）',
	'  collapsed:: true',
	'\t- 主动方和对立方的区别是哪一方先主动实施计划和行动，哪一方被动做出应对。',
	'- # 2 导演一人身兼两角',
	'  collapsed:: true',
	`  id:: ${UUID_A}`,
	'\t- 即驱动人物有双重身份，同时是主动方和对立方的驱动人物。',
	'\t- 导演人设：',
	`\t  id:: ${UUID_B}`,
	'\t\t- [[机关算尽]]',
	'\t\t- [[老谋深算]]',
	'\t- 明面上的身份，是对立方的驱动人物',
].join('\n');

describe('splitLines', () => {
	it('剥离 CRLF 的行尾回车', () => {
		expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b', '']);
	});

	it('保留空行', () => {
		expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
	});
});

describe('parseMarkdown 块树', () => {
	it('识别根块数量', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		const roots = parsed.blocks.filter((block) => block.parent === -1);
		expect(roots).toHaveLength(2);
	});

	it('第二个根块有三个直接子块', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		const secondRootIndex = parsed.blocks.findIndex((block) => block.startLine === 3);
		expect(secondRootIndex).toBeGreaterThanOrEqual(0);
		const secondRoot = parsed.blocks[secondRootIndex];
		// 子块分别是：即驱动人物…、导演人设：、明面上的身份…
		expect(secondRoot?.children).toHaveLength(3);
	});

	it('孙块挂在正确的父块下', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		// 第 8 行是「导演人设：」（0-based 行号 7）
		const personaIndex = parsed.blocks.findIndex((block) => block.startLine === 7);
		expect(personaIndex).toBeGreaterThanOrEqual(0);
		expect(parsed.blocks[personaIndex]?.children).toHaveLength(2);
	});

	it('块首行正文去掉列表标记', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		const first = parsed.blocks[0];
		expect(first ? getBlockTitle(first.ownLines[0] ?? '') : '').toBe('# 1 两方对立（最常见）');
	});

	it('根块 endLine 覆盖全部子块', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		const secondRootIndex = parsed.blocks.findIndex((block) => block.startLine === 3);
		const secondRoot = parsed.blocks[secondRootIndex];
		// 最后一行是第 11 行（0-based）
		expect(secondRoot?.endLine).toBe(11);
	});

	it('记录块首行行号到下标映射', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		expect(parsed.blockAtStartLine.get(0)).toBe(0);
		expect(parsed.blockAtStartLine.get(3)).toBeGreaterThan(0);
	});
});

describe('parseMarkdown 块 ID 归属', () => {
	it('id:: 归属缩进更浅的父块，而不是后面的子块', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		expect(parsed.blocksById.get(UUID_A)).toHaveLength(1);
		const index = parsed.blocksById.get(UUID_A)?.[0];
		expect(index).toBeDefined();
		expect(parsed.blocks[index as number]?.startLine).toBe(3);
	});

	it('子块的 id:: 归属子块', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		const index = parsed.blocksById.get(UUID_B)?.[0];
		expect(index).toBeDefined();
		expect(parsed.blocks[index as number]?.startLine).toBe(7);
	});

	it('同一块出现多个 id:: 时保留第一个', () => {
		const content = ['- 块', '  id:: 11111111-1111-1111-1111-111111111111', '  id:: 22222222-2222-2222-2222-222222222222'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks[0]?.id).toBe('11111111-1111-1111-1111-111111111111');
	});

	it('ID 统一转小写', () => {
		const content = ['- 块', '  id:: ABCDEFAB-1111-2222-3333-444444444444'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks[0]?.id).toBe('abcdefab-1111-2222-3333-444444444444');
	});

	it('空块也能携带 ID', () => {
		const content = ['-', '  id:: 11111111-1111-1111-1111-111111111111'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks[0]?.id).toBe('11111111-1111-1111-1111-111111111111');
	});
});

describe('parseMarkdown 边界情况', () => {
	it('跳过 frontmatter，其中的列表行不产生块', () => {
		const content = ['---', 'title: 测试', '- 这行在 frontmatter 里', '---', '- 真正的块'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.blocks[0]?.startLine).toBe(4);
	});

	it('页面属性行不产生块', () => {
		const content = ['title:: 页面标题', 'tags:: 测试', '- 第一个块'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.pageProperties).toHaveLength(2);
	});

	it('列表项内代码块里的列表行不产生新块', () => {
		const content = [
			'- 代码示例：',
			'\t```md',
			'\t- 这是代码里的列表行，不是块',
			'\t```',
			'\t- 真正的子块',
		].join('\n');
		const parsed = parseMarkdown('x.md', content);
		// 根块 1 个 + 真正的子块 1 个 = 2
		expect(parsed.blocks).toHaveLength(2);
		expect(parsed.blocks.some((block) => (block.ownLines[0] ?? '').includes('这是代码里的列表行'))).toBe(false);
	});

	it('代码块里的 id:: 不被解析', () => {
		const content = [
			'- 示例',
			'\t```',
			`\tid:: ${UUID_A}`,
			'\t```',
		].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocksById.size).toBe(0);
	});

	it('制表符与空格混用缩进时层级仍正确', () => {
		const content = ['- 父块', '    - 四空格子块', '\t\t- 两制表符孙块'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(3);
		expect(parsed.blocks[1]?.parent).toBe(0);
		expect(parsed.blocks[2]?.parent).toBe(1);
	});

	it('块内空行不会切断块', () => {
		const content = ['- 第一段', '', '  第二段', '- 下一个块'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(2);
		expect(parsed.blocks[0]?.ownLines.length).toBeGreaterThanOrEqual(3);
	});

	it('水平线不产生块', () => {
		const content = ['- 块一', '---', '- 块二'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(2);
	});
});

describe('findDeepestBlockAtLine', () => {
	it('返回包含该行的最深块', () => {
		const parsed = parseMarkdown('sample.md', SAMPLE);
		// 第 9 行（0-based）是 [[机关算尽]]，属于「导演人设：」的子块
		const index = findDeepestBlockAtLine(parsed, 9);
		expect(parsed.blocks[index]?.startLine).toBe(9);
	});

	it('行号不在任何块内时返回 -1', () => {
		const parsed = parseMarkdown('x.md', ['title:: x', '- 块'].join('\n'));
		expect(findDeepestBlockAtLine(parsed, 0)).toBe(-1);
	});
});
