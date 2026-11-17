// Pure routing policy: given what we know, which saved accounts should be
// tried for an artifact the active account can't open, in what order.

import type { AccountInfo, CachedArtifact } from './types.ts'

export type RouteInput = {
	activeUuid: string | null
	accounts: readonly (AccountInfo & { lastUsedAt: number; expired: boolean })[]
	cached: CachedArtifact | undefined
	ownerOrg: string | null
	tried: readonly string[]
}

export type Candidate = { uuid: string; email: string; why: 'cache' | 'owner_org' | 'other' }

export function candidates(input: RouteInput): Candidate[] {
	const skip = new Set([...input.tried, ...(input.activeUuid ? [input.activeUuid] : [])])
	const pool = input.accounts
		.filter(a => !a.expired && !skip.has(a.uuid))
		.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.email.localeCompare(b.email))
	const out: Candidate[] = []
	const add = (a: AccountInfo, why: Candidate['why']) => {
		if (!out.some(c => c.uuid === a.uuid)) out.push({ uuid: a.uuid, email: a.email, why })
	}
	const cached = input.cached && pool.find(a => a.uuid === input.cached?.accountUuid)
	if (cached) add(cached, 'cache')
	if (input.ownerOrg) for (const a of pool) if (a.orgs.some(o => o.uuid === input.ownerOrg)) add(a, 'owner_org')
	for (const a of pool) add(a, 'other')
	return out
}

/** Same account, other org: claude.ai switches orgs on its own, nothing to do. */
export function ownOrg(active: AccountInfo | undefined, ownerOrg: string | null): boolean {
	return !!active && !!ownerOrg && active.orgs.some(o => o.uuid === ownerOrg)
}

export const ATTEMPT_TTL_MS = 2 * 60_000
