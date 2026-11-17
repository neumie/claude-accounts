// Account switching: park tabs → save the outgoing session → swap cookies →
// verify with the server → roll back on failure → bring tabs back.

import { hasSession } from '../shared/cookies.ts'
import type { AccountInfo, StoredCookie } from '../shared/types.ts'
import { whoAmI } from './claude.ts'
import { clearJar, currentSessionKey, readJar, setPurgeMarker, writeJar } from './jar.ts'
import * as store from './store.ts'
import { parkClaudeTabs, restoreTabs, type Parked } from './tabs.ts'

export type SwitchResult =
	| { ok: true; warning?: string }
	| { ok: false; error: string }

/** While switching (and shortly after) any claude.ai logout request is blocked. */
const GUARD_RULE_ID = 900
const GUARD_AFTER_MS = 30_000
let guardTimer: ReturnType<typeof setTimeout> | undefined

async function guardLogout(on: boolean): Promise<void> {
	clearTimeout(guardTimer)
	if (on) {
		await chrome.declarativeNetRequest.updateSessionRules({
			removeRuleIds: [GUARD_RULE_ID],
			addRules: [
				{
					id: GUARD_RULE_ID,
					priority: 2,
					action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
					condition: {
						regexFilter: '^https://claude\\.ai/(?:[^?#]*/)?(?:log-?out|sign-?out)(?:[/?#]|$)',
						resourceTypes: [
							chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
							chrome.declarativeNetRequest.ResourceType.PING,
							chrome.declarativeNetRequest.ResourceType.OTHER,
						],
					},
				},
			],
		})
	} else {
		guardTimer = setTimeout(() => {
			void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [GUARD_RULE_ID] })
		}, GUARD_AFTER_MS)
	}
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
	if (await store.locked()) throw new Error('Another switch is still running')
	await store.setLock(true)
	await guardLogout(true)
	try {
		return await fn()
	} finally {
		await store.setLock(false)
		await guardLogout(false)
	}
}

function newSwitchId(): string {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * Save the live session under the account it really belongs to. The owner is
 * asked from the server, never assumed; an unknown owner is only saved when `allowNew`.
 */
export async function captureLive(opts: { allowNew: boolean }): Promise<AccountInfo | null> {
	const jar = await readJar()
	if (!hasSession(jar)) return null
	const who = await whoAmI()
	if (who.kind !== 'ok') return null
	// The jar may have changed while we asked (a switch started): only save if it's the same session.
	const key = jar.find(c => c.name === 'sessionKey')?.value
	if ((await currentSessionKey()) !== key) return null
	const existing = await store.account(who.account.uuid)
	if (!existing && !opts.allowNew) {
		await store.setActive(null) // signed in to an account that isn't saved
		return who.account
	}
	const now = Date.now()
	await store.upsertAccount({
		...who.account,
		cookies: jar,
		savedAt: now,
		lastUsedAt: existing?.lastUsedAt ?? now,
		expired: false,
	})
	await store.setActive(who.account.uuid)
	return who.account
}

/** Swap to `target`. `focus` sends one tab to a given URL afterwards (the artifact being opened). */
export async function switchTo(targetUuid: string, focus?: { tabId: number; url: string }): Promise<SwitchResult> {
	const target = await store.account(targetUuid)
	if (!target) return { ok: false, error: 'Unknown account' }
	if (!hasSession(target.cookies)) return { ok: false, error: 'No saved session for this account' }

	let parked: Parked[] = []
	try {
		return await withLock(async () => {
			parked = await parkClaudeTabs()
			const previous = await readJar()
			try {
				await captureLive({ allowNew: false })
				await swapJar(target.cookies)
				const who = await whoAmI()
				if (who.kind === 'signed_out' || (who.kind === 'ok' && who.account.uuid !== target.uuid)) {
					await store.patchAccount(target.uuid, { expired: who.kind === 'signed_out' })
					const restored = await rollback(previous)
					return {
						ok: false,
						error:
							who.kind === 'signed_out'
								? `The saved session for ${target.email} has expired. Sign in to it again.${restored ? '' : ' The previous session could not be restored either.'}`
								: `claude.ai answered with a different account than ${target.email}. Switched back.`,
					} as const
				}
				await store.setActive(target.uuid)
				if (who.kind === 'ok') {
					await store.patchAccount(target.uuid, { ...who.account, lastUsedAt: Date.now(), expired: false })
					return { ok: true } as const
				}
				await store.patchAccount(target.uuid, { lastUsedAt: Date.now() })
				return {
					ok: true,
					warning: "Couldn't confirm the switch with claude.ai. If pages ask you to sign in, switch back.",
				} as const
			} catch (err) {
				await rollback(previous)
				return { ok: false, error: err instanceof Error ? err.message : String(err) } as const
			} finally {
				await setPurgeMarker(newSwitchId()).catch(() => undefined)
			}
		})
	} finally {
		// After the lock is released, so the reloaded pages' own reports are accepted.
		await restoreTabs(parked, focus)
	}
}

async function swapJar(cookies: readonly StoredCookie[]): Promise<void> {
	await clearJar()
	const failed = await writeJar(cookies)
	if (failed.includes('sessionKey')) throw new Error('Chrome refused to set the session cookie')
}

async function rollback(previous: readonly StoredCookie[]): Promise<boolean> {
	await clearJar()
	if (!hasSession(previous)) return false
	const failed = await writeJar(previous)
	return !failed.includes('sessionKey')
}

/**
 * Add account: keep the current session (saved, never logged out: logging out
 * revokes it on the server), clear the jar locally and open the login page.
 */
export async function startAdd(): Promise<void> {
	let parked: Parked[] = []
	try {
		await withLock(async () => {
			parked = await parkClaudeTabs()
			try {
				await captureLive({ allowNew: true })
				await clearJar()
				await store.setActive(null)
				await store.setPendingAdd(true)
			} finally {
				await setPurgeMarker(newSwitchId()).catch(() => undefined)
			}
		})
	} finally {
		const [first, ...rest] = parked
		if (first) {
			await chrome.tabs.update(first.id, { url: 'https://claude.ai/login', active: true }).catch(() => undefined)
			await restoreTabs(rest)
		} else {
			await chrome.tabs.create({ url: 'https://claude.ai/login' })
		}
	}
}

/** A page reported who is signed in. Keep the saved snapshot fresh (sessions rotate). */
export async function onPageAccount(account: AccountInfo | null, reportedAt: number): Promise<void> {
	if (await store.locked()) return
	if (reportedAt < (await store.lastSwitchAt())) return // stale report from before a switch
	if (!account) {
		await store.setActive(null)
		return
	}
	const pending = await store.pendingAdd()
	const saved = await store.account(account.uuid)
	if (!saved && !pending) {
		// Signed in to an account that isn't saved: the popup offers "Save".
		await store.setActive(null)
		return
	}
	const captured = await captureLive({ allowNew: pending })
	if (captured && pending) await store.setPendingAdd(false)
}

export async function saveCurrent(): Promise<AccountInfo> {
	const a = await captureLive({ allowNew: true })
	if (!a) throw new Error('No claude.ai session to save. Sign in first.')
	await store.setPendingAdd(false)
	return a
}

