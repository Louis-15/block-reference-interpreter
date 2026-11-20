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

import { escapeHtml, safeJson, stripEmphasis } from './htmlText';
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
.head .toolbar { margin-top: 8px; }
.head .toolbar button {
	padding: 3px 10px;
	border: 1px solid var(--vscode-button-border, transparent);
	border-radius: 3px;
	background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
	color: var(--vscode-button-secondaryForeground, inherit);
	font-family: inherit;
	font-size: .85em;
	cursor: pointer;
}
.head .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.35)); }
.head .toolbar button:disabled { opacity: .5; cursor: default; }
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
li.ref-item { margin: 0 0 10px; padding: 3px 8px; border-radius: 3px; }
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
/* 引用块标题比面包屑深一级，体现「引用发生在这个父块的子块里」 */
.title-line { display: flex; align-items: baseline; gap: 4px; padding-left: 4px; }
/*
 * 折叠三角。没有子块的引用不显示三角，但留一个等宽占位，
 * 否则有子块和没子块的标题会左右错开，看着很乱。
 */
.toggle {
	flex: 0 0 auto;
	width: 16px;
	height: 16px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	padding: 0;
	border: none;
	border-radius: 2px;
	background: transparent;
	color: var(--vscode-icon-foreground, var(--vscode-editor-foreground, #ccc));
	cursor: pointer;
	font-size: .95em;
	line-height: 1;
	opacity: .95;
	user-select: none;
	/* 与链接文字基线对齐：三角字形自带下沉，上提 1px 看着才正 */
	position: relative;
	top: 1px;
}
.toggle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.25)); }
.toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder, #3794ff); outline-offset: 1px; }
.toggle-placeholder { flex: 0 0 auto; width: 16px; }
/* 折叠后整棵子树隐藏 */
.ref-item.collapsed .subtree { display: none; }
.subtree { padding-left: 4px; }
/* 折叠状态用左边一条竖线暗示，与 Tine 的引导线一致 */
.ref-item.collapsed .title-line { opacity: .95; }
/*
 * 子树缩进：层级用固定 class 而不是内联 style —— CSP 的 style-src 只放行
 * 带 nonce 的 <style>，内联 style 属性会被拦掉，缩进就会全部失效。
 * 层级超过 8 层时统一用 d8，实际笔记极少超过 4 层。
 */
