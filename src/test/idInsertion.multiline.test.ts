import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import {
	buildIdInsertionPlan,
	type IdInsertionOptions,
	type IdInsertionPlan,
} from '../core/idInsertion';

const UUID = '11111111-1111-4111-8111-111111111111';

function buildPlan(content: string, blockIndex = 0, options: IdInsertionOptions = {}): IdInsertionPlan {
	const parsed = parseMarkdown('test.md', content);
	return buildIdInsertionPlan(parsed, blockIndex, { uuid: UUID, ...options });
}

function getInsert(plan: IdInsertionPlan): Extract<IdInsertionPlan, { kind: 'insert' }> {
	if (plan.kind !== 'insert') {
		const detail = plan.kind === 'reject' ? `: ${plan.reason}` : '';
		throw new Error(`expected insert, got ${plan.kind}${detail}`);
	}
	return plan;
}

describe('多行块：软换行、子块与代码围栏', () => {
	it('块内软换行不是独立块，id:: 插在全部正文之前', () => {
		const insert = getInsert(buildPlan('- 块标题\n  第一行\n  第二行\n\t- 子块'));
		expect(insert.line).toBe(1);
		expect(insert.newText).toBe(`- 块标题\n  id:: ${UUID}`);
	});

	it('子块是独立块，父块插入点不会越到子块之后', () => {
		const content = ['- 父块', '  父正文', '\t- 子块', '\t  子正文'].join('\n');
		const insert = getInsert(buildPlan(content, 0));
		expect(insert.line).toBe(1);

		const parsed = parseMarkdown('test.md', content);
		const child = getInsert(buildIdInsertionPlan(parsed, 1, { uuid: UUID }));
		expect(child.propertyLine).toBe(`\t  id:: ${UUID}`);
	});

	it('正文中的代码围栏不妨碍属性组：id:: 仍插在围栏之前', () => {
		const content = ['- 代码示例', '  ```js', '  const x = 1', '  ```', '\t- 子块'].join('\n');
		const insert = getInsert(buildPlan(content));
		expect(insert.line).toBe(1);
		expect(insert.position).toBe('property-group');
		expect(insert.logseqCompatible).toBe(true);
	});

	it('块首行本身是代码围栏：按 Tine 方式追加到块尾、子块之前', () => {
		const content = ['- ```js', '  const x = 1', '  ```', '\t- 子块'].join('\n');
		const insert = getInsert(buildPlan(content));
		expect(insert.position).toBe('block-end');
		expect(insert.logseqCompatible).toBe(false);
		expect(insert.line).toBe(3);
		expect(insert.propertyLine).toBe(`  id:: ${UUID}`);
		expect(insert.newText).toBe(`  \`\`\`\n  id:: ${UUID}`);
	});

	it('块首行围栏未闭合时拒绝，避免把 id:: 写进代码内容', () => {
		const plan = buildPlan('- ```js\n  const x = 1');
		expect(plan).toMatchObject({ kind: 'reject', reason: 'unclosed-fence' });
	});

	it('围栏内的 `- ` 行不是子块，插入点仍在围栏闭合之后', () => {
		const content = ['- ```md', '  - 代码里的列表', '  ```'].join('\n');
		const insert = getInsert(buildPlan(content));
		expect(insert.position).toBe('block-end');
		expect(insert.line).toBe(3);
		// 解析器只应生成一个块；围栏内的列表行不能变成子块。
		expect(parseMarkdown('test.md', content).blocks).toHaveLength(1);
	});

	it('首行围栏闭合后还有正文时，追加到块自身内容末尾', () => {
		const content = ['- ```js', '  const x = 1', '  ```', '  补充说明', '\t- 子块'].join(
			'\n',
		);
		const insert = getInsert(buildPlan(content));
		expect(insert.position).toBe('block-end');
		expect(insert.line).toBe(4);
		expect(insert.oldText).toBe('  补充说明');
	});

	it('正文代码围栏内的 id:: 是示例，不算已有 ID', () => {
		// `ownLines` 原样包含围栏内的行；若直接扫描，会把示例误判成已有 ID，
		// 真正需要补 ID 的块反而拿不到插入计划。
		const content = ['- 示例', '  ```md', `  id:: ${UUID}`, '  ```', '  正文'].join('\n');
		const plan = buildPlan(content);
		expect(plan).toMatchObject({ kind: 'insert' });
	});

	it('块首行围栏内的 id:: 不算已有 ID，仍追加到块尾', () => {
		const content = ['- ```md', `  id:: ${UUID}`, '  ```'].join('\n');
		const insert = getInsert(buildPlan(content));
		expect(insert.position).toBe('block-end');
		expect(insert.line).toBe(3);
	});
});

