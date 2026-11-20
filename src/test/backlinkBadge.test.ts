/**
 * 反链徽章文案测试。
 *
 * 这段文字会出现在每一行被引用块的行尾，样式错了会很扎眼。
 */

import { describe, expect, it } from 'vitest';

import { formatAnchorLabel, formatAnchorTooltip, type BacklinkAnchor } from '../core/backlinkBadge';

function anchor(overrides: Partial<BacklinkAnchor> = {}): BacklinkAnchor {
	return {
		uuid: '6780f110-d8e8-489f-be72-d2b3dbbc5668',
		line: 1,
		count: 2,
		hitCount: 2,
		duplicate: false,
		...overrides,
	};
}

describe('formatAnchorLabel', () => {
	it('基本形态是 🔗 加计数', () => {
		expect(formatAnchorLabel(anchor({ count: 2 }))).toBe('🔗 2');
		expect(formatAnchorLabel(anchor({ count: 1, hitCount: 1 }))).toBe('🔗 1');
	});

	it('同一块内重复引用时补上总次数', () => {
		expect(formatAnchorLabel(anchor({ count: 1, hitCount: 3 }))).toBe('🔗 1 （共 3 次）');
	});

	it('重复定义时加警告符号', () => {
		expect(formatAnchorLabel(anchor({ count: 2, duplicate: true }))).toBe('🔗 2 ⚠');
	});

	it('重复引用与重复定义同时出现', () => {
		expect(formatAnchorLabel(anchor({ count: 1, hitCount: 2, duplicate: true }))).toBe(
			'🔗 1 （共 2 次） ⚠',
		);
	});
});

describe('formatAnchorTooltip', () => {
	it('包含计数、UUID 与操作提示', () => {
		const text = formatAnchorTooltip(anchor());
		expect(text).toContain('2 个引用块');
		expect(text).toContain('6780f110-d8e8-489f-be72-d2b3dbbc5668');
		expect(text).toContain('点击查看完整反链面板');
	});

	it('没有重复时不提重复信息', () => {
		const text = formatAnchorTooltip(anchor());
		expect(text).not.toContain('重复');
	});

	it('命中数大于条目数时才提重复引用', () => {
		const text = formatAnchorTooltip(anchor({ count: 1, hitCount: 3 }));
		expect(text).toContain('共出现 3 次');
	});

	it('重复定义时给出歧义警告', () => {
		const text = formatAnchorTooltip(anchor({ duplicate: true }));
		expect(text).toContain('重复定义');
		expect(text).toContain('任意一个');
	});
});
