// Chrome-on-macOS specifics: where profiles live, which profile an extension
// instance runs in, and how to open a URL in a given profile.

import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChromeProfile } from '../src/shared/protocol.ts'
import { isProfileDir } from './logic.ts'

export function chromeRoot(): string {
	return process.env.CLAUDE_ACCOUNTS_CHROME_ROOT ?? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

/** Profiles from Chrome's `Local State` (dir + display name). */
export function listChromeProfiles(root = chromeRoot()): ChromeProfile[] {
	let localState: unknown
	try {
		localState = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))
	} catch {
		return []
	}
	const cache = (localState as { profile?: { info_cache?: Record<string, { name?: unknown }> } })?.profile?.info_cache
	if (!cache || typeof cache !== 'object') return []
	return Object.entries(cache)
		.filter(([dir]) => isProfileDir(dir))
		.map(([dir, info]) => ({ dir, name: typeof info?.name === 'string' ? info.name.slice(0, 80) : dir }))
		.sort((a, b) => a.dir.localeCompare(b.dir, 'en', { numeric: true }))
}

const EXT_ID_RE = /^[a-p]{32}$/
const NONCE_RE = /^[0-9a-f]{32}$/
const MAX_SCAN_BYTES = 8 * 1024 * 1024

/**
 * Each extension instance writes a random nonce into its chrome.storage.local.
 * Chrome keeps that store as LevelDB under `<profile>/Local Extension Settings/<id>/`,
 * so the profile whose files contain the nonce is the caller's profile.
 */
export function findProfileByNonce(extensionId: string, nonce: string, root = chromeRoot()): string | null {
	if (!EXT_ID_RE.test(extensionId) || !NONCE_RE.test(nonce)) return null
	const needle = Buffer.from(nonce, 'utf8')
	for (const { dir } of listChromeProfiles(root)) {
		const storeDir = join(root, dir, 'Local Extension Settings', extensionId)
		let files: string[]
		try {
			files = readdirSync(storeDir)
		} catch {
			continue
		}
		for (const f of files) {
			if (!/\.(log|ldb)$/.test(f)) continue
			const path = join(storeDir, f)
			try {
				if (statSync(path).size > MAX_SCAN_BYTES) continue
				if (readFileSync(path).includes(needle)) return dir
			} catch {
				// unreadable file, try the next one
			}
		}
	}
	return null
}

export function isOpenableUrl(href: string): boolean {
	try {
		const url = new URL(href)
		return url.protocol === 'https:' && url.hostname === 'claude.ai' && !url.username && !url.password
	} catch {
		return false
	}
}

export type Opener = (dir: string, url: string) => Promise<void>

/** `open -na` hands the URL to the running Chrome, which opens it in that profile's window. */
export const openInProfile: Opener = (dir, url) =>
	new Promise((resolve, reject) => {
		const app = process.env.CLAUDE_ACCOUNTS_CHROME_APP ?? 'Google Chrome'
		execFile('/usr/bin/open', ['-na', app, '--args', `--profile-directory=${dir}`, url], { timeout: 10_000 }, err =>
			err ? reject(new Error(`open failed: ${err.message}`)) : resolve(),
		)
	})
