/**
 * 反链相关命令 ID 集中定义。
 *
 * 单独一个文件的原因：InlayHint、CodeLens、悬停提示三处都要引用这些 ID，
 * 定义在任何一个 provider 里都会造成循环依赖。
 */

/** 打开反链面板（只读文档）。 */
export const SHOW_BACKLINKS_PANEL_COMMAND = 'blockReferenceInterpreter.showBacklinksPanel';

/**
 * 打开某个具体的引用位置。
 *
 * 参数：`[filePath: string, line: number]`
 */
export const OPEN_BACKLINK_AT_COMMAND = 'blockReferenceInterpreter.openBacklinkAt';
