import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import {
	buildIdInsertionPlan,
	type IdInsertionOptions,
	type IdInsertionPlan,
} from '../core/idInsertion';

const UUID = '11111111-1111-4111-8111-111111111111';

/** 用固定 UUID 构建计划，避免随机值让断言不稳定。 */
function buildPlan(content: string, blockIndex = 0, options: IdInsertionOptions = {}): IdInsertionPlan {
	const parsed = parseMarkdown('test.md', content);
	return buildIdInsertionPlan(parsed, blockIndex, { uuid: UUID, ...options });
}

/** 断言并收窄为 insert，后续字段访问才有类型。 */
function getInsert(plan: IdInsertionPlan): Extract<IdInsertionPlan, { kind: 'insert' }> {
	if (plan.kind !== 'insert') {
		const detail = plan.kind === 'reject' ? `: ${plan.reason}` : '';
		throw new Error(`expected insert, got ${plan.kind}${detail}`);
	}
	return plan;
}

describe('id:: 插入点：基础位置', () => {
	it('无属性：插在块首行之后、正文之前', () => {
		const insert = getInsert(buildPlan('- 块标题\n  正文'));
		expect(insert.line).toBe(1);
		expect(insert.propertyLine).toBe(`  id:: ${UUID}`);
		expect(insert.position).toBe('property-group');
		expect(insert.logseqCompatible).toBe(true);
		expect(insert.oldText).toBe('- 块标题');
		expect(insert.newText).toBe(`- 块标题\n  id:: ${UUID}`);
	});

	it('有 collapsed:: 时插在属性之后', () => {
		const insert = getInsert(buildPlan('- 块标题\n  collapsed:: true\n  正文'));
		expect(insert.line).toBe(2);
		expect(insert.oldText).toBe('  collapsed:: true');
		expect(insert.newText).toBe(`  collapsed:: true\n  id:: ${UUID}`);
	});

	it('多个属性时插在属性组末尾', () => {
		const insert = getInsert(
			buildPlan('- 块标题\n  collapsed:: true\n  tine.author:: 作者\n  正文'),
		);
		expect(insert.line).toBe(3);
		expect(insert.oldText).toBe('  tine.author:: 作者');
	});

	it('有子块时插在块首行之后、子块之前', () => {
		const insert = getInsert(buildPlan('- 父块\n\t- 子块'));
		expect(insert.line).toBe(1);
		expect(insert.propertyLine).toBe(`  id:: ${UUID}`);
	});

	it('空块（`-`）也能插入', () => {
		const insert = getInsert(buildPlan('-'));
		expect(insert.propertyLine).toBe(`  id:: ${UUID}`);
		expect(insert.oldText).toBe('-');
	});

	it('页面属性不属于块，插入点仍按第一个列表块计算', () => {
		const plan = buildIdInsertionPlan(
			parseMarkdown('test.md', 'title:: 页面标题\ntags:: 测试\n- 第一个块'),
			0,
			{ uuid: UUID },
		);
		const insert = getInsert(plan);
		expect(insert.line).toBe(3);
		expect(insert.oldText).toBe('- 第一个块');
	});
});

describe('id:: 插入点：缩进', () => {
	it('Tab 缩进的块使用「Tab + 两个空格」', () => {
		const insert = getInsert(buildPlan('\t- 子块\n\t  正文'));
		expect(insert.propertyLine).toBe(`\t  id:: ${UUID}`);
	});

	it('空格缩进的块保留原有空格', () => {
		const insert = getInsert(buildPlan('    - 块\n      正文'));
		expect(insert.propertyLine).toBe(`      id:: ${UUID}`);
	});

	it('历史零缩进属性：跟随现有属性缩进，保持属性组连续', () => {
		const insert = getInsert(buildPlan('- # 1 文字\ncollapsed:: true\n正文'));
		expect(insert.propertyLine).toBe(`id:: ${UUID}`);
		expect(insert.line).toBe(2);
	});

	it('属性组中间的空行会终止属性组，id:: 插在空行之前', () => {
		const insert = getInsert(buildPlan('- 块\n  collapsed:: true\n\n  正文'));
		expect(insert.line).toBe(2);
		expect(insert.oldText).toBe('  collapsed:: true');
	});
});

describe('id:: 插入点：换行与文件末尾', () => {
	it('CRLF 文件的 insertText 使用 CRLF，AI 补丁仍用 LF', () => {
		const insert = getInsert(buildPlan('- 块\r\n  正文\r\n', 0, { eol: '\r\n' }));
		expect(insert.eol).toBe('\r\n');
		expect(insert.insertText).toBe(`  id:: ${UUID}\r\n`);
		expect(insert.newText).not.toContain('\r');
	});

	it('块位于文件末尾（有尾随换行）时插在尾随空行之前', () => {
		const insert = getInsert(buildPlan('- 块\n'));
		expect(insert.line).toBe(1);
		expect(insert.newText).toBe(`- 块\n  id:: ${UUID}`);
	});

	it('块位于文件末尾（无尾随换行）时 line 等于 lines.length', () => {
		const parsed = parseMarkdown('test.md', '- 块');
		const plan = buildIdInsertionPlan(parsed, 0, { uuid: UUID });
		const insert = getInsert(plan);
		expect(insert.line).toBe(parsed.lines.length);
		expect(insert.newText).toBe(`- 块\n  id:: ${UUID}`);
	});
});

describe('id:: 插入计划：补丁与错误', () => {
	it('相同块重复出现时，oldText 会扩展上下文直到唯一', () => {
		const content = ['- 块', '  正文', '- 块', '  正文'].join('\n');
		const insert = getInsert(buildPlan(content, 0));
		// 两个块完全相同，仅靠块首行无法定位，必须扩展到能区分的位置。
		expect(insert.oldText.split('\n').length).toBeGreaterThan(1);
		expect(insert.newText).toContain(`  id:: ${UUID}`);
	});

	it('指定非法 UUID 时拒绝', () => {
		const plan = buildPlan('- 块', 0, { uuid: 'not-a-uuid' });
		expect(plan).toMatchObject({ kind: 'reject', reason: 'invalid-uuid' });
	});

	it('块下标越界时拒绝', () => {
		const plan = buildPlan('- 块', 99);
		expect(plan).toMatchObject({ kind: 'reject', reason: 'no-block' });
	});

	it('不传 uuid 时生成合法的 v4，并尊重查重回调', () => {
		const parsed = parseMarkdown('test.md', '- 块');
		const plan = buildIdInsertionPlan(parsed, 0, {
			isUuidTaken: () => false,
			// 第一次给非法值，验证生成器会跳过而不是直接使用。
			generateUuid: (() => {
				let call = 0;
				return () => (call++ === 0 ? 'bad' : UUID);
			})(),
		});
		const insert = getInsert(plan);
		expect(insert.uuid).toBe(UUID);
	});

	it('生成器始终碰撞时返回 duplicate，不抛异常', () => {
		const parsed = parseMarkdown('test.md', '- 块');
		const plan = buildIdInsertionPlan(parsed, 0, {
			isUuidTaken: () => true,
			generateUuid: () => UUID,
			maxUuidAttempts: 3,
		});
		expect(plan).toMatchObject({ kind: 'reject', reason: 'duplicate' });
	});
});
