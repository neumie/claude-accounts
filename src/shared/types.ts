export type Mode = 'auto' | 'ask' | 'off'
export const MODES: readonly Mode[] = ['auto', 'ask', 'off']

export type Org = { uuid: string; name: string }

/** Who an account is. Safe to show and to send to content scripts. */
export type AccountInfo = {
	uuid: string
	email: string
	orgs: Org[]
}

/** A claude.ai cookie as chrome.cookies returns it (value included: this is a credential). */
export type StoredCookie = {
	name: string
	value: string
	domain: string
	path: string
	secure: boolean
	httpOnly: boolean
	sameSite: chrome.cookies.Cookie['sameSite']
	hostOnly: boolean
	session: boolean
	expirationDate?: number
}

/** Kept only in chrome.storage.local (TRUSTED_CONTEXTS); never leaves the background. */
export type SavedAccount = AccountInfo & {
	cookies: StoredCookie[]
	savedAt: number
	lastUsedAt: number
	/** The server rejected the stored session: sign in again to refresh it. */
	expired: boolean
}

/** What the popup may see about a saved account: no cookies. */
export type AccountView = AccountInfo & {
	lastUsedAt: number
	expired: boolean
}

export function toView(a: SavedAccount): AccountView {
	return {
		uuid: a.uuid,
		email: a.email,
		orgs: a.orgs,
		lastUsedAt: a.lastUsedAt,
		expired: a.expired,
	}
}

export type CachedArtifact = { accountUuid: string; ts: number }

/** One artifact link being walked through the saved accounts (chrome.storage.session). */
export type Attempt = {
	artifact: string
	url: string
	tabId: number
	/** Account the link was first opened with; we return to it if nobody can open the artifact. */
	originUuid: string | null
	tried: string[]
	/** Every saved account was tried; stop routing this artifact until the attempt expires. */
	done: boolean
	ts: number
}
