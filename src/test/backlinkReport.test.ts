/**
 * 块祖先路径与反链报告**构建**的单元测试。
 *
 * 这两块是「在编辑器里显示反链」的地基：路径错了用户会看到乱七八糟的面包屑，
 * 分组错了会和 CodeLens 的计数打架。所以用固定的小图把规则钉死。
 *
 * 渲染相关的测试在 `backlinkReportRender.test.ts`，共用
 * `backlinkReportFixture.ts` 里的同一份图。
 */

import { describe, expect, it } from 'vitest';

import { buildBlockAncestorTitles, buildBlockPath } from '../core/blockPath';
import { buildBacklinkReport } from '../core/backlinkReport';
import { parseMarkdown } from '../core/blockParser';
import { GraphIndex } from '../core/graphIndex';
import { TARGET_NOTE, UUID, buildFixtureIndex } from './backlinkReportFixture';

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

	it('块外的多行引用必须各算一条，不能合并成「同块内重复」', async () => {
		// 复现真实故障：文件末尾两行顶格裸引用（没有 `- `），两行都不属于任何块。
		// 修复前它们共用 blockIndex = -1 这个 key，被错误合并成一条，
		// 面板于是显示「同块内重复引用，共出现 2 次」。
		const graph = new GraphIndex();
		const files: Record<string, string> = {
			'pages/t.md': TARGET_NOTE,
			'pages/d.md': [
				'- 真正的块',
				'  正文',
				'',
				'((6780f110-d8e8-489f-be72-d2b3dbbc5668))',
				'',
				'{{embed ((6780f110-d8e8-489f-be72-d2b3dbbc5668))}}',
			].join('\n'),
		};
		await graph.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));

		const report = buildBacklinkReport(graph, UUID);
		expect(report.hitCount).toBe(2);
		// 两条独立条目，而不是合并成 1 条 count=2
		expect(report.itemCount).toBe(2);
		expect(report.groups[0]?.items).toHaveLength(2);
		expect(report.groups[0]?.items.map((item) => item.count)).toEqual([1, 1]);
		// 块外条目没有 blockIndex，面包屑为空，但不能因此被合并
		expect(report.groups[0]?.items.map((item) => item.blockIndex)).toEqual([-1, -1]);
	});

	it('块外引用与块内引用不会互相合并', async () => {
		const graph = new GraphIndex();
		const files: Record<string, string> = {
			'pages/t.md': TARGET_NOTE,
			'pages/d.md': [
				`- 块内引用 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))`,
				`((6780f110-d8e8-489f-be72-d2b3dbbc5668))`,
			].join('\n'),
		};
		await graph.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));

		const report = buildBacklinkReport(graph, UUID);
		expect(report.hitCount).toBe(2);
		expect(report.itemCount).toBe(2);
		expect(report.groups[0]?.items[0]?.blockIndex).toBe(0);
		expect(report.groups[0]?.items[1]?.blockIndex).toBe(-1);
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

describe('页面名（title::）', () => {
	const UUID_REF = '6780f110-d8e8-489f-be72-d2b3dbbc5668';

	/** 用一份最小图跑报告，返回引用方页面的 pageName。 */
	async function pageNameOf(referrerContent: string, referrerPath = 'pages/引用方.md') {
		const graph = new GraphIndex();
		const files: Record<string, string> = {
			'pages/目标.md': TARGET_NOTE,
			[referrerPath]: referrerContent,
		};
		await graph.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));
		const report = buildBacklinkReport(graph, UUID_REF);
		return report.groups.find((group) => group.path === referrerPath)?.pageName;
	}

	it('有 title:: 时页面名取标题值，而不是文件名', async () => {
		// 与 Tine 一致：页面名是 `title::` 的值，文件名只是存储位置。
		const pageName = await pageNameOf(
			['title:: 真正的页面名', `- 引用 ((${UUID_REF}))`].join('\n'),
		);
		expect(pageName).toBe('真正的页面名');
	});

	it('没有 title:: 时退回文件名', async () => {
		const pageName = await pageNameOf(`- 引用 ((${UUID_REF}))`, 'pages/文件名.md');
		expect(pageName).toBe('文件名');
	});

	it('空的 title:: 视为没有标题', async () => {
		const pageName = await pageNameOf(
			['title::', `- 引用 ((${UUID_REF}))`].join('\n'),
			'pages/文件名.md',
		);
		expect(pageName).toBe('文件名');
	});

	it('块内部的 title:: 属于那个块，不是页面名', async () => {
		// 只有第一个块之前的页面属性才算页面名，否则任何写着 title:: 的普通块
		// 都会把整篇笔记改名为它的属性值。
		const pageName = await pageNameOf(
			['- 第一个块', '  title:: 块自己的属性', `- 引用 ((${UUID_REF}))`].join('\n'),
			'pages/文件名.md',
		);
		expect(pageName).toBe('文件名');
	});

	it('title:: 大小写不敏感', async () => {
		const pageName = await pageNameOf(
			['Title:: 大写键', `- 引用 ((${UUID_REF}))`].join('\n'),
		);
		expect(pageName).toBe('大写键');
	});
});
