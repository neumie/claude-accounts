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

cpSync('src/manifest.json', 'dist/manifest.json')
cpSync('src/popup/popup.html', 'dist/popup.html')
cpSync('src/popup/popup.css', 'dist/popup.css')
cpSync('src/switching.html', 'dist/switching.html')
cpSync('src/switching.js', 'dist/switching.js')

console.log('Extension built to dist/')
