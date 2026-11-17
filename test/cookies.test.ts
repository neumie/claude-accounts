import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cookieHeader, cookieUrl, hasSession, isAccountCookie, setDetails } from '../src/shared/cookies.ts'
import type { StoredCookie } from '../src/shared/types.ts'

const NOW = 1_800_000_000_000
const c = (name: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({
	name,
	value: `v-${name}`,
	domain: '.claude.ai',
	path: '/',
	secure: true,
	httpOnly: true,
	sameSite: 'lax',
	hostOnly: false,
	session: false,
	expirationDate: NOW / 1000 + 3600,
	...extra,
})

test('device and Cloudflare cookies never move between accounts', () => {
	for (const n of ['anthropic-device-id', 'cf_clearance', '__cf_bm', '_cfuvid', 'cf_chl_rc_m']) assert.equal(isAccountCookie(n), false, n)
	for (const n of ['sessionKey', 'sessionKeyLC', 'routingHint', 'lastActiveOrg', 'activitySessionId', '__Host-sessionBinding'])
		assert.equal(isAccountCookie(n), true, n)
})

test('host-only and __Host- cookies are written without Domain', () => {
	assert.equal(setDetails(c('lastActiveOrg', { domain: 'claude.ai', hostOnly: true }), NOW)?.domain, undefined)
	assert.equal(setDetails(c('__Host-sessionBinding', { domain: 'claude.ai', hostOnly: false }), NOW)?.domain, undefined)
	assert.equal(setDetails(c('sessionKey'), NOW)?.domain, '.claude.ai')
	assert.equal(setDetails(c('sessionKey'), NOW)?.url, 'https://claude.ai/')
})

test('expired cookies are skipped, session cookies kept without expiry', () => {
	assert.equal(setDetails(c('x', { expirationDate: NOW / 1000 - 1 }), NOW), null)
	const s = setDetails(c('ion', { session: true, expirationDate: undefined }), NOW)
	assert.ok(s)
	assert.equal(s.expirationDate, undefined)
})

test('probe Cookie header carries only live account cookies', () => {
	const h = cookieHeader([c('sessionKey'), c('cf_clearance'), c('old', { expirationDate: NOW / 1000 - 5 })], NOW)
	assert.equal(h, 'sessionKey=v-sessionKey')
})

test('hasSession needs a non-empty sessionKey', () => {
	assert.equal(hasSession([c('sessionKey')]), true)
	assert.equal(hasSession([c('sessionKey', { value: '' })]), false)
	assert.equal(hasSession([c('routingHint')]), false)
	assert.equal(cookieUrl({ domain: 'claude.ai', path: '' }), 'https://claude.ai/')
})
