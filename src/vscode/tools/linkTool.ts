/**
 * 工具：一次算完「补目标块 id::」+「把引用写进目标段落」。
 *
 * 为什么需要它：原来的链路是「每引用一个块就要一次 `#blockMakeRef`、一次手工写入、
 * 再手写引用行」，N 个引用就是 2N+ 次模型往返。而模型每往返一次的思考时间，
 * 远大于工具本身的执行时间，所以真正的瓶颈是往返次数。
 *
 * 这个工具把整件事压成一次调用：定位、生成 UUID、算出 id:: 补丁、
 * 算出引用块的插入补丁，全部在本地算完，一次性返回。
 *
 * **不写文件**：补丁仍由 AI 用自己的编辑工具落盘，这样 Copilot 的
 * 「接受 / 拒绝」栏依然有效 —— 用户看到不满意可以点不接受。
 */

import * as vscode from 'vscode';

import { findDeepestBlockAtLine, parseMarkdown } from '../../core/blockParser';
import type { GraphIndex } from '../../core/graphIndex';
import { t } from '../../core/i18n';
import { buildIdInsertionPlan } from '../../core/idInsertion';
import { getBlockTitle } from '../../core/render';
import { buildRefBlockPlan, type RefTargetEntry } from '../../core/refPlan';
import type { ParsedFile } from '../../core/types';
import { describeIdInsertionReject } from '../blockRefMessages';
import { collectOpenMarkdownOverrides, collectTakenUuids, readCurrentText } from '../documentText';
import { normalizeFilePath, textResult, toDisplayPath } from './common';

/** 一个被引用的目标块。 */
export interface LinkTargetInput {
	/** 目标块所在笔记；省略时使用外层的 `filePath`。 */
	filePath?: string;
	/** 1-based 行号；块内任意一行都可以，工具会取包含该行的最深块。 */
	line: number;
	/** 目标块首行文本，用于校验目标未变。 */
	expectedFirstLine: string;
	/** 引用前面的说明文字，可空。 */
	label?: string;
	/** 引用形态，默认 inline。 */
	kind?: 'inline' | 'embed';
}

/** 引用写到哪里。 */
export interface LinkDestinationInput {
	/** 落点笔记路径；相对路径按图谱根解析。 */
	filePath: string;
	/** 锚点块的 1-based 行号。 */
	line: number;
	/** 锚点块首行文本，用于校验目标未变。 */
	expectedFirstLine: string;
	/** 作为锚点块的子块追加（默认），或作为其同级块追加。 */
	position?: 'child' | 'sibling';
}

export interface LinkInput {
	/** 目标笔记路径；`targets` 未单独给 filePath 时使用。 */
	filePath?: string;
	destination: LinkDestinationInput;
	targets: LinkTargetInput[];
}

/** 一份待应用的补丁。 */
interface PendingPatch {
	displayPath: string;
	title: string;
	oldText: string;
	newText: string;
}

/** 解析并缓存同一个文件的文本，避免多目标重复读盘。 */
interface LoadedFile {
	absolutePath: string;
	parsed: ParsedFile;
	displayPath: string;
}

