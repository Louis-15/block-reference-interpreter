/**
 * 生成「插入一行 `id::`」的 AI 补丁。
 *
 * 补丁必须能在编辑器缓冲区里唯一匹配，否则 AI 的编辑工具可能改错位置。
 * 这里只做字符串计算，不写文件；补丁统一使用 `\n`。
 */

/**
 * 生成插入补丁。
 *
 * @param lines 文件行（已剥离 `\r`）
 * @param insertAfterLine 新行插在这一行之后（0-based）
 * @param propertyLine 要插入的属性行，不含换行
 */
export function buildInsertPatch(
	lines: readonly string[],
	insertAfterLine: number,
	propertyLine: string,
): { oldText: string; newText: string } {
	return buildInsertLinesPatch(lines, insertAfterLine, [propertyLine]);
}

/**
 * 生成「插入多行」的补丁。
 *
 * 与单行版本的差别只有插入内容：插入多行时（例如一次追加几个引用块），
 * 唯一性扩展与上下文拼接逻辑完全一致，因此共用同一份实现，
 * 避免两个版本对不齐导致补丁匹配失败。
 *
 * @param lines 文件行（已剥离 `\r`）
 * @param insertAfterLine 新行插在这一行之后（0-based）
 * @param insertLines 要插入的行（不含换行）
 */
export function buildInsertLinesPatch(
	lines: readonly string[],
	insertAfterLine: number,
	insertLines: readonly string[],
): { oldText: string; newText: string } {
	if (insertLines.length === 0) {
		const unchanged = lines[insertAfterLine] ?? '';
		return { oldText: unchanged, newText: unchanged };
	}

	const inserted = insertLines.join('\n');
	const fullText = lines.join('\n');
	let start = insertAfterLine;
	let end = insertAfterLine;
	let oldText = lines[insertAfterLine] ?? '';
	let occurrences = countLineBlockOccurrences(fullText, oldText);

	// 扩展策略：优先向上扩（保留插入点前的块上下文），到文件头仍不唯一
	// 再向下扩；窗口最终覆盖全文时必然唯一。
	while (occurrences > 1) {
		if (start > 0) {
			start--;
		} else if (end < lines.length - 1) {
			end++;
		} else {
			break;
		}
		oldText = lines.slice(start, end + 1).join('\n');
		occurrences = countLineBlockOccurrences(fullText, oldText);
	}

	const before = lines.slice(start, insertAfterLine + 1).join('\n');
	const hasAfter = end > insertAfterLine;
	const after = hasAfter ? lines.slice(insertAfterLine + 1, end + 1).join('\n') : '';
	const newText = hasAfter
		? `${before}\n${inserted}\n${after}`
		: `${before}\n${inserted}`;

	return { oldText, newText };
}

/**
 * 生成「插入一行」的标准 unified diff，作为 `oldText/newText` 的兜底。
 *
 * 只取插入点前后各一行作为上下文：补丁本身足够小，AI 的编辑工具
 * 即使不支持 `oldText/newText`，也能按 hunk 定位。
 *
 * @param filePath 展示用路径（通常相对图谱根）
 * @param lines 文件行（已剥离 `\r`）
 * @param insertAfterLine 新行插在这一行之后（0-based）
 * @param propertyLine 要插入的属性行，不含换行
 */
export function buildInsertionDiff(
	filePath: string,
	lines: readonly string[],
	insertAfterLine: number,
	propertyLine: string,
): string {
	const anchor = insertAfterLine + 1; // 1-based
	const hasBefore = insertAfterLine > 0;
	const hasAfter = insertAfterLine + 1 < lines.length;

	const start = hasBefore ? insertAfterLine : anchor;
	const oldCount = (hasBefore ? 1 : 0) + 1 + (hasAfter ? 1 : 0);
	const newCount = oldCount + 1;

	const hunk: string[] = [];
	if (hasBefore) {
		hunk.push(` ${lines[insertAfterLine - 1] ?? ''}`);
	}
	hunk.push(` ${lines[insertAfterLine] ?? ''}`);
	hunk.push(`+${propertyLine}`);
	if (hasAfter) {
		hunk.push(` ${lines[insertAfterLine + 1] ?? ''}`);
	}

	return [
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		`@@ -${start},${oldCount} +${start},${newCount} @@`,
		...hunk,
	].join('\n');
}

/**
 * 统计 `oldText` 作为「完整行块」出现的次数。
 *
 * 不能直接用 `indexOf`：锚点行可能出现在另一行的中间，
 * 那种匹配对编辑工具没有意义，还会让唯一性判断永远无法收敛。
 */
function countLineBlockOccurrences(fullText: string, oldText: string): number {
	if (oldText.length === 0) {
		return 0;
	}

	let count = 0;
	let from = 0;
	while (from <= fullText.length - oldText.length) {
		const found = fullText.indexOf(oldText, from);
		if (found === -1) {
			break;
		}
		const beforeOk = found === 0 || fullText[found - 1] === '\n';
		const after = found + oldText.length;
		const afterOk = after === fullText.length || fullText[after] === '\n';
		if (beforeOk && afterOk) {
			count++;
		}
		from = found + Math.max(1, oldText.length);
	}
	return count;
}
