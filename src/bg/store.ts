// Extension state. Saved sessions live only in chrome.storage.local, which the
// background restricts to TRUSTED_CONTEXTS (no content-script access). Never sync.

import type { Attempt, CachedArtifact, Mode, SavedAccount, StoredCookie } from '../shared/types.ts'

type Local = {
	accounts?: SavedAccount[]
	activeUuid?: string | null
	mode?: Mode
	artifacts?: Record<string, CachedArtifact>
}

type Session = {
	attempt?: Attempt | null
	/** Heartbeat while a switch runs; survives a service-worker restart, expires after LOCK_TTL_MS. */
	lock?: number | null
	pendingAdd?: boolean
	/** When the last switch started: page reports from before it may describe the previous account. */
	lastSwitchAt?: number
	/** Tabs the extension itself reloaded after a switch: they never trigger routing (tabId → until). */
	quietTabs?: Record<string, number>
	/** Logout guard rule may be removed after this time. */
	guardUntil?: number
	/** In-flight switch, so a restarted service worker can finish or undo it. */
	journal?: Journal | null
	/** Last switch error, shown by the popup next time it opens. */
	lastError?: string | null
}

export type Journal = {
	parked: { id: number; url: string }[]
	/** The jar before the switch (credentials; session storage is memory-only and trusted-only). */
	previous: StoredCookie[]
	swapped: boolean
}

const MAX_CACHED = 500
export const LOCK_TTL_MS = 30_000

let secured: Promise<void> | null = null

/**
 * Saved sessions must be unreadable for content scripts. Fails closed: if Chrome can't
 * restrict storage.local, nothing secret gets stored.
 */
export function ensureSecureStorage(): Promise<void> {
	secured ??= (async () => {
		await chrome.storage.local.setAccessLevel({
			accessLevel: 'TRUSTED_CONTEXTS',
		})
		await chrome.storage.session.setAccessLevel({
			accessLevel: 'TRUSTED_CONTEXTS',
		})
	})().catch(err => {
		secured = null
		throw new Error(
			`This Chrome can't keep saved sessions private (${err instanceof Error ? err.message : err}). Update Chrome.`,
		)
	})
	return secured
}

async function local(): Promise<Local> {
	return (await chrome.storage.local.get(['accounts', 'activeUuid', 'mode', 'artifacts'])) as Local
}

async function session(): Promise<Session> {
	return (await chrome.storage.session.get([
		'attempt',
		'lock',
		'pendingAdd',
		'lastSwitchAt',
		'quietTabs',
		'guardUntil',
		'journal',
		'lastError',
	])) as Session
}

export async function accounts(): Promise<SavedAccount[]> {
	return (await local()).accounts ?? []
}

export async function account(uuid: string): Promise<SavedAccount | undefined> {
	return (await accounts()).find(a => a.uuid === uuid)
}

export async function upsertAccount(next: SavedAccount): Promise<void> {
	await ensureSecureStorage()
	const list = await accounts()
	const i = list.findIndex(a => a.uuid === next.uuid)
	if (i >= 0) list[i] = next
	else list.push(next)
	await chrome.storage.local.set({ accounts: list })
}

export async function patchAccount(uuid: string, patch: Partial<SavedAccount>): Promise<void> {
	const list = await accounts()
	const a = list.find(x => x.uuid === uuid)
	if (!a) return
	Object.assign(a, patch)
	await chrome.storage.local.set({ accounts: list })
}

export async function removeAccount(uuid: string): Promise<void> {
	const l = await local()
	const artifacts = Object.fromEntries(Object.entries(l.artifacts ?? {}).filter(([, v]) => v.accountUuid !== uuid))
	await chrome.storage.local.set({
		accounts: (l.accounts ?? []).filter(a => a.uuid !== uuid),
		artifacts,
	})
}

export async function activeUuid(): Promise<string | null> {
	return (await local()).activeUuid ?? null
}

export async function setActive(uuid: string | null): Promise<void> {
	await chrome.storage.local.set({ activeUuid: uuid })
}

export async function mode(): Promise<Mode> {
	return (await local()).mode ?? 'auto'
}

export async function setMode(m: Mode): Promise<void> {
	await chrome.storage.local.set({ mode: m })
}

export async function artifacts(): Promise<Record<string, CachedArtifact>> {
	return (await local()).artifacts ?? {}
}

export async function cacheArtifact(artifact: string, accountUuid: string): Promise<void> {
	const all = await artifacts()
	all[artifact] = { accountUuid, ts: Date.now() }
	const ids = Object.keys(all)
	if (ids.length > MAX_CACHED) {
		ids.sort((a, b) => (all[a]?.ts ?? 0) - (all[b]?.ts ?? 0))
		for (const id of ids.slice(0, ids.length - MAX_CACHED)) delete all[id]
	}
	await chrome.storage.local.set({ artifacts: all })
}

export async function forgetArtifact(artifact: string): Promise<void> {
	const all = await artifacts()
	delete all[artifact]
	await chrome.storage.local.set({ artifacts: all })
}

export async function attempt(): Promise<Attempt | null> {
	return (await session()).attempt ?? null
}

export async function setAttempt(a: Attempt | null): Promise<void> {
	await chrome.storage.session.set({ attempt: a })
}

export async function locked(): Promise<boolean> {
	const { lock } = await session()
	return !!lock && Date.now() - lock < LOCK_TTL_MS
}

export async function setLock(on: boolean): Promise<void> {
	const patch: Session = on ? { lock: Date.now(), lastSwitchAt: Date.now() } : { lock: null }
	await chrome.storage.session.set(patch)
}

/** Keep a long switch from looking abandoned. */
export async function heartbeat(): Promise<void> {
	const patch: Session = { lock: Date.now() }
	await chrome.storage.session.set(patch)
}

export async function journal(): Promise<Journal | null> {
	return (await session()).journal ?? null
}

export async function setJournal(j: Journal | null): Promise<void> {
	const patch: Session = { journal: j }
	await chrome.storage.session.set(patch)
}

const QUIET_MS = 20_000

export async function quietTabs(ids: readonly number[]): Promise<void> {
	const now = Date.now()
	const cur = (await session()).quietTabs ?? {}
	const next: Record<string, number> = {}
	for (const [k, v] of Object.entries(cur)) if (v > now) next[k] = v
	for (const id of ids) next[String(id)] = now + QUIET_MS
	const patch: Session = { quietTabs: next }
	await chrome.storage.session.set(patch)
}

export async function isQuiet(tabId: number): Promise<boolean> {
	const until = (await session()).quietTabs?.[String(tabId)]
	return !!until && until > Date.now()
}

export async function guardUntil(): Promise<number> {
	return (await session()).guardUntil ?? 0
}

export async function setGuardUntil(ts: number): Promise<void> {
	const patch: Session = { guardUntil: ts }
	await chrome.storage.session.set(patch)
}

export async function takeLastError(): Promise<string | null> {
	const e = (await session()).lastError ?? null
	if (e) await chrome.storage.session.set({ lastError: null } satisfies Session)
	return e
}

export async function setLastError(e: string | null): Promise<void> {
	await chrome.storage.session.set({ lastError: e } satisfies Session)
}

export async function lastSwitchAt(): Promise<number> {
	return (await session()).lastSwitchAt ?? 0
}

export async function pendingAdd(): Promise<boolean> {
	return !!(await session()).pendingAdd
}

export async function setPendingAdd(on: boolean): Promise<void> {
	await chrome.storage.session.set({ pendingAdd: on })
}
