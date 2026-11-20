/**
 * 块祖先路径与反链报告的单元测试。
 *
 * 这两块是「在编辑器里显示反链」的地基：路径错了用户会看到乱七八糟的面包屑，
 * 分组错了会和 CodeLens 的计数打架。所以用固定的小图把规则钉死。
 */

import { describe, expect, it } from 'vitest';

import { buildBlockAncestorTitles, buildBlockPath } from '../core/blockPath';
import { buildBacklinkReport, renderBacklinkReport } from '../core/backlinkReport';
import { parseMarkdown } from '../core/blockParser';
import { GraphIndex } from '../core/graphIndex';

/** 构造一份三层嵌套的笔记。 */
const NESTED = `- 71 举例
	- ## 71.3 毒舌讽刺型
		- 傲娇
			- 毒舌：嘴硬心软
	- ## 71.2 普通女
		- 傻白
`;

function parsedNested() {
	return parseMarkdown('pages/嵌套.md', NESTED);
}

describe('buildBlockAncestorTitles', () => {
	it('默认不含自身，只返回祖先链', () => {
		const parsed = parsedNested();
		// 找「毒舌：嘴硬心软」这个块（第 4 行，0-based）
		const target = parsed.blocks.find((block) => block.startLine === 3);
		expect(target).toBeDefined();
		const index = parsed.blocks.indexOf(target!);

		expect(buildBlockAncestorTitles(parsed, index)).toEqual(['71 举例', '71.3 毒舌讽刺型', '傲娇']);
	});

	it('includeSelf 时把自身放在末尾', () => {
		const parsed = parsedNested();
		const target = parsed.blocks.find((block) => block.startLine === 3);
		const index = parsed.blocks.indexOf(target!);

		expect(buildBlockAncestorTitles(parsed, index, { includeSelf: true })).toEqual([
			'71 举例',
			'71.3 毒舌讽刺型',
			'傲娇',
			'毒舌：嘴硬心软',
		]);
	});

	it('去掉了标题的 # 标记', () => {
		const parsed = parsedNested();
		const target = parsed.blocks.find((block) => block.startLine === 1);
		const index = parsed.blocks.indexOf(target!);

		expect(buildBlockAncestorTitles(parsed, index)).toEqual(['71 举例']);
	});

	it('stripHeading: false 时保留 # 标记', () => {
		const parsed = parsedNested();
		const target = parsed.blocks.find((block) => block.startLine === 2);
		const index = parsed.blocks.indexOf(target!);

		expect(buildBlockAncestorTitles(parsed, index, { stripHeading: false })).toEqual([
			'71 举例',
			'## 71.3 毒舌讽刺型',
		]);
	});

	it('maxDepth 保留最近的几级', () => {
		const parsed = parsedNested();
		const target = parsed.blocks.find((block) => block.startLine === 3);
		const index = parsed.blocks.indexOf(target!);

		expect(buildBlockAncestorTitles(parsed, index, { maxDepth: 2 })).toEqual([
			'71.3 毒舌讽刺型',
			'傲娇',
		]);
	});

	it('顶层块没有祖先，返回空数组', () => {
		const parsed = parsedNested();
		const index = parsed.blocks.findIndex((block) => block.startLine === 0);
		expect(buildBlockAncestorTitles(parsed, index)).toEqual([]);
	});

	it('blockIndex 越界时返回空数组而不是抛错', () => {
		const parsed = parsedNested();
		expect(buildBlockAncestorTitles(parsed, 999)).toEqual([]);
		expect(buildBlockAncestorTitles(parsed, -1)).toEqual([]);
	});
});

