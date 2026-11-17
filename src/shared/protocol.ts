// Messages between the extension (one instance per Chrome profile) and the
// native host, plus the shared state the host keeps on disk.
// Nothing here is a credential: emails, org names, UUIDs, profile names.

export const HOST_NAME = 'dev.neumie.claude_accounts'
export const STATE_VERSION = 1

export type Mode = 'auto' | 'ask' | 'off'
export const MODES: readonly Mode[] = ['auto', 'ask', 'off']

export type Org = { uuid: string; name: string }

export type Account = {
	uuid: string
	email: string
	orgs: Org[]
}

export type ProfileEntry = {
	dir: string
	account: Account | null
	lastSeen: number
}

export type CachedArtifact = { accountUuid: string; ts: number }

export type Attempt = {
	/** Profile dirs that already reported "no access" in this routing round. */
	tried: string[]
	/** Email of the account the round started from, for the "opened here" toast. */
	fromEmail: string | null
	ts: number
}

export type SharedState = {
	version: typeof STATE_VERSION
	mode: Mode
	profiles: Record<string, ProfileEntry>
	artifacts: Record<string, CachedArtifact>
	attempts: Record<string, Attempt>
}

export type ChromeProfile = { dir: string; name: string }

export type ProbeOutcome = 'no_access' | 'org_mismatch'

export type HostRequest =
	| { type: 'hello' }
	| { type: 'whoami'; nonce: string }
	| { type: 'seen'; dir: string; account: Account | null }
	| { type: 'route'; dir: string; artifact: string; outcome: ProbeOutcome; ownerOrg: string | null }
	| { type: 'access'; dir: string; artifact: string; accountUuid: string }
	| { type: 'open'; dir: string; url: string; artifact?: string }
	| { type: 'setMode'; mode: Mode }
	| { type: 'forget'; artifact: string }

export type RouteReason = 'off' | 'cache' | 'owner_org' | 'next' | 'exhausted' | 'same_account'

export type RouteTarget = { dir: string; email: string }

export type HostResponseMap = {
	hello: { chromeProfiles: ChromeProfile[]; state: SharedState; distDir: string | null }
	whoami: { dir: string | null }
	seen: Record<string, never>
	route: { mode: Mode; target: RouteTarget | null; reason: RouteReason }
	access: { routedFrom: string | null }
	open: Record<string, never>
	setMode: Record<string, never>
	forget: Record<string, never>
}

export type HostOk<T extends HostRequest['type']> = { ok: true } & HostResponseMap[T]
export type HostError = { ok: false; error: string }
export type HostResponse<T extends HostRequest['type']> = HostOk<T> | HostError
