import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySeen, ATTEMPT_TTL_MS, emptyState, normalizeState, recordAccess, route, touchAttempt } from '../host/logic.ts'
import type { Account, SharedState } from '../src/shared/protocol.ts'

const ART = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const acc = (n: number, orgs: string[] = []): Account => ({
	uuid: `0000000${n}-0000-4000-8000-000000000000`,
	email: n === 1 ? 'ucet1@example.com' : n === 2 ? 'ucet2@example.com' : 'ucet3@example.com',
	orgs: orgs.map(o => ({ uuid: o, name: o.slice(0, 4) })),
})
const ORG_A = 'a0000000-0000-4000-8000-000000000000'
const ORG_B = 'b0000000-0000-4000-8000-000000000000'

function three(): SharedState {
	const s = emptyState()
	applySeen(s, 'Default', acc(1, [ORG_A]), 3000)
	applySeen(s, 'Profile 1', acc(2, [ORG_B]), 2000)
	applySeen(s, 'Profile 2', acc(3), 1000)
	return s
}

test('no access: tries the most recently used other profile, then the next, then gives up', () => {
	const s = three()
	let r = route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 10)
	assert.deepEqual(r, { mode: 'auto', target: { dir: 'Profile 1', email: 'ucet2@example.com' }, reason: 'next' })
	r = route(s, { dir: 'Profile 1', artifact: ART, outcome: 'no_access', ownerOrg: null }, 20)
	assert.deepEqual(r.target, { dir: 'Profile 2', email: 'ucet3@example.com' })
	r = route(s, { dir: 'Profile 2', artifact: ART, outcome: 'no_access', ownerOrg: null }, 30)
	assert.deepEqual(r, { mode: 'auto', target: null, reason: 'exhausted' })
	// Never bounces back into the round: the start profile is not offered again.
	r = route(s, { dir: 'Profile 2', artifact: ART, outcome: 'no_access', ownerOrg: null }, 40)
	assert.equal(r.target, null)
})

test('a stale round starts over', () => {
	const s = three()
	route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 0)
	route(s, { dir: 'Profile 1', artifact: ART, outcome: 'no_access', ownerOrg: null }, 1)
	const r = route(s, { dir: 'Profile 2', artifact: ART, outcome: 'no_access', ownerOrg: null }, 2 + ATTEMPT_TTL_MS)
	assert.equal(r.reason, 'next')
	assert.equal(r.target?.dir, 'Default')
})

test('owner org of another account goes straight there', () => {
	const s = three()
	const r = route(s, { dir: 'Default', artifact: ART, outcome: 'org_mismatch', ownerOrg: ORG_B }, 10)
	assert.deepEqual(r.target, { dir: 'Profile 1', email: 'ucet2@example.com' })
	assert.equal(r.reason, 'owner_org')
})

test('owner org of the same account is left to claude.ai', () => {
	const s = three()
	const r = route(s, { dir: 'Default', artifact: ART, outcome: 'org_mismatch', ownerOrg: ORG_A }, 10)
	assert.deepEqual(r, { mode: 'auto', target: null, reason: 'same_account' })
	assert.equal(s.attempts[ART], undefined)
})

test('cache wins, and access closes the round with a "routed from" note', () => {
	const s = three()
	recordAccess(s, { dir: 'Profile 2', artifact: ART, accountUuid: acc(3).uuid }, 5)
	const r = route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 10)
	assert.deepEqual(r.target, { dir: 'Profile 2', email: 'ucet3@example.com' })
	assert.equal(r.reason, 'cache')
	assert.deepEqual(recordAccess(s, { dir: 'Profile 2', artifact: ART, accountUuid: acc(3).uuid }, 11), {
		routedFrom: 'ucet1@example.com',
	})
	assert.equal(s.attempts[ART], undefined)
	assert.deepEqual(recordAccess(s, { dir: 'Profile 2', artifact: ART, accountUuid: acc(3).uuid }, 12), { routedFrom: null })
})

test('a cache entry pointing at the current account is stale and dropped', () => {
	const s = three()
	recordAccess(s, { dir: 'Default', artifact: ART, accountUuid: acc(1).uuid }, 5)
	const r = route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 10)
	assert.equal(r.reason, 'next')
	assert.equal(s.artifacts[ART], undefined)
})

test('cache pointing at a profile already tried this round is skipped', () => {
	const s = three()
	recordAccess(s, { dir: 'Profile 1', artifact: ART, accountUuid: acc(2).uuid }, 5)
	route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 10) // → Profile 1 via cache
	const r = route(s, { dir: 'Profile 1', artifact: ART, outcome: 'no_access', ownerOrg: null }, 11)
	assert.deepEqual(r.target, { dir: 'Profile 2', email: 'ucet3@example.com' })
})

test('one account in two profiles counts as tried once', () => {
	const s = three()
	applySeen(s, 'Profile 3', acc(1, [ORG_A]), 2500)
	const r = route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 10)
	assert.notEqual(r.target?.dir, 'Profile 3')
})

test('off mode does nothing', () => {
	const s = three()
	s.mode = 'off'
	assert.equal(route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 1).reason, 'off')
	assert.equal(s.attempts[ART], undefined)
})

test('a signed-out or never-seen origin still routes, and is never a target', () => {
	const s = three()
	applySeen(s, 'Default', null, 5)
	let r = route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 10)
	assert.equal(r.target?.dir, 'Profile 1')
	assert.equal(s.attempts[ART]?.fromEmail, null)
	const t = three()
	r = route(t, { dir: 'Profile 9', artifact: ART, outcome: 'no_access', ownerOrg: null }, 10)
	assert.equal(r.target?.dir, 'Default')
})

test('touching a round keeps it alive past the TTL', () => {
	const s = three()
	route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 0)
	touchAttempt(s, ART, ATTEMPT_TTL_MS - 1)
	const r = route(s, { dir: 'Profile 1', artifact: ART, outcome: 'no_access', ownerOrg: null }, 2 * ATTEMPT_TTL_MS - 2)
	assert.equal(r.target?.dir, 'Profile 2') // Default stays ruled out
})

test('signed-out profiles are not routing targets', () => {
	const s = three()
	applySeen(s, 'Profile 1', null, 50)
	const r = route(s, { dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null }, 60)
	assert.equal(r.target?.dir, 'Profile 2')
})

test('normalizeState drops junk and path-like profile dirs', () => {
	const s = normalizeState({
		version: 1,
		mode: 'weird',
		profiles: { '../x': { account: null }, Default: { account: acc(1), lastSeen: 1 } },
		artifacts: { 'not-uuid': { accountUuid: acc(1).uuid, ts: 1 }, [ART]: { accountUuid: acc(1).uuid, ts: 1 } },
		attempts: { [ART]: { tried: ['Default', '../etc'], fromEmail: 'x@y', ts: 1 } },
	})
	assert.equal(s.mode, 'auto')
	assert.deepEqual(Object.keys(s.profiles), ['Default'])
	assert.deepEqual(Object.keys(s.artifacts), [ART])
	assert.deepEqual(s.attempts[ART]?.tried, ['Default'])
	assert.deepEqual(normalizeState({ version: 99 }), emptyState())
})
