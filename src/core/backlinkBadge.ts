/**
 * 反链徽章的显示文案。
 *
 * 放在 core 层而不是 vscode 层的原因：这是纯字符串逻辑，
 * 混在依赖 `vscode` 的模块里就没法单测了。
 */

/** 一个被引用块的锚点信息。 */
export interface BacklinkAnchor {
	/** 块 UUID（小写）。 */
	uuid: string;
	/** 块首行行号（0-based）。 */
	line: number;
	/** 引用条目数（按引用块合并后）。 */
	count: number;
	/** 原始命中次数，大于 count 说明同一块里重复引用。 */
	hitCount: number;
	/** 该 UUID 是否在多个位置重复定义。 */
	duplicate: boolean;
}

/**
 * 生成行尾徽章的文字。
 *
 * 用 `🔗 2` 这种紧凑写法是刻意的：徽章贴在行尾，写全「2 条链接引用」
 * 会把长行的可读性拖垮。完整含义放在 tooltip 里。
 */
export function formatAnchorLabel(anchor: BacklinkAnchor): string {
	const parts = [`🔗 ${anchor.count}`];
	if (anchor.hitCount > anchor.count) {
		parts.push(`（共 ${anchor.hitCount} 次）`);
	}
	if (anchor.duplicate) {
		parts.push('⚠');
	}
	return parts.join(' ');
}

/** 生成悬停说明。 */
export function formatAnchorTooltip(anchor: BacklinkAnchor): string {
	const lines = [`${anchor.count} 个引用块提到了这个块`, `UUID：${anchor.uuid}`];

	if (anchor.hitCount > anchor.count) {
		lines.push(`同一块内重复引用，共出现 ${anchor.hitCount} 次`);
	}
	if (anchor.duplicate) {
		lines.push('⚠ 该 UUID 在多个位置重复定义，引用可能指向其中任意一个');
	}

	lines.push('点击查看完整反链面板');
	return lines.join('\n');
}
