// Pure state transitions for the shared routing state. No I/O here, so the
// whole routing policy is unit-testable.

import { isUuid } from '../src/shared/artifact.ts'
import {
	MODES,
	STATE_VERSION,
	type Account,
	type Attempt,
	type Mode,
	type ProbeOutcome,
	type ProfileEntry,
	type RouteReason,
	type RouteTarget,
	type SharedState,
} from '../src/shared/protocol.ts'

/** A routing round (one artifact hopping between profiles) expires this long after its last step. */
export const ATTEMPT_TTL_MS = 10 * 60_000
export const MAX_CACHED_ARTIFACTS = 1000

export function emptyState(): SharedState {
	return { version: STATE_VERSION, mode: 'auto', profiles: {}, artifacts: {}, attempts: {} }
}

const DIR_RE = /^(Default|Profile \d{1,4}|[A-Za-z0-9 _.-]{1,64})$/

export function isProfileDir(value: unknown): value is string {
	return typeof value === 'string' && DIR_RE.test(value) && value !== '.' && value !== '..' && !value.includes('/')
}

function sanitizeAccount(raw: unknown): Account | null {
	if (!raw || typeof raw !== 'object') return null
	const a = raw as Record<string, unknown>
	if (!isUuid(a.uuid) || typeof a.email !== 'string' || !a.email.includes('@')) return null
	const orgs = Array.isArray(a.orgs)
		? a.orgs
				.filter((o): o is { uuid: string; name: unknown } => !!o && typeof o === 'object' && isUuid((o as { uuid?: unknown }).uuid))
				.slice(0, 50)
				.map(o => ({ uuid: o.uuid.toLowerCase(), name: typeof o.name === 'string' ? o.name.slice(0, 120) : '' }))
		: []
	return { uuid: a.uuid.toLowerCase(), email: a.email.slice(0, 254), orgs }
}

export function sanitizeIncomingAccount(raw: unknown): Account | null {
	return sanitizeAccount(raw)
}

/** Accepts whatever is on disk and returns a valid state; drops anything malformed. */
export function normalizeState(raw: unknown): SharedState {
	const state = emptyState()
	if (!raw || typeof raw !== 'object') return state
	const r = raw as Record<string, unknown>
	if (r.version !== STATE_VERSION) return state
	if (typeof r.mode === 'string' && (MODES as readonly string[]).includes(r.mode)) state.mode = r.mode as Mode
	if (r.profiles && typeof r.profiles === 'object') {
		for (const [dir, p] of Object.entries(r.profiles as Record<string, unknown>)) {
			if (!isProfileDir(dir) || !p || typeof p !== 'object') continue
			const e = p as Record<string, unknown>
			state.profiles[dir] = {
				dir,
				account: sanitizeAccount(e.account),
				lastSeen: typeof e.lastSeen === 'number' ? e.lastSeen : 0,
			}
		}
	}
	if (r.artifacts && typeof r.artifacts === 'object') {
		for (const [id, a] of Object.entries(r.artifacts as Record<string, unknown>)) {
			const e = a as Record<string, unknown> | null
			if (!isUuid(id) || !e || !isUuid(e.accountUuid) || typeof e.ts !== 'number') continue
			state.artifacts[id] = { accountUuid: e.accountUuid, ts: e.ts }
		}
	}
	if (r.attempts && typeof r.attempts === 'object') {
		for (const [id, a] of Object.entries(r.attempts as Record<string, unknown>)) {
			const e = a as Record<string, unknown> | null
			if (!isUuid(id) || !e || !Array.isArray(e.tried) || typeof e.ts !== 'number') continue
			state.attempts[id] = {
				tried: e.tried.filter(isProfileDir),
				fromEmail: typeof e.fromEmail === 'string' ? e.fromEmail : null,
				ts: e.ts,
			}
		}
	}
	return state
}

export function prune(state: SharedState, now: number): void {
	for (const [id, a] of Object.entries(state.attempts)) {
		if (now - a.ts > ATTEMPT_TTL_MS) delete state.attempts[id]
	}
	const ids = Object.keys(state.artifacts)
	if (ids.length > MAX_CACHED_ARTIFACTS) {
		ids.sort((a, b) => (state.artifacts[a]?.ts ?? 0) - (state.artifacts[b]?.ts ?? 0))
		for (const id of ids.slice(0, ids.length - MAX_CACHED_ARTIFACTS)) delete state.artifacts[id]
	}
}

