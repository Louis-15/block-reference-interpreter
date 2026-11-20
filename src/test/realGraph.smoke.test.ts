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
});
