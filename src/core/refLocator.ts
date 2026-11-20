/**
 * 行内块引用的精确定位。
 *
 * 用途：hover 与「光标处展开」都需要判断「鼠标/光标是不是正好落在某个引用上」。
 * 这个判断必须足够严格——如果只要同一行就命中，用户在引用旁边的普通文字上
 * 划来划去都会弹出内容，体验会很糟。
 *
 * **必须与 refScanner 的行为保持一致**：
 * 两处都独立实现正则，一旦规则不同就会出现「扫描认为这里有引用，
 * 但定位认为鼠标不在引用上」这类诡异 bug。所以下面的正则与 refScanner 逐字对应。
 */

/**
 * 块引用主匹配，与 `refScanner.ts` 的 BLOCK_REF_PATTERN 完全一致。
 *
 * 分组布局：
 *   1/2 = embed 内部的半角/全角 UUID
 *   3/4 = 普通行内的半角/全角 UUID
 */
const REFERENCE_PATTERN =
	/(?:\{\{\s*embed\s*(?:\(\(\s*([A-Za-z0-9_-]{36,})\s*\)\)|（（\s*([A-Za-z0-9_-]{36,})\s*））)\s*\}\})|(?:\(\(\s*([A-Za-z0-9_-]{36,})\s*\)\)|（（\s*([A-Za-z0-9_-]{36,})\s*））)/g;

/** 块引用在行内的定位结果。 */
export interface LocatedReference {
	/** 规范化（小写）后的 UUID。 */
	uuid: string;
	/** 起始列（0-based）。embed 时指向 `{{`，普通引用指向 `((`。 */
	start: number;
	/**
	 * 结束列（0-based，不含）。
	 *
	 * embed 时覆盖到 `}}` 之后，普通引用覆盖到 `))` 之后。
	 * 行内渲染直接替换这一段，所以 embed 外壳会被一起换掉，不会残留。
	 */
	end: number;
	/** 引用形态。 */
	kind: 'inline' | 'embed';
}

/**
 * 在指定行、指定列上定位块引用。
 *
 * @param line 整行文本
 * @param character 0-based 列号
 * @returns 命中时返回 UUID 与列范围；否则返回 null
 */
export function locateReferenceAt(line: string, character: number): LocatedReference | null {
	REFERENCE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = REFERENCE_PATTERN.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (character >= start && character < end) {
			const embedUuid = match[1] ?? match[2];
			const inlineUuid = match[3] ?? match[4];
			const rawUuid = embedUuid ?? inlineUuid;
			if (!rawUuid) {
				return null;
			}
			return {
				uuid: rawUuid.toLowerCase(),
				start,
				end,
				kind: embedUuid ? 'embed' : 'inline',
			};
		}
	}

	return null;
}

/** 取一段文本里所有块引用的位置（用于测试与批量定位）。 */
export function locateAllReferences(line: string): LocatedReference[] {
	REFERENCE_PATTERN.lastIndex = 0;
	const results: LocatedReference[] = [];
	let match: RegExpExecArray | null;

	while ((match = REFERENCE_PATTERN.exec(line)) !== null) {
		const embedUuid = match[1] ?? match[2];
		const inlineUuid = match[3] ?? match[4];
		const rawUuid = embedUuid ?? inlineUuid;
		if (!rawUuid) {
			continue;
		}
		results.push({
			uuid: rawUuid.toLowerCase(),
			start: match.index,
			end: match.index + match[0].length,
			kind: embedUuid ? 'embed' : 'inline',
		});
	}

	REFERENCE_PATTERN.lastIndex = 0;
	return results;
}
