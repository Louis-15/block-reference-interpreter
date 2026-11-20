import { describe, expect, it } from 'vitest';

import { GraphIndex } from '../core/graphIndex';
import { resolveBlock, resolveBlocks } from '../core/resolve';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';
const UUID_MISSING = '99999999-9999-9999-9999-999999999999';

async function buildIndex(files: Record<string, string>): Promise<GraphIndex> {
	const index = new GraphIndex();
	const entries = Object.entries(files);
	await index.rebuild(
		entries.map(([path]) => path),
		async (path) => files[path] ?? '',
	);
	return index;
}

describe('resolveBlock 基础', () => {
	it('能解析出块内容与来源', async () => {
		const index = await buildIndex({
			'a.md': [`- 目标块标题`, `  id:: ${UUID_A}`, '\t- 子项一', '\t- 子项二'].join('\n'),
		});
		const result = resolveBlock(index, UUID_A);
		expect(result.notFound).toBe(false);
		expect(result.text).toContain('目标块标题');
		expect(result.text).toContain('子项一');
		expect(result.text).toContain('a.md');
	});

	it('UUID 大小写不敏感', async () => {
		const index = await buildIndex({ 'a.md': ['- 块', `  id:: ${UUID_A}`].join('\n') });
		expect(resolveBlock(index, UUID_A.toUpperCase()).notFound).toBe(false);
	});
});

describe('resolveBlock 异常处理', () => {
	it('悬空引用给出明确说明而不是空结果', async () => {
		const index = await buildIndex({ 'a.md': '- 普通块' });
		const result = resolveBlock(index, UUID_MISSING);
		expect(result.notFound).toBe(true);
		expect(result.text).toContain('未找到');
		expect(result.text).toContain(UUID_MISSING);
	});

	it('重复 ID 返回全部候选并提示歧义', async () => {
		const index = await buildIndex({
			'a.md': ['- A 文件里的块', `  id:: ${UUID_A}`].join('\n'),
			'b.md': ['- B 文件里的块', `  id:: ${UUID_A}`].join('\n'),
		});
		const result = resolveBlock(index, UUID_A);
		expect(result.duplicateCount).toBe(2);
		expect(result.text).toContain('A 文件里的块');
		expect(result.text).toContain('B 文件里的块');
		expect(result.text).toContain('重复定义');
	});
});

describe('resolveBlock 嵌套展开', () => {
	it('块内引用会被展开', async () => {
		const index = await buildIndex({
			'a.md': ['- 外层块，参见 ((22222222-2222-2222-2222-222222222222))', `  id:: ${UUID_A}`].join('\n'),
			'b.md': ['- 内层块内容', `  id:: ${UUID_B}`].join('\n'),
		});
		const result = resolveBlock(index, UUID_A);
		expect(result.text).toContain('外层块');
		expect(result.text).toContain('内层块内容');
		expect(result.text).toContain('该块子树内还引用了以下块');
	});

	it('maxDepth=0 时不展开嵌套引用', async () => {
		const index = await buildIndex({
			'a.md': ['- 外层块，参见 ((22222222-2222-2222-2222-222222222222))', `  id:: ${UUID_A}`].join('\n'),
			'b.md': ['- 内层块内容', `  id:: ${UUID_B}`].join('\n'),
		});
		const result = resolveBlock(index, UUID_A, { maxDepth: 0 });
		expect(result.text).toContain('外层块');
		expect(result.text).not.toContain('内层块内容');
	});

	it('三层嵌套在默认深度内可完整展开', async () => {
		const index = await buildIndex({
			'a.md': ['- 第一层 ((22222222-2222-2222-2222-222222222222))', `  id:: ${UUID_A}`].join('\n'),
			'b.md': ['- 第二层 ((33333333-3333-3333-3333-333333333333))', `  id:: ${UUID_B}`].join('\n'),
			'c.md': ['- 第三层内容', `  id:: ${UUID_C}`].join('\n'),
		});
		const result = resolveBlock(index, UUID_A, { maxDepth: 3 });
		expect(result.text).toContain('第二层');
		expect(result.text).toContain('第三层内容');
	});

	it('循环引用被检测并跳过', async () => {
		const index = await buildIndex({
			'a.md': ['- A 块 ((22222222-2222-2222-2222-222222222222))', `  id:: ${UUID_A}`].join('\n'),
			'b.md': ['- B 块 ((11111111-1111-1111-1111-111111111111))', `  id:: ${UUID_B}`].join('\n'),
		});
		const result = resolveBlock(index, UUID_A, { maxDepth: 5 });
		expect(result.text).toContain('循环引用');
	});
});

describe('resolveBlock 预算控制', () => {
	it('超出字符预算时截断并标注', async () => {
		const longBody = Array.from({ length: 200 }, (_, index) => `\t- 第 ${index} 行内容填充文本`).join('\n');
		const index = await buildIndex({
			'a.md': ['- 巨型块', `  id:: ${UUID_A}`, longBody].join('\n'),
		});
		const result = resolveBlock(index, UUID_A, { maxChars: 500 });
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThan(1200);
	});
});

describe('resolveBlocks 批量', () => {
	it('多个 UUID 依次解析', async () => {
		const index = await buildIndex({
			'a.md': ['- 块A', `  id:: ${UUID_A}`, '- 块B', `  id:: ${UUID_B}`].join('\n'),
		});
		const results = resolveBlocks(index, [UUID_A, UUID_B]);
		expect(results).toHaveLength(2);
		expect(results[0]?.text).toContain('块A');
		expect(results[1]?.text).toContain('块B');
	});

	it('预算共享，耗尽后剩余项给出提示', async () => {
		const index = await buildIndex({
			'a.md': ['- 块A', `  id:: ${UUID_A}`, '- 块B', `  id:: ${UUID_B}`].join('\n'),
		});
		// 预算设为 1：第一块就会把预算耗尽，第二块必须走「预算用尽」分支。
		const results = resolveBlocks(index, [UUID_A, UUID_B], { maxChars: 1 });
		expect(results).toHaveLength(2);
		expect(results[1]?.text).toContain('预算已用尽');
	});
});
