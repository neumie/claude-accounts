import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base58ToUuid, parseArtifactUrl, uuidToBase58 } from '../src/shared/artifact.ts'

const UUID = '0b4c8f5e-6a1d-4f2b-9c3e-7d8a9b0c1d2e'

test('base58 round-trips UUIDs, including leading zero bytes', () => {
	for (const u of [UUID, '00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
		const short = uuidToBase58(u)
		assert.equal(short.length, 22)
		assert.equal(base58ToUuid(short), u)
	}
})

test('base58 rejects bad input', () => {
	assert.equal(base58ToUuid('0OIl0OIl0OIl0OIl0OIl0O'), null) // chars outside the alphabet
	assert.equal(base58ToUuid('abc'), null)
	assert.equal(base58ToUuid('zzzzzzzzzzzzzzzzzzzzzz'), null) // > 128 bits
})

test('parses every artifact URL form', () => {
	const short = uuidToBase58(UUID)
	for (const href of [
		`https://claude.ai/artifact/${short}`,
		`https://claude.ai/artifact/${UUID}`,
		`https://claude.ai/artifact/${UUID.toUpperCase()}`,
		`https://claude.ai/code/artifact/${short}`,
		`https://claude.ai/code/frame/${short}`,
		`https://claude.ai/artifact/q3-pricing-model-${short}`,
		`https://claude.ai/artifact/my-page-${UUID}?x=1#y`,
		`https://claude.ai/artifact/${short}/`,
	]) {
		assert.deepEqual(parseArtifactUrl(href), { uuid: UUID, shareKey: null }, href)
	}
})

test('keeps a valid share key, drops a malformed one', () => {
	const short = uuidToBase58(UUID)
	assert.equal(parseArtifactUrl(`https://claude.ai/artifact/${short}?sk=abc_DEF-123`)?.shareKey, 'abc_DEF-123')
	assert.equal(parseArtifactUrl(`https://claude.ai/artifact/${short}?sk=${'a'.repeat(65)}`)?.shareKey, null)
})

test('ignores non-artifact and foreign URLs', () => {
	const short = uuidToBase58(UUID)
	for (const href of [
		'https://claude.ai/new',
		'https://claude.ai/chat/0b4c8f5e-6a1d-4f2b-9c3e-7d8a9b0c1d2e',
		`https://evil.example/artifact/${short}`,
		`https://claude.ai.evil.example/artifact/${short}`,
		`http://claude.ai/artifact/${short}`,
		`https://claude.ai/artifact/${short}x`,
		`https://claude.ai/artifacts/${short}`,
		'not a url',
	]) {
		assert.equal(parseArtifactUrl(href), null, href)
	}
})
