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
 * 三种情况的宽度完全不同，必须分开算：
 * - 渲染关闭，或该引用没有替换文本（如悬空且未开启提示）：视觉宽度 = 原文宽度
 * - replace：原文不可见，视觉宽度 = 替换文本长度
 * - append：原文可见 + 追加 `〔标题〕`（两侧括号占 2 字符）
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

		// 落在原文范围内：开区间，与 refLocator 的语义保持一致。
		const insideSource = character >= reference.start && character < reference.end;

		// 落在替换文本的视觉范围内：闭区间，且只在行内渲染开启时才可能发生。
		// 关闭渲染时不能做这个判定，否则「紧贴引用之后」的普通文字也会触发 hover。
		const insideVisual =
			layout.enabled && character >= reference.start && character <= visualEnd;

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
