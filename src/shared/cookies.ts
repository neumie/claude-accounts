// Which claude.ai cookies belong to an account (swapped on switch) and which
// belong to this browser/device (never touched). Pure helpers, unit-tested.

import type { StoredCookie } from './types.ts'

export const SESSION_COOKIE = 'sessionKey'

/**
 * Device and anti-bot cookies stay as they are across accounts. Everything else on
 * claude.ai (sessionKey, sessionKeyLC, routingHint, lastActiveOrg, activitySessionId,
 * __Host-sessionBinding*, analytics) is per account and moves with it.
 */
const DEVICE_COOKIES = new Set(['anthropic-device-id', 'cf_clearance', '__cf_bm', '_cfuvid', '__cflb'])

export function isAccountCookie(name: string): boolean {
	return !DEVICE_COOKIES.has(name) && !name.startsWith('cf_chl')
}

export function isClaudeDomain(domain: string): boolean {
	return domain === 'claude.ai' || domain === '.claude.ai'
}

export function cookieUrl(c: { domain: string; path: string }): string {
	return `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`
}

export function toStored(c: chrome.cookies.Cookie): StoredCookie {
	return {
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: c.path,
		secure: c.secure,
		httpOnly: c.httpOnly,
		sameSite: c.sameSite,
		hostOnly: c.hostOnly,
		session: c.session,
		...(c.expirationDate === undefined ? {} : { expirationDate: c.expirationDate }),
	}
}

export function hasSession(cookies: readonly StoredCookie[]): boolean {
	return cookies.some(c => c.name === SESSION_COOKIE && c.value.length > 0)
}

/** chrome.cookies.set details that recreate `c` exactly (host-only stays host-only). */
export function setDetails(c: StoredCookie, now: number): chrome.cookies.SetDetails | null {
	if (!c.session && c.expirationDate !== undefined && c.expirationDate * 1000 <= now) return null
	const d: chrome.cookies.SetDetails = {
		url: cookieUrl(c),
		name: c.name,
		value: c.value,
		path: c.path,
		secure: c.secure,
		httpOnly: c.httpOnly,
		sameSite: c.sameSite as chrome.cookies.SetDetails['sameSite'],
	}
	// __Host- cookies must not carry Domain; host-only cookies would otherwise widen to .claude.ai.
	if (!c.hostOnly && !c.name.startsWith('__Host-')) d.domain = c.domain
	if (!c.session && c.expirationDate !== undefined) d.expirationDate = c.expirationDate
	return d
}

/** Cookie header for a background request made as `cookies`' account. */
export function cookieHeader(cookies: readonly StoredCookie[], now: number): string {
	return cookies
		.filter(
			c => isAccountCookie(c.name) && (c.session || c.expirationDate === undefined || c.expirationDate * 1000 > now),
		)
		.map(c => `${c.name}=${c.value}`)
		.join('; ')
}
