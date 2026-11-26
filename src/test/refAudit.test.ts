import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import { GraphIndex } from '../core/graphIndex';
import { auditReferences } from '../core/refAudit';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_V8 = '33333333-3333-8333-8333-333333333333';

function buildIndex(files: Record<string, string>): GraphIndex {
	const index = new GraphIndex();
	for (const [path, content] of Object.entries(files)) {
		index.updateFile(path, content);
	}
	return index;
}

/** 用同一份内容构建「解析结果 + 索引」，模拟当前文件已保存。 */
function audit(content: string, extraFiles: Record<string, string> = {}) {
	const path = 'pages/a.md';
	const parsed = parseMarkdown(path, content);
	const index = buildIndex({ [path]: content, ...extraFiles });
	return { parsed, result: auditReferences(parsed, index) };
}

describe('引用目标检查', () => {
	it('正常引用不报错', () => {
		const { result } = audit([`- 目标`, `  id:: ${UUID_A}`, `- 引用 ((${UUID_A}))`].join('\n'));
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.referenceCount).toBe(1);
	});

	it('悬空引用报错', () => {
		const { result } = audit(`- 引用 ((${UUID_A}))`);
		expect(result.errors.some((issue) => issue.code === 'dangling-reference')).toBe(true);
		expect(result.ok).toBe(false);
	});

	it('重复 UUID 报错', () => {
		const { result } = audit(
			[`- 目标`, `  id:: ${UUID_A}`, `- 引用 ((${UUID_A}))`].join('\n'),
			{ 'pages/b.md': ['- 另一个目标', `  id:: ${UUID_A}`].join('\n') },
		);
		expect(result.errors.some((issue) => issue.code === 'duplicate-uuid')).toBe(true);
	});

	it('当前文件以实时解析为准，索引中的旧版本不会造成假悬空', () => {
		const path = 'pages/a.md';
		const oldContent = '- 目标\n  旧正文';
		const newContent = ['- 目标', `  id:: ${UUID_A}`, `- 引用 ((${UUID_A}))`].join('\n');
		const parsed = parseMarkdown(path, newContent);
		const index = buildIndex({ [path]: oldContent });

		const result = auditReferences(parsed, index);
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('隐式块被引用时报错', () => {
		const { result } = audit(
			['# 隐式块', `id:: ${UUID_A}`, `- 引用 ((${UUID_A}))`].join('\n'),
		);
		expect(result.errors.some((issue) => issue.code === 'implicit-block-reference')).toBe(true);
	});

	it('顶格裸引用行报「不在任何块内」警告', () => {
		// 复现真实故障：0.4.2 之前回车不建块，留下顶格的裸引用行。
		const content = [
			`- 目标`,
			`  id:: ${UUID_A}`,
			`- 块内引用 ((${UUID_A}))`,
			'',
			`((${UUID_A}))`,
			'',
			`{{embed ((${UUID_A}))}}`,
		].join('\n');
		const { result } = audit(content);
		const outside = result.warnings.filter((issue) => issue.code === 'reference-outside-block');
		expect(outside).toHaveLength(2);
		expect(outside.map((issue) => issue.line)).toEqual([4, 6]);
		// 这是警告，不影响「通过」判定
		expect(result.ok).toBe(true);
	});

	it('子块内的引用不会被误报为块外引用', () => {
		const { result } = audit(
			[`- 父块`, `  id:: ${UUID_A}`, `\t- 子块引用 ((${UUID_A}))`].join('\n'),
		);
		expect(result.warnings.some((issue) => issue.code === 'reference-outside-block')).toBe(false);
	});

	it('首行代码围栏的块被引用时给出警告', () => {
		const { result } = audit(
			['- ```js', '  const x = 1', '  ```', `  id:: ${UUID_A}`, `- 引用 ((${UUID_A}))`].join(
				'\n',
			),
		);
		expect(result.warnings.some((issue) => issue.code === 'block-end-id')).toBe(true);
	});
});

describe('块 ID 检查', () => {
	it('id:: 在正文之后报错', () => {
		const { result } = audit([`- 块`, `  正文`, `  id:: ${UUID_A}`].join('\n'));
		expect(result.errors.some((issue) => issue.code === 'id-not-in-property-group')).toBe(true);
	});

	it('同一块多个 id:: 报错', () => {
		const { result } = audit([`- 块`, `  id:: ${UUID_A}`, `  id:: ${UUID_B}`].join('\n'));
		expect(result.errors.some((issue) => issue.code === 'multiple-ids')).toBe(true);
	});

	it('非 UUID 的 id:: 报警告', () => {
		const { result } = audit(['- 块', '  id:: abc-123'].join('\n'));
		expect(result.warnings.some((issue) => issue.code === 'invalid-id')).toBe(true);
	});

	it('v8 形态 UUID 报警告', () => {
		const { result } = audit(['- 块', `  id:: ${UUID_V8}`].join('\n'));
		expect(result.warnings.some((issue) => issue.code === 'runtime-v8-id')).toBe(true);
	});

	it('历史零缩进 id:: 报警告', () => {
		const { result } = audit([`- # 标题`, `id:: ${UUID_A}`].join('\n'));
		expect(result.warnings.some((issue) => issue.code === 'zero-indent-id')).toBe(true);
	});

	it('代码围栏内的 id:: 示例不算块 ID', () => {
		const { result } = audit(
			['- 示例', '  ```md', `  id:: ${UUID_A}`, '  ```', '  正文'].join('\n'),
		);
		expect(result.idCount).toBe(0);
		expect(result.warnings.some((issue) => issue.code === 'invalid-id')).toBe(false);
	});
});

describe('畸形引用', () => {
	it('非 UUID 的引用报错', () => {
		const { result } = audit('- 引用 ((abc))');
		expect(result.errors.some((issue) => issue.code === 'malformed-reference')).toBe(true);
		expect(result.malformedCount).toBe(1);
	});

	it('三重括号报错', () => {
		const { result } = audit(`- 引用 ((( ${UUID_A} )))`);
		expect(result.errors.some((issue) => issue.code === 'malformed-reference')).toBe(true);
	});

	it('代码围栏与行内代码里的引用被忽略', () => {
		const content = [
			'- 示例',
			'  ```',
			`  ((${UUID_A}))`,
			'  ```',
			`  正文 \`((${UUID_A}))\``,
		].join('\n');
		const { result } = audit(content);
		expect(result.referenceCount).toBe(0);
		expect(result.malformedCount).toBe(0);
		expect(result.errors).toEqual([]);
	});
});

describe('blockIds 过滤', () => {
	it('只报告指定 UUID 的引用问题', () => {
		const content = [`- 引用 ((${UUID_A}))`, `- 引用 ((${UUID_B}))`].join('\n');
		const { parsed } = audit(content);
		const index = buildIndex({ 'pages/a.md': content });
		const result = auditReferences(parsed, index, { blockIds: [UUID_A] });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({ code: 'dangling-reference', uuid: UUID_A });
	});
});
