/**
 * 展开网页的 HTML 渲染测试。
 *
 * 关注三件事：来源链接的坐标是否准确、转义是否到位、脚本标签数量是否可控。
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../core/blockParser';
import { renderExpandHtml } from '../core/expandHtml';
import { buildBlockExpandView, buildNoteExpandView } from '../core/expandView';
import { GraphIndex } from '../core/graphIndex';

const UUID = '6780f110-d8e8-489f-be72-d2b3dbbc5668';
const NONCE = 'test-nonce';

const TARGET = `- ## 人物
	- 《星落凝成糖》夜昙（黑化前）
		id:: ${UUID}
		- 天然
`;
const REF = `- 父级
	- 引用 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;

async function fixture(files?: Record<string, string>): Promise<GraphIndex> {
	const index = new GraphIndex();
	const data: Record<string, string> = files ?? {
		'graph/pages/星落凝成糖.md': TARGET,
		'graph/pages/傲娇.md': REF,
	};
	await index.rebuild(Object.keys(data), (filePath) => Promise.resolve(data[filePath] ?? ''));
	return index;
}

describe('renderExpandHtml 基本结构', () => {
	it('生成完整文档并带 CSP nonce', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain("default-src 'none'");
		expect(html).toContain(`style-src 'nonce-${NONCE}'`);
		expect(html).toContain(`script-src 'nonce-${NONCE}'`);
	});

	it('脚本标签只有两个（目标表 + 扩展脚本）', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect((html.match(/<script/g) ?? []).length).toBe(2);
	});

	it('显示标题、来源与规模', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('《星落凝成糖》夜昙（黑化前）');
		expect(html).toContain('pages/星落凝成糖.md');
		expect(html).toContain('来源');
	});

	it('来源链接带可点击标记与 tooltip', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('<a class="src-link"');
		expect(html).toContain('跳到第 2 行');
	});

	it('内容画成灰点列表，不显示 Markdown 的减号', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('<div class="content">');
		expect(html).toContain('<span class="dot">•</span>');
		expect(html).toContain('天然');
		// 不应再出现源码里的减号前缀
		expect(html).not.toMatch(/<span class="ctx">- /);
	});

	it('子块按层级套用缩进 class', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		// 直接子块 depth=1 → .cline.lv1
		expect(html).toContain('class="cline lv1"');
	});

	it('缩进用 class 而非内联 style（CSP 会拦内联样式）', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).not.toMatch(/<div class="cline[^"]*"\s+style=/);
	});
});

describe('renderExpandHtml 跳转目标', () => {
	it('每个来源链接对应一个跳转目标', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html, targets } = renderExpandHtml(view, { nonce: NONCE });

		expect(targets).toHaveLength(1);
		expect(targets[0]?.path).toContain('星落凝成糖.md');
		expect(targets[0]?.line).toBe(1);

		const links = html.match(/data-i="\d+"/g) ?? [];
		expect(links).toHaveLength(targets.length);
	});

	it('整篇展开时每个块都有跳转目标', async () => {
		const notePath = 'graph/pages/傲娇.md';
		const parsed = parseMarkdown(notePath, REF);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);
		const { html, targets } = renderExpandHtml(view, { nonce: NONCE });

		const blockCount = view.flow.filter((item) => item.type === 'block').length;
		expect(targets.length).toBe(blockCount);
		expect(html).toContain('data-i="0"');
	});

	it('块不存在时没有跳转目标，但有警告', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, '00000000-0000-0000-0000-000000000000');
		const { html, targets } = renderExpandHtml(view, { nonce: NONCE });

		expect(targets).toHaveLength(0);
		expect(html).toContain('class="warn"');
	});
});

describe('renderExpandHtml 转义与安全', () => {
	it('块标题里的尖括号与 & 被转义', async () => {
		const index = await fixture({
			'graph/pages/x.md': `- 标题含 <b>标签</b> 与 A & B\n\tid:: ${UUID}\n`,
		});
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('&lt;b&gt;');
		expect(html).toContain('&amp;');
		expect(html).not.toContain('<b>标签</b>');
	});

	it('内容里的 </script> 无法提前闭合标签', async () => {
		const index = await fixture({
			'graph/pages/x.md': `- 恶意块\n\tid:: ${UUID}\n\t- </script><img src=x onerror=alert(1)>\n`,
		});
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).not.toContain('</script><img');
		expect(html).not.toMatch(/<img\s/);
		expect((html.match(/<script/g) ?? []).length).toBe(2);
	});

	it('原文行的 HTML 标签被转义', async () => {
		const notePath = 'graph/pages/x.md';
		const parsed = parseMarkdown(notePath, `- <script>alert(1)</script> ((${UUID}))\n`);
		const index = await fixture({
			'graph/pages/x.md': `- 目标\n\tid:: ${UUID}\n`,
		});
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
	});
});

describe('renderExpandHtml 显示细节', () => {
	it('原文行号从 1 开始', async () => {
		const notePath = 'graph/pages/x.md';
		const parsed = parseMarkdown(notePath, `${REF}`);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('<span class="ln">1</span>');
		expect(html).toContain('<span class="ln">2</span>');
	});

	it('触发展开的原文行带高亮标记', async () => {
		const notePath = 'graph/pages/x.md';
		const parsed = parseMarkdown(notePath, `${REF}`);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('class="src marked"');
	});

	it('空行也保留占位符，行号不会跳号', async () => {
		const notePath = 'graph/pages/x.md';
		const parsed = parseMarkdown(notePath, `- 第一行\n\n- 第三行\n`);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		// 空行用 &nbsp; 撑住高度
		expect(html).toContain('&nbsp;');
	});

	it('没有引用时给出说明', async () => {
		const notePath = 'graph/pages/x.md';
		const parsed = parseMarkdown(notePath, `- 没有引用的笔记\n`);
		const index = await fixture();
		const view = buildNoteExpandView(
			index,
			{ path: notePath, lines: parsed.lines, references: parsed.references },
			{ graphRoot: 'graph' },
		);
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		expect(html).toContain('没有块引用');
	});

	it('不使用 emoji 作为图标（部分字体渲染成方框）', async () => {
		const index = await fixture();
		const view = buildBlockExpandView(index, UUID, { graphRoot: 'graph' });
		const { html } = renderExpandHtml(view, { nonce: NONCE });

		// 内容区不应出现 📄 这类依赖系统字体的符号
		expect(html).not.toContain('📄');
	});
});
