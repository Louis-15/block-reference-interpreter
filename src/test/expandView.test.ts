/**
 * 展开视图（结构化数据）测试。
 *
 * 重点验证「每个块都能带出可跳转的来源」，因为这是本次改动的核心目的：
 * 让人在网页里点一下就回到笔记原文。
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import { buildBlockExpandView, buildNoteExpandView } from '../core/expandView';
import { GraphIndex } from '../core/graphIndex';

const UUID = '6780f110-d8e8-489f-be72-d2b3dbbc5668';

const TARGET = `- ## 人物
	- 《星落凝成糖》夜昙（黑化前）
		id:: ${UUID}
		- 天然
		- 元气
`;
const REF = `- 父级
	- 引用 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;

async function fixture(files?: Record<string, string>): Promise<GraphIndex> {
	const index = new GraphIndex();
	const data: Record<string, string> = files ?? {
		'graph/pages/星落凝成糖.md': TARGET,
		'graph/pages/傲娇.md': REF,
	};
	await index.rebuild(Object.keys(data), (filePath) => Promise.resolve(data[filePath] ?? ''));
	return index;
}

describe('buildBlockExpandView', () => {
	it('顶层块带来源、行范围与规模', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });

		expect(view.title).toBe(`块 ${UUID}`);
		const first = view.flow[0];
		expect(first?.type).toBe('block');
		if (first?.type !== 'block') {
			return;
		}

		expect(first.block.title).toBe('《星落凝成糖》夜昙（黑化前）');
		expect(first.block.source?.path).toContain('星落凝成糖.md');
		// 块首行是第 2 行（0-based 1）
		expect(first.block.source?.line).toBe(1);
		// 显示路径必须相对图谱根，不含绝对路径
		expect(first.block.source?.displayPath).toBe('pages/星落凝成糖.md');
		expect(first.block.lineRange).toMatch(/第 \d+–\d+ 行/);
		expect(first.block.size).toMatch(/\d+ 行 \/ \d+ 字符/);
	});

	it('内容行不含块自身标题（避免与标题重复）', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID);
		const first = view.flow[0];
		if (first?.type !== 'block') {
			throw new Error('期望第一个元素是块');
		}

		const joined = first.block.lines.join('\n');
		expect(joined).toContain('天然');
		expect(joined).toContain('元气');
		// 标题不重复出现在内容里
		expect(joined).not.toContain('《星落凝成糖》夜昙（黑化前）');
	});

	it('保留子块的缩进', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID);
		const first = view.flow[0];
		if (first?.type !== 'block') {
			throw new Error('期望第一个元素是块');
		}

		const line = first.block.lines.find((text) => text.includes('天然'));
		expect(line).toBeDefined();
		expect(line?.startsWith(' ')).toBe(true);
	});

	it('块不存在时给出警告且没有来源', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, '00000000-0000-0000-0000-000000000000');
		const first = view.flow[0];
		if (first?.type !== 'block') {
			throw new Error('期望第一个元素是块');
		}

		expect(first.block.source).toBeUndefined();
		expect(first.block.warnings.length).toBeGreaterThan(0);
		expect(first.block.title).toContain('未找到');
	});

	it('重复定义时列出全部候选并各自带来源', async () => {
		const index = await fixture({
			'graph/pages/a.md': `- 候选甲\n\tid:: ${UUID}\n`,
			'graph/pages/b.md': `- 候选乙\n\tid:: ${UUID}\n`,
		});
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });

		expect(view.flow).toHaveLength(2);
		for (const item of view.flow) {
			if (item.type !== 'block') {
				continue;
			}
			expect(item.block.source).toBeDefined();
			expect(item.block.warnings.join()).toContain('重复定义');
		}
	});

	it('maxDepth 控制嵌套展开', async () => {
		const inner = 'aaaaaaaa-1111-4111-8111-111111111111';
		const files = {
			'graph/pages/a.md': `- 外层\n\tid:: ${UUID}\n\t- 引用 ((${inner}))\n`,
			'graph/pages/b.md': `- 内层\n\tid:: ${inner}\n\t- 内层子块\n`,
		};

		const noNested = buildBlockExpandView(await fixture(files), UUID, { maxDepth: 0, graphRoot: 'graph' });
		expect(noNested.flow).toHaveLength(1);

		const withNested = buildBlockExpandView(await fixture(files), UUID, { maxDepth: 3, graphRoot: 'graph' });
		expect(withNested.flow.length).toBeGreaterThan(1);
		const nested = withNested.flow[1];
		if (nested?.type === 'block') {
			expect(nested.block.depth).toBe(1);
			expect(nested.block.source?.displayPath).toBe('pages/b.md');
		}
	});

	it('循环引用不会无限展开', async () => {
		const a = 'aaaaaaaa-1111-4111-8111-111111111111';
		const b = 'bbbbbbbb-2222-4222-8222-222222222222';
		const files = {
			'graph/pages/a.md': `- A 块\n\tid:: ${a}\n\t- 引用 ((${b}))\n`,
			'graph/pages/b.md': `- B 块\n\tid:: ${b}\n\t- 引用 ((${a}))\n`,
		};
		const view = buildBlockExpandView(await fixture(files), a, { maxDepth: 5 });
		expect(view.flow.length).toBeLessThan(10);
	});

	it('stripHeading 去掉标题的 # 标记', async () => {
		const index = await fixture({
			'graph/pages/h.md': `- ## 带井号的标题\n\tid:: ${UUID}\n`,
		});
		const view = buildBlockExpandView(index, UUID, { stripHeading: true });
		const first = view.flow[0];
		if (first?.type === 'block') {
			expect(first.block.title).toBe('带井号的标题');
		}
	});

	it('maxLines 截断并提示省略行数', async () => {
		const long = Array.from({ length: 12 }, (_, i) => `\t\t- 子块${i + 1}`).join('\n');
		const index = await fixture({
			'graph/pages/long.md': `- 长块\n\tid:: ${UUID}\n${long}\n`,
		});
		const view = buildBlockExpandView(index, UUID, { maxLines: 3 });
		const first = view.flow[0];
		if (first?.type === 'block') {
			expect(first.block.lines).toHaveLength(3);
			expect(first.block.warnings.join()).toContain('已省略');
		}
	});
});

describe('buildNoteExpandView', () => {
	it('原文行与展开块交错排列', async () => {
		const notePath = 'graph/pages/傲娇.md';
		const parsed = parseMarkdown(notePath, REF);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);

		// 每个原文行对应一个 source 项，另有至少 1 个 block 项
		const sources = view.flow.filter((item) => item.type === 'source');
		const blocks = view.flow.filter((item) => item.type === 'block');
		expect(sources).toHaveLength(parsed.lines.length);
		expect(blocks.length).toBeGreaterThanOrEqual(1);
	});

	it('触发展开的原文行被标记', async () => {
		const notePath = 'graph/pages/傲娇.md';
		const parsed = parseMarkdown(notePath, REF);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);

		const marked = view.flow.filter((item) => item.type === 'source' && item.hasExpansion);
		expect(marked).toHaveLength(1);
	});

	it('展开块带可跳转来源', async () => {
		const notePath = 'graph/pages/傲娇.md';
		const parsed = parseMarkdown(notePath, REF);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);

		const block = view.flow.find((item) => item.type === 'block');
		if (block?.type === 'block') {
			expect(block.block.source?.displayPath).toBe('pages/星落凝成糖.md');
		}
	});

	it('同一行重复引用同一块只展开一次', async () => {
		const line = `- 两次 ((${UUID})) 和 ((${UUID}))`;
		const parsed = parseMarkdown('graph/pages/dup.md', line + '\n');
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: 'graph/pages/dup.md', lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);

		const blocks = view.flow.filter((item) => item.type === 'block');
		expect(blocks).toHaveLength(1);
	});

	it('没有引用时只有原文行', async () => {
		const parsed = parseMarkdown('graph/pages/plain.md', '- 普通笔记\n- 没有引用\n');
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: 'graph/pages/plain.md', lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);

		expect(view.flow.every((item) => item.type === 'source')).toBe(true);
	});
});
