import { isUuid } from './artifact.ts'

// Mirrors how claude.ai's own frame shell reads GET /api/frame/<uuid>?bk=probe.
export type ProbeResult =
	| { kind: 'access' }
	| { kind: 'signed_out' }
	| { kind: 'org_mismatch'; ownerOrg: string }
	| { kind: 'no_access' }
	/** Cloudflare challenge, network error, 5xx, HTML, anything we can't read. Never act on it. */
	| { kind: 'unknown' }

export type ProbeResponse = {
	status: number
	/** Lower-cased header lookup. */
	header: (name: string) => string | null
	body: unknown
}

export function classifyProbe(res: ProbeResponse): ProbeResult {
	const { status } = res
	if ((status === 403 || status === 404) && res.header('cf-mitigated') === 'challenge') return { kind: 'unknown' }
	if (status === 200) return { kind: 'access' }
	const json = (res.header('content-type') ?? '').includes('application/json')
	if (!json) return { kind: 'unknown' }
	if (status === 401) return { kind: 'signed_out' }
	if (status === 403 || status === 404) {
		const body = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : null
		if (status === 403 && body?.reason === 'org_mismatch' && isUuid(body.owner_org)) {
			return { kind: 'org_mismatch', ownerOrg: body.owner_org.toLowerCase() }
		}
		return { kind: 'no_access' }
	}
	return { kind: 'unknown' }
}

export function probeUrl(artifact: string, org: string | null, shareKey: string | null): string {
	const params = new URLSearchParams()
	if (org) params.set('org', org)
	if (shareKey) params.set('sk', shareKey)
	params.set('bk', 'probe')
	return `/api/frame/${artifact}?${params.toString()}`
}

/** GET /api/account → our Account shape, or null if the body is not an account. */
export function parseAccount(body: unknown): {
	uuid: string
	email: string
	orgs: { uuid: string; name: string }[]
} | null {
	if (!body || typeof body !== 'object') return null
	const b = body as Record<string, unknown>
	const uuid = b.uuid
	const email = b.email_address
	if (!isUuid(uuid) || typeof email !== 'string' || !email.includes('@')) return null
	const orgs: { uuid: string; name: string }[] = []
	for (const m of Array.isArray(b.memberships) ? b.memberships : []) {
		const org = m && typeof m === 'object' ? (m as Record<string, unknown>).organization : null
		if (!org || typeof org !== 'object') continue
		const o = org as Record<string, unknown>
		if (!isUuid(o.uuid)) continue
		orgs.push({
			uuid: o.uuid.toLowerCase(),
			name: typeof o.name === 'string' ? o.name.slice(0, 120) : '',
		})
	}
	return { uuid: uuid.toLowerCase(), email: email.slice(0, 254), orgs }
}
