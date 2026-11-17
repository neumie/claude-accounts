// The shared state file. Several profiles can call the host at once, so every
// read-modify-write runs under a lock directory and the write is atomic.

import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SharedState } from '../src/shared/protocol.ts'
import { normalizeState } from './logic.ts'

export function dataDir(): string {
	return process.env.CLAUDE_ACCOUNTS_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'claude-accounts')
}

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms))
}

async function acquire(lock: string): Promise<void> {
	const start = Date.now()
	for (;;) {
		try {
			mkdirSync(lock)
			return
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
			try {
				// Break a stale lock by renaming it first: only one waiter can win the rename,
				// so two waiters can't both remove it and then both take it.
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
					const grave = `${lock}.stale.${process.pid}.${Date.now()}`
					renameSync(lock, grave)
					if (Date.now() - statSync(grave).mtimeMs > LOCK_STALE_MS) rmdirSync(grave)
					else renameSync(grave, lock) // it was a fresh lock taken meanwhile: put it back
				}
			} catch {
				// someone else released it meanwhile
			}
			if (Date.now() - start > LOCK_WAIT_MS) throw new Error('state is locked')
			await sleep(25)
		}
	}
}

export function readState(dir = dataDir()): SharedState {
	try {
		return normalizeState(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')))
	} catch {
		return normalizeState(null)
	}
}

export async function updateState<T>(fn: (state: SharedState) => T, dir = dataDir()): Promise<T> {
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const lock = join(dir, 'state.lock')
	await acquire(lock)
	try {
		const state = readState(dir)
		const result = fn(state)
		const file = join(dir, 'state.json')
		const tmp = join(dir, `state.json.${process.pid}.tmp`)
		writeFileSync(tmp, `${JSON.stringify(state, null, '\t')}\n`, { mode: 0o600 })
		chmodSync(tmp, 0o600)
		renameSync(tmp, file)
		return result
	} finally {
		try {
			rmdirSync(lock)
		} catch {
			// already gone
		}
	}
}
