import { describe, expect, it } from 'vitest';

import {
	formatBlockRef,
	formatIdPropertyLine,
	generateBlockUuid,
	isUuid,
	isUuidV4,
	isUuidV8,
	parseIdPropertyLine,
	toCanonicalUuid,
	uuidVersion,
} from '../core/blockIdentity';

const UUID_V4 = '11111111-1111-4111-8111-111111111111';
const UUID_V8 = '22222222-2222-8222-8222-222222222222';

describe('UUID 校验', () => {
	it('接受标准 v4 / v8 形态，大小写不敏感', () => {
		expect(isUuid(UUID_V4)).toBe(true);
		expect(isUuid(UUID_V4.toUpperCase())).toBe(true);
		expect(isUuid(UUID_V8)).toBe(true);
		expect(isUuid(`  ${UUID_V4}  `)).toBe(true);
	});

	it('拒绝非规范形态', () => {
		expect(isUuid('')).toBe(false);
		expect(isUuid('abc')).toBe(false);
		expect(isUuid('65cc96fb-1.a7-4c1b-9c3d-123456789abc')).toBe(false);
		expect(isUuid('11111111111141118111111111111111')).toBe(false);
	});

	it('区分版本号', () => {
		expect(uuidVersion(UUID_V4)).toBe(4);
		expect(uuidVersion(UUID_V8)).toBe(8);
		expect(uuidVersion('abc')).toBeNull();
		expect(isUuidV4(UUID_V4)).toBe(true);
		expect(isUuidV8(UUID_V8)).toBe(true);
		expect(isUuidV4(UUID_V8)).toBe(false);
	});

	it('规范化为小写；非法值返回 null', () => {
		expect(toCanonicalUuid(UUID_V4.toUpperCase())).toBe(UUID_V4);
		expect(toCanonicalUuid('not-a-uuid')).toBeNull();
	});
});

describe('generateBlockUuid', () => {
	it('默认生成小写 v4 UUID', () => {
		const uuid = generateBlockUuid();
		expect(isUuid(uuid)).toBe(true);
		expect(uuidVersion(uuid)).toBe(4);
		expect(uuid).toBe(uuid.toLowerCase());
	});

	it('碰撞时重试，返回未占用的候选', () => {
		const candidates = [UUID_V4, UUID_V8];
		let index = 0;
		const uuid = generateBlockUuid({
			isTaken: (value) => value === UUID_V4,
			generate: () => candidates[index++] ?? UUID_V8,
		});
		expect(uuid).toBe(UUID_V8);
	});

	it('跳过生成器返回的非法值', () => {
		const values = ['not-a-uuid', UUID_V4];
		let index = 0;
		const uuid = generateBlockUuid({
			generate: () => values[index++] ?? UUID_V4,
		});
		expect(uuid).toBe(UUID_V4);
	});

	it('始终碰撞时抛错，而不是返回重复 ID', () => {
		expect(() =>
			generateBlockUuid({
				isTaken: () => true,
				generate: () => UUID_V4,
				maxAttempts: 3,
			}),
		).toThrow();
	});
});

describe('id:: 与引用文本格式化', () => {
	it('格式化属性行，保留缩进', () => {
		expect(formatIdPropertyLine(UUID_V4)).toBe(`id:: ${UUID_V4}`);
		expect(formatIdPropertyLine(UUID_V4, '\t  ')).toBe(`\t  id:: ${UUID_V4}`);
	});

	it('格式化行内引用与嵌入引用', () => {
		expect(formatBlockRef(UUID_V4)).toBe(`((${UUID_V4}))`);
		expect(formatBlockRef(UUID_V4, 'embed')).toBe(`{{embed ((${UUID_V4}))}}`);
	});
});

describe('parseIdPropertyLine', () => {
	it('解析任意大小写的 id::，保留缩进', () => {
		expect(parseIdPropertyLine(`  id:: ${UUID_V4}`)).toEqual({
			raw: `  id:: ${UUID_V4}`,
			indent: '  ',
			value: UUID_V4,
		});
		expect(parseIdPropertyLine(`\tID::   ${UUID_V4}   `)).toMatchObject({
			indent: '\t',
			value: UUID_V4,
		});
	});

	it('允许非 UUID 值（用于报告历史数据问题）', () => {
		expect(parseIdPropertyLine('  id:: abc-123')).toMatchObject({ value: 'abc-123' });
		expect(parseIdPropertyLine('  id::')).toMatchObject({ value: '' });
	});

	it('不把块首行正文误判成属性行', () => {
		expect(parseIdPropertyLine('- id:: abc')).toBeNull();
		expect(parseIdPropertyLine('  idx:: abc')).toBeNull();
	});
});
