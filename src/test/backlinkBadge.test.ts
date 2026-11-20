/**
 * 反链徽章与悬停数据测试。
 *
 * 徽章文字会出现在每一行被引用块的行尾，悬停列表是用户主要的反链入口，
 * 两者样式错了都会很扎眼，所以规则钉死。
 */

import { describe, expect, it } from 'vitest';

import {
	buildTooltipData,
	formatAnchorLabel,
	formatTooltipText,
	type BacklinkAnchor,
	type BacklinkTooltipData,
} from '../core/backlinkBadge';
import { buildBacklinkReport } from '../core/backlinkReport';
import { GraphIndex } from '../core/graphIndex';

const UUID = '6780f110-d8e8-489f-be72-d2b3dbbc5668';

const TARGET = `- ## 人物
	- 《星落凝成糖》夜昙（黑化前）
		id:: 6780f110-d8e8-489f-be72-d2b3dbbc5668
		- 傲娇：毒舌
		- 傻白
`;
const REF_A = `- 71 举例
	- ## 71.3 毒舌讽刺型
		- ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;
const REF_B = `- 71 举例
	- ## 71.2 普通女
		- ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
	- 别处
		- 又引用 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;

async function fixture(): Promise<GraphIndex> {
	const index = new GraphIndex();
	const files: Record<string, string> = {
		'pages/星落凝成糖.md': TARGET,
		'pages/傲娇.md': REF_A,
		'pages/傻白+中二.md': REF_B,
	};
	await index.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));
	return index;
}

function anchor(
	overrides: Partial<Pick<BacklinkAnchor, 'count' | 'duplicate'>> = {},
): Pick<BacklinkAnchor, 'count' | 'duplicate'> {
	return { count: 2, duplicate: false, ...overrides };
}

function emptyTooltip(overrides: Partial<BacklinkTooltipData> = {}): BacklinkTooltipData {
	return {
		itemCount: 0,
		hitCount: 0,
		duplicate: false,
		items: [],
		remaining: 0,
		...overrides,
	};
}

describe('formatAnchorLabel', () => {
	it('基本形态是 🔗 加计数', () => {
		expect(formatAnchorLabel(anchor({ count: 2 }))).toBe('🔗 2');
		expect(formatAnchorLabel(anchor({ count: 1 }))).toBe('🔗 1');
	});

	it('重复定义时加警告符号', () => {
		expect(formatAnchorLabel(anchor({ count: 2, duplicate: true }))).toBe('🔗 2 ⚠');
	});

	it('不把总次数塞进徽章（会撑爆行尾）', () => {
		expect(formatAnchorLabel(anchor({ count: 1 }))).not.toContain('共');
	});
});

describe('buildTooltipData', () => {
	it('每个页面只出一行', async () => {
		const index = await fixture();
		const data = buildTooltipData(buildBacklinkReport(index, UUID));

		expect(data.items).toHaveLength(2);
		const pages = data.items.map((item) => item.pageName);
		expect(pages).toContain('傲娇');
		expect(pages).toContain('傻白+中二');
	});

	it('记录页面内的引用条数', async () => {
		const index = await fixture();
		const data = buildTooltipData(buildBacklinkReport(index, UUID));

		const b = data.items.find((item) => item.pageName === '傻白+中二');
		expect(b?.groupCount).toBe(2);
	});

	it('带上可跳转的路径与行号', async () => {
		const index = await fixture();
		const data = buildTooltipData(buildBacklinkReport(index, UUID));

		for (const item of data.items) {
			expect(item.path.length).toBeGreaterThan(0);
			expect(item.line).toBeGreaterThanOrEqual(0);
		}
	});

	it('带上引用块的面包屑，便于判断语境', async () => {
		const index = await fixture();
		const data = buildTooltipData(buildBacklinkReport(index, UUID));

		const a = data.items.find((item) => item.pageName === '傲娇');
		expect(a?.blockPath).toBe('71 举例 › 71.3 毒舌讽刺型');
	});

	it('maxItems 限制页面数并计入 remaining', async () => {
		const index = await fixture();
		const report = buildBacklinkReport(index, UUID);
		const data = buildTooltipData(report, 1);

		expect(data.items).toHaveLength(1);
		expect(data.remaining).toBe(1);
	});

	it('没有引用时列表为空', async () => {
		const index = await fixture();
		const data = buildTooltipData(buildBacklinkReport(index, '00000000-0000-0000-0000-000000000000'));
		expect(data.items).toHaveLength(0);
		expect(data.remaining).toBe(0);
	});
});

describe('formatTooltipText（CodeLens 备选路径用的纯文本）', () => {
	it('列出页面名与上下文', () => {
		const text = formatTooltipText(
			emptyTooltip({
				itemCount: 2,
				hitCount: 2,
				items: [
					{ pageName: '傲娇', path: '/g/pages/傲娇.md', line: 2, blockPath: '71 举例', groupCount: 1 },
				],
			}),
		);

		expect(text).toContain('2 个引用块');
		expect(text).toContain('傲娇');
		expect(text).toContain('71 举例');
		// CodeLens 拿不到链接，必须提示用户去哪看
		expect(text).toContain('点击查看完整反链面板');
	});

	it('面包屑为空时退回行号', () => {
		const text = formatTooltipText(
			emptyTooltip({
				itemCount: 1,
				hitCount: 1,
				items: [{ pageName: '社恐', path: '/g/pages/社恐.md', line: 52, blockPath: '', groupCount: 1 }],
			}),
		);
		expect(text).toContain('第 53 行');
	});

	it('超限时说明还有多少', () => {
		const text = formatTooltipText(emptyTooltip({ itemCount: 20, remaining: 12 }));
		expect(text).toContain('还有 12 个页面未列出');
	});
});
