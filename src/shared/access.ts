import type { ProbeReport } from './messages.ts'
import type { ProbeResult } from './probe.ts'
import type { AccountInfo as Account } from './types.ts'

/** Probe with the active org first, then the account's other orgs (claude.ai switches orgs itself). */
export async function checkAccess(
	probe: (org: string | null) => Promise<ProbeResult>,
	active: string | null,
	me: Account,
): Promise<ProbeReport | null> {
	const queue = [active, ...me.orgs.map(o => o.uuid).filter(o => o !== active)].filter((o): o is string => !!o)
	if (queue.length === 0) queue.push('')
	const probed = new Set<string>()
	let mismatch: string | null = null
	while (queue.length > 0) {
		const org = queue.shift() ?? ''
		if (probed.has(org)) continue
		probed.add(org)
		const r = await probe(org || null)
		if (r.kind === 'access') return { kind: 'access' }
		if (r.kind === 'signed_out' || r.kind === 'unknown') return null
		if (r.kind === 'org_mismatch') {
			// Owner org is one of mine: check that org next, and count it as access only on a 200.
			if (me.orgs.some(o => o.uuid === r.ownerOrg)) queue.unshift(r.ownerOrg)
			else mismatch = r.ownerOrg
		}
	}
	return mismatch ? { kind: 'org_mismatch', ownerOrg: mismatch } : { kind: 'no_access' }
}
