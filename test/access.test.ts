import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAccess } from '../src/shared/access.ts'
import type { ProbeResult } from '../src/shared/probe.ts'

const X = 'a0000000-0000-4000-8000-000000000000'
const Y = 'b0000000-0000-4000-8000-000000000000'
const Z = 'c0000000-0000-4000-8000-000000000000'
const me = { uuid: X, email: 'ucet3@example.com', orgs: [{ uuid: X, name: 'Personal' }, { uuid: Y, name: 'Team' }] }

function prober(answers: Record<string, ProbeResult>) {
	const calls: (string | null)[] = []
	return { calls, fn: async (org: string | null) => (calls.push(org), answers[org ?? ''] ?? { kind: 'no_access' }) }
}

test('access in the active org', async () => {
	const p = prober({ [X]: { kind: 'access' } })
	assert.deepEqual(await checkAccess(p.fn, X, me), { kind: 'access' })
	assert.deepEqual(p.calls, [X])
})

test('access only in another own org counts as access', async () => {
	const p = prober({ [Y]: { kind: 'access' } })
	assert.deepEqual(await checkAccess(p.fn, X, me), { kind: 'access' })
})

test('mismatch to an own org is verified, not assumed', async () => {
	const p = prober({ [X]: { kind: 'org_mismatch', ownerOrg: Y }, [Y]: { kind: 'no_access' } })
	assert.deepEqual(await checkAccess(p.fn, X, me), { kind: 'no_access' })
	assert.deepEqual(p.calls, [X, Y])
})

test('mismatch to a foreign org is reported with the owner', async () => {
	const p = prober({ [X]: { kind: 'org_mismatch', ownerOrg: Z } })
	assert.deepEqual(await checkAccess(p.fn, X, me), { kind: 'org_mismatch', ownerOrg: Z })
})

test('unknown or signed-out answers stop without a verdict', async () => {
	assert.equal(await checkAccess(prober({ [X]: { kind: 'unknown' } }).fn, X, me), null)
	assert.equal(await checkAccess(prober({ [X]: { kind: 'signed_out' } }).fn, X, me), null)
})

test('no orgs known: one probe without org', async () => {
	const p = prober({ '': { kind: 'access' } })
	assert.deepEqual(await checkAccess(p.fn, null, { ...me, orgs: [] }), { kind: 'access' })
	assert.deepEqual(p.calls, [null])
})
