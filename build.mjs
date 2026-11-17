// Same pipeline as Helm's extension: rollup + babel (TypeScript, Solid), IIFE bundles.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import babel from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'
import { rollup } from 'rollup'

const plugins = [
	resolve({ extensions: ['.tsx', '.ts', '.jsx', '.js'], browser: true }),
	babel({
		extensions: ['.ts', '.tsx', '.js', '.jsx'],
		babelHelpers: 'bundled',
		presets: [
			['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
			['babel-preset-solid', { generate: 'dom' }],
		],
	}),
]

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist')

for (const [input, file] of [
	['src/background.ts', 'dist/background.js'],
	['src/content.ts', 'dist/content.js'],
	['src/popup/main.tsx', 'dist/popup.js'],
]) {
	const bundle = await rollup({ input, plugins })
	await bundle.write({ file, format: 'iife' })
	await bundle.close()
}

// Native host: one plain .mjs, so install-host can copy it out of ~/Documents
// (macOS privacy protection blocks helpers Chrome starts from reading there).
const hostPlugins = [
	resolve({ extensions: ['.ts', '.js'], preferBuiltins: true }),
	babel({ extensions: ['.ts'], babelHelpers: 'bundled', presets: [['@babel/preset-typescript', { allExtensions: true }]] }),
]
rmSync('dist-host', { recursive: true, force: true })
const hostBundle = await rollup({ input: 'host/main.ts', plugins: hostPlugins, external: id => id.startsWith('node:') })
await hostBundle.write({ file: 'dist-host/host.mjs', format: 'es' })
await hostBundle.close()

cpSync('src/manifest.json', 'dist/manifest.json')
cpSync('src/popup/popup.html', 'dist/popup.html')
cpSync('src/popup/popup.css', 'dist/popup.css')

console.log('Extension built to dist/, native host to dist-host/')
