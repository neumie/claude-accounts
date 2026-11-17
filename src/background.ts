// Service worker: the only part that talks to the native host.
// One instance per Chrome profile; the host keeps the cross-profile state.

import { parseArtifactUrl } from './shared/artifact.ts'
import { accountColor, initials } from './shared/avatar.ts'
import type { ContentMessage, PopupMessage, PopupState, ProbeReply, Reply } from './shared/messages.ts'
import {
	HOST_NAME,
	MODES,
	type Account,
	type HostOk,
	type HostRequest,
	type HostResponse,
} from './shared/protocol.ts'

type Local = {
	nonce?: string
	dir?: string
	me?: Account | null
}

async function local(): Promise<Local> {
	return (await chrome.storage.local.get(['nonce', 'dir', 'me'])) as Local
}

async function host<T extends HostRequest['type']>(req: Extract<HostRequest, { type: T }>): Promise<HostOk<T>> {
	const res = (await chrome.runtime.sendNativeMessage(HOST_NAME, req)) as HostResponse<T> | undefined
	if (!res) throw new Error('No reply from the helper')
	if (!res.ok) throw new Error(res.error)
	return res
}

function randomHex(bytes: number): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('')
}

/** Which Chrome profile directory this extension instance lives in. */
async function detectDir(): Promise<string | null> {
	const { nonce: stored } = await local()
	let nonce = stored
	if (!nonce) {
		nonce = randomHex(16)
		await chrome.storage.local.set({ nonce })
	}
	// LevelDB may not have flushed the nonce yet on the very first run.
	for (let i = 0; i < 4; i++) {
		const { dir } = await host({ type: 'whoami', nonce })
		if (dir) {
			await chrome.storage.local.set({ dir })
			return dir
		}
		await new Promise(r => setTimeout(r, 400))
	}
	return null
}

async function ensureDir(): Promise<string | null> {
	const { dir } = await local()
	if (dir) return dir
	try {
		return await detectDir()
	} catch {
		return null
	}
}

async function updateBadge(me: Account | null | undefined): Promise<void> {
	if (me) {
		await chrome.action.setBadgeText({ text: initials(me.email) })
		await chrome.action.setBadgeBackgroundColor({ color: accountColor(me.email) })
		await chrome.action.setTitle({ title: `Claude accounts: ${me.email}` })
	} else {
		await chrome.action.setBadgeText({ text: '' })
		await chrome.action.setTitle({ title: 'Claude accounts' })
	}
}

