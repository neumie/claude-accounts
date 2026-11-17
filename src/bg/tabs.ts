// While cookies change, no claude.ai page may run: its app would notice the
// account changed under it and call /logout?involuntary=1, which revokes the
// NEW session on the server. So every claude.ai tab is parked on our own page first.

import { parseArtifactUrl } from '../shared/artifact.ts'

const PARK_TIMEOUT_MS = 4000
const CLAUDE_TABS = 'https://claude.ai/*'

export type Parked = { id: number; url: string }

function parkedUrl(): string {
	return chrome.runtime.getURL('switching.html')
}

function waitParked(tabId: number): Promise<void> {
	const target = parkedUrl()
	const done = (t: chrome.tabs.Tab | undefined) => t?.status === 'complete' && (t.url ?? '').startsWith(target)
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
			if (id === tabId && done(tab)) finish()
		}
		chrome.tabs.onUpdated.addListener(listener)
		const timer = setTimeout(finish, PARK_TIMEOUT_MS)
		chrome.tabs.get(tabId).then(t => done(t) && finish(), finish)
	})
}

export async function parkClaudeTabs(): Promise<Parked[]> {
	const tabs = await chrome.tabs.query({ url: CLAUDE_TABS })
	const parked = tabs.filter((t): t is chrome.tabs.Tab & { id: number; url: string } => t.id !== undefined && !!t.url)
	await Promise.all(parked.map(t => chrome.tabs.update(t.id, { url: parkedUrl() }).catch(() => undefined)))
	await Promise.all(parked.map(t => waitParked(t.id)))
	return parked.map(t => ({ id: t.id, url: t.url }))
}

/**
 * Where a tab goes after the switch: artifacts stay (that's the point), anything
 * else lands on /new, since the old account's chats don't exist for the new one.
 */
export function landing(url: string): string {
	return parseArtifactUrl(url) ? url : 'https://claude.ai/new'
}

export async function restoreTabs(parked: readonly Parked[], override?: { tabId: number; url: string }): Promise<void> {
	await Promise.all(
		parked.map(t =>
			chrome.tabs
				.update(t.id, { url: override?.tabId === t.id ? override.url : landing(t.url) })
				.catch(() => undefined),
		),
	)
}
