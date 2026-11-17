// While cookies change, no claude.ai page may run: its app would notice the
// account changed under it and call /logout?involuntary=1, which revokes the
// NEW session on the server. So every claude.ai tab is parked on our own page
// first, and new claude.ai page loads are held back until the switch is over.

import { parseArtifactUrl } from '../shared/artifact.ts'

const PARK_TIMEOUT_MS = 4000
const CLAUDE_TABS = 'https://claude.ai/*'
const HOLD_RULE_ID = 901

export type Parked = { id: number; url: string }

function parkedUrl(): string {
	return chrome.runtime.getURL('switching.html')
}

function isParked(t: chrome.tabs.Tab | undefined): boolean {
	return t?.status === 'complete' && (t.url ?? '').startsWith(parkedUrl())
}

function waitParked(tabId: number): Promise<void> {
	return new Promise(resolve => {
		let finished = false
		const finish = () => {
			if (finished) return
			finished = true
			chrome.tabs.onUpdated.removeListener(listener)
			clearTimeout(timer)
			resolve()
		}
		const listener = (id: number, _c: unknown, tab: chrome.tabs.Tab) => {
			if (id === tabId && isParked(tab)) finish()
		}
		chrome.tabs.onUpdated.addListener(listener)
		const timer = setTimeout(finish, PARK_TIMEOUT_MS)
		chrome.tabs.get(tabId).then(t => isParked(t) && finish(), finish)
	})
}

/** Block claude.ai page loads (main frame and frames) until releaseHold(). */
export async function holdClaudeLoads(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [HOLD_RULE_ID],
		addRules: [
			{
				id: HOLD_RULE_ID,
				priority: 3,
				action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
				condition: {
					requestDomains: ['claude.ai'],
					resourceTypes: [
						chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
						chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
					],
				},
			},
		],
	})
}

export async function releaseHold(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [HOLD_RULE_ID],
	})
}

/** stuck: parked tabs whose page didn't let go (e.g. a "Leave site?" dialog). strays: tabs that
 * tried to load claude.ai during the hold (blocked, so not running); reload them afterwards. */
export type ParkResult = {
	parked: Parked[]
	stuck: number[]
	strays: number[]
}

/** Call with the hold already on, so no claude.ai page can start after the query. */
export async function parkClaudeTabs(): Promise<ParkResult> {
	const tabs = await chrome.tabs.query({ url: CLAUDE_TABS })
	const parked = tabs
		.filter((t): t is chrome.tabs.Tab & { id: number; url: string } => t.id !== undefined && !!t.url)
		.map(t => ({ id: t.id, url: t.url }))
	await Promise.all(parked.map(t => chrome.tabs.update(t.id, { url: parkedUrl() }).catch(() => undefined)))
	await Promise.all(parked.map(t => waitParked(t.id)))
	const stuck: number[] = []
	for (const t of parked) {
		const now = await chrome.tabs.get(t.id).catch(() => undefined)
		if (now && !isParked(now)) stuck.push(t.id)
	}
	const strays: number[] = []
	for (const t of await chrome.tabs.query({ url: CLAUDE_TABS })) {
		if (t.id !== undefined && !parked.some(p => p.id === t.id)) strays.push(t.id)
	}
	return { parked, stuck, strays }
}

/**
 * Where a tab goes after a switch: artifacts stay (that's the point), anything
 * else lands on /new, since the old account's chats don't exist for the new one.
 */
export function landing(url: string): string {
	return parseArtifactUrl(url) ? url : 'https://claude.ai/new'
}

export async function restoreTabs(
	parked: readonly Parked[],
	opts: { focus?: { tabId: number; url: string }; keepUrls?: boolean } = {},
): Promise<void> {
	await Promise.all(
		parked.map(t => {
			const url = opts.focus?.tabId === t.id ? opts.focus.url : opts.keepUrls ? t.url : landing(t.url)
			return chrome.tabs.update(t.id, { url }).catch(() => undefined)
		}),
	)
}

export async function reloadTabs(ids: readonly number[]): Promise<void> {
	await Promise.all(ids.map(id => chrome.tabs.reload(id).catch(() => undefined)))
}
