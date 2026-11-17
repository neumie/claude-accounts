import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyProbe, parseAccount, probeUrl } from '../src/shared/probe.ts'

const ORG = '11111111-2222-4333-8444-555555555555'
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => ({
	status,
	body,
	header: (n: string) => ({ 'content-type': 'application/json', ...extra })[n.toLowerCase()] ?? null,
})
const html = (status: number, extra: Record<string, string> = {}) => ({
	status,
	body: null,
	header: (n: string) => ({ 'content-type': 'text/html', ...extra })[n.toLowerCase()] ?? null,
})

test('200 means access', () => assert.deepEqual(classifyProbe(json(200, null)), { kind: 'access' }))
test('404 JSON means no access', () => assert.deepEqual(classifyProbe(json(404, { reason: 'not_found' })), { kind: 'no_access' }))
test('403 request_access means no access', () =>
	assert.deepEqual(classifyProbe(json(403, { request_access: true })), { kind: 'no_access' }))
test('403 org_mismatch carries the owner org', () =>
	assert.deepEqual(classifyProbe(json(403, { reason: 'org_mismatch', owner_org: ORG.toUpperCase() })), {
		kind: 'org_mismatch',
		ownerOrg: ORG,
	}))
test('org_mismatch with a bad owner_org is plain no access', () =>
	assert.deepEqual(classifyProbe(json(403, { reason: 'org_mismatch', owner_org: 'x' })), { kind: 'no_access' }))
test('401 JSON means signed out', () => assert.deepEqual(classifyProbe(json(401, {})), { kind: 'signed_out' }))

test('Cloudflare challenge or HTML is never acted on', () => {
	assert.deepEqual(classifyProbe(json(403, {}, { 'cf-mitigated': 'challenge' })), { kind: 'unknown' })
	assert.deepEqual(classifyProbe(html(403)), { kind: 'unknown' })
	assert.deepEqual(classifyProbe(html(404)), { kind: 'unknown' })
	assert.deepEqual(classifyProbe(json(500, {})), { kind: 'unknown' })
	assert.deepEqual(classifyProbe(json(429, {})), { kind: 'unknown' })
})

test('probe URL matches what claude.ai sends', () => {
	assert.equal(probeUrl(ORG, ORG, null), `/api/frame/${ORG}?org=${ORG}&bk=probe`)
	assert.equal(probeUrl(ORG, null, 'k1'), `/api/frame/${ORG}?sk=k1&bk=probe`)
})

test('parseAccount keeps only email, uuid and orgs', () => {
	const acc = parseAccount({
		uuid: ORG,
		email_address: 'ucet1@example.com',
		full_name: 'x',
		memberships: [{ organization: { uuid: ORG, name: 'Neumie', capabilities: ['chat'] } }, { organization: { uuid: 'bad' } }],
	})
	assert.deepEqual(acc, { uuid: ORG, email: 'ucet1@example.com', orgs: [{ uuid: ORG, name: 'Neumie' }] })
	assert.equal(parseAccount({ email_address: 'x@y' }), null)
	assert.equal(parseAccount(null), null)
})
