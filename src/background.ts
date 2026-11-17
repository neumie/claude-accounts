// Service worker: owns saved sessions, switching and artifact routing.

import { parseArtifactUrl } from './shared/artifact.ts'
import { accountColor, initials } from './shared/avatar.ts'
import type { ContentMessage, PopupMessage, PopupState, ProbeReply, Reply, Target } from './shared/messages.ts'
import { ATTEMPT_TTL_MS, candidates, ownOrg } from './shared/route.ts'
import { MODES, toView, type Attempt } from './shared/types.ts'
import { clearProbeRules, silentCheck, whoAmI } from './bg/claude.ts'
import { currentSessionKey } from './bg/jar.ts'
import * as store from './bg/store.ts'
import {
	captureLive,
	expireGuard,
	isSwitching,
	onPageAccount,
	recover,
	saveCurrent,
	startAdd,
	switchTo,
} from './bg/switch.ts'

// ---------- badge ----------

async function updateBadge(): Promise<void> {
	const uuid = await store.activeUuid()
	const a = uuid ? await store.account(uuid) : undefined
	if (a) {
		await chrome.action.setBadgeText({ text: initials(a.email) })
		await chrome.action.setBadgeBackgroundColor({
			color: accountColor(a.email),
		})
		await chrome.action.setTitle({ title: `Claude accounts: ${a.email}` })
	} else {
		await chrome.action.setBadgeText({ text: '' })
		await chrome.action.setTitle({ title: 'Claude accounts' })
	}
}

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && ('activeUuid' in changes || 'accounts' in changes)) void updateBadge()
})

// ---------- artifact routing ----------

function target(a: { uuid: string; email: string }): Target {
	return { uuid: a.uuid, email: a.email }
}

async function onProbe(msg: Extract<ContentMessage, { kind: 'probe' }>, tabId: number): Promise<ProbeReply> {
	const ref = parseArtifactUrl(msg.url)
	if (!ref || ref.uuid !== msg.artifact) return { action: 'none' }
	if (await isSwitching()) return { action: 'none' }
	const since = await store.lastSwitchAt()
	if (msg.at < since) return { action: 'none' } // probed before a switch
	// Tabs we reloaded after a switch don't route on their own: several artifact tabs
	// owned by different accounts would otherwise switch back and forth forever.
	const quiet = await store.isQuiet(tabId)
	const [active, accounts, mode, cache] = await Promise.all([
		store.activeUuid(),
		store.accounts(),
		store.mode(),
		store.artifacts(),
	])
	const now = Date.now()
	let attempt: Attempt | null = await store.attempt()
	if (!attempt || attempt.artifact !== ref.uuid || now - attempt.ts > ATTEMPT_TTL_MS) attempt = null

	if (msg.result.kind === 'access') {
		if (!active) return { action: 'none' }
		if (quiet) {
			await store.cacheArtifact(ref.uuid, active)
			return { action: 'none' }
		}
		await store.cacheArtifact(ref.uuid, active)
		if (!attempt) return { action: 'none' }
		await store.setAttempt(null)
		const from = attempt.originUuid && attempt.originUuid !== active ? attempt.originUuid : null
		return {
			action: 'routedHere',
			from: accounts.find(a => a.uuid === from)?.email ?? null,
		}
	}

	if (mode === 'off' || quiet) return { action: 'none' }
	// Signed in to an account that isn't saved: switching away would need it saved first.
	if (!active) return { action: 'none' }
	const activeAccount = accounts.find(a => a.uuid === active)
	const ownerOrg = msg.result.kind === 'org_mismatch' ? msg.result.ownerOrg : null
	if (ownOrg(activeAccount, ownerOrg)) return { action: 'none' }
	if (attempt?.done) return { action: 'exhausted', backTo: null }

	const round: Attempt = attempt ?? {
		artifact: ref.uuid,
		url: msg.url,
		tabId,
		originUuid: active,
		tried: [],
		done: false,
		ts: now,
	}
	round.ts = now
	round.tabId = tabId
	if (active && !round.tried.includes(active)) round.tried.push(active)
	if (cache[ref.uuid]?.accountUuid === active) await store.forgetArtifact(ref.uuid)

	// Ask accounts silently first; whatever can't be checked silently is tried by switching.
	let pick: Target | null = null
	let verified = false
	let silent = true
	for (const c of candidates({
		activeUuid: active,
		accounts,
		cached: cache[ref.uuid],
		ownerOrg,
		tried: round.tried,
	})) {
		const acc = accounts.find(a => a.uuid === c.uuid)
		if (!acc) continue
		if (silent) {
			const r = await silentCheck(acc, ref.uuid).catch(() => null)
			if (r?.kind === 'access') {
				pick = target(acc)
				verified = true
				break
			}
			if (r) {
				round.tried.push(acc.uuid) // checked: it can't open it either
				continue
			}
			silent = false
		}
		pick = target(acc)
		break
	}

	// The silent checks took a while: if the user switched meanwhile, this decision is stale.
	if ((await isSwitching()) || (await store.lastSwitchAt()) !== since || (await store.activeUuid()) !== active) {
		return { action: 'none' }
	}
	const focus = { tabId, url: msg.url }

	if (!pick) {
		round.done = true
		await store.setAttempt(round)
		const origin = accounts.find(a => a.uuid === round.originUuid)
		if (origin && origin.uuid !== active && mode === 'auto') {
			setTimeout(() => void switchTo(origin.uuid, { focus, ifActive: active }), 0)
			return { action: 'switching', target: target(origin), verified: false }
		}
		return { action: 'exhausted', backTo: null }
	}

	// Counted as tried now: if the switch fails, the next round moves on instead of retrying it.
	round.tried.push(pick.uuid)
	await store.setAttempt(round)
	if (mode === 'ask') return { action: 'ask', target: pick, verified }
	const chosen = pick
	// Reply first: the page gets parked as part of the switch.
	setTimeout(() => void switchTo(chosen.uuid, { focus, ifActive: active }), 0)
	return { action: 'switching', target: chosen, verified }
}

