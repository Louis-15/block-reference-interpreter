/**
 * 引用文本清洗。
 *
 * 真实笔记库里的「纯引用块」非常常见：一个块的全部内容就是一个 `((uuid))`，
 * 真正的文字在它的子块里。这类块如果被当作祖先放进面包屑，
 * 用户会看到 `3 符号的衍变 › ((68edae0a-12ba-41df-a4bc-569bbb8f1a2f))` 这种噪声。
 *
 * 本模块负责把引用外壳剥掉，让调用方判断「剥完之后还剩不剩东西」。
 */

/**
 * 去掉 `((uuid))` 与 `{{embed ((uuid))}}`，返回剩余文字（已 trim）。
 *
 * 正则说明：
 * - 内层用 `[^\s()]{20,}` 而不是严格的 36 位 UUID —— 笔记库里存在被手工改坏的 ID
 *   （例如 `65cc96fb-1.a7-...` 含点号），严格匹配会让这些残骸漏回面包屑里。
 *   要求至少 20 个非空白非括号字符，普通中文文本不可能命中，不会误伤。
 * - 必须先剥 embed 外壳再剥内层，否则会留下 `{{embed }}` 残骸。
 */
export function stripReferenceMarks(text: string): string {
	return text
		.replace(/\{\{\s*embed\s*\(\(\s*[^\s()]{20,}\s*\)\)\s*\}\}/gi, '')
		.replace(/\(\(\s*[^\s()]{20,}\s*\)\)/g, '')
		.trim();
}

/**
 * 把整行（可能带 `- ` 列表标记）清洗成适合展示的一行文字。
 *
 * 用于反链面板：引用行往往是 `- 2、 ((uuid))` 或 `- ((uuid))`，
 * 清洗后分别得到 `2、` 与空字符串，调用方据此决定是否回退到块标题。
 */
export function cleanReferenceLine(lineText: string): string {
	return stripReferenceMarks(lineText.replace(/^[ \t]*-[ \t]*/, '').trim());
}
