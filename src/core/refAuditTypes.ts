/**
 * 引用审计的共享类型。
 *
 * 拆出来是为了让扫描、ID 检查、主流程三个模块都能引用，
 * 又不会形成运行时循环依赖。
 */

/** 审计问题代码；工具层可以据此做结构化展示。 */
export type RefAuditCode =
	| 'dangling-reference'
	| 'duplicate-uuid'
	| 'implicit-block-reference'
	| 'malformed-reference'
	/** 引用不在任何块内（顶格裸引用行），Tine / Logseq 不会把它当成块内引用。 */
	| 'reference-outside-block'
	/** 引用紧贴前文（前面没有空格），Tine / Logseq 不会把它渲染成引用。 */
	| 'reference-tight-prefix'
	| 'multiple-ids'
	| 'invalid-id'
	| 'id-not-in-property-group'
	| 'block-end-id'
	| 'zero-indent-id'
	| 'runtime-v8-id';

/** 一条审计问题。 */
export interface RefAuditIssue {
	severity: 'error' | 'warning';
	code: RefAuditCode;
	message: string;
	/** 0-based 行号。 */
	line?: number;
	/** 相关文件；目标块在其他文件时使用。 */
	path?: string;
	uuid?: string;
}

/** 审计结果。 */
export interface RefAuditResult {
	errors: RefAuditIssue[];
	warnings: RefAuditIssue[];
	/** 规范 UUID 引用数量（不含畸形引用）。 */
	referenceCount: number;
	/** 当前文件里带规范 UUID 的块数量。 */
	idCount: number;
	/** 畸形引用数量。 */
	malformedCount: number;
	ok: boolean;
}

/** 审计选项。 */
export interface RefAuditOptions {
	/** 只检查这些 UUID 的引用；不传则检查全部。ID 本身的问题始终检查。 */
	blockIds?: string[];
	/** 制表位宽度，必须与解析器一致。 */
	tabSize?: number;
}
