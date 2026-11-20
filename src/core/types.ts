/**
 * 核心层共享类型定义。
 *
 * 这一层刻意不依赖 `vscode` 模块，目的是能在普通 Node 环境里直接单测，
 * 也便于将来复用到别的宿主（CLI、LSP 等）。
 */

/** 列表行解析结果。 */
export interface BlockLineInfo {
	/** 列表标记前的空白（可能是空格与制表符混合）。 */
	leadingWhitespace: string;
	/** `- ` 之后的正文（可能是空字符串，表示空块）。 */
	content: string;
}

/** 一次块引用命中。 */
export interface ReferenceHit {
	/** 规范化后（小写）的块 UUID。 */
	uuid: string;
	/** 0-based 行号。 */
	line: number;
	/** 0-based 列号（字符下标，非字节），指向整个表达式的起点。 */
	column: number;
	/**
	 * 表达式结束列（0-based，不含）。
	 *
	 * embed 引用会覆盖完整的 `{{embed ((uuid))}}`，
	 * 普通行内引用只覆盖 `((uuid))`。
	 * 渲染与悬停都用这个范围，保证 embed 外壳不会残留。
	 */
	endColumn: number;
	/**
	 * 引用形态：
	 * - `inline`：形如 `((uuid))`
	 * - `embed`：形如 `{{embed ((uuid))}}`
	 */
	kind: 'inline' | 'embed';
}

/** 解析后的单个块。 */
export interface BlockNode {
	/** 块首行（`- ` 那一行）的行号，0-based。 */
	startLine: number;
	/** 块最后一行（含所有子块）的行号，0-based。 */
	endLine: number;
	/** 块首行的缩进列数（制表符按 tabStop 展开后计算）。 */
	indent: number;
	/** 块自身的原文行（含首行，含 `id::` 等属性行），不含子块。 */
	ownLines: string[];
	/** 块 ID（已转小写），没有 `id::` 时为 undefined。 */
	id?: string;
	/** 父块在 blocks 数组中的下标；根块为 -1。 */
	parent: number;
	/** 子块在 blocks 数组中的下标。 */
	children: number[];
}

/** 一个 Markdown 文件的完整解析结果。 */
export interface ParsedFile {
	/** 文件标识（调用方决定是绝对路径还是相对路径）。 */
	path: string;
	/** 原始行（按 `\n` 切分，已剥离行尾 `\r`）。 */
	lines: string[];
	/** 扁平块列表，父子关系用下标表达。 */
	blocks: BlockNode[];
	/** 块首行行号 → blocks 下标。 */
	blockAtStartLine: Map<number, number>;
	/** uuid（小写）→ blocks 下标；数组用于承载重复 ID。 */
	blocksById: Map<string, number[]>;
	/** 全文引用命中（已跳过 frontmatter、围栏、行内代码）。 */
	references: ReferenceHit[];
	/** 文件开头的页面属性行（如 `title:: xxx`），用于展示来源时补充信息。 */
	pageProperties: string[];
}

/** 一个 uuid 对应的块位置。 */
export interface BlockLocation {
	/** 文件标识。 */
	path: string;
	/** 块在文件 blocks 数组中的下标。 */
	blockIndex: number;
}

/** 索引统计信息。 */
export interface IndexStats {
	/** 参与索引的文件数。 */
	fileCount: number;
	/** 块总数（含没有 ID 的块）。 */
	blockCount: number;
	/** 带 ID 的块数。 */
	idBlockCount: number;
	/** 引用命中总数。 */
	referenceCount: number;
	/** 存在重复定义的 UUID 数量。 */
	duplicateIdCount: number;
	/** 构建耗时（毫秒）。 */
	elapsedMs: number;
}
