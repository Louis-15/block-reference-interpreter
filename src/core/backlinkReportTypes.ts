/**
 * 反向链接报告的共享类型。
 *
 * 拆出来是为了让「构建报告」「渲染文本」「渲染面板」三个模块都能引用，
 * 又不会形成运行时循环依赖。
 */

/**
 * 引用所在块的子树中的一行。
 *
 * 为什么要展开子树：Tine / Logseq 的反链面板不只显示「哪一行引用了它」，
 * 还会把那个块的完整内容（含子块）摆出来。只给一行标题的话，
 * 用户还得自己打开笔记才知道这句话到底在说什么。
 */
export interface BacklinkSubtreeLine {
	/**
	 * 相对引用块标题的缩进层级。
	 *
	 * 0 = 引用块自身的续行（与标题同层），1 = 直接子块，2 = 孙块……
	 */
	depth: number;
	/** 行文本（已去掉 `- ` 标记与前导空白）。 */
	text: string;
	/** 是否为列表项；false 表示块的续行正文。 */
	isListItem: boolean;
}

/** 一条引用（按「引用所在块」合并后的结果）。 */
export interface BacklinkItem {
	/** 引用所在文件（绝对路径）。 */
	path: string;
	/** 引用所在块在文件 blocks 数组里的下标；-1 表示定位失败。 */
	blockIndex: number;
	/** 被引用文本出现的行号（0-based），取该块内第一次出现的行。 */
	line: number;
	/** 该块内出现的全部引用形态。 */
	kinds: Array<'inline' | 'embed'>;
	/** 该块内引用出现的次数。 */
	count: number;
	/** 引用所在块的标题（块首行正文）。 */
	blockTitle: string;
	/** 引用所在行的原文，用于面包屑为空时兜底展示。 */
	lineText: string;
	/** 引用所在块的祖先路径（不含自身）；没有祖先时为空字符串。 */
	blockPath: string;
	/** 引用所在块的子树（标题之后的行），用于在面板里完整展示上下文。 */
	subtree: BacklinkSubtreeLine[];
	/** 因超过行数上限而未展开的行数。 */
	subtreeOmitted: number;
}

/** 同一个文件内的全部引用。 */
export interface BacklinkGroup {
	/** 文件绝对路径。 */
	path: string;
	/** 该文件内的引用条目。 */
	items: BacklinkItem[];
	/** 条目数（供 CodeLens 与排序使用）。 */
	count: number;
}

/** 目标块的定义位置。 */
export interface BacklinkDefinition {
	/** 文件绝对路径。 */
	path: string;
	/** 块首行行号（0-based）。 */
	line: number;
	/** 块首行正文。 */
	title: string;
}

/** 完整的反链报告。 */
export interface BacklinkReport {
	/** 规范化的 UUID（小写）。 */
	uuid: string;
	/** 定义位置。空数组表示块不存在（悬空引用）。 */
	definitions: BacklinkDefinition[];
	/** 按页面分组的引用。 */
	groups: BacklinkGroup[];
	/** 引用条目总数（已按块合并）。 */
	itemCount: number;
	/** 原始命中次数（同一块里出现两次就算两次）。 */
	hitCount: number;
	/** 涉及的页面数。 */
	fileCount: number;
}

/** 生成报告时的选项。 */
export interface BacklinkReportOptions {
	/** 是否去掉标题里的 `#` 标记，默认 true（给人看的场景）。 */
	stripHeading?: boolean;
	/** 路径最多保留几级祖先，默认 3——太长的面包屑在窄面板里会被折断。 */
	maxPathDepth?: number;
	/**
	 * 是否展开引用所在块的子树，默认 true。
	 *
	 * 只为拿计数的地方（编辑器内徽章）应传 false：那边只关心数字，
	 * 展开子树是白费力气。
	 */
	includeSubtree?: boolean;
	/** 渲染时隐藏的属性名（`id`、`collapsed` 等）。不传用默认值。 */
	hideProperties?: string[];
	/**
	 * 每个引用块最多展开多少行子树，0 表示不限制（默认）。
	 *
	 * 真实库里 90% 以上的被引用块子树在 20 行内，但不乏 485 行的巨型块。
	 * 需要时可以设个上限避免面板过长。
	 */
	maxSubtreeLines?: number;
}

/** 渲染报告时的选项。 */
export interface RenderBacklinkReportOptions {
	/** 图谱根目录，用于把绝对路径转成 `pages/xxx.md`。不传则显示原路径。 */
	graphRoot?: string;
	/** 每组最多显示几条，默认不限制。 */
	maxItemsPerGroup?: number;
	/**
	 * 全部组加起来的条目上限，默认不限制。
	 *
	 * 这是给 AI 工具用的硬预算：只限制「每组条数」挡不住「被 100 个页面各引用 1 次」
	 * 这种分散情况，输出照样会爆掉模型上下文。
	 */
	maxTotalItems?: number;
	/** 是否输出「定义位置」与统计头，默认 true。 */
	includeHeader?: boolean;
	/** 面板用途标记（影响文案），默认 `panel`。 */
	purpose?: 'panel' | 'tool';
}

/** 面板里一条可点击链接的位置与目标。 */
export interface BacklinkPanelLink {
	/** 链接所在行（0-based）。 */
	line: number;
	/** 链接起始列（0-based，含）。 */
	startColumn: number;
	/** 链接结束列（0-based，不含）。 */
	endColumn: number;
	/** 跳转目标文件绝对路径。 */
	path: string;
	/** 跳转目标行（0-based）。 */
	targetLine: number;
	/** 悬停说明，补回被省略的行号与引用类型。 */
	tooltip: string;
}

/** 面板内容与其上的链接位置。 */
export interface BacklinkPanelContent {
	/** 完整文本。 */
	text: string;
	/** 需要变成可点击链接的片段。 */
	links: BacklinkPanelLink[];
}
