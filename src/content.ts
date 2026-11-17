// Runs on claude.ai (top frame). Reads who is signed in, and on artifact
// pages checks whether this account can open the artifact, the same way the
// page itself does. Reads only the non-httpOnly lastActiveOrg cookie (an org
// id); never writes cookies or page storage.

import { parseArtifactUrl, shortUuid, type ArtifactRef } from './shared/artifact.ts'
import type { ContentMessage, ProbeReply, Reply } from './shared/messages.ts'
import { checkAccess } from './shared/access.ts'
import { classifyProbe, parseAccount, probeUrl, type ProbeResult } from './shared/probe.ts'
import type { Account } from './shared/protocol.ts'
import { showBanner } from './banner.ts'

const HEADERS = { 'X-Frame-CP': 'go' }

async function send<T>(msg: ContentMessage): Promise<T> {
	const res = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined
	if (!res?.ok) throw new Error(res?.error ?? 'no reply')
	return res.data
}

async function readJson(res: Response): Promise<unknown> {
	if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null
	return res.json().catch(() => null)
}

/** undefined = could not tell (challenge, network); null = signed out. */
async function fetchAccount(): Promise<Account | null | undefined> {
	try {
		const res = await fetch('/api/account', { credentials: 'same-origin', cache: 'no-store' })
		if (res.headers.get('cf-mitigated') === 'challenge') return undefined
		const body = await readJson(res)
		if (res.ok) return parseAccount(body) ?? undefined
		if ((res.status === 401 || res.status === 403) && body !== null) return null
		return undefined
	} catch {
		return undefined
	}
}

async function probe(ref: ArtifactRef, org: string | null): Promise<ProbeResult> {
	try {
		const res = await fetch(probeUrl(ref.uuid, org, ref.shareKey), {
			credentials: 'same-origin',
			cache: 'no-store',
			headers: HEADERS,
		})
		const body = res.status === 200 ? null : await readJson(res)
		await res.body?.cancel().catch(() => undefined)
		return classifyProbe({ status: res.status, header: n => res.headers.get(n), body })
	} catch {
		return { kind: 'unknown' }
	}
}

function lastActiveOrg(): string | null {
	const m = /(?:^|;\s*)lastActiveOrg=([0-9a-fA-F-]{36})(?:;|$)/.exec(document.cookie)
	return m?.[1]?.toLowerCase() ?? null
}

let accountPromise: Promise<Account | null | undefined> | null = null

function account(): Promise<Account | null | undefined> {
	accountPromise ??= fetchAccount().then(async a => {
		if (a !== undefined) await send({ kind: 'account', account: a }).catch(() => undefined)
		return a
	})
	return accountPromise
}

const handled = new Set<string>()

/** Reloads and back/forward (including restored tabs) never trigger routing. */
function isRevisit(): boolean {
	const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
	return nav?.type === 'reload' || nav?.type === 'back_forward'
}

async function onUrl(href: string, freshTab: boolean): Promise<void> {
	const ref = parseArtifactUrl(href)
	if (!ref || handled.has(ref.uuid)) return
	handled.add(ref.uuid)
	if (ref.shareKey) return // share links open for anyone with the key
	const me = await account()
	if (me === undefined) return // couldn't tell who is signed in: do nothing
	// Signed out here: no probe possible, but another profile may open it.
	const result = me === null ? { kind: 'no_access' as const } : await checkAccess(org => probe(ref, org), lastActiveOrg(), me)
	if (!result) return
	let reply: ProbeReply
	try {
		reply = await send<ProbeReply>({ kind: 'probe', artifact: ref.uuid, url: href, result, freshTab })
	} catch {
		return
	}
	render(reply, me, ref, href)
}

function render(reply: ProbeReply, me: Account | null, ref: ArtifactRef, href: string): void {
	const who = me?.email ?? 'This profile'
	switch (reply.action) {
		case 'none':
			return
		case 'routedHere':
			showBanner({ tone: 'info', text: `Opened here: ${reply.from} can't open this artifact.`, autoHideMs: 6000 })
			return
		case 'opened':
			showBanner({ tone: 'info', text: `Opened in ${reply.target.email}'s Chrome profile. ${who} can't open it.` })
			return
		case 'ask':
			showBanner({
				tone: 'warn',
				text: `${who} can't open this artifact. ${reply.target.email} might.`,
				actions: [
					{
						label: `Open as ${reply.target.email}`,
						primary: true,
						run: () =>
							send({ kind: 'openElsewhere', dir: reply.target.dir, url: href, closeTab: false }).then(
								() => true,
								() => false,
							),
					},
					{ label: 'Stay', run: async () => true },
				],
			})
			return
		case 'exhausted':
			showBanner({ tone: 'warn', text: `None of your Claude accounts can open artifact ${shortUuid(ref.uuid)}.` })
			return
	}
}

function start(): void {
	const freshTab = history.length <= 1
	void account()
	if (!isRevisit()) void onUrl(location.href, freshTab)
	// In-app navigation (sidebar, links inside claude.ai) doesn't reload the content script.
	const nav = (window as unknown as { navigation?: EventTarget }).navigation
	nav?.addEventListener('navigatesuccess', () => void onUrl(location.href, false))
}

// A prerendered page isn't the main frame yet: wait until the user actually lands on it.
const doc = document as Document & { prerendering?: boolean }
if (doc.prerendering) document.addEventListener('prerenderingchange', () => start(), { once: true })
else start()