/** Profiles that exist in Chrome right now; entries for deleted profiles are dropped. */
export function syncProfiles(state: SharedState, existingDirs: readonly string[]): void {
	const keep = new Set(existingDirs)
	for (const dir of Object.keys(state.profiles)) if (!keep.has(dir)) delete state.profiles[dir]
}

export function applySeen(state: SharedState, dir: string, account: Account | null, now: number): void {
	const prev = state.profiles[dir]
	state.profiles[dir] = { dir, account, lastSeen: account ? now : (prev?.lastSeen ?? 0) }
}

function signedIn(p: ProfileEntry | undefined): p is ProfileEntry & { account: Account } {
	return !!p?.account
}

export type RouteInput = {
	dir: string
	artifact: string
	outcome: ProbeOutcome
	ownerOrg: string | null
}

export type RouteResult = { mode: Mode; target: RouteTarget | null; reason: RouteReason }

/**
 * Profile `dir` could not open `artifact`. Pick the next profile to try, and
 * record the attempt so the same round never revisits a profile.
 */
export function route(state: SharedState, input: RouteInput, now: number): RouteResult {
	const mode = state.mode
	if (mode === 'off') return { mode, target: null, reason: 'off' }
	// The origin may be signed out (account null): it still routes, it just can't be a target.
	const fromAccount = state.profiles[input.dir]?.account ?? null

	// Same account, other org: claude.ai switches orgs on its own.
	if (input.outcome === 'org_mismatch' && input.ownerOrg && fromAccount?.orgs.some(o => o.uuid === input.ownerOrg)) {
		return { mode, target: null, reason: 'same_account' }
	}

	let attempt: Attempt | undefined = state.attempts[input.artifact]
	if (!attempt || now - attempt.ts > ATTEMPT_TTL_MS) {
		attempt = { tried: [], fromEmail: fromAccount?.email ?? null, ts: now }
	}
	if (!attempt.tried.includes(input.dir)) attempt.tried.push(input.dir)
	attempt.ts = now
	state.attempts[input.artifact] = attempt
	const tried = new Set(attempt.tried)
	// Accounts already ruled out in this round (also covers one account signed in to two profiles).
	const triedAccounts = new Set(
		attempt.tried.map(d => state.profiles[d]?.account?.uuid).filter((u): u is string => !!u),
	)

	const candidates = Object.values(state.profiles)
		.filter(signedIn)
		.filter(p => !tried.has(p.dir) && !triedAccounts.has(p.account.uuid))
		.sort((a, b) => b.lastSeen - a.lastSeen || a.dir.localeCompare(b.dir))
	const pick = (p: ProfileEntry & { account: Account }, reason: RouteReason): RouteResult => ({
		mode,
		target: { dir: p.dir, email: p.account.email },
		reason,
	})

	const cached = state.artifacts[input.artifact]
	if (cached) {
		if (cached.accountUuid === fromAccount?.uuid) {
			delete state.artifacts[input.artifact] // stale: this account lost access
		} else {
			const hit = candidates.find(p => p.account.uuid === cached.accountUuid)
			if (hit) return pick(hit, 'cache')
		}
	}

	if (input.outcome === 'org_mismatch' && input.ownerOrg) {
		const owner = candidates.find(p => p.account.orgs.some(o => o.uuid === input.ownerOrg))
		if (owner) return pick(owner, 'owner_org')
	}

	const next = candidates[0]
	if (next) return pick(next, 'next')
	return { mode, target: null, reason: 'exhausted' }
}

/** Profile `dir` opened `artifact`: remember it and close the routing round. */
export function recordAccess(
	state: SharedState,
	input: { dir: string; artifact: string; accountUuid: string },
	now: number,
): { routedFrom: string | null } {
	state.artifacts[input.artifact] = { accountUuid: input.accountUuid, ts: now }
	const attempt = state.attempts[input.artifact]
	delete state.attempts[input.artifact]
	if (!attempt || now - attempt.ts > ATTEMPT_TTL_MS) return { routedFrom: null }
	const self = state.profiles[input.dir]?.account?.email ?? null
	return { routedFrom: attempt.fromEmail && attempt.fromEmail !== self ? attempt.fromEmail : null }
}

/** The user acted on a routing suggestion: keep the round (and its tried list) alive. */
export function touchAttempt(state: SharedState, artifact: string, now: number): void {
	const attempt = state.attempts[artifact]
	if (attempt && now - attempt.ts <= ATTEMPT_TTL_MS) attempt.ts = now
}

export function forget(state: SharedState, artifact: string): void {
	delete state.artifacts[artifact]
	delete state.attempts[artifact]
}
