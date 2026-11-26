import { describe, expect, it } from 'vitest';

import {
	buildBlockEnterPlan,
	buildSoftBreakPlan,
	isLineInFrontmatter,
	isLineInsideFence,
	isPagePropertyLine,
} from '../core/blockSplit';
import { parseMarkdown } from '../core/blockParser';

/** 断言回车计划插入的文本。 */
function expectEnter(content: string, line: number, character: number, insertText: string): void {
	const parsed = parseMarkdown('test.md', content);
	const plan = buildBlockEnterPlan(parsed, line, character);
	if (plan.kind !== 'insert-block') {
		throw new Error(`expected insert-block, got ${plan.kind}`);
	}
	expect(plan.insertText).toBe(insertText);
}

/** 断言回车被拒绝。 */
function expectEnterReject(content: string, line: number, character: number, reason: string): void {
	const parsed = parseMarkdown('test.md', content);
	expect(buildBlockEnterPlan(parsed, line, character)).toMatchObject({
		kind: 'reject',
		reject: reason,
	});
}

/** 断言块内换行计划。 */
function expectSoftBreak(content: string, line: number, character: number, insertText: string): void {
	const parsed = parseMarkdown('test.md', content);
	const plan = buildSoftBreakPlan(parsed, line, character);
	if (plan.kind !== 'soft-break') {
		throw new Error(`expected soft-break, got ${plan.kind}`);
	}
	expect(plan.insertText).toBe(insertText);
}

describe('回车：块内新建同级块', () => {
	it('顶级块行尾回车', () => {
		expectEnter('- 块标题', 0, 5, '\n- ');
	});

	it('块首行中间回车，拆成两个同级块', () => {
		expectEnter('- 前半后半', 0, 3, '\n- ');
	});

	it('Tab 缩进的子块保留原缩进', () => {
		const content = ['- 父块', '\t- 子块', '\t  正文'].join('\n');
		expectEnter(content, 1, 6, '\n\t- ');
	});

	it('空格缩进的块保留原有空格', () => {
		const content = ['- 父块', '    - 子块'].join('\n');
		expectEnter(content, 1, 8, '\n    - ');
	});

	it('块内续行回车，新块跟随块级缩进', () => {
		const content = ['- 块标题', '  正文A正文B'].join('\n');
		expectEnter(content, 1, 5, '\n- ');
	});

	it('嵌套块的续行回车，新块仍是同级', () => {
		const content = ['- 父块', '\t- 子块', '\t    续行'].join('\n');
		expectEnter(content, 2, 6, '\n\t- ');
	});
});

describe('回车：空块允许连续出现', () => {
	it('空块行尾回车产生新的空块（不是退出列表）', () => {
		// 用户明确要求：空块是合法的占位写法，想空几行就空几行。
		expectEnter('- 上一个块\n- \n- 下一个块', 1, 2, '\n- ');
	});

	it('连续多个空块仍然逐个新建', () => {
		const content = ['- 块', '- ', '- ', '- '].join('\n');
		expectEnter(content, 3, 2, '\n- ');
	});

	it('缩进的空块保留缩进', () => {
		const content = ['- 父块', '\t- '].join('\n');
		expectEnter(content, 1, 3, '\n\t- ');
	});
});

describe('回车：正文区域一律产生大纲块', () => {
	it('块间空行回车仍插入带项目符号的新行', () => {
		expectEnter('- 块一\n\n- 块二', 1, 0, '\n- ');
	});

	it('顶格裸文本回车也产生块', () => {
		expectEnter('- 块\n裸文本', 1, 3, '\n- ');
	});

	it('文件开头的空行回车产生块', () => {
		expectEnter('\n- 第一个块', 0, 0, '\n- ');
	});

	it('没有块、只有正文的文件也产生块', () => {
		expectEnter('这是一段普通文字', 0, 3, '\n- ');
	});
});

describe('回车：拒绝接管的情况', () => {
	it('frontmatter 内回车不接管', () => {
		expectEnterReject(['---', 'title: 测试', '---', '- 块'].join('\n'), 1, 5, 'frontmatter');
	});

	it('页面属性行回车不接管', () => {
		expectEnterReject(['title:: 页面标题', '- 第一个块'].join('\n'), 0, 5, 'page-property');
	});

	it('正文里的块属性行（第一个块之后）不被当成页面属性', () => {
		// `collapsed::` 属于块属性，回车应该正常拆块
		expectEnter(['- 块', '  collapsed:: true', '  正文'].join('\n'), 1, 10, '\n- ');
	});

	it('代码围栏内回车只换行，且保留当前行缩进', () => {
		const content = ['- 代码示例', '  ```js', '  const x = 1', '  ```'].join('\n');
		const parsed = parseMarkdown('test.md', content);
		expect(buildBlockEnterPlan(parsed, 2, 8)).toEqual({
			kind: 'plain-newline',
			insertText: '\n  ',
			atLineEnd: false,
		});
	});

	it('代码围栏的起始行回车插到行尾，不拆三连反引号', () => {
		const content = ['- ```js', '  const x = 1', '  ```'].join('\n');
		const parsed = parseMarkdown('test.md', content);
		expect(buildBlockEnterPlan(parsed, 0, 4)).toEqual({
			kind: 'plain-newline',
			insertText: '\n',
			atLineEnd: true,
		});
	});

	it('代码围栏的结束行回车插到行尾', () => {
		const content = ['- 代码示例', '  ```js', '  const x = 1', '  ```'].join('\n');
		const parsed = parseMarkdown('test.md', content);
		expect(buildBlockEnterPlan(parsed, 3, 3)).toEqual({
			kind: 'plain-newline',
			insertText: '\n',
			atLineEnd: true,
		});
	});

	it('表格行不接管', () => {
		expectEnterReject(['- 块', '  | 列1 | 列2 |'].join('\n'), 1, 6, 'in-table');
	});

	it('块首行的 `- ` 标记区域内不接管', () => {
		expectEnterReject('- 块标题', 0, 0, 'before-content');
		expectEnterReject('- 块标题', 0, 1, 'before-content');
	});

	it('页首隐式块回车也产生真正的块', () => {
		// 真实库有 12 例「顶格标题 + id::」的隐式块；
		// 用户要求正文任何位置回车都要落到大纲块上。
		expectEnter(['# 标题', '', '正文'].join('\n'), 2, 1, '\n- ');
		expectEnter(['# 标题', '', '正文'].join('\n'), 0, 3, '\n- ');
	});

	it('有选区时不接管', () => {
		const parsed = parseMarkdown('test.md', '- 块标题');
		expect(buildBlockEnterPlan(parsed, 0, 4, { hasSelection: true })).toMatchObject({
			kind: 'reject',
			reject: 'has-selection',
		});
	});

	it('行号越界不接管', () => {
		expectEnterReject('- 块', 99, 0, 'no-line');
	});
});

