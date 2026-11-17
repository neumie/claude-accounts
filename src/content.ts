// Runs on claude.ai (top frame, document_start).
// 1. Right after an account switch, drops the page's cached account state before
//    claude.ai's own scripts run (they would otherwise act as the old account).
// 2. Reports who is signed in.
// 3. On artifact pages, checks whether this account can open the artifact, the
//    same way the page itself does, and lets the background route it.
// Never reads session cookies (they are httpOnly); reads only the purge marker
// and lastActiveOrg (an org id).

import { parseArtifactUrl, shortUuid, type ArtifactRef } from './shared/artifact.ts'
import { checkAccess } from './shared/access.ts'
import type { ContentMessage, ProbeReply, Reply } from './shared/messages.ts'
import { classifyProbe, parseAccount, probeUrl, type ProbeResult } from './shared/probe.ts'
import { purgeMarker, purgeSiteData } from './shared/purge.ts'
import type { AccountInfo } from './shared/types.ts'
import { showBanner } from './banner.ts'

// Must run first, synchronously, before any claude.ai script.
const marker = purgeMarker(document.cookie)
if (marker) purgeSiteData(marker, window.localStorage, window.sessionStorage, indexedDB, globalThis.caches)

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
async function fetchAccount(): Promise<AccountInfo | null | undefined> {
	try {
		const res = await fetch('/api/account', {
			credentials: 'same-origin',
			cache: 'no-store',
		})
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
		return classifyProbe({
			status: res.status,
			header: n => res.headers.get(n),
			body,
		})
	} catch {
		return { kind: 'unknown' }
	}
}

function lastActiveOrg(): string | null {
	const m = /(?:^|;\s*)lastActiveOrg=([0-9a-fA-F-]{36})(?:;|$)/.exec(document.cookie)
	return m?.[1]?.toLowerCase() ?? null
}

let accountPromise: Promise<AccountInfo | null | undefined> | null = null

function account(): Promise<AccountInfo | null | undefined> {
	accountPromise ??= (async () => {
		const at = Date.now()
		const a = await fetchAccount()
		if (a !== undefined) await send({ kind: 'account', account: a, at }).catch(() => undefined)
		return a
	})()
	return accountPromise
}

/** Reloads and back/forward (including restored tabs) never trigger routing. */
function isRevisit(): boolean {
	const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
	return nav?.type === 'reload' || nav?.type === 'back_forward'
}

const handled = new Set<string>()

async function onUrl(href: string): Promise<void> {
	const ref = parseArtifactUrl(href)
	if (!ref || handled.has(ref.uuid)) return
	handled.add(ref.uuid)
	if (ref.shareKey) return // share links open for anyone with the key
	const at = Date.now()
	const me = await account()
	if (!me) return // signed out or unknown: nothing to compare against
	const result = await checkAccess(org => probe(ref, org), lastActiveOrg(), me)
	if (!result) return
	let reply: ProbeReply
	try {
		reply = await send<ProbeReply>({
			kind: 'probe',
			artifact: ref.uuid,
			url: href,
			result,
			at,
		})
	} catch {
		return
	}
	render(reply, me, ref, href)
}

function render(reply: ProbeReply, me: AccountInfo, ref: ArtifactRef, href: string): void {
	switch (reply.action) {
		case 'none':
			return
		case 'switching':
			showBanner({
				tone: 'info',
				text: reply.verified
					? `${me.email} can't open this artifact. Switching to ${reply.target.email}…`
					: `${me.email} can't open this artifact. Trying ${reply.target.email}…`,
			})
			return
		case 'routedHere':
			showBanner({
				tone: 'info',
				text: reply.from
					? `Switched to ${me.email}: ${reply.from} can't open this artifact.`
					: `Switched to ${me.email}.`,
				autoHideMs: 6000,
			})
			return
		case 'ask':
			showBanner({
				tone: 'warn',
				text: reply.verified
					? `${me.email} can't open this artifact. ${reply.target.email} can.`
					: `${me.email} can't open this artifact. Try ${reply.target.email}?`,
				actions: [
					{
						label: `Switch to ${reply.target.email}`,
						primary: true,
						run: () =>
							send({
								kind: 'switchFor',
								uuid: reply.target.uuid,
								url: href,
							}).then(
								() => true,
								() => false,
							),
					},
					{ label: 'Stay', run: async () => true },
				],
			})
			return
		case 'exhausted':
			showBanner({
				tone: 'warn',
				text: `None of your saved accounts can open artifact ${shortUuid(ref.uuid)}.`,
			})
			return
	}
}

function start(): void {
	void account()
	if (!isRevisit()) void onUrl(location.href)
	// In-app navigation (sidebar, links inside claude.ai) doesn't reload the content script.
	const nav = (window as unknown as { navigation?: EventTarget }).navigation
	nav?.addEventListener('navigatesuccess', () => void onUrl(location.href))
}

// A prerendered page isn't shown yet: wait until the user actually lands on it.
const doc = document as Document & { prerendering?: boolean }
if (doc.prerendering)
	document.addEventListener('prerenderingchange', () => start(), {
		once: true,
	})
else start()
