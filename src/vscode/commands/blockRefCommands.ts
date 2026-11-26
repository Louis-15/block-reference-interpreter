/**
 * 复制块引用 / 嵌入引用的命令入口。
 *
 * 只做参数固定，具体逻辑在 `blockIdService` 里；这样右键菜单、
 * 命令面板和将来的快捷键都能复用同一套行为。
 */

import { copyBlockReference, type BlockRefDeps } from '../blockIdService';

/** 复制 `((uuid))`。 */
export async function copyBlockReferenceCommand(deps: BlockRefDeps): Promise<void> {
	await copyBlockReference(deps, 'inline');
}

/** 复制 `{{embed ((uuid))}}`。 */
export async function copyBlockEmbedCommand(deps: BlockRefDeps): Promise<void> {
	await copyBlockReference(deps, 'embed');
}
