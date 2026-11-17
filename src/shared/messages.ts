// Messages inside the extension (content script / popup → background).

import type { AccountInfo, AccountView, CachedArtifact, Mode } from './types.ts'

export type ProbeReport = { kind: 'access' } | { kind: 'no_access' } | { kind: 'org_mismatch'; ownerOrg: string }

export type ContentMessage =
	| { kind: 'account'; account: AccountInfo | null; at: number }
	| {
			kind: 'probe'
			artifact: string
			url: string
			result: ProbeReport
			at: number
	  }
	| { kind: 'switchFor'; uuid: string; url: string }

export type Target = { uuid: string; email: string }

export type ProbeReply =
	| { action: 'none' }
	/** The background is switching accounts; this page is about to be parked.
	 * verified: the target was checked and can open it (else it's just being tried). */
	| { action: 'switching'; target: Target; verified: boolean }
	| { action: 'routedHere'; from: string | null }
	| { action: 'ask'; target: Target; verified: boolean }
	| { action: 'exhausted'; backTo: string | null }

export type PopupMessage =
	| { kind: 'popupState'; tabUrl: string | null }
	| { kind: 'switch'; uuid: string; url: string | null }
	| { kind: 'save' }
	| { kind: 'add' }
	| { kind: 'remove'; uuid: string }
	| { kind: 'setMode'; mode: Mode }
	| { kind: 'forget'; artifact: string }

export type PopupState = {
	accounts: AccountView[]
	activeUuid: string | null
	/** Signed in to claude.ai with an account that isn't saved yet. */
	unsaved: AccountInfo | null
	signedIn: boolean
	mode: Mode
	switching: boolean
	/** A switch that failed while the popup was closed. */
	lastError: string | null
	tab: {
		tabId: number
		artifact: string
		url: string
		cached: CachedArtifact | null
	} | null
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }
