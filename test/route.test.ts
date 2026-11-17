import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidates, ownOrg } from '../src/shared/route.ts'

const ORG_A = 'a0000000-0000-4000-8000-000000000000'
const ORG_B = 'b0000000-0000-4000-8000-000000000000'
const acc = (uuid: string, email: string, lastUsedAt: number, orgs: string[] = [], expired = false) => ({
	uuid,
	email,
	lastUsedAt,
	expired,
	orgs: orgs.map(o => ({ uuid: o, name: '' })),
})
const C1 = acc('u1', 'ucet1@example.com', 300, [ORG_A])
const C = acc('u2', 'ucet2@example.com', 200, [ORG_B])
const N = acc('u3', 'ucet3@example.com', 100)
const ALL = [C1, C, N]

test('others by most recent use, never the active one', () => {
	const r = candidates({ activeUuid: 'u1', accounts: ALL, cached: undefined, ownerOrg: null, tried: [] })
	assert.deepEqual(r.map(x => x.uuid), ['u2', 'u3'])
})

test('cache first, then owner org, then the rest', () => {
	let r = candidates({ activeUuid: 'u1', accounts: ALL, cached: { accountUuid: 'u3', ts: 1 }, ownerOrg: null, tried: [] })
	assert.deepEqual(r.map(x => [x.uuid, x.why]), [['u3', 'cache'], ['u2', 'other']])
	r = candidates({ activeUuid: 'u3', accounts: ALL, cached: undefined, ownerOrg: ORG_B, tried: [] })
	assert.deepEqual(r.map(x => [x.uuid, x.why]), [['u2', 'owner_org'], ['u1', 'other']])
})

test('tried and expired accounts are skipped', () => {
	const expired = acc('u3', 'ucet3@example.com', 100, [], true)
	const r = candidates({ activeUuid: 'u1', accounts: [C1, C, expired], cached: { accountUuid: 'u3', ts: 1 }, ownerOrg: null, tried: ['u2'] })
	assert.deepEqual(r, [])
})

test('no active account (signed out): everyone is a candidate', () => {
	assert.equal(candidates({ activeUuid: null, accounts: ALL, cached: undefined, ownerOrg: null, tried: [] }).length, 3)
})

test('own org is left to claude.ai', () => {
	assert.equal(ownOrg(C1, ORG_A), true)
	assert.equal(ownOrg(C1, ORG_B), false)
	assert.equal(ownOrg(undefined, ORG_A), false)
	assert.equal(ownOrg(C1, null), false)
})
