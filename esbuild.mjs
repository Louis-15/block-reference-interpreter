import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** 扩展主进程入口的打包配置：vscode 模块由宿主提供，必须保持 external。 */
const options = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	sourcemap: true,
	// 打包体积不是本扩展的痛点，关闭 minify 以便出错时堆栈可读。
	minify: false,
	logLevel: 'info',
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[esbuild] watching src/extension.ts ...');
} else {
	await esbuild.build(options);
	console.log('[esbuild] build done');
}