.sub { font-size: .92em; line-height: 1.5; padding-left: 36px; }
.sub.d2 { padding-left: 54px; }
.sub.d3 { padding-left: 72px; }
.sub.d4 { padding-left: 90px; }
.sub.d5 { padding-left: 108px; }
.sub.d6 { padding-left: 126px; }
.sub.d7 { padding-left: 144px; }
.sub.d8 { padding-left: 160px; }
.sub .bullet { opacity: .45; margin-right: 6px; }
.sub-more { font-size: .85em; color: var(--vscode-descriptionForeground); padding-left: 36px; }
.empty { color: var(--vscode-descriptionForeground); }
.more { font-size: .85em; color: var(--vscode-descriptionForeground); padding-left: 8px; }
`;

/** 前端脚本：把点击转成 postMessage，交给扩展执行真正的跳转。 */
const SCRIPT = `
(function () {
	var api = acquireVsCodeApi();
	var targets = JSON.parse(document.getElementById('targets').textContent);

	// ---- 跳转 ----
	var links = document.querySelectorAll('a.ref');
	for (var i = 0; i < links.length; i++) {
		links[i].addEventListener('click', function (event) {
			event.preventDefault();
			var target = targets[Number(this.dataset.i)];
			if (!target) { return; }
			api.postMessage({ type: 'jump', path: target.path, line: target.line });
		});
	}

	// ---- 折叠状态 ----
	// 存在 webview state 里：面板内容因切换块而重建时，用户的折叠选择仍能恢复。
	// 键是「文件路径|行号」，所以不同块的折叠状态互不干扰。
	var saved = api.getState() || {};
	var collapsed = saved.collapsed || {};

	function syncItem(li) {
		var toggle = li.querySelector('.toggle');
		if (!toggle) { return; }
		var isCollapsed = !!collapsed[li.dataset.key];
		li.classList.toggle('collapsed', isCollapsed);
		toggle.textContent = isCollapsed ? '▸' : '▾';
		toggle.setAttribute('aria-expanded', String(!isCollapsed));
	}

	function syncAll() {
		var items = document.querySelectorAll('.ref-item');
		for (var k = 0; k < items.length; k++) { syncItem(items[k]); }
		syncToggleAll();
	}

	var toggleAllButton = document.getElementById('toggle-all');
	function syncToggleAll() {
		if (!toggleAllButton) { return; }
		var items = document.querySelectorAll('.ref-item .toggle');
		var anyExpanded = false;
		for (var k = 0; k < items.length; k++) {
			if (items[k].getAttribute('aria-expanded') === 'true') { anyExpanded = true; break; }
		}
		toggleAllButton.textContent = anyExpanded ? '全部折叠' : '全部展开';
		toggleAllButton.disabled = items.length === 0;
	}

	var toggles = document.querySelectorAll('.toggle');
	for (var t = 0; t < toggles.length; t++) {
		toggles[t].addEventListener('click', function (event) {
			event.preventDefault();
			// 阻止冒泡，避免误触到外层可能的点击处理。
			event.stopPropagation();
			var li = this.closest('.ref-item');
			if (!li) { return; }
			var key = li.dataset.key;
			if (collapsed[key]) { delete collapsed[key]; } else { collapsed[key] = true; }
			api.setState({ collapsed: collapsed });
			syncItem(li);
			syncToggleAll();
		});
	}

	if (toggleAllButton) {
		toggleAllButton.addEventListener('click', function (event) {
			event.preventDefault();
			var items = document.querySelectorAll('.ref-item .toggle');
			var anyExpanded = false;
			for (var k = 0; k < items.length; k++) {
				if (items[k].getAttribute('aria-expanded') === 'true') { anyExpanded = true; break; }
			}
			// 只要还有展开的就全部折起，否则全部展开。
			var itemsAll = document.querySelectorAll('.ref-item');
			for (var m = 0; m < itemsAll.length; m++) {
				var key = itemsAll[m].dataset.key;
				if (!itemsAll[m].querySelector('.toggle')) { continue; }
				if (anyExpanded) { collapsed[key] = true; } else { delete collapsed[key]; }
			}
			api.setState({ collapsed: collapsed });
			syncAll();
		});
	}

	syncAll();
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
			'<div class="hint">单击蓝色文字跳到引用位置；点左侧小三角可折叠或展开子块。</div>',
			'<div class="toolbar"><button id="toggle-all" type="button">全部折叠</button></div>',
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

			// 折叠状态的键：报告 UUID + 序号。
			// 不用文件路径——路径是绝对值，会把这个机器上的目录结构写进 DOM；
			// 加上 UUID 是为了让不同块的反链面板之间不串折叠状态。
			const itemKey = `${report.uuid}|${index}`;
			const hasSubtree = item.subtree.length > 0;

			bodyParts.push(`<li class="ref-item" data-key="${escapeHtml(itemKey)}">`);
			if (item.blockPath.length > 0) {
				bodyParts.push(`<div class="crumb">${escapeHtml(stripEmphasis(item.blockPath))}</div>`);
			}

			/*
			 * 引用块标题缩进一级，体现它是面包屑最后那一级的子块。
			 * 三角放在标题**左侧**，与 Tine 一致；没有子块时用等宽占位保持对齐。
			 */
			bodyParts.push('<div class="title-line">');
			if (hasSubtree) {
				bodyParts.push(
					`<button class="toggle" type="button" aria-expanded="true" title="折叠 / 展开子块">▾</button>`,
				);
			} else {
				bodyParts.push('<span class="toggle-placeholder"></span>');
			}
			bodyParts.push(
				`<a class="ref" data-i="${index}" title="${escapeHtml(tooltip)}">${escapeHtml(stripEmphasis(text))}</a>`,
			);
			bodyParts.push('</div>');

			if (hasSubtree) {
				bodyParts.push('<div class="subtree">');
				// 子树按层级缩进展示，让用户不用打开笔记就知道这句话在说什么。
				for (const sub of item.subtree) {
					const depthClass = `d${Math.min(Math.max(sub.depth, 0), 8)}`;
					const bullet = sub.isListItem ? '<span class="bullet">•</span>' : '';
					bodyParts.push(
						`<div class="sub ${depthClass}">${bullet}${escapeHtml(stripEmphasis(sub.text))}</div>`,
					);
				}
				if (item.subtreeOmitted > 0) {
					bodyParts.push(`<div class="sub-more">… 还有 ${item.subtreeOmitted} 行未展开</div>`);
				}
				bodyParts.push('</div>');
			}

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
