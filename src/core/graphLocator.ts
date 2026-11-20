/**
 * Tine / Logseq 图谱根目录探测。
 *
 * 为什么需要探测：块引用是跨文件的，索引必须锚定在「整个图谱」而不是「当前文件所在目录」。
 * 用户可能在任意子目录打开 VS Code，插件要能自己找到图谱根。
 *
 * 判定依据（满足任一即认定）：
 * 1. 同时存在 `pages/` 和 `logseq/`         —— Logseq/Tine 的标准布局
 * 2. 存在 `logseq/config.edn`               —— 明确的 Logseq 图谱标记
 * 3. 存在 `.tine-trash/`                    —— Tine 特有目录
 *
 * 文件系统访问通过接口注入，便于用假的探针做单测。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 文件系统探针：把探测所需的最小能力抽象出来，避免在单测里真的建目录。 */
export interface PathProbe {
	/** 判断路径是否为已存在的目录。 */
	isDirectory(target: string): boolean;
	/** 判断路径是否存在（文件或目录）。 */
	exists(target: string): boolean;
	/** 取父目录。 */
	dirname(target: string): string;
	/** 拼接路径。 */
	join(base: string, ...parts: string[]): string;
}

/** 基于真实文件系统的探针。 */
export const nodePathProbe: PathProbe = {
	isDirectory(target: string): boolean {
		try {
			return fs.statSync(target).isDirectory();
		} catch {
			return false;
		}
	},
	exists(target: string): boolean {
		try {
			fs.statSync(target);
			return true;
		} catch {
			return false;
		}
	},
	dirname(target: string): string {
		return path.dirname(target);
	},
	join(base: string, ...parts: string[]): string {
		return path.join(base, ...parts);
	},
};

/** 单层判定：该目录本身是否是图谱根。 */
export function isGraphRoot(directory: string, probe: PathProbe = nodePathProbe): boolean {
	const hasPages = probe.isDirectory(probe.join(directory, 'pages'));
	const hasLogseq = probe.isDirectory(probe.join(directory, 'logseq'));

	if (hasPages && hasLogseq) {
		return true;
	}

	if (probe.exists(probe.join(directory, 'logseq', 'config.edn'))) {
		return true;
	}

	if (probe.isDirectory(probe.join(directory, '.tine-trash'))) {
		return true;
	}

	return false;
}

/**
 * 从某个起点（文件或目录）向上查找图谱根。
 *
 * @param startPath 起点，可以是文件路径，也可以是目录路径
 * @param probe 文件系统探针
 * @param maxDepth 最多向上多少层，默认 10，避免极端路径下无限循环
 * @returns 图谱根绝对路径；找不到返回 null
 */
export function detectGraphRoot(
	startPath: string,
	probe: PathProbe = nodePathProbe,
	maxDepth = 10,
): string | null {
	let current = startPath;

	// 起点如果是文件，先退到它所在目录。
	if (!probe.isDirectory(current)) {
		current = probe.dirname(current);
	}

	for (let depth = 0; depth < maxDepth; depth++) {
		if (isGraphRoot(current, probe)) {
			return current;
		}
		const parent = probe.dirname(current);
		// 到达盘符根（parent === current）就停。
		if (parent === current) {
			return null;
		}
		current = parent;
	}

	return null;
}

/** 判断某个文件是否位于图谱的 `pages/` 或 `journals/` 下。 */
export function isGraphContentFile(filePath: string, graphRoot: string): boolean {
	const relative = path.relative(graphRoot, filePath).replace(/\\/g, '/');
	if (relative.startsWith('..')) {
		return false;
	}
	return relative.startsWith('pages/') || relative.startsWith('journals/');
}
