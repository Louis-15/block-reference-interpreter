/**
 * 极简 glob 匹配（只支持 `**`、`*`、`?` 与字面量）。
 *
 * 为什么自己写而不用第三方 glob 库：
 * 这里只用于「某个文件是否在索引范围内」这种粗判定，精确文件列举交给
 * `vscode.workspace.findFiles`。为了一个 20 行的函数引入依赖不划算。
 *
 * 放在 core 层而不是 indexService 里，是为了能脱离 vscode 单独测试——
 * 这个函数判错的后果很隐蔽：文件不进索引，表现为「引用总是找不到」。
 */

/**
 * 把 glob 模式转成正则源码。
 *
 * 关键处理：
 * - `**\/` → `(?:.*\/)?`，允许零层或多层目录（`pages/**\/*.md` 要能匹配 `pages/a.md`）
 * - `**`  → `.*`，跨目录匹配
 * - `*`   → `[^/]*`，不跨目录
 * - `?`   → `[^/]`，单个非分隔符字符
 * - 其余字符按字面量转义
 */
function globToRegExpSource(pattern: string): string {
	let source = '';

	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];

		if (char === '*') {
			if (pattern[index + 1] === '*') {
				if (pattern[index + 2] === '/') {
					// `**/`：零层或多层目录
					source += '(?:.*/)?';
					index += 2;
				} else {
					// `**`：任意字符（含分隔符）
					source += '.*';
					index += 1;
				}
			} else {
				// 单个 `*`：不跨目录
				source += '[^/]*';
			}
			continue;
		}

		if (char === '?') {
			source += '[^/]';
			continue;
		}

		source += char !== undefined ? char.replace(/[.+^${}()|[\]\\]/g, '\\$&') : '';
	}

	return source;
}

/**
 * 判断路径是否匹配 glob 模式。
 *
 * @param target 待判断路径（建议传入相对图谱根的路径，使用 `/` 分隔）
 * @param pattern glob 模式（`/` 或 `\` 分隔都可以）
 * @returns 匹配返回 true；模式非法时返回 false（宁可漏索引，也不要误索引）
 */
export function matchSimpleGlob(target: string, pattern: string): boolean {
	// 统一分隔符：Windows 上传入的路径可能带反斜杠。
	const normalizedTarget = target.replace(/\\/g, '/');
	const normalizedPattern = pattern.replace(/\\/g, '/');

	try {
		return new RegExp(`^${globToRegExpSource(normalizedPattern)}$`, 'i').test(normalizedTarget);
	} catch {
		return false;
	}
}
