import { describe, expect, it } from 'vitest';

import { searchBlocks } from '../core/blockSearch';
import { parseMarkdown } from '../core/blockParser';
import { GraphIndex } from '../core/graphIndex';

const UUID = '11111111-1111-4111-8111-111111111111';

function buildIndex(files: Record<string, string>): GraphIndex {
	const index = new GraphIndex();
	for (const [path, content] of Object.entries(files)) {
		index.updateFile(path, content);
	}
	return index;
}

const FILE_A = [
	'- 驱动方分类',
	'\t- 主动方与被动方',
	'\t\t- 主动方先行动',
	'- 剧情模式',
	`  id:: ${UUID}`,
	'  正文里提到主动方',
].join('\n');

describe('searchBlocks 标题匹配', () => {
	it('按标题找到块，返回文件、行号、标题与 UUID', () => {
		const index = buildIndex({ 'pages/a.md': FILE_A });
		const results = searchBlocks(index, { query: '剧情模式' });
		expect(results[0]).toMatchObject({
			path: 'pages/a.md',
			startLine: 3,
			title: '剧情模式',
			uuid: UUID,
			needsId: false,
			matchedIn: 'title',
		});
	});

	it('标题完全相等的评分高于包含', () => {
		const index = buildIndex({
			'pages/a.md': ['- 剧情模式', '- 剧情模式补充说明'].join('\n'),
		});
		const results = searchBlocks(index, { query: '剧情模式' });
		expect(results[0]?.title).toBe('剧情模式');
		expect(results[1]?.title).toBe('剧情模式补充说明');
	});

	it('多个词必须全部命中', () => {
		const index = buildIndex({
			'pages/a.md': ['- 主动方先行动', '- 主动方后行动'].join('\n'),
		});
		expect(searchBlocks(index, { query: '主动方 后行动' }).map((item) => item.title)).toEqual([
			'主动方后行动',
		]);
	});

	it('空查询返回空数组', () => {
		const index = buildIndex({ 'pages/a.md': FILE_A });
		expect(searchBlocks(index, { query: '   ' })).toEqual([]);
	});
});

describe('searchBlocks 内容匹配与定位', () => {
	it('includeContent 为 false 时不搜索正文', () => {
		const index = buildIndex({ 'pages/a.md': FILE_A });
		expect(searchBlocks(index, { query: '正文里提到' })).toEqual([]);
	});

	it('includeContent 为 true 时搜索正文，并给出真实行号', () => {
		const index = buildIndex({ 'pages/a.md': FILE_A });
		const results = searchBlocks(index, { query: '正文里提到', includeContent: true });
		expect(results[0]).toMatchObject({
			title: '剧情模式',
			matchedIn: 'content',
			contentLine: 5,
		});
	});

	it('内容命中排在标题命中之后', () => {
		const index = buildIndex({
			'pages/a.md': ['- 包含 关键词 的标题', '- 另一个块', '  正文包含关键词'].join('\n'),
		});
		const results = searchBlocks(index, { query: '关键词', includeContent: true });
		expect(results[0]?.matchedIn).toBe('title');
		expect(results[1]?.matchedIn).toBe('content');
	});
});

describe('searchBlocks 候选信息', () => {
	it('返回面包屑与子树规模', () => {
		const index = buildIndex({ 'pages/a.md': FILE_A });
		const results = searchBlocks(index, { query: '主动方先行动' });
		expect(results[0]).toMatchObject({
			pathText: '驱动方分类 › 主动方与被动方',
			subtreeSize: 0,
		});
	});

	it('没有 ID 的块标记 needsId', () => {
		const index = buildIndex({ 'pages/a.md': FILE_A });
		const results = searchBlocks(index, { query: '驱动方分类' });
		expect(results[0]).toMatchObject({ needsId: true, uuid: undefined });
	});

	it('非 UUID 的历史 ID 标记 invalidId，而不是 needsId', () => {
		const index = buildIndex({ 'pages/a.md': ['- 块', '  id:: abc-123'].join('\n') });
		const results = searchBlocks(index, { query: '块' });
		expect(results[0]).toMatchObject({
			needsId: false,
			uuid: undefined,
			invalidId: 'abc-123',
		});
	});

	it('limit 限制返回条数', () => {
		const index = buildIndex({ 'pages/a.md': FILE_A });
		expect(searchBlocks(index, { query: '主动方', limit: 1 })).toHaveLength(1);
	});

	it('filePath 只搜索指定文件', () => {
		const index = buildIndex({
			'pages/a.md': '- 目标块',
			'pages/b.md': '- 目标块',
		});
		const results = searchBlocks(index, { query: '目标块', filePath: 'pages/b.md' });
		expect(results).toHaveLength(1);
		expect(results[0]?.path).toBe('pages/b.md');
	});
});

describe('searchBlocks 实时文本覆盖', () => {
	it('overrides 优先于索引中的旧版本', () => {
		const index = buildIndex({ 'pages/a.md': '- 旧标题' });
		const overrides = new Map([
			['pages/a.md', parseMarkdown('pages/a.md', '- 新标题\n  id:: 22222222-2222-4222-8222-222222222222')],
		]);

		expect(searchBlocks(index, { query: '旧标题', overrides })).toEqual([]);

		const results = searchBlocks(index, { query: '新标题', overrides });
		expect(results[0]).toMatchObject({
			title: '新标题',
			uuid: '22222222-2222-4222-8222-222222222222',
		});
	});
});

describe('searchBlocks 结构枚举', () => {
	const OUTLINE = [
		'- # 11 行为模式概括',
		'\t- ## 11.1 适用阶段',
		'\t\t- ### 11.1.1 细节',
		'- 普通块，不是标题',
		'- # 12 收到情感表达',
		`  id:: ${UUID}`,
		'\t- ## 12.1 子标题',
		'- #标签 不是标题',
	].join('\n');

	it('headingsOnly 只返回标题块，并按文件顺序排列', () => {
		const index = buildIndex({ 'pages/a.md': OUTLINE });
		const results = searchBlocks(index, {
			query: '',
			filePath: 'pages/a.md',
			headingsOnly: true,
			limit: 50,
		});

		expect(results.map((item) => item.title)).toEqual([
			'# 11 行为模式概括',
			'## 11.1 适用阶段',
			'### 11.1.1 细节',
			'# 12 收到情感表达',
			'## 12.1 子标题',
		]);
	});

	it('headingLevel 只保留指定层级', () => {
		const index = buildIndex({ 'pages/a.md': OUTLINE });
		const results = searchBlocks(index, {
			query: '',
			filePath: 'pages/a.md',
			headingsOnly: true,
			headingLevel: 1,
			limit: 50,
		});

		// `#标签` 没有空格分隔，不应被当成一级标题
		expect(results.map((item) => item.title)).toEqual(['# 11 行为模式概括', '# 12 收到情感表达']);
	});

	it('枚举模式保留 UUID 信息，便于直接引用', () => {
		const index = buildIndex({ 'pages/a.md': OUTLINE });
		const results = searchBlocks(index, {
			query: '',
			filePath: 'pages/a.md',
			headingsOnly: true,
			headingLevel: 1,
		});

		expect(results[1]).toMatchObject({ uuid: UUID, needsId: false });
		expect(results[0]).toMatchObject({ uuid: undefined, needsId: true });
	});

	it('没有 filePath 的空查询直接返回空，不会把全库倒出来', () => {
		const index = buildIndex({ 'pages/a.md': OUTLINE });
		expect(searchBlocks(index, { query: '', headingsOnly: true })).toEqual([]);
	});
});

