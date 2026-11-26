/**
 * 反链测试共用的固定图谱。
 *
 * 抽成独立文件（不叫 `*.test.ts`，不会被 vitest 当测试收集），
 * 让「构建报告」与「渲染报告」两组测试用同一份数据，
 * 避免两边夹具漂移导致「同一场景在 build 侧通过、render 侧失败」。
 */

import { GraphIndex } from '../core/graphIndex';

/** 目标块 UUID。 */
export const UUID = '6780f110-d8e8-489f-be72-d2b3dbbc5668';

/** 目标块：定义在「星落凝成糖」，带两个子块。 */
export const TARGET_NOTE = `- ## 人物
	- 《星落凝成糖》夜昙（黑化前）
		id:: 6780f110-d8e8-489f-be72-d2b3dbbc5668
		- 傲娇：毒舌
		- 傻白
`;

/** 引用方 B：嵌套在两级块之下。 */
export const REF_NOTE_B = `- 71 举例
	- ## 71.3 毒舌讽刺型
		- ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;

/** 引用方 C：同一个页面里两处引用。 */
export const REF_NOTE_C = `- 71 举例
	- ## 71.2 普通女
		- ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
	- 别的地方
		- 又引用一次 ((6780f110-d8e8-489f-be72-d2b3dbbc5668))
`;

/** 构造两文件的图：目标块定义在 A，被 B 与 C 引用。 */
export async function buildFixtureIndex(): Promise<GraphIndex> {
	const index = new GraphIndex();
	const files: Record<string, string> = {
		'pages/星落凝成糖.md': TARGET_NOTE,
		'pages/傲娇.md': REF_NOTE_B,
		'pages/傻白+中二.md': REF_NOTE_C,
	};
	await index.rebuild(Object.keys(files), (filePath) => Promise.resolve(files[filePath] ?? ''));
	return index;
}
