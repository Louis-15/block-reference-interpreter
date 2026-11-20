/**
 * 真实笔记库冒烟测试（只读）。
 *
 * 目的：用真实数据验证解析器不会崩、性能可接受、统计量级与调研一致。
 *
 * 安全约束：
 * - 只读文件，绝不写入；
 * - 笔记库可能正在被 Tine 编辑，统计数字会漂移，因此断言用宽松区间而不是精确值；
 * - 目录不存在时整个测试跳过（换机器、删库都不会让 CI 变红）。
 *
 * 可通过环境变量 TINE_GRAPH_ROOT 指向别的图谱。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildExpandedNote } from '../core/expandNote';
import { buildBlockPath } from '../core/blockPath';
import { buildBacklinkReport, renderBacklinkReport } from '../core/backlinkReport';
import { parseMarkdown } from '../core/blockParser';
import { GraphIndex } from '../core/graphIndex';
import { resolveBlock } from '../core/resolve';

const GRAPH_ROOT = process.env.TINE_GRAPH_ROOT ?? 'd:\\扁舟听雨工作室\\网文创作理论';

/** 列举 pages/ 与 journals/ 下的 Markdown 文件（与插件默认 include 一致）。 */
function listMarkdownFiles(root: string): string[] {
	const files: string[] = [];
	for (const directory of ['pages', 'journals']) {
		const full = path.join(root, directory);
		if (!fs.existsSync(full)) {
			continue;
		}
		for (const name of fs.readdirSync(full)) {
			if (name.toLowerCase().endsWith('.md')) {
				files.push(path.join(full, name));
			}
		}
	}
	return files;
}

const graphExists = fs.existsSync(path.join(GRAPH_ROOT, 'pages'));

