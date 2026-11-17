// Account switching: hold claude.ai page loads → park tabs → save the outgoing
// session → swap cookies → verify with the server → roll back on failure →
// bring tabs back. One switch at a time; a journal lets a restarted service
// worker finish or undo a switch that was cut short.

import { hasSession, SESSION_COOKIE } from '../shared/cookies.ts'
import type { AccountInfo, StoredCookie } from '../shared/types.ts'
import { whoAmI } from './claude.ts'
import { clearJar, currentSessionKey, readJar, setPurgeMarker, writeJar } from './jar.ts'
import * as store from './store.ts'
import { holdClaudeLoads, parkClaudeTabs, releaseHold, reloadTabs, restoreTabs, type Parked } from './tabs.ts'

export type SwitchResult = { ok: true; warning?: string } | { ok: false; error: string }

// ---------- logout guard ----------

/** While switching (and shortly after) every claude.ai logout request is blocked. */
const GUARD_RULE_ID = 900
const GUARD_AFTER_MS = 30_000

async function guardOn(): Promise<void> {
	await store.setGuardUntil(Number.MAX_SAFE_INTEGER)
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [GUARD_RULE_ID],
		addRules: [
			{
				id: GUARD_RULE_ID,
				priority: 4,
				action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
				condition: {
					regexFilter: '^https://claude\\.ai/(?:[^?#]*/)?(?:log-?out|sign-?out)(?:[/?#]|$)',
					resourceTypes: [
						chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
						chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
						chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
						chrome.declarativeNetRequest.ResourceType.PING,
						chrome.declarativeNetRequest.ResourceType.OTHER,
					],
				},
			},
		],
	})
}

async function guardOffLater(): Promise<void> {
	await store.setGuardUntil(Date.now() + GUARD_AFTER_MS)
	setTimeout(() => void expireGuard(), GUARD_AFTER_MS + 100)
}

/** Also called on every service-worker start, so a lost timer can't leave the guard up. */
export async function expireGuard(): Promise<void> {
	if (busy || (await store.locked())) return
	if (Date.now() < (await store.guardUntil())) return
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [GUARD_RULE_ID],
	})
}

// ---------- one switch at a time ----------

let busy = false

export async function isSwitching(): Promise<boolean> {
	return busy || (await store.locked())
}

