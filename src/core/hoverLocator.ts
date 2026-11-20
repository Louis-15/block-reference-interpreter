/**
 * 悬停定位：判断「鼠标所在列」对应的是哪一处块引用。
 *
 * 为什么单独成层：行内渲染会把原文 `((uuid))` 的字符宽度压成 0，
 * 视觉上显示的是叠加的替换文本。VS Code 把鼠标位置换算成字符偏移时，
 * 会落到引用范围**之后**，导致严格区间判定全部失配、hover 完全失效。
 *
 * 这段逻辑直接决定 hover 能不能用，所以抽成纯函数便于覆盖测试。
 */

import type { LocatedReference } from './refLocator';

/** 行内渲染的实际布局参数。 */
export interface HoverLayout {
	/** 行内渲染是否开启。 */
	enabled: boolean;
	/** 是否为 replace 模式（隐藏原文，只显示替换文本）。 */
	replaceMode: boolean;
}

/** 命中的目标引用。 */
export interface HoverTarget {
	/** 命中的引用。 */
	reference: LocatedReference;
	/** 考虑替换文本之后的视觉右边界（用于高亮范围）。 */
	visualEnd: number;
}

/**
 * 计算某处引用在编辑器里的视觉右边界。
 *
 * **必须取 `max(原文宽度, 替换文本宽度)`，不能只按替换文本算。**
 *
 * 原因（这是 0.1.10 踩过的坑）：
 * `replace` 模式把原文宽度压成 0，但字符仍然存在。VS Code 把鼠标位置换算成
 * 字符偏移时，落在被隐藏的原文区域会得到**接近 `reference.end` 的位置**，
 * 而不是 `start`~`end-1` 之间的某点。
 * 若只按标题宽度算视觉边界（如 5 字符），`character = start + 40` 就会同时
 * 超出原文区间与视觉区间，导致**所有引用的 hover 全部失效**。
 *
 * 所以视觉边界至少覆盖到原文末尾：宁可鼠标在引用右边缘也弹提示，
 * 也不能让整个功能静默失灵。
 */
function computeVisualEnd(reference: LocatedReference, title: string, layout: HoverLayout): number {
	if (!layout.enabled || title.length === 0) {
		return reference.end;
	}
	if (layout.replaceMode) {
		return Math.max(reference.end, reference.start + title.length);
	}
	return reference.end + title.length + 2;
}

/**
 * 在一行内找出用户「想悬停」的那处引用。
 *
 * @param references 该行内全部引用的位置（应已按出现顺序排列）
 * @param character 鼠标所在列（0-based）
 * @param titleOf 取该处引用渲染后显示的标题；返回 undefined 表示该引用应被忽略
 *                （例如它其实在代码块内，不该响应 hover）
 * @param layout 行内渲染布局参数
 */
export function findHoverTarget(
	references: readonly LocatedReference[],
	character: number,
	titleOf: (reference: LocatedReference) => string | undefined,
	layout: HoverLayout,
): HoverTarget | undefined {
	let best: HoverTarget | undefined;

	for (const reference of references) {
		const title = titleOf(reference);
		if (title === undefined) {
			continue;
		}

		const visualEnd = computeVisualEnd(reference, title, layout);

		// 原文范围用开区间：渲染关闭时「紧贴 )) 之后」不该算在引用上。
		const insideSource = character >= reference.start && character < reference.end;

		/**
		 * 视觉范围用闭区间，且只在行内渲染开启时生效。
		 *
		 * 这是修复「hover 全部失效」的关键：
		 * `replace` 模式把原文宽度压成 0，鼠标落在这段隐藏字符上时，
		 * VS Code 换算出的位置可能是 `reference.end` 本身
		 * （不在 `[start, end)` 里），只靠 insideSource 会漏掉。
		 * 而 `computeVisualEnd` 保证 visualEnd >= reference.end，
		 * 于是这里能把这种情况接住。
		 */
		const insideVisual = layout.enabled && character >= reference.start && character <= visualEnd;

		if (!insideSource && !insideVisual) {
			continue;
		}

		// 视觉范围可能重叠（两个引用靠得很近时）。取起点最靠右的那个：
		// 用户很可能在看离鼠标最近的一处。
		if (!best || reference.start > best.reference.start) {
			best = { reference, visualEnd };
		}
	}

	return best;
}
