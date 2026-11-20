/**
 * 反链面板 HTML 渲染测试。
 *
 * 这块的风险集中在两处：
 * 1. **转义**：笔记标题里常出现 `<`、`&`、引号，漏转义会破坏 DOM；
 * 2. **脚本注入**：正文若含 `</script>` 会提前闭合标签，必须验证它跑不出去。
 */

import { describe, expect, it } from 'vitest';

import { renderBacklinkHtml } from '../core/backlinkHtml';
import { buildBacklinkReport } from '../core/backlinkReport';
import { GraphIndex } from '../core/graphIndex';

const UUID = '6780f110-d8e8-489f-be72-d2b3dbbc5668';

const TARGET = `- ## 人物
	- 《星落凝成糖》夜昙（黑化前）
		id:: 6780f110-d8e8-489f-be72-d2b3dbbc5668
		- 傲娇：毒舌
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

async function fixture(files?: Record<string, string>): Promise<GraphIndex> {
	const index = new GraphIndex();
	const data: Record<string, string> = files ?? {
		'pages/星落凝成糖.md': TARGET,
		'pages/傲娇.md': REF_A,
		'pages/傻白+中二.md': REF_B,
	};
	await index.rebuild(Object.keys(data), (filePath) => Promise.resolve(data[filePath] ?? ''));
	return index;
}

const NONCE = 'test-nonce-123';

describe('renderBacklinkHtml 基本结构', () => {
	it('生成完整 HTML 文档并带 CSP nonce', async () => {
		const index = await fixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain(`style-src 'nonce-${NONCE}'`);
		expect(html).toContain(`script-src 'nonce-${NONCE}'`);
		// 默认策略必须禁掉一切，只放行带 nonce 的样式与脚本
		expect(html).toContain("default-src 'none'");
	});

	it('头部显示 UUID、定义位置与块内容', async () => {
		const index = await fixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain(UUID);
		expect(html).toContain('定义位置');
		expect(html).toContain('《星落凝成糖》夜昙（黑化前）');
	});

	it('按页面分组，每组有页面名与引用数', async () => {
		const index = await fixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('<h2>傲娇</h2>');
		expect(html).toContain('<h2>傻白+中二</h2>');
		expect(html).toContain('2 处引用');
	});

	it('面包屑路径出现在引用项里', async () => {
		const index = await fixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('71 举例 › 71.3 毒舌讽刺型');
	});
});

describe('renderBacklinkHtml 链接与跳转目标', () => {
	it('每个引用条目对应一个链接与一个跳转目标', async () => {
		const index = await fixture();
		const report = buildBacklinkReport(index, UUID);
		const { html, targets } = renderBacklinkHtml(report, { nonce: NONCE });

		expect(targets).toHaveLength(report.itemCount);
		// 每个 a.ref 都带 data-i 索引，脚本靠它查 targets
		const anchors = html.match(/<a class="ref" data-i="\d+"/g) ?? [];
		expect(anchors).toHaveLength(report.itemCount);
	});

	it('跳转目标携带正确的文件路径与行号', async () => {
		const index = await fixture();
		const { targets } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		const a = targets.find((target) => target.path.endsWith('傲娇.md'));
		expect(a).toBeDefined();
		// REF_A 里引用在第 2 行（0-based）
		expect(a?.line).toBe(2);
	});

	it('targets 里不含 HTML 语法（脚本用 JSON 读取）', async () => {
		const index = await fixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		// 目标表必须是 application/json 且内容被转义
		expect(html).toContain('<script type="application/json" id="targets">');
	});

	it('得给链接加 tooltip 补回行号与类型', async () => {
		const index = await fixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('第 3 行 · 行内引用');
	});
});

describe('renderBacklinkHtml 转义与安全', () => {
	it('块标题里的尖括号与 & 被转义', async () => {
		const index = await fixture({
			'pages/<script>alert(1)</script>.md': `- 标题含 <b>标签</b> 与 A & B
		id:: ${UUID}
`,
			'pages/ref.md': `- 引用 ((${UUID}))\n`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		// 转义后的形式必须存在，原始标签绝不能出现
		expect(html).toContain('&lt;b&gt;');
		expect(html).toContain('&amp;');
		expect(html).not.toContain('<b>标签</b>');
	});

	it('标题里的 </script> 无法提前闭合标签', async () => {
		const index = await fixture({
			'pages/x.md': `- 恶意标题 </script><img src=x onerror=alert(1)>
		id:: ${UUID}
`,
			'pages/ref.md': `- 引用 ((${UUID}))\n`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		// 危险形态：标签被真正解析出来
		expect(html).not.toContain('</script><img');
		expect(html).not.toMatch(/<img\s/);
		// 安全形态：整段被当作普通文本转义
		expect(html).toContain('&lt;/script&gt;&lt;img');
		// 脚本标签数量固定为 2 个（目标表 + 本扩展脚本），没被注入第三个
		const scriptTags = html.match(/<script/g) ?? [];
		expect(scriptTags).toHaveLength(2);
	});

	it('引号被转义，不会打断属性', async () => {
		const index = await fixture({
			'pages/q.md': `- 标题含 "双引号" 和 '单引号'
		id:: ${UUID}
`,
			'pages/ref.md': `- 引用 ((${UUID}))\n`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('&quot;双引号&quot;');
		expect(html).toContain('&#39;单引号&#39;');
	});
});

describe('renderBacklinkHtml 显示细节', () => {
	it('面包屑里的 ** 强调标记被去掉（像 Tine 那样渲染）', async () => {
		const index = await fixture({
			'pages/t.md': TARGET,
			'pages/r.md': `- 父级
	- **重点小节**
		- 引用 ((${UUID}))
`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('重点小节');
		expect(html).not.toContain('**重点小节**');
	});

	it('maxItemsPerGroup 截断并提示剩余', async () => {
		const index = await fixture();
		const report = buildBacklinkReport(index, UUID);
		const { html, targets } = renderBacklinkHtml(report, { nonce: NONCE, maxItemsPerGroup: 1 });

		expect(targets.length).toBe(2); // 两个页面各显示 1 条
		expect(html).toContain('本页还有 1 处未显示');
	});

	it('块不存在时给出悬空引用警告', async () => {
		const index = await fixture();
		const { html } = renderBacklinkHtml(
			buildBacklinkReport(index, '00000000-0000-0000-0000-000000000000'),
			{ nonce: NONCE },
		);

		expect(html).toContain('不存在');
		expect(html).toContain('悬空引用');
	});

	it('没有任何引用时给出空状态文案', async () => {
		const index = await fixture({
			'pages/t.md': TARGET,
		});
		const { html, targets } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('没有任何笔记引用这个块');
		expect(targets).toHaveLength(0);
	});

	it('graphRoot 生效时显示相对路径', async () => {
		const root = 'D:/graph';
		const index = await fixture({
			[`${root}/pages/t.md`]: TARGET,
			[`${root}/pages/r.md`]: `- 引用 ((${UUID}))\n`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), {
			nonce: NONCE,
			graphRoot: root,
		});

		// 可见区域用相对路径（绝对路径仍保留在 JSON 目标表里供跳转使用）
		expect(html).toContain('<code>pages/r.md</code>');
		expect(html).toContain('· 1 处引用');
		// 绝对路径只应出现在目标表那段 JSON 里，正文中不能有
		const bodyOnly = html.split('<script type="application/json"')[0] ?? '';
		expect(bodyOnly).not.toContain('D:/graph/pages/r.md');
	});

	it('悬挂引用（有引用但块已删）用行号兜底，链接仍可点', async () => {
		const index = await fixture({
			'pages/d.md': '- 引用不存在的块 ((00000000-0000-0000-0000-000000000001))\n',
		});
		const { html, targets } = renderBacklinkHtml(
			buildBacklinkReport(index, '00000000-0000-0000-0000-000000000001'),
			{ nonce: NONCE },
		);

		expect(targets).toHaveLength(1);
		expect(html).toMatch(/第 1 行<\/a>/);
	});
});

describe('renderBacklinkHtml 子树与缩进', () => {
	/** 构造带三层嵌套的引用场景。 */
	async function nestedFixture(): Promise<GraphIndex> {
		return fixture({
			'pages/t.md': TARGET,
			'pages/ref.md': `- 父级
	- 引用所在块 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
		- 直接子块
			- 孙块
`,
		});
	}

	it('引用块标题单独占一行并缩进一级', async () => {
		const index = await nestedFixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('<div class="title-line">');
		// 面包屑不带缩进，标题带缩进
		expect(html).toMatch(/<div class="crumb">[\s\S]*?<div class="title-line"><a class="ref"/);
	});

	it('子块按 depth 套用缩进 class', async () => {
		const index = await nestedFixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		// 直接子块 depth=1 → .sub.d1；孙块 depth=2 → .sub.d2
		expect(html).toContain('<div class="sub d1">');
		expect(html).toContain('<div class="sub d2">');
		expect(html).toContain('直接子块');
		expect(html).toContain('孙块');
	});

	it('子块层级用 class 而非内联 style（CSP 会拦内联 style）', async () => {
		const index = await nestedFixture();
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		// 正文里不能出现 style= 属性
		expect(html).not.toMatch(/<div class="sub[^"]*"\s+style=/);
	});

	it('列表项带圆点，续行不带', async () => {
		const index = await fixture({
			'pages/t.md': TARGET,
			'pages/ref.md': `- 引用块 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
	这是块自身的续行
	- 这是子块
`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('<span class="bullet">•</span>这是子块');

		// 续行所在 div 不应带圆点
		const continuationDiv = /<div class="sub d\d">([\s\S]*?)<\/div>/.exec(html);
		expect(continuationDiv?.[1]).toBeDefined();
		expect(continuationDiv?.[1] ?? '').toContain('这是块自身的续行');
		expect(continuationDiv?.[1] ?? '').not.toContain('bullet');
	});

	it('maxSubtreeLines 达到上限时提示剩余行数', async () => {
		const index = await fixture({
			'pages/t.md': TARGET,
			'pages/ref.md': `- 引用块 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
	- 子一
	- 子二
	- 子三
`,
		});
		const report = buildBacklinkReport(index, UUID, { maxSubtreeLines: 1 });
		const { html } = renderBacklinkHtml(report, { nonce: NONCE });

		expect(html).toContain('还有');
		expect(html).toContain('行未展开');
		expect(html).not.toContain('子三');
	});

	it('includeSubtree: false 时不渲染任何子块', async () => {
		const index = await nestedFixture();
		const report = buildBacklinkReport(index, UUID, { includeSubtree: false });
		const { html } = renderBacklinkHtml(report, { nonce: NONCE });

		expect(html).not.toContain('直接子块');
		expect(html).not.toContain('class="sub');
	});

	it('子块内容也会转义，不会注入标签', async () => {
		const index = await fixture({
			'pages/t.md': TARGET,
			'pages/ref.md': `- 引用块 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
	- <img src=x onerror=alert(1)>
`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).not.toMatch(/<img\s/);
		expect(html).toContain('&lt;img');
	});

	it('子块里的 ** 强调标记也被去掉', async () => {
		const index = await fixture({
			'pages/t.md': TARGET,
			'pages/ref.md': `- 引用块 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
	- **加粗的子块**
`,
		});
		const { html } = renderBacklinkHtml(buildBacklinkReport(index, UUID), { nonce: NONCE });

		expect(html).toContain('加粗的子块');
		expect(html).not.toContain('**加粗的子块**');
	});
});
