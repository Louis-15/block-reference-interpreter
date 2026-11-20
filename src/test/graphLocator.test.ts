/**
 * 图谱根目录探测的单元测试。
 *
 * 这一层是「打开笔记库就自动建索引」的地基：探测错了，
 * 索引会锚定到错误目录，表现为工具全部报「未找到块」。
 * 因此用假探针把各种目录布局都固定下来。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectGraphRoot, isGraphContentFile, isGraphRoot } from '../core/graphLocator';
import type { PathProbe } from '../core/graphLocator';

/**
 * 用一组「已存在的目录」构造假探针。
 *
 * 用 POSIX 风格路径，避免在 Windows 上还要处理盘符，测试意图更清楚。
 */
function fakeProbe(existingDirectories: string[], existingFiles: string[] = []): PathProbe {
	// 列出的目录隐含其所有父目录都存在（真实文件系统就是如此），
	// 必须把祖先补齐，否则 `/graph` 会被判成不存在。
	const dirs = new Set<string>();
	for (const entry of existingDirectories) {
		let current = entry.replace(/\/+$/, '');
		for (;;) {
			dirs.add(current);
			const index = current.lastIndexOf('/');
			if (index <= 0) {
				break;
			}
			current = current.slice(0, index);
		}
	}
	const files = new Set(existingFiles);

	return {
		isDirectory: (target) => dirs.has(target.replace(/\/+$/, '')),
		exists: (target) => dirs.has(target.replace(/\/+$/, '')) || files.has(target),
		// 用 posix 语义：/a/b/c → /a/b，/a → /
		dirname: (target) => {
			const trimmed = target.replace(/\/+$/, '');
			const index = trimmed.lastIndexOf('/');
			return index <= 0 ? '/' : trimmed.slice(0, index);
		},
		join: (base, ...parts) => [base.replace(/\/+$/, ''), ...parts].join('/'),
	};
}

describe('isGraphRoot 判定依据', () => {
	it('同时有 pages/ 与 logseq/ 才算标准图谱', () => {
		const probe = fakeProbe(['/graph/pages', '/graph/logseq']);
		expect(isGraphRoot('/graph', probe)).toBe(true);
	});

	it('只有 pages/ 不算（普通文件夹里也可能有 pages）', () => {
		const probe = fakeProbe(['/graph/pages']);
		expect(isGraphRoot('/graph', probe)).toBe(false);
	});

	it('只有 logseq/ 不算', () => {
		const probe = fakeProbe(['/graph/logseq']);
		expect(isGraphRoot('/graph', probe)).toBe(false);
	});

	it('logseq/config.edn 单独即可认定', () => {
		const probe = fakeProbe(['/graph/logseq'], ['/graph/logseq/config.edn']);
		expect(isGraphRoot('/graph', probe)).toBe(true);
	});

	it('.tine-trash/ 单独即可认定', () => {
		const probe = fakeProbe(['/graph/.tine-trash']);
		expect(isGraphRoot('/graph', probe)).toBe(true);
	});
});

describe('detectGraphRoot 向上查找', () => {
	const graphDirs = ['/graph/pages', '/graph/logseq'];

	it('从深层文件定位到图谱根（笔记库的常见布局）', () => {
		const probe = fakeProbe([...graphDirs, '/graph/pages/sub']);
		expect(detectGraphRoot('/graph/pages/sub/note.md', probe)).toBe('/graph');
	});

	it('从图谱主目录本身定位', () => {
		const probe = fakeProbe(graphDirs);
		expect(detectGraphRoot('/graph', probe)).toBe('/graph');
	});

	it('找不到任何图谱标记时返回 null', () => {
		const probe = fakeProbe(['/plain/docs']);
		expect(detectGraphRoot('/plain/docs/a.md', probe)).toBeNull();
	});

	it('不会无限向上（maxDepth 生效）', () => {
		const probe = fakeProbe([...graphDirs]);
		// 起点深度 20 层，maxDepth=3 时够不着 /graph
		const deep = '/graph/pages/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/note.md';
		expect(detectGraphRoot(deep, probe, 3)).toBeNull();
	});

	it('到达根目录后停止，不抛异常', () => {
		const probe = fakeProbe([]);
		expect(detectGraphRoot('/a/b/c.md', probe)).toBeNull();
	});
});

describe('isGraphContentFile', () => {
	it('pages/ 与 journals/ 下算内容文件', () => {
		expect(isGraphContentFile(path.join('/graph', 'pages', 'a.md'), '/graph')).toBe(true);
		expect(isGraphContentFile(path.join('/graph', 'journals', '2026_01_01.md'), '/graph')).toBe(true);
	});

	it('logseq/ 与图谱外不算', () => {
		expect(isGraphContentFile(path.join('/graph', 'logseq', 'pages', 'a.md'), '/graph')).toBe(false);
		expect(isGraphContentFile('/other/pages/a.md', '/graph')).toBe(false);
	});
});

describe('真实笔记库探测', () => {
	const realGraph = process.env.TINE_GRAPH_ROOT ?? 'd:\\扁舟听雨工作室\\网文创作理论';

	it.skipIf(!fs.existsSync(path.join(realGraph, 'pages')))(
		'能从真实笔记库的深层文件探测到图谱根',
		() => {
			const detected = detectGraphRoot(path.join(realGraph, 'pages', '任意笔记.md'));
			expect(detected).toBe(path.resolve(realGraph));
		},
	);

	it.skipIf(!fs.existsSync(path.join(realGraph, 'pages')))('真实笔记库的图谱根可被判定', () => {
		expect(isGraphRoot(realGraph)).toBe(true);
	});
});
