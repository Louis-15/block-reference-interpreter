/**
 * 生成块引用时的共享文案。
 *
 * AI 工具（`#blockMakeRef`）与人工命令（复制块引用 / 嵌入引用）会走同一套
 * `buildIdInsertionPlan` 拒绝原因；文案必须一致，否则同一个块在两条路径上
 * 会给出不同解释。
 */

import type { IdInsertionRejectReason } from '../core/idInsertion';
import { t } from '../core/i18n';

/** 把拒绝原因翻成可执行的说明。 */
export function describeIdInsertionReject(
	reason: IdInsertionRejectReason,
	detail?: string,
): string {
	switch (reason) {
		case 'implicit':
			return t(
				'This target is a page-leading implicit block without a `- ` prefix. Logseq does not treat it as a normal block, so no id:: was generated.',
			);
		case 'not-list-block':
			return t('This target is not a list block (`- ...`), so no id:: was generated.');
		case 'page-property':
			return t('This target is a page property, not a block.');
		case 'unclosed-fence':
			return t(
				'The block starts with a code fence that is never closed. There is no safe place for id::, so nothing was generated.',
			);
		case 'invalid-uuid':
			return t('The supplied UUID is invalid: {0}', detail ?? '');
		case 'duplicate':
			return t('Could not generate a unique UUID: {0}', detail ?? '');
		case 'not-indexed':
			return t(
				'The parsed block lines do not line up with the file. Re-open the file and retry.',
			);
		case 'id-not-in-property-group':
			return t(
				'The block already has an id:: outside the property group. Fix its position before referencing it.',
			);
		case 'no-block':
		default:
			return t('No block was found at the requested location.');
	}
}
