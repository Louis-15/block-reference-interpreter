/**
 * 反向链接报告用到的路径工具。
 *
 * 单独成文件，避免「构建报告」与「渲染文本」互相 import 形成循环。
 */

/** 把绝对路径转成相对图谱根的显示路径。 */
export function toDisplayPath(filePath: string, graphRoot?: string): string {
	if (!graphRoot) {
		return filePath.replace(/\\/g, '/');
	}
	const normalizedRoot = graphRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	const normalizedPath = filePath.replace(/\\/g, '/');
	if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/')) {
		return normalizedPath.slice(normalizedRoot.length + 1);
	}
	return normalizedPath;
}

/** 取文件名（不含目录与扩展名），用作「页面名」。 */
export function toPageName(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	const base = normalized.slice(normalized.lastIndexOf('/') + 1);
	return base.replace(/\.md$/i, '');
}
