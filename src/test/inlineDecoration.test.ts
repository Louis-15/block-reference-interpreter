import { describe, expect, it } from 'vitest';

import {
	modeDependsOnSelection,
	normalizeRenderMode,
	planInlineDecorations,
	type InlineRenderItem,
} from '../core/inlineDecoration';

const ITEM_A: InlineRenderItem = {
	uuid: '11111111-1111-4111-8111-111111111111',
	line: 2,
	start: 4,
	end: 42,
	text: '目标块标题',
	missing: false,
};

const ITEM_B: InlineRenderItem = {
	uuid: '22222222-2222-4222-8222-222222222222',
	line: 5,
	start: 0,
	end: 38,
	text: '另一个块',
	missing: true,
};

describe('normalizeRenderMode', () => {
	it('识别三种合法模式', () => {
		expect(normalizeRenderMode('activeLine')).toBe('activeLine');
		expect(normalizeRenderMode('replace')).toBe('replace');
		expect(normalizeRenderMode('append')).toBe('append');
	});

	it('未知值回退到 activeLine', () => {
		expect(normalizeRenderMode('')).toBe('activeLine');
		expect(normalizeRenderMode('something')).toBe('activeLine');
	});
});

describe('planInlineDecorations：activeLine', () => {
	it('活动行不加任何装饰，显示真实原文', () => {
		const slots = planInlineDecorations([ITEM_A], 'activeLine', new Set([2]));
		expect(slots).toHaveLength(1);
		expect(slots[0]?.hide).toBe(false);
		expect(slots[0]?.contentText).toBeUndefined();
	});

	it('非活动行隐藏原文并显示标题', () => {
		const slots = planInlineDecorations([ITEM_A], 'activeLine', new Set([99]));
		expect(slots[0]?.hide).toBe(true);
		expect(slots[0]?.contentText).toBe('目标块标题');
	});

	it('多行选区里的引用同样显示原文', () => {
		const slots = planInlineDecorations([ITEM_A, ITEM_B], 'activeLine', new Set([2, 3, 4, 5]));
		expect(slots.every((slot) => slot.hide === false)).toBe(true);
		expect(slots.every((slot) => slot.contentText === undefined)).toBe(true);
	});

	it('活动行按行号判断，而不是按引用序号', () => {
		const slots = planInlineDecorations([ITEM_A, ITEM_B], 'activeLine', new Set([5]));
		expect(slots[0]?.hide).toBe(true);
		expect(slots[1]?.hide).toBe(false);
	});

	it('空活动行集合时所有引用都被替换', () => {
		const slots = planInlineDecorations([ITEM_A], 'activeLine');
		expect(slots[0]?.hide).toBe(true);
	});
});

describe('planInlineDecorations：replace 与 append', () => {
	it('replace 模式忽略活动行，始终隐藏原文', () => {
		const slots = planInlineDecorations([ITEM_A], 'replace', new Set([2]));
		expect(slots[0]?.hide).toBe(true);
		expect(slots[0]?.contentText).toBe('目标块标题');
	});

	it('append 模式保留原文并追加〔标题〕', () => {
		const slots = planInlineDecorations([ITEM_A], 'append');
		expect(slots[0]?.hide).toBe(false);
		expect(slots[0]?.contentText).toBe('〔目标块标题〕');
	});

	it('append 模式下活动行仍保留追加文字（原文本来就可见）', () => {
		const slots = planInlineDecorations([ITEM_A], 'append', new Set([2]));
		expect(slots[0]?.hide).toBe(false);
		expect(slots[0]?.contentText).toBe('〔目标块标题〕');
	});

	it('空标题仍然会追加一对括号（与既有行为一致）', () => {
		const empty: InlineRenderItem = { ...ITEM_A, text: '' };
		const slots = planInlineDecorations([empty], 'append');
		expect(slots[0]?.contentText).toBe('〔〕');
	});
});

describe('modeDependsOnSelection', () => {
	it('只有 activeLine 依赖光标位置', () => {
		expect(modeDependsOnSelection('activeLine')).toBe(true);
		expect(modeDependsOnSelection('replace')).toBe(false);
		expect(modeDependsOnSelection('append')).toBe(false);
		expect(modeDependsOnSelection('unknown')).toBe(true);
	});
});