// ---------- content script ----------

async function onContent(msg: ContentMessage, tabId: number): Promise<unknown> {
	switch (msg.kind) {
		case 'account':
			await onPageAccount(msg.account, msg.at)
			return {}
		case 'probe':
			return onProbe(msg, tabId)
		case 'switchFor': {
			// "Open as …" in the Ask banner.
			if (!parseArtifactUrl(msg.url)) throw new Error('not an artifact link')
			if (!(await store.account(msg.uuid))) throw new Error('unknown account')
			setTimeout(() => void switchTo(msg.uuid, { focus: { tabId, url: msg.url } }), 0)
			return {}
		}
	}
}

// ---------- popup ----------

async function popupState(tabUrl: string | null, tabId: number | null): Promise<PopupState> {
	const [accounts, mode, cache, switching, key] = await Promise.all([
		store.accounts(),
		store.mode(),
		store.artifacts(),
		isSwitching(),
		currentSessionKey(),
	])
	const lastError = await store.takeLastError()
	let activeUuid = await store.activeUuid()
	let unsaved: PopupState['unsaved'] = null
	if (key && !switching && !accounts.some(a => a.uuid === activeUuid)) {
		const who = await whoAmI()
		if (who.kind === 'ok') {
			if (accounts.some(a => a.uuid === who.account.uuid)) {
				// A saved account signed in outside the extension: refresh its snapshot.
				await captureLive({ allowNew: false })
				activeUuid = await store.activeUuid()
			} else {
				unsaved = who.account
			}
		}
	}
	const ref = tabUrl ? parseArtifactUrl(tabUrl) : null
	return {
		accounts: accounts.map(toView),
		activeUuid,
		unsaved,
		signedIn: !!key,
		mode,
		switching,
		lastError,
		tab:
			ref && tabUrl && tabId !== null
				? {
						tabId,
						artifact: ref.uuid,
						url: tabUrl,
						cached: cache[ref.uuid] ?? null,
					}
				: null,
	}
}

async function onPopup(msg: PopupMessage): Promise<unknown> {
	switch (msg.kind) {
		case 'popupState': {
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			})
			return popupState(msg.tabUrl, tab?.id ?? null)
		}
		case 'switch': {
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			})
			const focus =
				msg.url && tab?.id !== undefined && parseArtifactUrl(msg.url) ? { tabId: tab.id, url: msg.url } : undefined
			const res = await switchTo(msg.uuid, focus ? { focus } : {})
			if (!res.ok) await store.setLastError(null) // shown right here instead
			if (!res.ok) throw new Error(res.error)
			return res
		}
		case 'save':
			return saveCurrent()
		case 'add':
			await startAdd()
			return {}
		case 'remove':
			await store.removeAccount(msg.uuid)
			if ((await store.activeUuid()) === msg.uuid) await store.setActive(null)
			return {}
		case 'setMode':
			if (!MODES.includes(msg.mode)) throw new Error('bad mode')
			await store.setMode(msg.mode)
			return {}
		case 'forget':
			await store.forgetArtifact(msg.artifact)
			return {}
	}
}

// ---------- wiring ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (sender.id !== chrome.runtime.id) return false
	const fromContent =
		sender.tab?.id !== undefined &&
		sender.frameId === 0 &&
		typeof sender.url === 'string' &&
		sender.url.startsWith('https://claude.ai/')
	const fromPopup =
		!sender.tab && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('popup.html'))
	let work: Promise<unknown>
	if (fromContent && sender.tab?.id !== undefined) work = onContent(msg as ContentMessage, sender.tab.id)
	else if (fromPopup) work = onPopup(msg as PopupMessage)
	else return false
	work.then(
		data => sendResponse({ ok: true, data } satisfies Reply<unknown>),
		err =>
			sendResponse({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			} satisfies Reply<unknown>),
	)
	return true
})

// Sessions rotate while you use claude.ai: keep the saved snapshot current.
let refreshTimer: ReturnType<typeof setTimeout> | undefined
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
	if (cookie.name !== 'sessionKey' || (cookie.domain !== 'claude.ai' && cookie.domain !== '.claude.ai')) return
	clearTimeout(refreshTimer)
	refreshTimer = setTimeout(() => void refreshAfterCookieChange(removed), 3000)
})

async function refreshAfterCookieChange(removed: boolean): Promise<void> {
	if (await isSwitching()) return
	if (removed && !(await currentSessionKey())) {
		await store.setActive(null)
		return
	}
	const pending = await store.pendingAdd()
	const a = await captureLive({ allowNew: pending }).catch(() => null)
	if (a && pending && (await store.account(a.uuid))) await store.setPendingAdd(false)
}

// Runs on every service-worker start (not only browser start): finish anything a
// previous worker left half-done.
async function wake(): Promise<void> {
	await store.ensureSecureStorage().catch(err => store.setLastError(err instanceof Error ? err.message : String(err)))
	await clearProbeRules().catch(() => undefined)
	await recover().catch(() => undefined)
	await expireGuard().catch(() => undefined)
	await updateBadge().catch(() => undefined)
}

void wake()
chrome.runtime.onInstalled.addListener(() => void updateBadge())
chrome.runtime.onStartup.addListener(() => void updateBadge())
