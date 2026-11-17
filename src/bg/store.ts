// Extension state. Saved sessions live only in chrome.storage.local, which the
// background restricts to TRUSTED_CONTEXTS (no content-script access). Never sync.

import type { Attempt, CachedArtifact, Mode, SavedAccount } from '../shared/types.ts'

type Local = {
	accounts?: SavedAccount[]
	activeUuid?: string | null
	mode?: Mode
	artifacts?: Record<string, CachedArtifact>
}

type Session = {
	attempt?: Attempt | null
	/** Timestamp while a switch runs; survives a service-worker restart, expires after LOCK_TTL_MS. */
	lock?: number | null
	pendingAdd?: boolean
	/** When the last switch started: page reports from before it may describe the previous account. */
	lastSwitchAt?: number
}

const MAX_CACHED = 500
export const LOCK_TTL_MS = 30_000

export async function init(): Promise<void> {
	await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
	await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
}

async function local(): Promise<Local> {
	return (await chrome.storage.local.get(['accounts', 'activeUuid', 'mode', 'artifacts'])) as Local
}

async function session(): Promise<Session> {
	return (await chrome.storage.session.get(['attempt', 'lock', 'pendingAdd', 'lastSwitchAt'])) as Session
}

export async function accounts(): Promise<SavedAccount[]> {
	return (await local()).accounts ?? []
}

export async function account(uuid: string): Promise<SavedAccount | undefined> {
	return (await accounts()).find(a => a.uuid === uuid)
}

export async function upsertAccount(next: SavedAccount): Promise<void> {
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
	await chrome.storage.local.set({ accounts: (l.accounts ?? []).filter(a => a.uuid !== uuid), artifacts })
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

export async function lastSwitchAt(): Promise<number> {
	return (await session()).lastSwitchAt ?? 0
}

export async function pendingAdd(): Promise<boolean> {
	return !!(await session()).pendingAdd
}

export async function setPendingAdd(on: boolean): Promise<void> {
	await chrome.storage.session.set({ pendingAdd: on })
}
