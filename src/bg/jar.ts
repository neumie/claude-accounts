// The browser's claude.ai cookie jar. Only account cookies are read or written;
// device and Cloudflare cookies are never touched. Values are never logged.

import { cookieUrl, isAccountCookie, isClaudeDomain, setDetails, SESSION_COOKIE, toStored } from '../shared/cookies.ts'
import type { StoredCookie } from '../shared/types.ts'

export async function readJar(): Promise<StoredCookie[]> {
	const all = await chrome.cookies.getAll({ domain: 'claude.ai' })
	return all.filter(c => isClaudeDomain(c.domain) && isAccountCookie(c.name)).map(toStored)
}

export async function currentSessionKey(): Promise<string | null> {
	const c = await chrome.cookies.get({ url: 'https://claude.ai/', name: SESSION_COOKIE })
	return c?.value || null
}

export async function clearJar(): Promise<void> {
	const all = await chrome.cookies.getAll({ domain: 'claude.ai' })
	await Promise.all(
		all
			.filter(c => isClaudeDomain(c.domain) && isAccountCookie(c.name) && c.name !== PURGE_MARKER)
			.map(c => chrome.cookies.remove({ url: cookieUrl(c), name: c.name }).catch(() => null)),
	)
}

/** Writes a snapshot back. Returns names that could not be written. */
export async function writeJar(cookies: readonly StoredCookie[]): Promise<string[]> {
	const failed: string[] = []
	const now = Date.now()
	for (const c of cookies) {
		if (!isAccountCookie(c.name) || c.name === PURGE_MARKER) continue
		const details = setDetails(c, now)
		if (!details) continue // expired: Chrome would drop it anyway
		try {
			if (!(await chrome.cookies.set(details))) failed.push(c.name)
		} catch {
			failed.push(c.name)
		}
	}
	return failed
}

/**
 * Marker the content script reads synchronously at document_start: "a switch
 * happened, drop the page's cached account state before claude.ai's own scripts run".
 * Its value is the switch id, so each tab and the shared storage purge once per switch.
 */
export const PURGE_MARKER = 'ca_purge'
const MARKER_TTL_S = 120

export async function setPurgeMarker(switchId: string): Promise<void> {
	await chrome.cookies.set({
		url: 'https://claude.ai/',
		name: PURGE_MARKER,
		value: switchId,
		path: '/',
		secure: true,
		httpOnly: false,
		sameSite: 'lax',
		expirationDate: Math.floor(Date.now() / 1000) + MARKER_TTL_S,
	})
}