describe('buildBlockPath', () => {
	it('用 › 连接', () => {
		const parsed = parsedNested();
		const target = parsed.blocks.find((block) => block.startLine === 3);
		const index = parsed.blocks.indexOf(target!);
		expect(buildBlockPath(parsed, index)).toBe('71 举例 › 71.3 毒舌讽刺型 › 傲娇');
	});

	it('自定义分隔符', () => {
		const parsed = parsedNested();
		const target = parsed.blocks.find((block) => block.startLine === 3);
		const index = parsed.blocks.indexOf(target!);
		expect(buildBlockPath(parsed, index, { separator: ' / ' })).toBe('71 举例 / 71.3 毒舌讽刺型 / 傲娇');
	});

	it('顶层块返回空字符串', () => {
		const parsed = parsedNested();
		const index = parsed.blocks.findIndex((block) => block.startLine === 0);
		expect(buildBlockPath(parsed, index)).toBe('');
	});
});

/** 构造一个两文件的图：目标块定义在 A，被 B 与 C 引用。 */
const TARGET_NOTE = `- ## 人物
	- 《星落凝成糖》夜昙（黑化前）
		id:: 6780f110-d8e8-489f-be72-d2b3dbbc5668
		- 傲娇：毒舌
		- 傻白
`;
const REF_NOTE_B = `- 71 举例
	- ## 71.3 毒舌讽刺型
		- ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;
const REF_NOTE_C = `- 71 举例
	- ## 71.2 普通女
		- ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
	- 别的地方
		- 又引用一次 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;

async function buildFixtureIndex(): Promise<GraphIndex> {
	const index = new GraphIndex();
	const files: Record<string, string> = {
		'pages/星落凝成糖.md': TARGET_NOTE,
		'pages/傲娇.md': REF_NOTE_B,
		'pages/傻白+中二.md': REF_NOTE_C,
	};
	await index.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));
	return index;
}

const UUID = '6780f110-d8e8-489f-be72-d2b3dbbc5668';

describe('buildBacklinkReport', () => {
	it('识别出定义位置与块标题', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);

		expect(report.definitions).toHaveLength(1);
		expect(report.definitions[0]?.path).toBe('pages/星落凝成糖.md');
		expect(report.definitions[0]?.line).toBe(1);
		expect(report.definitions[0]?.title).toBe('《星落凝成糖》夜昙（黑化前）');
	});

	it('按页面分组，且页面内按行号排序', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);

		expect(report.fileCount).toBe(2);
		const paths = report.groups.map((group) => group.path);
		expect(paths).toContain('pages/傲娇.md');
		expect(paths).toContain('pages/傻白+中二.md');

		const cGroup = report.groups.find((group) => group.path === 'pages/傻白+中二.md');
		const lines = cGroup?.items.map((item) => item.line) ?? [];
		expect([...lines].sort((a, b) => a - b)).toEqual(lines);
	});

	it('生成引用所在块的面包屑路径', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);

		const bGroup = report.groups.find((group) => group.path === 'pages/傲娇.md');
		expect(bGroup?.items[0]?.blockPath).toBe('71 举例 › 71.3 毒舌讽刺型');
	});

	it('页面按引用条目数降序排列', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);

		// 傻白+中二 有 2 个引用块，傲娇 有 1 个
		expect(report.groups[0]?.path).toBe('pages/傻白+中二.md');
		expect(report.groups[0]?.count).toBe(2);
		expect(report.groups[1]?.count).toBe(1);
	});

	it('同一块内的重复引用会合并为一条并记录次数', async () => {
		// 在同一个块里放两次引用
		const doubled = new GraphIndex();
		const files: Record<string, string> = {
			'pages/t.md': TARGET_NOTE,
			'pages/d.md': `- 一个块里出现两次 ((6780f110-d8e8-489f-be72-d2b3dbbc5668)) 和 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))\n`,
		};
		await doubled.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));

		const report = buildBacklinkReport(doubled, UUID);
		expect(report.hitCount).toBe(2);
		expect(report.itemCount).toBe(1);
		expect(report.groups[0]?.items[0]?.count).toBe(2);
	});

	it('UUID 大小写不敏感', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID.toUpperCase());
		expect(report.uuid).toBe(UUID);
		expect(report.itemCount).toBe(3);
	});

	it('没有引用时返回空分组但保留定义', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, '00000000-0000-0000-0000-000000000000');
		expect(report.itemCount).toBe(0);
		expect(report.groups).toHaveLength(0);
		expect(report.definitions).toHaveLength(0);
	});
});

