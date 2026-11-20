import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// core 层是纯函数，不需要 vscode 宿主，直接用 node 环境跑。
		include: ['src/test/**/*.test.ts'],
		environment: 'node',
		reporters: ['default'],
	},
});
