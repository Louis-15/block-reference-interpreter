/**
 * 属性隐藏策略：哪些 `key:: value` 行属于元数据、不该出现在块正文里。
 *
 * 单独成文件的原因：
 * - `core/render.ts` 已在 400 行警戒线附近，而属性清单本身就有 30 多项；
 * - 清单同时被 core 渲染层和 vscode 配置读取层使用，
 *   放在 render.ts 里会让适配层为了一个常量去 import 整个渲染模块。
 */

/**
 * 默认隐藏的属性键。
 *
 * 与 Tine 的 `BUILTIN_HIDDEN` 保持一致（`crates/tine-outline/src/property_visibility.rs`），
 * 它是 Logseq OG 的 `hidden-built-in-properties` 加上 SRS 扩展的六个键。
 *
 * 为什么必须对齐：这些键全是**元数据**，不是块的正文。若只隐藏 `id`/`collapsed`，
 * `heading::`、`todo::`、`created-at::`、`logseq.*` 都会被当成正文喂给 AI，
 * 让模型误以为块里真的写着这些字符串。
 *
 * **改动这里必须同步 `package.json` 的 `tineBlockRef.hideProperties` 默认值。**
 * 两处不一致时，「用户没配置」和「显式配置成旧默认值」会得到不同结果。
 */
export const DEFAULT_HIDDEN_PROPERTIES: readonly string[] = [
	'id',
	'custom-id',
	'background-color',
	'heading',
	'collapsed',
	'created-at',
	'updated-at',
	'last-modified-at',
	'query-table',
	'query-properties',
	'query-sort-by',
	'query-sort-desc',
	'ls-type',
	'hl-type',
	'hl-page',
	'hl-stamp',
	'hl-color',
	'logseq.macro-name',
	'logseq.macro-arguments',
	'logseq.order-list-type',
	'logseq.tldraw.page',
	'logseq.tldraw.shape',
	'todo',
	'doing',
	'now',
	'later',
	'done',
	'card-last-interval',
	'card-repeats',
	'card-last-reviewed',
	'card-next-schedule',
	'card-ease-factor',
	'card-last-score',
];

/**
 * 属性键归一化。
 *
 * 与 Tine 的 `normalize` 一致：小写化，并把空格和下划线都换成 `-`。
 * 少了这一步，`created_at::`、`Created At::` 会被当成用户自定义属性而漏隐藏。
 * Logseq 历史上确实存在下划线拼写的键，所以不能只做 `toLowerCase()`。
 */
export function normalizePropertyKey(key: string): string {
	return key.trim().toLowerCase().replace(/[\s_]/g, '-');
}

/**
 * 把键列表变成可直接 `has()` 查表的集合。
 *
 * 归一化在构建集合时统一做一次，行级判断就只剩一次哈希查找，
 * 不必每行都跑一遍正则替换。
 */
export function buildHiddenPropertySet(keys: readonly string[]): ReadonlySet<string> {
	return new Set(keys.map(normalizePropertyKey));
}
