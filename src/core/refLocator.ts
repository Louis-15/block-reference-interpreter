/**
 * 行内块引用的精确定位。
 *
 * 用途：hover 与「光标处展开」都需要判断「鼠标/光标是不是正好落在某个 ((uuid)) 上」。
 * 这个判断必须足够严格——如果只要同一行就命中，用户在 UUID 旁边的普通文字上
 * 划来划去都会弹出内容，体验会很糟。
 */

/** 半角与全角块引用的行内匹配。 */
const INLINE_REF_PATTERN = /(?:\(\(([A-Za-z0-9_-]{36,})\)\)|（（([A-Za-z0-9_-]{36,})））)/g;

/** 块引用在行内的定位结果：起始列与结束列（结束列不含）。 */
export interface LocatedReference {
	/** 规范化（小写）后的 UUID。 */
	uuid: string;
	/** 起始列（0-based，指向第一个括号）。 */
	start: number;
	/** 结束列（0-based，不含；即最后一个右括号之后）。 */
	end: number;
}

/**
 * 在指定行、指定列上定位块引用。
 *
 * @param line 整行文本
 * @param character 0-based 列号
 * @returns 命中时返回 UUID 与列范围；否则返回 null
 */
export function locateReferenceAt(line: string, character: number): LocatedReference | null {
	INLINE_REF_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = INLINE_REF_PATTERN.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (character >= start && character < end) {
			const rawUuid = match[1] ?? match[2];
			if (!rawUuid) {
				return null;
			}
			return { uuid: rawUuid.toLowerCase(), start, end };
		}
	}

	return null;
}

/** 取一段文本里所有块引用的位置（用于测试与批量定位）。 */
export function locateAllReferences(line: string): LocatedReference[] {
	INLINE_REF_PATTERN.lastIndex = 0;
	const results: LocatedReference[] = [];
	let match: RegExpExecArray | null;

	while ((match = INLINE_REF_PATTERN.exec(line)) !== null) {
		const rawUuid = match[1] ?? match[2];
		if (!rawUuid) {
			continue;
		}
		results.push({
			uuid: rawUuid.toLowerCase(),
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	INLINE_REF_PATTERN.lastIndex = 0;
	return results;
}
