// Messages inside the extension (content script / popup → background).

import type { Account, ChromeProfile, Mode, RouteTarget, SharedState } from './protocol.ts'

export type ProbeReport =
	| { kind: 'access' }
	| { kind: 'no_access' }
	| { kind: 'org_mismatch'; ownerOrg: string }

export type ContentMessage =
	| { kind: 'account'; account: Account | null }
	| { kind: 'probe'; artifact: string; url: string; result: ProbeReport; freshTab: boolean }
	| { kind: 'openElsewhere'; dir: string; url: string; closeTab: boolean }

export type ProbeReply =
	| { action: 'none' }
	| { action: 'routedHere'; from: string }
	| { action: 'opened'; target: RouteTarget }
	| { action: 'ask'; target: RouteTarget }
	| { action: 'exhausted' }

export type PopupMessage =
	| { kind: 'popupState'; tabUrl: string | null }
	| { kind: 'openProfile'; dir: string; url: string }
	| { kind: 'setMode'; mode: Mode }
	| { kind: 'setDir'; dir: string }
	| { kind: 'detectDir' }
	| { kind: 'forget'; artifact: string }

export type PopupState = {
	host: { ok: true } | { ok: false; error: string }
	dir: string | null
	me: Account | null
	meKnown: boolean
	chromeProfiles: ChromeProfile[]
	state: SharedState | null
	distDir: string | null
	tab: { artifact: string; url: string } | null
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }
