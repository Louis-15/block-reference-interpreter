/**
 * 反链面板的 HTML 渲染。
 *
 * 为什么需要 HTML 版本：面板原本是只读文本文档，靠 `DocumentLink` 做跳转，
 * 但 **文本编辑器里的链接强制要求 Ctrl + 单击**（目的是避免用户点光标或
 * 拖选文字时误跳转），这是 VS Code 的硬规则，扩展改不了。
 * Webview 里的 `<a>` 元素没有这个限制，左键单击即可跳转。
 *
 * 这一层仍然是纯字符串逻辑，不依赖 `vscode`，可在 Node 里直接单测。
 * 平台相关的部分（CSP nonce、消息通道）由 `vscode/backlinkPanelView.ts` 负责。
 */

import type { BacklinkReport } from './backlinkReport';
import { toPageName } from './backlinkReport';

/** 渲染选项。 */
export interface BacklinkHtmlOptions {
	/** Webview 的 CSP nonce，由调用方生成。 */
	nonce: string;
	/** 图谱根目录，用于把绝对路径转成 `pages/xxx.md`。 */
	graphRoot?: string;
	/** 每组最多显示几条，默认不限制。 */
	maxItemsPerGroup?: number;
}

/** 一条跳转目标，交给前端脚本按索引查找。 */
export interface BacklinkHtmlTarget {
	/** 目标文件绝对路径。 */
	path: string;
	/** 目标行（0-based）。 */
	line: number;
	/** 显示用的相对路径。 */
	displayPath: string;
}

/** HTML 与其内嵌的跳转目标表。 */
export interface BacklinkHtmlResult {
	/** 完整 HTML 文档。 */
	html: string;
	/** 按索引对应的跳转目标。 */
	targets: BacklinkHtmlTarget[];
}

/**
 * 去掉 Markdown 强调标记（`**粗体**`、`__粗体__`）。
 *
 * 真实笔记库里大量标题用 `**...**` 标重点，例如
 * `**3、导向意义层（动机揭示、符号象征直通）**`。
 * 面板是给人看的渲染结果，照搬星号会变成噪声——Tine 那边是渲染成粗体的。
 *
 * 只去掉标记、不加粗：面包屑本身已经是次要信息（灰色小字），
 * 再叠一层粗体反而抢了下面「块名链接」的注意力。
 */
function stripEmphasis(text: string): string {
	return text.replace(/\*\*|__/g, '');
}

/**
 * HTML 转义。
 *
 * 笔记标题里常见 `<`、`&`、引号（例如「动机揭示：信念由"人"承载」），
 * 不转义会破坏 DOM 结构，甚至被当成标签执行。
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 把数据安全地嵌进 `<script>` 标签。
 *
 * 直接把 JSON 塞进脚本里，正文若含 `</script>` 会提前闭合标签；
 * `<` `>` `&` 转成 unicode 转义后就不会被 HTML 解析器误读，
 * 而 JSON 语义完全不变。
 */
function safeJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026');
}

/** 把绝对路径转成相对图谱根的显示路径。 */
function toDisplayPath(filePath: string, graphRoot?: string): string {
	if (!graphRoot) {
		return filePath.replace(/\\/g, '/');
	}
	const root = graphRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	const target = filePath.replace(/\\/g, '/');
	return target.toLowerCase().startsWith(root.toLowerCase() + '/')
		? target.slice(root.length + 1)
		: target;
}

/** 面板样式。用 VS Code 主题变量，自动跟随深浅色。 */
const STYLES = `
* { box-sizing: border-box; }
body {
	margin: 0;
	padding: 16px 20px 40px;
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-editor-foreground);
	background: var(--vscode-editor-background);
	line-height: 1.6;
}
.head { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; margin-bottom: 20px; }
.head h1 { font-size: 1.15em; margin: 0 0 8px; font-weight: 600; }
.head .uuid { font-family: var(--vscode-editor-font-family); opacity: .65; font-weight: 400; }
.head .row { margin: 2px 0; font-size: .92em; }
.head .label { color: var(--vscode-descriptionForeground); }
.head .block-content { font-weight: 600; }
.head .hint { margin-top: 10px; font-size: .88em; color: var(--vscode-descriptionForeground); }
.warn {
	margin: 10px 0;
	padding: 8px 12px;
	border-left: 3px solid var(--vscode-editorWarning-foreground);
	background: var(--vscode-inputValidation-warningBackground, rgba(255,180,0,.1));
	font-size: .9em;
}
.page { margin-bottom: 26px; }
.page h2 { font-size: 1.02em; margin: 0 0 2px; font-weight: 600; }
.page .meta { font-size: .85em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.page .meta code { font-family: var(--vscode-editor-font-family); }
ul.refs { list-style: none; margin: 0; padding: 0; }
li.ref-item { margin: 0 0 2px; padding: 3px 8px; border-radius: 3px; }
li.ref-item:hover { background: var(--vscode-list-hoverBackground); }
.crumb { font-size: .85em; color: var(--vscode-descriptionForeground); word-break: break-word; }
a.ref {
	display: inline-block;
	margin-top: 1px;
	color: var(--vscode-textLink-foreground, #3794ff);
	text-decoration: none;
	cursor: pointer;
	word-break: break-word;
}
a.ref:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, #3794ff); }
.empty { color: var(--vscode-descriptionForeground); }
.more { font-size: .85em; color: var(--vscode-descriptionForeground); padding-left: 8px; }
`;

/** 前端脚本：把点击转成 postMessage，交给扩展执行真正的跳转。 */
const SCRIPT = `
(function () {
	var api = acquireVsCodeApi();
	var targets = JSON.parse(document.getElementById('targets').textContent);
	var links = document.querySelectorAll('a.ref');
	for (var i = 0; i < links.length; i++) {
		links[i].addEventListener('click', function (event) {
			event.preventDefault();
			var target = targets[Number(this.dataset.i)];
			if (!target) { return; }
			api.postMessage({ type: 'jump', path: target.path, line: target.line });
		});
	}
})();
`;

/**
 * 渲染反链面板 HTML。
 *
 * 每处引用分两行呈现，与 Tine 一致：
 * 1. 引用所在块的祖先路径（`71 举例 › 71.3 毒舌讽刺型`）；
 * 2. 被引用块自身的文字，作为可点击链接。
 */
export function renderBacklinkHtml(
	report: BacklinkReport,
	options: BacklinkHtmlOptions,
): BacklinkHtmlResult {
	const targets: BacklinkHtmlTarget[] = [];
	const bodyParts: string[] = [];

	const maxItems = options.maxItemsPerGroup;

	// ---- 头部 ----
	bodyParts.push('<header class="head">');
	bodyParts.push(
		`<h1>块 <span class="uuid">${escapeHtml(report.uuid)}</span> 的反向链接</h1>`,
	);

	if (report.definitions.length === 0) {
		bodyParts.push('<div class="warn">⚠ 该 UUID 对应的块不存在（可能已被删除）。以下引用均为<strong>悬空引用</strong>。</div>');
	} else if (report.definitions.length > 1) {
		bodyParts.push(
			`<div class="warn">⚠ 该 UUID 在 ${report.definitions.length} 处重复定义，引用可能指向其中任意一个。</div>`,
		);
	}

	const first = report.definitions[0];
	if (first) {
		bodyParts.push(
			`<div class="row"><span class="label">定义位置：</span>${escapeHtml(toDisplayPath(first.path, options.graphRoot))} 第 ${first.line + 1} 行</div>`,
			`<div class="row"><span class="label">块内容：</span><span class="block-content">${escapeHtml(first.title)}</span></div>`,
		);
	}

	if (report.itemCount > 0) {
		const hitNote =
			report.hitCount > report.itemCount
				? `（同一块内重复出现共 ${report.hitCount} 次）`
				: '';
		bodyParts.push(
			`<div class="row"><span class="label">引用统计：</span>${report.fileCount} 个页面 / ${report.itemCount} 个引用块${escapeHtml(hitNote)}</div>`,
			'<div class="hint">单击下方蓝色文字即可跳到引用位置。</div>',
		);
	}

	bodyParts.push('</header>');

	// ---- 空状态 ----
	if (report.itemCount === 0) {
		bodyParts.push('<p class="empty">没有任何笔记引用这个块。</p>');
		return {
			html: wrapDocument(bodyParts.join('\n'), targets, options.nonce),
			targets,
		};
	}

	// ---- 分组列表 ----
	const linkText = first?.title ?? '';

	for (const group of report.groups) {
		const displayPath = toDisplayPath(group.path, options.graphRoot);
		bodyParts.push('<section class="page">');
		bodyParts.push(`<h2>${escapeHtml(toPageName(group.path))}</h2>`);
		bodyParts.push(
			`<div class="meta"><code>${escapeHtml(displayPath)}</code> · ${group.count} 处引用</div>`,
		);
		bodyParts.push('<ul class="refs">');

		const shown = maxItems === undefined ? group.items : group.items.slice(0, maxItems);

		for (const item of shown) {
			const kindText = item.kinds.includes('embed')
				? item.kinds.includes('inline')
					? '行内引用 + 嵌入引用'
					: '嵌入引用'
				: '行内引用';
			const countText = item.count > 1 ? `，本块内 ${item.count} 次` : '';
			const tooltip = `${displayPath} 第 ${item.line + 1} 行 · ${kindText}${countText}`;

			const index = targets.length;
			targets.push({ path: item.path, line: item.line, displayPath });

			// 块不存在时没有文字可用，退回行号，保证仍然可点击。
			const text = linkText.length > 0 ? linkText : `第 ${item.line + 1} 行`;

			bodyParts.push('<li class="ref-item">');
			if (item.blockPath.length > 0) {
				bodyParts.push(`<div class="crumb">${escapeHtml(stripEmphasis(item.blockPath))}</div>`);
			}
			bodyParts.push(
				`<a class="ref" data-i="${index}" title="${escapeHtml(tooltip)}">${escapeHtml(stripEmphasis(text))}</a>`,
			);
			bodyParts.push('</li>');
		}

		if (maxItems !== undefined && group.items.length > maxItems) {
			bodyParts.push(`<li class="more">本页还有 ${group.items.length - maxItems} 处未显示</li>`);
		}

		bodyParts.push('</ul>', '</section>');
	}

	return {
		html: wrapDocument(bodyParts.join('\n'), targets, options.nonce),
		targets,
	};
}

/** 包成完整 HTML 文档。 */
function wrapDocument(bodyHtml: string, targets: unknown[], nonce: string): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>反向链接</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
${bodyHtml}
<script type="application/json" id="targets">${safeJson(targets)}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
