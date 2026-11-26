/**
 * 行内渲染的装饰计划（纯函数）。
 *
 * 把「哪些引用要隐藏原文、哪些要显示标题、显示什么文字」从 vscode 层
 * 抽出来，既能让主文件保持在警戒线以内，也能用普通 Node 单测覆盖
 * `activeLine` 这类容易出错的模式判断。
 *
 * 不依赖 vscode：位置用普通数字表达，渲染层再转成 Range。
 */

/** 行内渲染模式。 */
export type InlineRenderMode = 'activeLine' | 'replace' | 'append';

/** 一处待渲染的引用（不含 vscode 类型）。 */
export interface InlineRenderItem {
	uuid: string;
	/** 0-based 行号。 */
	line: number;
	/** 引用表达式起始列。 */
	start: number;
	/** 引用表达式结束列（不含）。 */
	end: number;
	/** 要显示的标题；悬空引用时是「块不存在」或空字符串。 */
	text: string;
	/** 目标块是否不存在。 */
	missing: boolean;
}

/** 单个引用最终要加的装饰。 */
export interface InlineDecorationSlot {
	item: InlineRenderItem;
	/** 是否把原文压成 0 宽度。 */
	hide: boolean;
	/** 要显示的虚拟文本；undefined 表示不加任何装饰（显示真实原文）。 */
	contentText?: string;
}

/** 规范化模式值；无法识别时回退到 `activeLine`。 */
export function normalizeRenderMode(mode: string): InlineRenderMode {
	if (mode === 'replace' || mode === 'append' || mode === 'activeLine') {
		return mode;
	}
	return 'activeLine';
}

/**
 * 生成装饰计划。
 *
 * @param items 待渲染的引用
 * @param mode 渲染模式
 * @param activeLines 光标/选区覆盖到的行（只有 `activeLine` 模式会用到）
 */
export function planInlineDecorations(
	items: readonly InlineRenderItem[],
	mode: string,
	activeLines: ReadonlySet<number> = new Set<number>(),
): InlineDecorationSlot[] {
	const normalized = normalizeRenderMode(mode);
	const hidesSource = normalized === 'replace' || normalized === 'activeLine';

	const slots: InlineDecorationSlot[] = [];
	for (const item of items) {
		// activeLine：正在编辑的行完全保持原样——字符宽度、颜色、光标都不动。
		// 这是「能自由定位光标、选中、编辑引用」的唯一实现方式。
		if (normalized === 'activeLine' && activeLines.has(item.line)) {
			slots.push({ item, hide: false });
			continue;
		}

		slots.push({
			item,
			hide: hidesSource,
			contentText: hidesSource ? item.text : `〔${item.text}〕`,
		});
	}

	return slots;
}

/** 该模式是否需要监听光标移动（只有 activeLine 会随光标变化重绘）。 */
export function modeDependsOnSelection(mode: string): boolean {
	return normalizeRenderMode(mode) === 'activeLine';
}