describe('块内换行（Shift+Enter）', () => {
	it('块内换行只插入换行与内容缩进，不带项目符号', () => {
		expectSoftBreak('- 块标题正文', 0, 4, '\n  ');
	});

	it('Tab 缩进的块，内容缩进为 Tab + 两个空格', () => {
		const content = ['- 父块', '\t- 子块正文'].join('\n');
		expectSoftBreak(content, 1, 5, '\n\t  ');
	});

	it('块内续行上换行，缩进仍然对齐块内容', () => {
		const content = ['- 块标题', '  正文'].join('\n');
		expectSoftBreak(content, 1, 3, '\n  ');
	});

	it('代码围栏内保留当前行缩进，避免把列表项代码块拆断', () => {
		// 复现真实故障：插入顶格新行会让 VS Code 认为围栏提前结束，
		// 大代码块被切成两段。
		const content = ['- 示例', '  ```python', '  def f():', '  ```'].join('\n');
		const parsed = parseMarkdown('test.md', content);
		expect(buildSoftBreakPlan(parsed, 2, 8)).toEqual({
			kind: 'plain-newline',
			insertText: '\n  ',
			atLineEnd: false,
		});
	});

	it('围栏起始行与结束行的软换行插到行尾', () => {
		const content = ['- ```python', '  def f():', '  ```'].join('\n');
		const parsed = parseMarkdown('test.md', content);
		expect(buildSoftBreakPlan(parsed, 0, 3)).toEqual({
			kind: 'plain-newline',
			insertText: '\n',
			atLineEnd: true,
		});
		expect(buildSoftBreakPlan(parsed, 2, 3)).toEqual({
			kind: 'plain-newline',
			insertText: '\n',
			atLineEnd: true,
		});
	});

	it('无缩进的代码行，换行后仍然无缩进', () => {
		const content = ['- 示例', '  ```', 'code', '  ```'].join('\n');
		const parsed = parseMarkdown('test.md', content);
		expect(buildSoftBreakPlan(parsed, 2, 2)).toEqual({
			kind: 'plain-newline',
			insertText: '\n',
			atLineEnd: false,
		});
	});

	it('块外换行退化成普通换行', () => {
		expectSoftBreak('普通文字', 0, 2, '\n');
	});

	it('frontmatter 内不接管', () => {
		const parsed = parseMarkdown('test.md', ['---', 'title: x', '---'].join('\n'));
		expect(buildSoftBreakPlan(parsed, 1, 3)).toMatchObject({
			kind: 'reject',
			reject: 'frontmatter',
		});
	});

	it('块首行的 `- ` 标记区域内不接管', () => {
		const parsed = parseMarkdown('test.md', '- 块标题');
		expect(buildSoftBreakPlan(parsed, 0, 0)).toMatchObject({
			kind: 'reject',
			reject: 'before-content',
		});
	});
});

describe('辅助判定', () => {
	it('isLineInsideFence', () => {
		const lines = ['- 示例', '  ```', '  代码', '  ```'];
		expect(isLineInsideFence(lines, 1)).toBe(false);
		expect(isLineInsideFence(lines, 2)).toBe(true);
		expect(isLineInsideFence(lines, 4)).toBe(false);
	});

	it('isLineInFrontmatter', () => {
		const lines = ['---', 'title: x', '---', '- 块'];
		expect(isLineInFrontmatter(lines, 0)).toBe(true);
		expect(isLineInFrontmatter(lines, 2)).toBe(true);
		expect(isLineInFrontmatter(lines, 3)).toBe(false);
	});

	it('isPagePropertyLine 只在第一个块之前生效', () => {
		const parsed = parseMarkdown('test.md', ['title:: 页面', '- 块', '  collapsed:: true'].join('\n'));
		expect(isPagePropertyLine(parsed, 0)).toBe(true);
		expect(isPagePropertyLine(parsed, 2)).toBe(false);
	});
});
