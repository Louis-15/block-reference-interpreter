/**
 * 「展开全文」网页的 HTML 渲染。
 *
 * 与响应纯文本的两个关键差异：
 * 1. **来源可点击**：每个块上方标出它来自哪篇笔记、第几行，
 *    点一下直接打开那篇笔记并跳到块的首行；
 * 2. **保留缩进**：块子树用等宽字体原样呈现，不丢层级。
 *
 * 这一层是纯字符串逻辑，不依赖 `vscode`，可在 Node 里直接单测。
 */

import type { ExpandBlock, ExpandView } from './expandView';
import { escapeHtml, safeJson } from './htmlText';
import { locale, t } from './i18n';

/** 渲染选项。 */
export interface ExpandHtmlOptions {
	/** Webview 的 CSP nonce。 */
	nonce: string;
}

/** 一条跳转目标，交给前端脚本按索引查找。 */
export interface ExpandHtmlTarget {
	/** 目标文件绝对路径。 */
	path: string;
	/** 目标行（0-based）。 */
	line: number;
}

/** HTML 与其内嵌的跳转目标表。 */
export interface ExpandHtmlResult {
	/** 完整 HTML 文档。 */
	html: string;
	/** 按索引对应的跳转目标。 */
	targets: ExpandHtmlTarget[];
}

const STYLES = `
* { box-sizing: border-box; }
body {
	margin: 0;
	padding: 16px 22px 60px;
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-editor-foreground);
	background: var(--vscode-editor-background);
	line-height: 1.6;
}
.head { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; margin-bottom: 18px; }
.head h1 { font-size: 1.12em; margin: 0 0 6px; font-weight: 600; }
.head .uuid { font-family: var(--vscode-editor-font-family); opacity: .65; font-weight: 400; }
.head .sub { font-size: .92em; color: var(--vscode-descriptionForeground); }
.head .summary { font-size: .88em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.hint { margin-top: 8px; font-size: .85em; color: var(--vscode-descriptionForeground); }

/* 原文行 */
.src { display: flex; gap: 10px; padding: 1px 4px; border-radius: 2px; }
.src .ln {
	flex: 0 0 auto;
	width: 44px;
	text-align: right;
	color: var(--vscode-editorLineNumber-foreground, rgba(128,128,128,.7));
	font-family: var(--vscode-editor-font-family);
	font-size: .82em;
	user-select: none;
}
.src .tx {
	flex: 1 1 auto;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: var(--vscode-editor-font-family);
}
.src.marked { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.13)); }

/* 展开块 */
.block {
	margin: 6px 0 14px;
	border-left: 2px solid var(--vscode-textLink-foreground, #3794ff);
	padding: 6px 0 6px 12px;
}
.block .meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.block .btitle { font-weight: 600; }
.block .size { font-size: .82em; color: var(--vscode-descriptionForeground); }
a.src-link {
	color: var(--vscode-textLink-foreground, #3794ff);
	text-decoration: none;
	cursor: pointer;
	font-size: .86em;
	font-family: var(--vscode-editor-font-family);
}
a.src-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, #3794ff); }
/* 来源前缀用文字标签，不用依赖系统字体的符号图标（部分环境会渲染成方框） */
.lbl {
	flex: 0 0 auto;
	font-size: .8em;
	color: var(--vscode-descriptionForeground);
	margin-right: -4px;
}
.block pre {
	margin: 6px 0 0;
	padding: 8px 10px;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: var(--vscode-editor-font-family);
	font-size: .92em;
	background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.1));
	border-radius: 3px;
}
/*
 * 内容区画成灰点列表，与笔记软件（Tine / Logseq）和本插件的反链面板一致。
 * 不显示 Markdown 的减号标记：那只是源码记号，不是阅读时该看到的东西。
 */
.content {
	margin: 6px 0 0;
	padding: 8px 10px;
	background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.06));
	border-radius: 3px;
	font-size: .93em;
	line-height: 1.55;
}
.cline { display: flex; gap: 7px; align-items: baseline; }
.cline .dot {
	flex: 0 0 auto;
	opacity: .45;
	user-select: none;
	/* 圆点宽度固定，续行文字才能对齐到同一列 */
	width: 8px;
	text-align: center;
}
.cline .cdot { flex: 0 0 auto; width: 8px; }
.cline .ctx { flex: 1 1 auto; white-space: pre-wrap; word-break: break-word; }
/* 层级缩进：用固定 class 而不是内联 style，CSP 的 style-src 会拦内联样式 */
.cline.lv1 { padding-left: 18px; }
.cline.lv2 { padding-left: 36px; }
.cline.lv3 { padding-left: 54px; }
.cline.lv4 { padding-left: 72px; }
.cline.lv5 { padding-left: 90px; }
.cline.lv6 { padding-left: 108px; }
.cline.lv7 { padding-left: 126px; }
.cline.lv8 { padding-left: 138px; }
.warn {
	margin: 6px 0 0;
	padding: 5px 9px;
	border-left: 3px solid var(--vscode-editorWarning-foreground);
	background: var(--vscode-inputValidation-warningBackground, rgba(255,180,0,.1));
	font-size: .85em;
}
/* 嵌套展开：每层往右缩进一点，但不超过 4 层 */
.block.d1 { margin-left: 16px; border-left-color: var(--vscode-descriptionForeground); }
.block.d2 { margin-left: 32px; border-left-color: var(--vscode-descriptionForeground); }
.block.d3 { margin-left: 48px; border-left-color: var(--vscode-descriptionForeground); }
.block.d4 { margin-left: 64px; border-left-color: var(--vscode-descriptionForeground); }
.empty { color: var(--vscode-descriptionForeground); }
`;

