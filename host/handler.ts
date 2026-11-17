import { isUuid } from '../src/shared/artifact.ts'
import { MODES, type HostRequest, type Mode } from '../src/shared/protocol.ts'
import { findProfileByNonce, isOpenableUrl, listChromeProfiles, type Opener } from './chrome.ts'
import {
	applySeen,
	forget,
	isProfileDir,
	prune,
	recordAccess,
	route,
	sanitizeIncomingAccount,
	syncProfiles,
	touchAttempt,
} from './logic.ts'
import { updateState } from './store.ts'

export type HandlerContext = {
	extensionId: string
	now: () => number
	open: Opener
	dataDir?: string
	chromeRoot?: string
}

class BadRequest extends Error {}

function knownDir(dir: unknown, ctx: HandlerContext): string {
	if (!isProfileDir(dir)) throw new BadRequest('bad profile dir')
	if (!listChromeProfiles(ctx.chromeRoot).some(p => p.dir === dir)) throw new BadRequest('unknown Chrome profile')
	return dir
}

function artifactId(value: unknown): string {
	if (!isUuid(value)) throw new BadRequest('bad artifact id')
	return value.toLowerCase()
}

export async function handle(raw: unknown, ctx: HandlerContext): Promise<Record<string, unknown>> {
	try {
		return { ok: true, ...(await dispatch(raw, ctx)) }
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'host error' }
	}
}

async function dispatch(raw: unknown, ctx: HandlerContext): Promise<Record<string, unknown>> {
	if (!raw || typeof raw !== 'object') throw new BadRequest('bad request')
	const req = raw as HostRequest & Record<string, unknown>
	const { dataDir } = ctx
	switch (req.type) {
		case 'hello': {
			const chromeProfiles = listChromeProfiles(ctx.chromeRoot)
			const state = await updateState(s => {
				syncProfiles(s, chromeProfiles.map(p => p.dir))
				prune(s, ctx.now())
				return s
			}, dataDir)
			return { chromeProfiles, state, distDir: process.env.CLAUDE_ACCOUNTS_DIST ?? null }
		}
		case 'whoami': {
			if (typeof req.nonce !== 'string') throw new BadRequest('bad nonce')
			return { dir: findProfileByNonce(ctx.extensionId, req.nonce, ctx.chromeRoot) }
		}
		case 'seen': {
			const dir = knownDir(req.dir, ctx)
			const account = req.account === null ? null : sanitizeIncomingAccount(req.account)
			if (req.account !== null && !account) throw new BadRequest('bad account')
			await updateState(s => applySeen(s, dir, account, ctx.now()), dataDir)
			return {}
		}
		case 'route': {
			const dir = knownDir(req.dir, ctx)
			const artifact = artifactId(req.artifact)
			if (req.outcome !== 'no_access' && req.outcome !== 'org_mismatch') throw new BadRequest('bad outcome')
			const ownerOrg = isUuid(req.ownerOrg) ? req.ownerOrg.toLowerCase() : null
			const existing = listChromeProfiles(ctx.chromeRoot).map(p => p.dir)
			return await updateState(s => {
				syncProfiles(s, existing)
				prune(s, ctx.now())
				return route(s, { dir, artifact, outcome: req.outcome, ownerOrg }, ctx.now())
			}, dataDir)
		}
		case 'access': {
			const dir = knownDir(req.dir, ctx)
			const artifact = artifactId(req.artifact)
			if (!isUuid(req.accountUuid)) throw new BadRequest('bad account')
			const accountUuid = req.accountUuid.toLowerCase()
			return await updateState(s => recordAccess(s, { dir, artifact, accountUuid }, ctx.now()), dataDir)
		}
		case 'open': {
			const dir = knownDir(req.dir, ctx)
			if (typeof req.url !== 'string' || !isOpenableUrl(req.url)) throw new BadRequest('only https://claude.ai URLs')
			if (req.artifact !== undefined) {
				const artifact = artifactId(req.artifact)
				await updateState(s => touchAttempt(s, artifact, ctx.now()), dataDir)
			}
			await ctx.open(dir, req.url)
			return {}
		}
		case 'setMode': {
			if (!(MODES as readonly unknown[]).includes(req.mode)) throw new BadRequest('bad mode')
			const mode = req.mode as Mode
			await updateState(s => {
				s.mode = mode
			}, dataDir)
			return {}
		}
		case 'forget': {
			const artifact = artifactId(req.artifact)
			await updateState(s => forget(s, artifact), dataDir)
			return {}
		}
		default:
			throw new BadRequest('unknown request')
	}
}

