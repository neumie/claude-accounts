// Registers the native messaging host with Google Chrome (current user only).
//   npm run install-host     build, then install / update
//   npm run uninstall-host   remove
//
// The host is copied to ~/Library/Application Support/claude-accounts/ because
// Chrome starts native hosts as their own responsible process, and macOS
// privacy protection (TCC) would block that process from reading ~/Documents.

import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_NAME } from '../src/shared/protocol.ts'
import { chromeRoot } from './chrome.ts'
import { dataDir } from './store.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function extensionIdFromKey(keyBase64: string): string {
	const der = Buffer.from(keyBase64, 'base64')
	const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
	return hex.replace(/./g, ch => String.fromCharCode(97 + Number.parseInt(ch, 16)))
}

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * process.execPath is the resolved binary (e.g. Homebrew's versioned Cellar path,
 * gone after `brew upgrade`). Prefer a stable symlink that points at the same node.
 */
export function stableNodePath(execPath = process.execPath): string {
	let real: string
	try {
		real = realpathSync(execPath)
	} catch {
		return execPath
	}
	for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
		try {
			if (realpathSync(candidate) === real) return candidate
		} catch {
			// not installed there
		}
	}
	return execPath
}

function main(): void {
	const manifestDir = join(chromeRoot(), 'NativeMessagingHosts')
	const manifestPath = join(manifestDir, `${HOST_NAME}.json`)
	const launcher = join(dataDir(), 'host.sh')
	const hostScript = join(dataDir(), 'host.mjs')

	if (process.argv.includes('--uninstall')) {
		for (const f of [manifestPath, launcher, hostScript]) rmSync(f, { force: true })
		console.log(`Removed ${manifestPath}, ${launcher}, ${hostScript}`)
		return
	}

	const built = join(repo, 'dist-host', 'host.mjs')
	if (!existsSync(built)) throw new Error('dist-host/host.mjs missing: run `npm run build` first')
	const extManifest = JSON.parse(readFileSync(join(repo, 'src', 'manifest.json'), 'utf8')) as { key: string }
	const extensionId = extensionIdFromKey(extManifest.key)

	mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
	copyFileSync(built, hostScript)
	chmodSync(hostScript, 0o600)
	writeFileSync(
		launcher,
		[
			'#!/bin/sh',
			`CLAUDE_ACCOUNTS_DIST=${shellQuote(join(repo, 'dist'))}`,
			'export CLAUDE_ACCOUNTS_DIST',
			`exec ${shellQuote(stableNodePath())} ${shellQuote(hostScript)} "$@"`,
			'',
		].join('\n'),
		{ mode: 0o700 },
	)
	chmodSync(launcher, 0o700)

	mkdirSync(manifestDir, { recursive: true })
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				name: HOST_NAME,
				description: 'Claude accounts: opens claude.ai links in the right Chrome profile',
				path: launcher,
				type: 'stdio',
				allowed_origins: [`chrome-extension://${extensionId}/`],
			},
			null,
			'\t',
		)}\n`,
	)
	console.log(`Installed native host for extension ${extensionId}`)
	console.log(`  manifest: ${manifestPath}`)
	console.log(`  launcher: ${launcher} (node: ${stableNodePath()})`)
	console.log(`  state:    ${join(dataDir(), 'state.json')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