describe('renderBacklinkReport', () => {
	it('包含定义位置、块内容与统计', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);
		const text = renderBacklinkReport(report, { graphRoot: '/' });

		expect(text).toContain('块内容');
		expect(text).toContain('《星落凝成糖》夜昙（黑化前）');
		expect(text).toContain('2 个页面');
	});

	it('用页面名作分组标题，路径用相对图谱根的形式', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);
		const text = renderBacklinkReport(report, { graphRoot: '' });

		expect(text).toContain('## 傲娇');
		expect(text).toContain('`pages/傲娇.md`');
	});

	it('graphRoot 生效时把绝对路径压成相对路径', async () => {
		// 夹具用的是相对路径，这里换成绝对路径验证一次真实场景
		const absolute = new GraphIndex();
		const root = 'D:/graph';
		const files: Record<string, string> = {
			[`${root}/pages/t.md`]: TARGET_NOTE,
			[`${root}/pages/r.md`]: `- 引用 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))\n`,
		};
		await absolute.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));

		const report = buildBacklinkReport(absolute, UUID);
		const text = renderBacklinkReport(report, { graphRoot: root });
		expect(text).toContain('`pages/r.md`');
		expect(text).not.toContain('D:/graph/pages/r.md');
	});

	it('没有引用时明确说明', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);
		const empty = renderBacklinkReport({ ...report, groups: [], itemCount: 0, fileCount: 0 });
		expect(empty).toContain('没有任何笔记引用');
	});

	it('块不存在时给出悬空引用警告', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, '00000000-0000-0000-0000-000000000000');
		const text = renderBacklinkReport(report);
		expect(text).toContain('不存在');
		expect(text).toContain('悬空引用');
	});

	it('maxItemsPerGroup 会截断并给出剩余数量提示', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);
		const text = renderBacklinkReport(report, { maxItemsPerGroup: 1 });
		expect(text).toContain('还有 1 处未显示');
	});

	it('maxTotalItems 是跨页面的硬预算，防止分散引用把输出撑爆', async () => {
		// 造 5 个页面各引用一次
		const spread = new GraphIndex();
		const files: Record<string, string> = { 'pages/t.md': TARGET_NOTE };
		for (let index = 0; index < 5; index++) {
			files[`pages/p${index}.md`] = `- 引用 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))\n`;
		}
		await spread.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));

		const report = buildBacklinkReport(spread, UUID);
		expect(report.itemCount).toBe(5);

		const text = renderBacklinkReport(report, { maxTotalItems: 2 });
		// 只应出现 2 条「第 N 行」条目
		const positions = text.match(/第 \d+ 行 · /g) ?? [];
		expect(positions).toHaveLength(2);
		expect(text).toContain('已达显示上限 2 条');
		expect(text).toContain('共 5 条');
	});

	it('有面包屑时只输出路径与位置，不再重复输出裸 UUID', async () => {
		const index = await buildFixtureIndex();
		const report = buildBacklinkReport(index, UUID);
		const text = renderBacklinkReport(report);

		// 引用行本身只有 ((uuid))，清空后没有内容，不应出现在输出里
		expect(text).not.toContain('((6780f110-d8e8-489f-be72-d2b3dbbc5668))');
		// 面包屑与位置都要在
		expect(text).toContain('71 举例 › 71.3 毒舌讽刺型');
		expect(text).toContain('行内引用');
	});

	it('顶层块（无面包屑）时用引用行清洗后的文字兜底', async () => {
		const top = new GraphIndex();
		const files: Record<string, string> = {
			'pages/t.md': TARGET_NOTE,
			// 顶层块，没有祖先；引用行本身带一段有意义的文字
			'pages/top.md': `- 这里说的是 ((6780f110-d8e8-489f-be72-d2b3dbbc5668)) 这个东西\n`,
		};
		await top.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));

		const text = renderBacklinkReport(buildBacklinkReport(top, UUID));
		expect(text).toContain('这里说的是');
		// 引用外壳必须被剥掉
		expect(text).not.toContain('((6780f110');
	});
});
