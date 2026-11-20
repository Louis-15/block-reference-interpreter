import { describe, expect, it } from 'vitest';

import { getOpeningFenceState, isClosingFence, skipInlineCodeSpan } from '../core/fence';

describe('getOpeningFenceState', () => {
	it('识别根级反引号围栏', () => {
		const state = getOpeningFenceState('```js');
		expect(state).not.toBeNull();
		expect(state?.char).toBe('`');
		expect(state?.length).toBe(3);
	});

	it('识别根级波浪线围栏', () => {
		const state = getOpeningFenceState('~~~');
		expect(state?.char).toBe('~');
	});

	it('缩进较深的围栏也能识别（Logseq 列表项内代码块）', () => {
		// 这里刻意不遵循 CommonMark 的「4 列以上不算围栏」：
		// Tine/Logseq 笔记的代码块普遍缩进在列表项内部，按 CommonMark 会让块树崩掉。
		const state = getOpeningFenceState('    ```');
		expect(state).not.toBeNull();
		expect(state?.minClosingIndentColumns).toBe(4);
	});

	it('识别列表项内围栏，并把缩进作为闭围栏下限', () => {
		const state = getOpeningFenceState('\t- ```js');
		expect(state).not.toBeNull();
		expect(state?.char).toBe('`');
		expect(state?.length).toBe(3);
		// 列表标记缩进为 4（一个 tab）
		expect(state?.minClosingIndentColumns).toBe(4);
	});

	it('识别带 checkbox 的列表项内围栏', () => {
		const state = getOpeningFenceState('  - [ ] ```');
		expect(state).not.toBeNull();
		expect(state?.minClosingIndentColumns).toBe(2);
	});

	it('普通文本返回 null', () => {
		expect(getOpeningFenceState('- 普通内容')).toBeNull();
		expect(getOpeningFenceState('hello')).toBeNull();
	});
});

describe('isClosingFence', () => {
	it('同字符且长度不短于开围栏才算闭合', () => {
		const state = getOpeningFenceState('```');
		expect(state).not.toBeNull();
		if (!state) {
			return;
		}
		expect(isClosingFence('```', state)).toBe(true);
		expect(isClosingFence('````', state)).toBe(true);
		expect(isClosingFence('``', state)).toBe(false);
		expect(isClosingFence('~~~', state)).toBe(false);
	});

	it('闭围栏允许尾部空白', () => {
		const state = getOpeningFenceState('```');
		if (!state) {
			throw new Error('围栏状态缺失');
		}
		expect(isClosingFence('```   ', state)).toBe(true);
	});

	it('闭围栏缩进不能小于开围栏缩进', () => {
		const state = getOpeningFenceState('  ```');
		if (!state) {
			throw new Error('围栏状态缺失');
		}
		// 缩进更浅的围栏标记不能闭合缩进更深的围栏
		expect(isClosingFence('```', state)).toBe(false);
		expect(isClosingFence('  ```', state)).toBe(true);
		expect(isClosingFence('    ```', state)).toBe(true);
	});

	it('列表项围栏的闭围栏必须追上列表缩进', () => {
		const state = getOpeningFenceState('\t- ```');
		if (!state) {
			throw new Error('围栏状态缺失');
		}
		// 缩进 0 不够
		expect(isClosingFence('```', state)).toBe(false);
		// 缩进 4（一个 tab）足够
		expect(isClosingFence('\t```', state)).toBe(true);
	});
});

describe('skipInlineCodeSpan', () => {
	it('跳过单反引号跨度', () => {
		const line = '前 `代码` 后';
		const end = skipInlineCodeSpan(line, line.indexOf('`'));
		expect(line.slice(end)).toBe(' 后');
	});

	it('双反引号包裹内部含反引号的内容', () => {
		const line = '``a`b``rest';
		const end = skipInlineCodeSpan(line, 0);
		expect(line.slice(end)).toBe('rest');
	});

	it('未闭合时只跳过开头那串反引号', () => {
		const line = '`未闭合';
		expect(skipInlineCodeSpan(line, 0)).toBe(1);
	});
});