function sameAccount(a: Account | null | undefined, b: Account | null | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// ---------- content script ----------

async function onContent(msg: ContentMessage, tabId: number): Promise<unknown> {
	switch (msg.kind) {
		case 'account': {
			const prev = await local()
			if (!sameAccount(prev.me, msg.account) || prev.me === undefined) {
				await chrome.storage.local.set({ me: msg.account })
				await updateBadge(msg.account)
			}
			const dir = await ensureDir()
			if (dir) await host({ type: 'seen', dir, account: msg.account })
			return {}
		}
		case 'probe':
			return onProbe(msg, tabId)
		case 'openElsewhere': {
			const dir = await ensureDir()
			if (!parseArtifactUrl(msg.url)) throw new Error('not an artifact link')
			if (msg.dir === dir) throw new Error('already in that profile')
			await host({ type: 'open', dir: msg.dir, url: msg.url, artifact: parseArtifactUrl(msg.url)?.uuid })
			if (msg.closeTab) await chrome.tabs.remove(tabId).catch(() => undefined)
			return {}
		}
	}
}

async function onProbe(msg: Extract<ContentMessage, { kind: 'probe' }>, tabId: number): Promise<ProbeReply> {
	const ref = parseArtifactUrl(msg.url)
	if (!ref || ref.uuid !== msg.artifact) return { action: 'none' }
	const [{ me }, dir] = await Promise.all([local(), ensureDir()])
	if (!dir) return { action: 'none' }

	if (msg.result.kind === 'access') {
		if (!me) return { action: 'none' }
		const { routedFrom } = await host({ type: 'access', dir, artifact: ref.uuid, accountUuid: me.uuid })
		return routedFrom ? { action: 'routedHere', from: routedFrom } : { action: 'none' }
	}

	const { mode, target, reason } = await host({
		type: 'route',
		dir,
		artifact: ref.uuid,
		outcome: msg.result.kind,
		ownerOrg: msg.result.kind === 'org_mismatch' ? msg.result.ownerOrg : null,
	})
	if (!target) return reason === 'exhausted' ? { action: 'exhausted' } : { action: 'none' }
	if (mode === 'ask') return { action: 'ask', target }

	await host({ type: 'open', dir: target.dir, url: msg.url })
	// Close the origin tab only when we know where the artifact lives. A blind "try the next
	// profile" hop may dead-end there (signed out, challenge), so keep the link here as well.
	if (msg.freshTab && me && (reason === 'cache' || reason === 'owner_org')) {
		await chrome.tabs.remove(tabId).catch(() => undefined)
		return { action: 'none' }
	}
	return { action: 'opened', target }
}

// ---------- popup ----------

async function onPopup(msg: PopupMessage): Promise<unknown> {
	switch (msg.kind) {
		case 'popupState': {
			const { me } = await local()
			const ref = msg.tabUrl ? parseArtifactUrl(msg.tabUrl) : null
			const out: PopupState = {
				host: { ok: true },
				dir: null,
				me: me ?? null,
				meKnown: me !== undefined,
				chromeProfiles: [],
				state: null,
				distDir: null,
				tab: ref && msg.tabUrl ? { artifact: ref.uuid, url: msg.tabUrl } : null,
			}
			try {
				const hello = await host({ type: 'hello' })
				out.chromeProfiles = hello.chromeProfiles
				out.state = hello.state
				out.distDir = hello.distDir
				out.dir = await ensureDir()
			} catch (err) {
				out.host = { ok: false, error: err instanceof Error ? err.message : String(err) }
			}
			return out
		}
		case 'openProfile': {
			const url = new URL(msg.url)
			if (url.protocol !== 'https:' || url.hostname !== 'claude.ai') throw new Error('only claude.ai')
			await host({ type: 'open', dir: msg.dir, url: url.href })
			return {}
		}
		case 'setMode':
			if (!MODES.includes(msg.mode)) throw new Error('bad mode')
			await host({ type: 'setMode', mode: msg.mode })
			return {}
		case 'setDir': {
			const { chromeProfiles } = await host({ type: 'hello' })
			if (!chromeProfiles.some(p => p.dir === msg.dir)) throw new Error('unknown profile')
			await chrome.storage.local.set({ dir: msg.dir })
			const { me } = await local()
			if (me !== undefined) await host({ type: 'seen', dir: msg.dir, account: me })
			return {}
		}
		case 'detectDir': {
			await chrome.storage.local.remove('dir')
			const dir = await detectDir()
			const { me } = await local()
			if (dir && me !== undefined) await host({ type: 'seen', dir, account: me })
			return { dir }
		}
		case 'forget':
			await host({ type: 'forget', artifact: msg.artifact })
			return {}
	}
}

// ---------- wiring ----------

const CLAUDE_ORIGIN = 'https://claude.ai/'

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (sender.id !== chrome.runtime.id) return false
	const fromContent =
		!!sender.tab?.id && sender.frameId === 0 && typeof sender.url === 'string' && sender.url.startsWith(CLAUDE_ORIGIN)
	const fromPopup = !sender.tab && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''))
	let work: Promise<unknown>
	if (fromContent && sender.tab?.id !== undefined) work = onContent(msg as ContentMessage, sender.tab.id)
	else if (fromPopup) work = onPopup(msg as PopupMessage)
	else return false
	work.then(
		data => sendResponse({ ok: true, data } satisfies Reply<unknown>),
		err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Reply<unknown>),
	)
	return true
})

async function init(): Promise<void> {
	await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined)
	const { me } = await local()
	await updateBadge(me)
}

chrome.runtime.onInstalled.addListener(() => void init())
chrome.runtime.onStartup.addListener(() => void init())