describe('已有 ID：不重复插入，只报告问题', () => {
	it('已有 id:: 返回 existing', () => {
		const plan = buildPlan(`- 块\n  id:: ${UUID}`);
		expect(plan.kind).toBe('existing');
		if (plan.kind !== 'existing') {
			return;
		}
		expect(plan.ids).toHaveLength(1);
		expect(plan.ids[0]).toMatchObject({
			value: UUID,
			line: 1,
			inPropertyGroup: true,
			validUuid: true,
			warnings: [],
		});
	});

	it('大写 ID:: 也能识别', () => {
		const plan = buildPlan(`- 块\n  ID:: ${UUID.toUpperCase()}`);
		expect(plan).toMatchObject({ kind: 'existing' });
		if (plan.kind === 'existing') {
			expect(plan.ids[0]?.value).toBe(UUID.toUpperCase());
			expect(plan.ids[0]?.warnings).toHaveLength(0);
		}
	});

	it('同一块多个 id:: 标记 multiple-ids', () => {
		const plan = buildPlan(`- 块\n  id:: ${UUID}\n  id:: 22222222-2222-4222-8222-222222222222`);
		expect(plan.kind).toBe('existing');
		if (plan.kind === 'existing') {
			expect(plan.ids).toHaveLength(2);
			expect(plan.ids.every((id) => id.warnings.includes('multiple-ids'))).toBe(true);
		}
	});

	it('非 UUID 的历史 ID 不覆盖，标记 invalid-id', () => {
		const plan = buildPlan('- 块\n  id:: abc-123');
		expect(plan.kind).toBe('existing');
		if (plan.kind === 'existing') {
			expect(plan.ids[0]).toMatchObject({
				value: 'abc-123',
				validUuid: false,
				warnings: ['invalid-id'],
			});
		}
	});

	it('id:: 写在正文之后时只报告位置问题，不再插入第二行', () => {
		const plan = buildPlan(`- 块\n  正文\n  id:: ${UUID}`);
		expect(plan.kind).toBe('existing');
		if (plan.kind === 'existing') {
			expect(plan.ids[0]).toMatchObject({
				inPropertyGroup: false,
				warnings: ['id-not-in-property-group'],
			});
		}
	});

	it('已有 ID 在块首行围栏的块尾时也返回 existing', () => {
		const content = ['- ```js', '  const x = 1', '  ```', `  id:: ${UUID}`].join('\n');
		const plan = buildPlan(content);
		expect(plan).toMatchObject({ kind: 'existing' });
	});

	it('已有 ID 优先于调用方传入的 uuid', () => {
		const plan = buildPlan(`- 块\n  id:: ${UUID}`, 0, {
			uuid: '22222222-2222-4222-8222-222222222222',
		});
		expect(plan).toMatchObject({ kind: 'existing' });
	});
});

describe('拒绝目标', () => {
	it('页首隐式块（没有 `- ` 前缀）拒绝', () => {
		const plan = buildPlan('# 1 大义、天理\ncollapsed:: true');
		expect(plan).toMatchObject({ kind: 'reject', reason: 'implicit' });
	});
});