function newSwitchId(): string {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

type Session = {
	parked: Parked[]
	strays: number[]
	stuck: number[]
	previous: StoredCookie[]
}

/**
 * Runs `body` with claude.ai frozen: loads held, tabs parked, journal written.
 * `body` returns whether the account in the jar changed; the wrap-up depends on it.
 */
async function frozen<T extends { changed: boolean }>(
	body: (s: Session) => Promise<T>,
	after: (s: Session, result: T | null) => Promise<void>,
): Promise<T> {
	if (busy) throw new Error('Another switch is still running')
	busy = true
	if ((await store.locked().catch(() => true)) || (await store.journal().catch(() => null))) {
		busy = false
		throw new Error('Another switch is still running')
	}
	let session: Session = { parked: [], strays: [], stuck: [], previous: [] }
	let result: T | null = null
	try {
		await store.setLock(true)
		await guardOn()
		await holdClaudeLoads()
		const { parked, stuck, strays } = await parkClaudeTabs()
		session = { parked, stuck, strays, previous: await readJar() }
		await store.setJournal({
			parked,
			previous: session.previous,
			swapped: false,
		})
		result = await body(session)
		return result
	} finally {
		try {
			if (result?.changed) await setPurgeMarker(newSwitchId()).catch(() => undefined)
			await releaseHold().catch(() => undefined)
			await after(session, result).catch(() => undefined)
			await reloadTabs(session.strays)
		} finally {
			await store.setJournal(null).catch(() => undefined)
			await store.setLock(false).catch(() => undefined)
			await guardOffLater().catch(() => undefined)
			busy = false
		}
	}
}

const STUCK_ERROR =
	'A claude.ai tab didn’t let go (maybe a “Leave site?” dialog). Close it or answer it, then try again.'

/**
 * Save the live session under the account it really belongs to. The owner is
 * asked from the server, never assumed; an unknown owner is only saved when `allowNew`.
 * Returns the owner, or null if it couldn't be confirmed.
 */
export async function captureLive(opts: { allowNew: boolean }): Promise<AccountInfo | null> {
	const jar = await readJar()
	if (!hasSession(jar)) return null
	const who = await whoAmI()
	if (who.kind !== 'ok') return null
	// The jar may have changed while we asked: only save if it's still the same session.
	const key = jar.find(c => c.name === SESSION_COOKIE)?.value
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

/**
 * Before the jar is cleared, the live session must be safe: saved now, or
 * already saved earlier (same session key). Otherwise clearing it would lose it.
 */
async function secureOutgoing(previous: readonly StoredCookie[]): Promise<AccountInfo | null> {
	if (!hasSession(previous)) return null
	const saved = await captureLive({ allowNew: true })
	if (saved) return saved
	const key = previous.find(c => c.name === SESSION_COOKIE)?.value
	const known = (await store.accounts()).find(a => a.cookies.some(c => c.name === SESSION_COOKIE && c.value === key))
	if (known) return known
	throw new Error(
		'Couldn’t confirm with claude.ai who is signed in right now, so nothing was changed (that session would be lost). Try again in a moment.',
	)
}

async function swapJar(cookies: readonly StoredCookie[]): Promise<void> {
	await clearJar()
	const failed = await writeJar(cookies)
	if (failed.includes(SESSION_COOKIE)) throw new Error('Chrome refused to set the session cookie')
}

async function rollback(previous: readonly StoredCookie[]): Promise<boolean> {
	await clearJar()
	if (!hasSession(previous)) return false
	const failed = await writeJar(previous)
	return !failed.includes(SESSION_COOKIE)
}

export type SwitchOptions = {
	/** One tab goes to this URL afterwards (the artifact being opened). */
	focus?: { tabId: number; url: string }
	/** Only switch if this is still the active account (routing decisions can go stale). */
	ifActive?: string | null
}

/** Swap to `targetUuid`. Never throws; failures come back as { ok: false }. */
export async function switchTo(targetUuid: string, opts: SwitchOptions = {}): Promise<SwitchResult> {
	if (opts.ifActive !== undefined && (await store.activeUuid()) !== opts.ifActive) {
		return {
			ok: false,
			error: 'The active account changed meanwhile; nothing was done.',
		}
	}
	if (!(await store.account(targetUuid))) return { ok: false, error: 'Unknown account' }

	type R = { changed: boolean; res: SwitchResult }
	try {
		const { res } = await frozen<R>(
			async s => {
				if (s.stuck.length) return { changed: false, res: { ok: false, error: STUCK_ERROR } }
				const outgoing = await secureOutgoing(s.previous)
				if (outgoing?.uuid === targetUuid) return { changed: false, res: { ok: true } } // already there
				const target = await store.account(targetUuid) // re-read: may have been refreshed meanwhile
				if (!target || !hasSession(target.cookies)) {
					return {
						changed: false,
						res: { ok: false, error: 'No saved session for this account' },
					}
				}
				await store.heartbeat()
				try {
					await swapJar(target.cookies)
					await store.setJournal({
						parked: s.parked,
						previous: s.previous,
						swapped: true,
					})
					const who = await whoAmI()
					await store.heartbeat()
					if (who.kind === 'signed_out' || (who.kind === 'ok' && who.account.uuid !== target.uuid)) {
						if (who.kind === 'signed_out') await store.patchAccount(target.uuid, { expired: true })
						const restored = await rollback(s.previous)
						const error =
							who.kind === 'signed_out'
								? `The saved session for ${target.email} has expired. Click it to sign in again.${restored ? '' : ' The previous session could not be restored either.'}`
								: `claude.ai answered with a different account than ${target.email}, so nothing was changed.`
						return { changed: !restored, res: { ok: false, error } }
					}
					await store.setActive(target.uuid)
					if (who.kind === 'ok') {
						await store.patchAccount(target.uuid, {
							...who.account,
							lastUsedAt: Date.now(),
							expired: false,
						})
						return { changed: true, res: { ok: true } }
					}
					await store.patchAccount(target.uuid, { lastUsedAt: Date.now() })
					return {
						changed: true,
						res: {
							ok: true,
							warning: 'Couldn’t confirm the switch with claude.ai. If pages ask you to sign in, switch back.',
						},
					}
				} catch (err) {
					const restored = await rollback(s.previous)
					return {
						changed: !restored,
						res: {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						},
					}
				}
			},
			async (s, r) => {
				const changed = !!r?.changed
				await restoreTabs(s.parked, {
					...(opts.focus ? { focus: opts.focus } : {}),
					keepUrls: !changed,
				})
				// Tabs we reloaded ourselves must not start routing on their own (they'd fight each other).
				if (changed) await store.quietTabs(s.parked.map(p => p.id).filter(id => id !== opts.focus?.tabId))
			},
		)
		if (!res.ok) await store.setLastError(res.error)
		return res
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		await store.setLastError(error).catch(() => undefined)
		return { ok: false, error }
	}
}

/**
 * Add account: keep the current session (saved, never logged out: logging out
 * revokes it on the server), clear the jar locally and open the login page.
 */
export async function startAdd(): Promise<void> {
	await frozen<{ changed: boolean; stuck: boolean }>(
		async s => {
			if (s.stuck.length) return { changed: false, stuck: true }
			await secureOutgoing(s.previous)
			await clearJar()
			await store.setActive(null)
			await store.setPendingAdd(true)
			return { changed: true, stuck: false }
		},
		async (s, r) => {
			if (!r?.changed) {
				await restoreTabs(s.parked, { keepUrls: true })
				return
			}
			const [first, ...rest] = s.parked
			await restoreTabs(rest)
			if (first)
				await chrome.tabs.update(first.id, {
					url: 'https://claude.ai/login',
					active: true,
				})
			else await chrome.tabs.create({ url: 'https://claude.ai/login' })
		},
	).then(r => {
		if (r.stuck) throw new Error(STUCK_ERROR)
	})
}

/** A page reported who is signed in. Keep the saved snapshot fresh (sessions rotate). */
export async function onPageAccount(account: AccountInfo | null, reportedAt: number): Promise<void> {
	if (await isSwitching()) return
	if (reportedAt < (await store.lastSwitchAt())) return // stale report from before a switch
	if (!account) {
		await store.setActive(null)
		return
	}
	const pending = await store.pendingAdd()
	if (!(await store.account(account.uuid)) && !pending) {
		await store.setActive(null) // signed in to an account that isn't saved: the popup offers "Save"
		return
	}
	const captured = await captureLive({ allowNew: pending })
	if (captured && pending && (await store.account(captured.uuid))) await store.setPendingAdd(false)
}

export async function saveCurrent(): Promise<AccountInfo> {
	if (await isSwitching()) throw new Error('A switch is running; try again in a moment')
	const a = await captureLive({ allowNew: true })
	if (!a) throw new Error('No claude.ai session to save, or claude.ai didn’t answer. Sign in first, or try again.')
	await store.setPendingAdd(false)
	return a
}

/**
 * Runs when the service worker starts. Only this worker ever switches, so a lock or
 * journal found now belongs to a worker that died mid-switch: put back the previous
 * session if the jar ended up empty, bring the tabs back, drop the stale rules.
 */
export async function recover(): Promise<void> {
	if (busy) return
	const j = await store.journal()
	if (!j) {
		if (await store.locked()) await store.setLock(false)
		await releaseHold().catch(() => undefined)
		await expireGuard().catch(() => undefined)
		return
	}
	busy = true
	try {
		let changed = j.swapped
		if (!(await currentSessionKey()) && hasSession(j.previous)) {
			await rollback(j.previous)
			changed = true
		}
		if (changed) await setPurgeMarker(newSwitchId()).catch(() => undefined)
		await releaseHold().catch(() => undefined)
		await restoreTabs(j.parked, { keepUrls: !changed })
		await store.setJournal(null)
		await store.setLock(false)
		await store.setLastError('A switch was interrupted. Check which account is active.')
	} finally {
		busy = false
	}
	await guardOffLater().catch(() => undefined)
}
