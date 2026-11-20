/**
 * 全库索引：UUID → 块位置、UUID → 引用位置。
 *
 * 为什么要有索引：
 * 块引用是跨文件的，`((uuid))` 出现在 A 文件，目标块却可能在 B 文件。
 * 每次查询都全库扫描虽然只要 ~0.7 秒，但悬停预览、连续工具调用会明显卡顿，
 * 所以内存里常驻一份索引，文件变更时增量更新。
 *
 * 这一层不依赖 vscode：文件列表与内容读取都由调用方注入，
 * 这样既能跑单测，也能在将来换成别的宿主。
 */

import { parseMarkdown } from './blockParser';
import type { BlockLocation, IndexStats, ParsedFile, ReferenceHit } from './types';

/** 引用位置 + 归属文件（ReferenceHit 本身不带路径，索引层负责补齐）。 */
interface ReferenceRecord {
	path: string;
	hit: ReferenceHit;
}

/** 一条反向链接记录。 */
export interface BacklinkEntry {
	/** 引用所在的文件。 */
	path: string;
	/** 引用命中详情（含行列号）。 */
	hit: ReferenceHit;
	/** 引用所在行的文本，便于展示上下文。 */
	lineText: string;
	/** 引用所在的最深块下标；找不到时为 -1。 */
	blockIndex: number;
}

/** 一次查询命中的块。 */
export interface BlockLookupResult {
	/** 块位置。 */
	location: BlockLocation;
	/** 所属文件的解析结果。 */
	parsed: ParsedFile;
	/** 块下标。 */
	blockIndex: number;
}

export class GraphIndex {
	private readonly tabSize: number;

	/** 文件路径 → 解析结果。 */
	private readonly files = new Map<string, ParsedFile>();
	/** uuid → 块位置（数组承载重复 ID）。 */
	private readonly byId = new Map<string, BlockLocation[]>();
	/** uuid → 引用位置。 */
	private readonly refsById = new Map<string, ReferenceRecord[]>();
	/** 文件路径 → 该文件的引用命中（增量更新时用于精确移除旧数据）。 */
	private readonly refsByFile = new Map<string, ReferenceHit[]>();

	private stats: IndexStats = {
		fileCount: 0,
		blockCount: 0,
		idBlockCount: 0,
		referenceCount: 0,
		duplicateIdCount: 0,
		elapsedMs: 0,
	};

	constructor(options: { tabSize?: number } = {}) {
		this.tabSize = options.tabSize ?? 4;
	}

	/** 清空全部索引。 */
	clear(): void {
		this.files.clear();
		this.byId.clear();
		this.refsById.clear();
		this.refsByFile.clear();
		this.stats = {
			fileCount: 0,
			blockCount: 0,
			idBlockCount: 0,
			referenceCount: 0,
			duplicateIdCount: 0,
			elapsedMs: 0,
		};
	}

	/**
	 * 全量重建索引。
	 *
	 * @param filePaths 参与索引的文件路径列表
	 * @param read 读取文件内容；由调用方决定用 node:fs 还是 vscode.workspace.fs
	 */
	async rebuild(filePaths: readonly string[], read: (path: string) => Promise<string>): Promise<IndexStats> {
		const startedAt = Date.now();
		this.clear();

		for (const path of filePaths) {
			let content: string;
			try {
				content = await read(path);
			} catch {
				// 单个文件读失败不应该让整次索引失败：跳过并继续，
				// 否则一个被占用/权限异常的文件会让插件彻底不可用。
				continue;
			}
			this.indexOne(path, content);
		}

		this.recomputeStats(Date.now() - startedAt);
		return this.stats;
	}

	/**
	 * 增量更新单个文件。
	 *
	 * 先精确移除该文件此前贡献的块与引用，再重新解析，
	 * 避免「同一个 UUID 被记录了两次」导致重复 ID 误报。
	 */
	updateFile(path: string, content: string): void {
		this.removeFile(path);
		this.indexOne(path, content);
		this.recomputeStats(this.stats.elapsedMs);
	}

	/** 从索引中移除一个文件贡献的全部数据。 */
	removeFile(path: string): void {
		const previous = this.files.get(path);
		if (previous) {
			for (const uuid of previous.blocksById.keys()) {
				const locations = this.byId.get(uuid);
				if (!locations) {
					continue;
				}
				const remaining = locations.filter((location) => location.path !== path);
				if (remaining.length > 0) {
					this.byId.set(uuid, remaining);
				} else {
					this.byId.delete(uuid);
				}
			}
			this.files.delete(path);
		}

		const previousRefs = this.refsByFile.get(path);
		if (previousRefs) {
			for (const uuid of new Set(previousRefs.map((hit) => hit.uuid))) {
				const records = this.refsById.get(uuid);
				if (!records) {
					continue;
				}
				const remaining = records.filter((record) => record.path !== path);
				if (remaining.length > 0) {
					this.refsById.set(uuid, remaining);
				} else {
					this.refsById.delete(uuid);
				}
			}
			this.refsByFile.delete(path);
		}
	}

	/** 解析并写入单个文件。 */
	private indexOne(path: string, content: string): void {
		const parsed = parseMarkdown(path, content, { tabSize: this.tabSize });
		this.files.set(path, parsed);

		for (const [uuid, indexes] of parsed.blocksById) {
			const locations = this.byId.get(uuid) ?? [];
			for (const blockIndex of indexes) {
				locations.push({ path, blockIndex });
			}
			this.byId.set(uuid, locations);
		}

		const hits = parsed.references;
		if (hits.length > 0) {
			this.refsByFile.set(path, hits);
			for (const hit of hits) {
				const records = this.refsById.get(hit.uuid) ?? [];
				records.push({ path, hit });
				this.refsById.set(hit.uuid, records);
			}
		}
	}

	/** 重算统计信息。 */
	private recomputeStats(elapsedMs: number): void {
		let blockCount = 0;
		let idBlockCount = 0;
		let duplicateIdCount = 0;

		for (const parsed of this.files.values()) {
			blockCount += parsed.blocks.length;
			idBlockCount += parsed.blocksById.size;
		}
		for (const locations of this.byId.values()) {
			if (locations.length > 1) {
				duplicateIdCount++;
			}
		}

		let referenceCount = 0;
		for (const hits of this.refsByFile.values()) {
			referenceCount += hits.length;
		}

		this.stats = {
			fileCount: this.files.size,
			blockCount,
			idBlockCount,
			referenceCount,
			duplicateIdCount,
			elapsedMs,
		};
	}

	/** 查询一个 UUID 对应的全部块位置（可能有重复 ID）。 */
	lookup(uuid: string): BlockLocation[] {
		return this.byId.get(uuid.toLowerCase()) ?? [];
	}

	/**
	 * 查询 UUID 对应的块，并把解析结果一并返回。
	 *
	 * 返回数组：正常情况长度为 1，重复 ID 时会有多个候选。
	 */
	lookupBlocks(uuid: string): BlockLookupResult[] {
		const locations = this.lookup(uuid);
		const results: BlockLookupResult[] = [];
		for (const location of locations) {
			const parsed = this.files.get(location.path);
			if (!parsed) {
				continue;
			}
			results.push({ location, parsed, blockIndex: location.blockIndex });
		}
		return results;
	}

	/** 查询哪些地方引用了该 UUID。 */
	findBacklinks(uuid: string): BacklinkEntry[] {
		const records = this.refsById.get(uuid.toLowerCase()) ?? [];
		const entries: BacklinkEntry[] = [];

		for (const record of records) {
			const parsed = this.files.get(record.path);
			const lineText = parsed?.lines[record.hit.line] ?? '';
			const blockIndex = parsed ? findBlockAtLine(parsed, record.hit.line) : -1;
			entries.push({ path: record.path, hit: record.hit, lineText, blockIndex });
		}

		return entries;
	}

	/** 取某文件的解析结果。 */
	getParsedFile(path: string): ParsedFile | undefined {
		return this.files.get(path);
	}

	/** 列出全部已索引文件路径。 */
	listFiles(): string[] {
		return [...this.files.keys()];
	}

	/** 取当前统计信息。 */
	getStats(): IndexStats {
		return this.stats;
	}
}

/** 在解析结果里找包含指定行的最深块。 */
export function findBlockAtLine(parsed: ParsedFile, lineNumber: number): number {
	let best = -1;
	for (let index = 0; index < parsed.blocks.length; index++) {
		const block = parsed.blocks[index];
		if (!block) {
			continue;
		}
		if (lineNumber >= block.startLine && lineNumber <= block.endLine) {
			// 缩进更深 = 层级更深，取最深的那个更符合用户直觉。
			if (best === -1 || (parsed.blocks[best]?.indent ?? -1) <= block.indent) {
				best = index;
			}
		}
	}
	return best;
}
