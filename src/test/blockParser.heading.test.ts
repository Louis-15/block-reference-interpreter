/**
 * 顶格 ATX 标题（`# 标题`，行首无缩进）作为独立块的解析测试。
 *
 * 为什么要单独成文件：`blockParser.test.ts` 已接近 400 行警戒线，
 * 而这条规则是相对独立的一块——它处理的是「没有 `- ` 列表标记的块」，
 * 与列表块、ID 归属那些用例的关注点不同。
 *
 * 规则来源：Tine / Logseq（lsdoc）把顶格 `# 标题` 当作块，
 * 它可以挂 `id::`、可以被 `((uuid))` 引用。插件原先只在**文件开头**
 * 支持这种块，文件中部出现的第二个顶格标题会被丢弃，
 * 导致后一个标题下的子块错误地并入前一个标题的子树。
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import { getBlockTitle } from '../core/render';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

/** 两个顶格标题并列，各自带子块与 ID。 */
const TWO_HEADINGS = [
	'# 人物',
	'\t- 张楚岚',
	`\t  id:: ${UUID_A}`,
	'',
	'# 势力',
	`id:: ${UUID_B}`,
	'\t- 哪都通',
	`\t  id:: ${UUID_C}`,
].join('\n');

describe('顶格标题块', () => {
	it('第二个顶格标题成为新的根块，不并入前一个', () => {
		const parsed = parseMarkdown('x.md', TWO_HEADINGS);
		const roots = parsed.blocks.filter((block) => block.parent === -1);
		expect(roots).toHaveLength(2);
		expect(roots.map((block) => block.startLine)).toEqual([0, 4]);
	});

	it('每个标题的子块挂在各自标题下', () => {
		const parsed = parseMarkdown('x.md', TWO_HEADINGS);
		const firstHeading = parsed.blocks[0];
		const secondHeading = parsed.blocks.find((block) => block.startLine === 4);

		expect(firstHeading?.children).toHaveLength(1);
		expect(secondHeading?.children).toHaveLength(1);
		// 子块首行分别是「张楚岚」和「哪都通」。
		expect(parsed.blocks[firstHeading?.children[0] ?? -1]?.startLine).toBe(1);
		expect(parsed.blocks[secondHeading?.children[0] ?? -1]?.startLine).toBe(6);
	});

	it('顶格标题后与它同缩进的 id:: 归属它自己', () => {
		// 这是最容易串块的一项：`id::` 顶格，若标题没被建成块，
		// 它会挂到上一个标题名下，同一个 UUID 在两边指向不同的块。
		const parsed = parseMarkdown('x.md', TWO_HEADINGS);
		const owner = parsed.blocksById.get(UUID_B)?.[0];
		expect(owner).toBeDefined();
		expect(parsed.blocks[owner as number]?.startLine).toBe(4);
	});

	it('子块的 id:: 仍然归属子块', () => {
		const parsed = parseMarkdown('x.md', TWO_HEADINGS);
		const first = parsed.blocksById.get(UUID_A)?.[0];
		const second = parsed.blocksById.get(UUID_C)?.[0];
		expect(parsed.blocks[first as number]?.startLine).toBe(1);
		expect(parsed.blocks[second as number]?.startLine).toBe(6);
	});

	it('标题正文保留 `#`，按需由渲染层剥掉', () => {
		const parsed = parseMarkdown('x.md', TWO_HEADINGS);
		const heading = parsed.blocks.find((block) => block.startLine === 4);
		expect(getBlockTitle(heading?.ownLines[0] ?? '')).toBe('# 势力');
	});

	it('endLine 覆盖标题下的全部子块', () => {
		const parsed = parseMarkdown('x.md', TWO_HEADINGS);
		const heading = parsed.blocks.find((block) => block.startLine === 4);
		expect(heading?.endLine).toBe(7);
	});

	it('文件开头的顶格标题行为不变（真实库中存在该写法）', () => {
		const content = ['# 1 大义、天理', 'collapsed:: true', `id:: ${UUID_A}`, '\t- 孟子：民为贵'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(2);
		expect(parsed.blocks[0]?.startLine).toBe(0);
		expect(parsed.blocksById.get(UUID_A)?.[0]).toBe(0);
	});
});

describe('顶格标题的边界条件', () => {
	it('`#标签`（# 后没有空白）不是块', () => {
		// Logseq 的 tag 语法与标题语法只差一个空格，放宽会把 tag 变成块。
		const content = ['- 块', '#标签'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(1);
	});

	it('缩进的 `# 标题` 是普通续行，不是块', () => {
		// 真实库里 `- ## 3.1 小节名` 下面的续行常见这种写法，
		// 若按顶格标题处理会凭空多出一个根块。
		const content = ['- 块', '\t# 缩进标题'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.blocks[0]?.ownLines).toHaveLength(2);
	});

	it('`#` 单独成行也算标题块', () => {
		const content = ['- 块', '#', '\t- 子块'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(3);
		expect(parsed.blocks[1]?.parent).toBe(-1);
		expect(parsed.blocks[2]?.parent).toBe(1);
	});

	it('多级标题各自成块', () => {
		const content = ['# 一级', '## 二级', '### 三级'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		// 三个都是顶格根块，层级由 `#` 数量表达，不改变块树父子关系。
		expect(parsed.blocks).toHaveLength(3);
		expect(parsed.blocks.every((block) => block.parent === -1)).toBe(true);
	});

	it('代码围栏内的顶格标题不当作块', () => {
		const content = ['- 块', '\t```', '\t# 注释', '\t```'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		expect(parsed.blocks).toHaveLength(1);
	});

	it('顶格标题之后的普通顶格正文不会变成块', () => {
		const content = ['# 标题', '普通正文一行', '\t- 子块'].join('\n');
		const parsed = parseMarkdown('x.md', content);
		// 普通正文缩进为 0、与标题同缩进且不是属性行，按既有规则被忽略。
		expect(parsed.blocks).toHaveLength(2);
		expect(parsed.blocks[0]?.ownLines).toHaveLength(1);
	});
});