/** 前端脚本：把点击转成 postMessage，交给扩展执行真正的跳转。 */
const SCRIPT = `
(function () {
	var api = acquireVsCodeApi();
	var targets = JSON.parse(document.getElementById('targets').textContent);
	var links = document.querySelectorAll('a.src-link');
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

/** 渲染一个展开块。 */
function renderBlock(
	block: ExpandBlock,
	targets: ExpandHtmlTarget[],
): string {
	const parts: string[] = [];
	const depthClass = block.depth > 0 ? ` d${Math.min(block.depth, 4)}` : '';
	parts.push(`<div class="block${depthClass}">`);

	parts.push('<div class="meta">');
	parts.push(`<span class="btitle">${escapeHtml(block.title)}</span>`);

	if (block.source) {
		const index = targets.length;
		targets.push({ path: block.source.path, line: block.source.line });
		const label = block.lineRange
			? `${block.source.displayPath} ${block.lineRange}`
			: block.source.displayPath;
		parts.push(`<span class="lbl">${escapeHtml(t('Source'))}</span>`);
		parts.push(
			`<a class="src-link" data-i="${index}" title="${escapeHtml(
				t('Open this note and jump to line {0}', block.source.line + 1),
			)}">${escapeHtml(label)}</a>`,
		);
	}

	if (block.size) {
		parts.push(`<span class="size">${escapeHtml(block.size)}</span>`);
	}
	parts.push('</div>');

	if (block.lines.length > 0) {
		parts.push('<div class="content">');
		for (const line of block.lines) {
			const level = Math.min(Math.max(line.depth, 0), 8);
			const levelClass = level > 0 ? ` lv${level}` : '';
			/*
			 * 列表项画灰点；续行与空块留等宽空位。
			 * 空块（原文里是单个 `-`）不画点：一个孤零零的圆点看起来像渲染出错，
			 * 而它实际只是作者留的空行。
			 */
			const marker =
				line.isListItem && line.text.length > 0
					? '<span class="dot">•</span>'
					: '<span class="cdot"></span>';
			parts.push(
				`<div class="cline${levelClass}">${marker}<span class="ctx">${escapeHtml(line.text)}</span></div>`,
			);
		}
		parts.push('</div>');
	}
	/*
	 * 不再对「没有子块」输出「（该块没有内容）」。
	 * 单行块的全部内容就是上面那行标题，此时再提示「没有内容」是错的，
	 * 会让人以为块真的空了。真的空块标题会显示为「（空块）」。
	 */

	for (const warning of block.warnings) {
		parts.push(`<div class="warn">${escapeHtml(warning)}</div>`);
	}

	parts.push('</div>');
	return parts.join('\n');
}

/** 渲染一行原文。 */
function renderSourceLine(
	line: number,
	text: string,
	hasExpansion: boolean,
): string {
	const marked = hasExpansion ? ' marked' : '';
	// 空行也要保留高度，否则原文的行号会跳号，看着像丢内容。
	const body = text.length > 0 ? escapeHtml(text) : '&nbsp;';
	return (
		`<div class="src${marked}">` +
		`<span class="ln">${line + 1}</span>` +
		`<span class="tx">${body}</span>` +
		`</div>`
	);
}

/**
 * 渲染展开视图为完整 HTML 文档。
 */
export function renderExpandHtml(
	view: ExpandView,
	options: ExpandHtmlOptions,
): ExpandHtmlResult {
	const targets: ExpandHtmlTarget[] = [];
	const body: string[] = [];

	body.push('<header class="head">');
	body.push(`<h1>${escapeHtml(view.title)}</h1>`);
	if (view.subtitle) {
		body.push(`<div class="sub">${escapeHtml(view.subtitle)}</div>`);
	}
	if (view.summary) {
		body.push(`<div class="summary">${escapeHtml(view.summary)}</div>`);
	}
	body.push(`<div class="hint">${escapeHtml(t('Click the Source link above a block to open that note at the block.'))}</div>`);
	body.push('</header>');

	if (view.flow.length === 0) {
		body.push(`<p class="empty">${escapeHtml(t('Nothing to display.'))}</p>`);
	}

	let hasBlock = false;
	for (const item of view.flow) {
		if (item.type === 'source') {
			body.push(renderSourceLine(item.line, item.text, item.hasExpansion));
		} else {
			hasBlock = true;
			body.push(renderBlock(item.block, targets));
		}
	}

	if (!hasBlock && view.flow.length > 0) {
		body.push(`<p class="empty">${escapeHtml(t('This note has no block references, nothing to expand.'))}</p>`);
	}

	const html = `<!DOCTYPE html>
<html lang="${escapeHtml(locale())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${options.nonce}'; script-src 'nonce-${options.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(view.title)}</title>
<style nonce="${options.nonce}">${STYLES}</style>
</head>
<body>
${body.join('\n')}
<script type="application/json" id="targets">${safeJson(targets)}</script>
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;

	return { html, targets };
}
