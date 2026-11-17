// claude.ai calls made by the background itself.

import { checkAccess } from '../shared/access.ts'
import { cookieHeader } from '../shared/cookies.ts'
import type { ProbeReport } from '../shared/messages.ts'
import { classifyProbe, parseAccount, probeUrl, type ProbeResult } from '../shared/probe.ts'
import type { AccountInfo, SavedAccount } from '../shared/types.ts'

/** Well under the 30 s after which Chrome may kill a service worker waiting on fetch. */
const FETCH_TIMEOUT_MS = 8000

export type WhoAmI = { kind: 'ok'; account: AccountInfo } | { kind: 'signed_out' } | { kind: 'unknown' }

/** GET /api/account with the browser's current cookies. */
export async function whoAmI(): Promise<WhoAmI> {
	try {
		const res = await fetch('https://claude.ai/api/account', {
			credentials: 'include',
			cache: 'no-store',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		})
		if (res.headers.get('cf-mitigated') === 'challenge') return { kind: 'unknown' }
		const json = (res.headers.get('content-type') ?? '').includes('application/json')
		const body = json ? await res.json().catch(() => null) : null
		if (res.ok) {
			const account = parseAccount(body)
			return account ? { kind: 'ok', account } : { kind: 'unknown' }
		}
		if ((res.status === 401 || res.status === 403) && json) return { kind: 'signed_out' }
		return { kind: 'unknown' }
	} catch {
		return { kind: 'unknown' }
	}
}

// ---------- silent probe as another saved account ----------
//
// fetch() may not set Cookie, so a one-shot DNR session rule sets it for exactly one
// request: our own (initiator = this extension, not from any tab) to a URL carrying a
// random nonce. credentials:'omit' keeps the real jar out of it, and Set-Cookie in the
// reply is dropped, so the browser's session is never touched.

let ruleSeq = 0

async function nextRuleId(): Promise<number> {
	const existing = new Set((await chrome.declarativeNetRequest.getSessionRules()).map(r => r.id))
	let id = 1000 + (ruleSeq++ % 1000)
	while (existing.has(id)) id = 1000 + (ruleSeq++ % 1000)
	return id
}

let queue: Promise<unknown> = Promise.resolve()

/** Serialized: one probe rule at a time. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const run = queue.then(fn, fn)
	queue = run.catch(() => undefined)
	return run
}

async function probeAs(account: SavedAccount, artifact: string, org: string | null): Promise<ProbeResult> {
	return serial(async () => {
		const nonce = crypto.randomUUID()
		const path = probeUrl(artifact, org, null)
		const url = `https://claude.ai${path}&ca=${nonce}`
		const id = await nextRuleId()
		const header = cookieHeader(account.cookies, Date.now())
		if (!header) return { kind: 'unknown' } as const
		await chrome.declarativeNetRequest.updateSessionRules({
			addRules: [
				{
					id,
					priority: 1,
					action: {
						type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
						requestHeaders: [
							{
								header: 'cookie',
								operation: chrome.declarativeNetRequest.HeaderOperation.SET,
								value: header,
							},
						],
						responseHeaders: [
							{
								header: 'set-cookie',
								operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
							},
						],
					},
					condition: {
						urlFilter: `|${url}|`,
						initiatorDomains: [chrome.runtime.id],
						tabIds: [chrome.tabs.TAB_ID_NONE],
						resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
					},
				},
			],
		})
		try {
			const res = await fetch(url, {
				credentials: 'omit',
				cache: 'no-store',
				headers: { 'X-Frame-CP': 'go' },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			})
			const body =
				res.status !== 200 && (res.headers.get('content-type') ?? '').includes('application/json')
					? await res.json().catch(() => null)
					: null
			await res.body?.cancel().catch(() => undefined)
			return classifyProbe({
				status: res.status,
				header: n => res.headers.get(n),
				body,
			})
		} catch {
			return { kind: 'unknown' } as const
		} finally {
			await chrome.declarativeNetRequest.updateSessionRules({
				removeRuleIds: [id],
			})
		}
	})
}

/** Can `account` open `artifact`? null = couldn't tell (fall back to a visible switch). */
export async function silentCheck(account: SavedAccount, artifact: string): Promise<ProbeReport | null> {
	const lastOrg = account.cookies.find(c => c.name === 'lastActiveOrg')?.value ?? null
	return checkAccess(org => probeAs(account, artifact, org), lastOrg, account)
}

/** Drop probe rules left over from a service worker that died mid-probe. */
export async function clearProbeRules(): Promise<void> {
	const rules = await chrome.declarativeNetRequest.getSessionRules()
	const ids = rules.filter(r => r.id >= 1000 && r.id < 2000).map(r => r.id)
	if (ids.length)
		await chrome.declarativeNetRequest.updateSessionRules({
			removeRuleIds: ids,
		})
}