export class LinkTool implements vscode.LanguageModelTool<LinkInput> {
	constructor(
		private readonly getIndex: () => GraphIndex,
		private readonly ensureReady: () => Promise<void>,
		private readonly getGraphRoot: () => string | undefined,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<LinkInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		await this.ensureReady();
		if (token.isCancellationRequested) {
			return textResult(t('(call cancelled)'));
		}

		const input = options.input;
		if (!Array.isArray(input.targets) || input.targets.length === 0) {
			return textResult(t('The targets parameter is missing. Pass at least one block to reference.'));
		}
		const destination = input.destination;
		if (!destination?.filePath || !destination.expectedFirstLine || !destination.line) {
			return textResult(
				t(
					'The destination parameter is incomplete. Pass filePath, line and expectedFirstLine for the block that should hold the references.',
				),
			);
		}

		const graphRoot = this.getGraphRoot();
		const cache = new Map<string, LoadedFile>();

		const load = async (rawPath: string): Promise<LoadedFile | string> => {
			const absolutePath = normalizeFilePath(rawPath, graphRoot);
			const cached = cache.get(absolutePath);
			if (cached) {
				return cached;
			}
			const content = await readCurrentText(absolutePath);
			if (content === undefined) {
				return t(
					'Cannot read file: {0}\nCheck that the path is correct. The graph root is: {1}',
					absolutePath,
					graphRoot ?? t('(not detected)'),
				);
			}
			const loaded: LoadedFile = {
				absolutePath,
				parsed: parseMarkdown(absolutePath, content),
				displayPath: toDisplayPath(absolutePath, graphRoot),
			};
			cache.set(absolutePath, loaded);
			return loaded;
		};

		/**
		 * 在指定文件里定位一个块并校验首行。
		 *
		 * 校验是有意保留的：模型给的行号很容易因为是「改文件前的行号」而错位，
		 * 一旦错位就会把 id:: 插进别人的块。宁可失败让它重查，也不要写错位置。
		 */
		const locate = (
			file: LoadedFile,
			line: number,
			expected: string,
		): { index: number } | { error: string } => {
			if (line < 1) {
				return { error: t('The line parameter must be a 1-based line number.') };
			}
			const lineIndex = line - 1;
			if (lineIndex >= file.parsed.lines.length) {
				return {
					error: t(
						'Line {0} is beyond the end of the file ({1} lines).',
						line,
						file.parsed.lines.length,
					),
				};
			}
			const index = findDeepestBlockAtLine(file.parsed, lineIndex);
			if (index < 0) {
				return {
					error: t(
						'Line {0} is not inside a block. Put the cursor inside the target block and retry.',
						line,
					),
				};
			}
			const block = file.parsed.blocks[index];
			if (!block) {
				return { error: t('No block was found at line {0}.', line) };
			}
			const actualFirstLine = file.parsed.lines[block.startLine] ?? '';
			const actualTitle = getBlockTitle(actualFirstLine).trim();
			const wanted = expected.trim();
			if (wanted !== actualTitle && wanted !== actualFirstLine.trim()) {
				return {
					error: t(
						'Target mismatch at line {0}. Expected "{1}", but the block first line is "{2}". Re-read the file and retry with the exact first line.',
						block.startLine + 1,
						wanted,
						actualTitle || actualFirstLine,
					),
				};
			}
			return { index };
		};

		// 落点文件先解析：同一文件既当落点又当目标时，只需要读一次。
		const destinationFile = await load(destination.filePath);
		if (typeof destinationFile === 'string') {
			return textResult(destinationFile);
		}
		const destinationAnchor = locate(
			destinationFile,
			destination.line,
			destination.expectedFirstLine,
		);
		if ('error' in destinationAnchor) {
			return textResult(destinationAnchor.error);
		}

		const overrides = collectOpenMarkdownOverrides();
		const taken = collectTakenUuids(this.getIndex(), { overrides });
		const entries: RefTargetEntry[] = [];
		const idPatches: PendingPatch[] = [];
		const notes: string[] = [];

		for (const target of input.targets) {
			const targetFile = await load(target.filePath ?? input.filePath ?? destination.filePath);
			if (typeof targetFile === 'string') {
				return textResult(targetFile);
			}
			const located = locate(targetFile, target.line, target.expectedFirstLine);
			if ('error' in located) {
				return textResult(located.error);
			}

			const block = targetFile.parsed.blocks[located.index];
			if (!block) {
				return textResult(t('No block was found at line {0}.', target.line));
			}
			const firstLine = targetFile.parsed.lines[block.startLine] ?? '';
			const title = getBlockTitle(firstLine).trim() || firstLine.trim();
			const kind = target.kind === 'embed' ? 'embed' : 'inline';

			if (block.id) {
				entries.push({ uuid: block.id, label: target.label, kind });
				continue;
			}

			const plan = buildIdInsertionPlan(targetFile.parsed, located.index, {
				isUuidTaken: (uuid) => taken.has(uuid),
				tabSize: 4,
				// AI 补丁统一用 \n。
				eol: '\n',
			});

			if (plan.kind === 'reject') {
				return textResult(
					t(
						'Cannot create a reference for block "{0}" at {1}:{2}.\n{3}',
						title,
						targetFile.displayPath,
						block.startLine + 1,
						describeIdInsertionReject(plan.reason, plan.detail),
					),
				);
			}

			if (plan.kind === 'existing') {
				const valid = plan.ids.find((id) => id.validUuid);
				if (!valid) {
					return textResult(
						t(
							'This block already has an id::, but it is not a standard UUID: {0}. Fix the ID before referencing it.',
							plan.ids.map((id) => id.value).join(', '),
						),
					);
				}
				entries.push({ uuid: valid.value, label: target.label, kind });
				continue;
			}

			taken.add(plan.uuid);
			entries.push({ uuid: plan.uuid, label: target.label, kind });
			idPatches.push({
				displayPath: targetFile.displayPath,
				title: t('add id:: to line {0} "{1}"', block.startLine + 1, title),
				oldText: plan.oldText,
				newText: plan.newText,
			});
			if (!plan.logseqCompatible) {
				notes.push(
					t(
						'Warning: block "{0}" starts with a code fence, so id:: is placed after the closing fence. Tine accepts this, but Logseq may not.',
						title,
					),
				);
			}
		}

		const destBlock = destinationFile.parsed.blocks[destinationAnchor.index];
		const destTitle = destBlock
			? getBlockTitle(destinationFile.parsed.lines[destBlock.startLine] ?? '').trim()
			: '';
		const position = destination.position === 'sibling' ? 'sibling' : 'child';
		const refPlan = buildRefBlockPlan(
			destinationFile.parsed,
			destinationAnchor.index,
			entries,
			position,
		);

		if ('reason' in refPlan) {
			return textResult(
				refPlan.reason === 'no-targets'
					? t('No reference to write.')
					: t('The destination block could not be resolved. Re-read the file and retry.'),
			);
		}

		const refPatch: PendingPatch = {
			displayPath: destinationFile.displayPath,
			title: t(
				'add {0} reference block(s) after line {1}, as {2} of line {3} "{4}"',
				refPlan.lines.length,
				refPlan.insertAfterLine + 1,
				position === 'child' ? t('a child block') : t('a sibling block'),
				(destBlock?.startLine ?? 0) + 1,
				destTitle,
			),
			oldText: refPlan.oldText,
			newText: refPlan.newText,
		};

		const patches = [refPatch, ...idPatches];
		const out: string[] = [
			t(
				'Block link plan ready. Apply every patch below with your file editing tool, exactly as written; do not reformat, reorder or merge them.',
			),
			'',
		];

		for (let index = 0; index < patches.length; index++) {
			const patch = patches[index];
			if (!patch) {
				continue;
			}
			out.push(
				`### [${index + 1}/${patches.length}] ${patch.displayPath} — ${patch.title}`,
				'oldText:',
				patch.oldText,
				'newText:',
				patch.newText,
				'',
			);
		}

		out.push(t('Reference lines that will be written:'));
		for (const line of refPlan.lines) {
			out.push(line);
		}
		out.push('');
		out.push(
			t(
				'Next: apply the patches, then call #blockCheck once on {0}. Do not re-read the files to verify the result.',
				destinationFile.displayPath,
			),
		);
		if (notes.length > 0) {
			out.push('', ...notes);
		}

		return textResult(out.join('\n'));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<LinkInput>,
	): Promise<vscode.PreparedToolInvocation> {
		const count = Array.isArray(options.input.targets) ? options.input.targets.length : 0;
		return {
			invocationMessage: t('Planning {0} block reference(s)', count),
		};
	}
}
