/**
 * 生成 HTML 时的文本处理工具。
 *
 * 单独一层的理由：反链面板与展开全文两个网页都要用，
 * 各写一份迟早会出现「一处转义了、一处没转义」的 XSS 缺口。
 */

/**
 * HTML 转义。
 *
 * 笔记标题里常见 `<`、`&`、引号（例如「动机揭示：信念由"人"承载」），
 * 不转义会破坏 DOM 结构，甚至被当成标签执行。
 */
export function escapeHtml(text: string): string {
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
export function safeJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026');
}

/**
 * 去掉 Markdown 强调标记（`**粗体**`、`__粗体__`）。
 *
 * 真实笔记库里大量标题用 `**...**` 标重点。网页是渲染结果，
 * 照搬星号会变成噪声——Tine 那边是渲染成粗体的。
 *
 * 只去掉标记、不加粗：调用方多为次要信息（灰色小字），
 * 再叠一层粗体反而抢注意力。
 */
export function stripEmphasis(text: string): string {
	return text.replace(/\*\*|__/g, '');
}