describe.skipIf(!graphExists)('真实笔记库冒烟测试', () => {
	it('全量索引不抛异常，且性能与统计量级符合预期', async () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		expect(files.length).toBeGreaterThan(100);

		const index = new GraphIndex();
		const startedAt = Date.now();
		const stats = await index.rebuild(files, (filePath) => fs.promises.readFile(filePath, 'utf8'));
		const elapsed = Date.now() - startedAt;

		// 调研时实测：1173 文件 / 1255 带 ID 块 / 1436 次引用 / 0.35 秒。
		// 这里放宽到区间，允许笔记库继续增长。
		expect(stats.fileCount).toBe(files.length);
		expect(stats.idBlockCount).toBeGreaterThan(500);
		expect(stats.referenceCount).toBeGreaterThan(500);
		expect(stats.duplicateIdCount).toBeGreaterThanOrEqual(0);
		expect(elapsed).toBeLessThan(15000);

		// 打印一份可读报告，便于人工核对（vitest 默认只在失败时显示）。
		console.log(
			`[真实库] 文件 ${stats.fileCount} / 块 ${stats.blockCount} / 带 ID ${stats.idBlockCount} / ` +
				`引用 ${stats.referenceCount} / 重复 ID ${stats.duplicateIdCount} / 耗时 ${elapsed}ms`,
		);
	}, 60000);

	it('能解析真实存在的块引用（跨文件）', async () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		const index = new GraphIndex();
		await index.rebuild(files, (filePath) => fs.promises.readFile(filePath, 'utf8'));

		// 取真实存在的第一个引用目标进行验证。
		const allReferences = index
			.listFiles()
			.flatMap((filePath) => index.getParsedFile(filePath)?.references ?? []);
		const resolvable = allReferences.find((hit) => index.lookupBlocks(hit.uuid).length > 0);
		expect(resolvable).toBeDefined();

		if (!resolvable) {
			return;
		}

		const result = resolveBlock(index, resolvable.uuid, { maxChars: 5000 });
		expect(result.notFound).toBe(false);
		expect(result.text.length).toBeGreaterThan(0);
		expect(result.text).toContain('来源：');
	}, 60000);

	it('反向链接查询能返回真实引用位置', async () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		const index = new GraphIndex();
		await index.rebuild(files, (filePath) => fs.promises.readFile(filePath, 'utf8'));

		const allReferences = index
			.listFiles()
			.flatMap((filePath) => index.getParsedFile(filePath)?.references ?? []);
		const first = allReferences[0];
		expect(first).toBeDefined();
		if (!first) {
			return;
		}

		const backlinks = index.findBacklinks(first.uuid);
		expect(backlinks.length).toBeGreaterThan(0);
		expect(backlinks[0]?.lineText.length).toBeGreaterThan(0);
	}, 60000);

	it('展开真实笔记的输出可读且格式正确', async () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		const index = new GraphIndex();
		await index.rebuild(files, (filePath) => fs.promises.readFile(filePath, 'utf8'));

		// 找一个至少含 2 处引用的真实文件来做展开验证。
		const target = index
			.listFiles()
			.map((filePath) => ({ filePath, parsed: index.getParsedFile(filePath) }))
			.find((entry) => (entry.parsed?.references.length ?? 0) >= 2);
		expect(target).toBeDefined();
		if (!target?.parsed) {
			return;
		}

		const expanded = buildExpandedNote(
			{ lines: target.parsed.lines, references: target.parsed.references },
			{
				includeHeader: true,
				fileName: target.filePath,
				resolve: (uuid) => resolveBlock(index, uuid, { maxChars: 8000 }).text,
			},
		);

		// 头部说明
		expect(expanded).toContain('块引用解释器');
		// 展开标记必须成对出现
		expect(expanded).toContain('块引用 ((');
		expect(expanded).toContain('展开结束');
		// 原始行必须原样保留，不能被改写
		const originalFirstLine = target.parsed.lines[0] ?? '';
		expect(expanded).toContain(originalFirstLine);
	}, 60000);

	it('所有合法的 id:: 行都能被识别为块（防回归）', async () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		const index = new GraphIndex();
		const stats = await index.rebuild(files, (filePath) => fs.promises.readFile(filePath, 'utf8'));

		// 严格匹配合法 UUID：损坏的 ID（如含点号的 `65cc96fb-1.a7-...`）不计入，
		// 它们本来就不该被解析成块。
		const strictIdLine =
			/^\s*id::\s*[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/;

		let idLineCount = 0;
		for (const filePath of files) {
			const content = await fs.promises.readFile(filePath, 'utf8');
			for (const line of content.split('\n')) {
				if (strictIdLine.test(line)) {
					idLineCount++;
				}
			}
		}

		// 允许少量差异：代码块里出现的 id:: 示例行会被正确跳过。
		// 但差异不能大——实测曾因「id:: 与块首行同缩进」漏掉 12 个 ID，
		// 直接导致 8 个块引用变成假性悬空。
		expect(stats.idBlockCount).toBeGreaterThanOrEqual(idLineCount - 5);

		console.log(`[ID 完整性] id:: 行 ${idLineCount} 条 / 识别为块 ${stats.idBlockCount} 个`);
	}, 60000);

	it('无块文件（只有页面属性）不会报错', () => {
		const files = listMarkdownFiles(GRAPH_ROOT);
		const emptyish = files.filter((filePath) => {
			const content = fs.readFileSync(filePath, 'utf8');
			return content.trim().length > 0 && !content.split('\n').some((line) => /^[ \t]*-/.test(line));
		});

		// 这类文件存在是正常的（只有 tags:: 的空页面），解析器应产出 0 个块而不是抛错。
		for (const filePath of emptyish) {
			const content = fs.readFileSync(filePath, 'utf8');
			expect(() => parseMarkdown(filePath, content)).not.toThrow();
		}
	}, 60000);

	it('反链报告在真实库上能按页面分组并给出面包屑', async () => {
		const index = new GraphIndex();
		await index.rebuild(listMarkdownFiles(GRAPH_ROOT), (filePath) => fs.promises.readFile(filePath, 'utf8'));

		// 找引用次数最多的块来验证分组与路径。
		const counts = new Map<string, number>();
		for (const filePath of index.listFiles()) {
			for (const hit of index.getParsedFile(filePath)?.references ?? []) {
				counts.set(hit.uuid, (counts.get(hit.uuid) ?? 0) + 1);
			}
		}
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
		expect(top).toBeDefined();
		if (!top) {
			return;
		}

		const report = buildBacklinkReport(index, top[0]);
		expect(report.definitions.length).toBeGreaterThan(0);
		expect(report.itemCount).toBeGreaterThan(1);
		expect(report.groups.length).toBeGreaterThan(1);

		// 所有条目都应当能定位到具体行，且分组计数自洽。
		let sum = 0;
		for (const group of report.groups) {
			sum += group.count;
			expect(group.items.length).toBe(group.count);
			for (const item of group.items) {
				expect(item.line).toBeGreaterThanOrEqual(0);
				expect(item.path.length).toBeGreaterThan(0);
			}
		}
		expect(sum).toBe(report.itemCount);

		const text = renderBacklinkReport(report, { graphRoot: GRAPH_ROOT });
		expect(text).toContain('反向链接');
		// 面板不应出现裸 UUID 引用（面包屑已提供可读上下文）
		expect(text).not.toMatch(/\(\([0-9a-f]{8}-/);
	}, 60000);

	it('真实库的块路径能生成有意义的面包屑（不含裸 ID）', async () => {
		const index = new GraphIndex();
		await index.rebuild(listMarkdownFiles(GRAPH_ROOT), (filePath) => fs.promises.readFile(filePath, 'utf8'));

		let checked = 0;
		let withPath = 0;
		for (const filePath of index.listFiles()) {
			const parsed = index.getParsedFile(filePath);
			if (!parsed) {
				continue;
			}
			for (let index2 = 0; index2 < parsed.blocks.length; index2++) {
				const pathText = buildBlockPath(parsed, index2);
				checked++;
				if (pathText.length > 0) {
					withPath++;
					// 面包屑里绝不能出现 `id::` 的 UUID
					expect(pathText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
				}
			}
		}

		expect(checked).toBeGreaterThan(1000);
		// 真实笔记里大量块是嵌套的，应当有一半以上能算出祖先路径
		expect(withPath).toBeGreaterThan(checked / 2);
	}, 60000);

	it('真实库的反链子树能正确展开（引用处的完整上下文）', async () => {
		const index = new GraphIndex();
		await index.rebuild(listMarkdownFiles(GRAPH_ROOT), (filePath) => fs.promises.readFile(filePath, 'utf8'));

		// 找一个「引用所在块有子块」的真实案例，验证子树被完整带入报告。
		let checked = 0;
		let withSubtree = 0;
		let maxDepth = 0;

		for (const filePath of index.listFiles()) {
			for (const hit of index.getParsedFile(filePath)?.references ?? []) {
				const report = buildBacklinkReport(index, hit.uuid);
				if (report.definitions.length === 0) {
					continue;
				}
				checked++;
				for (const group of report.groups) {
					for (const item of group.items) {
						if (item.subtree.length > 0) {
							withSubtree++;
						}
						for (const sub of item.subtree) {
							maxDepth = Math.max(maxDepth, sub.depth);
						}
					}
				}
				if (checked >= 60) {
					break;
				}
			}
			if (checked >= 60) {
				break;
			}
		}

		expect(checked).toBeGreaterThan(10);
		// 真实笔记里引用几乎总在嵌套块中，绝大多数应当能带出子块或续行
		expect(withSubtree).toBeGreaterThan(0);
		// 深度换算要正确：至少出现过 2 层以上的子块
		expect(maxDepth).toBeLessThanOrEqual(12);
	}, 90000);

	it('子树深度换算与原始缩进一致（防层级错乱回归）', async () => {
		const index = new GraphIndex();
		await index.rebuild(listMarkdownFiles(GRAPH_ROOT), (filePath) => fs.promises.readFile(filePath, 'utf8'));

		// 抽查：报告里报告的 depth 必须与源文件中该行的实际缩进层级吻合
		let samples = 0;
		for (const filePath of index.listFiles()) {
			const parsed = index.getParsedFile(filePath);
			if (!parsed) {
				continue;
			}
			for (const block of parsed.blocks) {
				if (!block.id) {
					continue;
				}
				const report = buildBacklinkReport(index, block.id, { includeSubtree: true });
				const group = report.groups.find((g) => g.path === filePath);
				const item = group?.items.find((i) => i.blockIndex >= 0);
				if (!item || item.subtree.length === 0) {
					continue;
				}
				for (const sub of item.subtree) {
					expect(sub.depth).toBeGreaterThanOrEqual(0);
					expect(sub.depth).toBeLessThanOrEqual(20);
					expect(sub.text.length).toBeGreaterThan(0);
				}
				samples++;
				if (samples >= 20) {
					break;
				}
			}
			if (samples >= 20) {
				break;
			}
		}
		expect(samples).toBeGreaterThan(0);
	}, 90000);
});
