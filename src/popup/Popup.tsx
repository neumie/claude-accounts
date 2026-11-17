import { createResource, createSignal, For, Match, Show, Switch, type JSX } from 'solid-js'
import { shortUuid } from '../shared/artifact.ts'
import { accountColor, initials } from '../shared/avatar.ts'
import type { PopupMessage, PopupState, Reply } from '../shared/messages.ts'
import { MODES, type Account, type ChromeProfile, type Mode, type ProfileEntry } from '../shared/protocol.ts'

async function send<T>(msg: PopupMessage): Promise<T> {
	const res = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined
	if (!res?.ok) throw new Error(res?.error ?? 'No reply from the extension')
	return res.data
}

async function load(): Promise<PopupState> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
	return send<PopupState>({ kind: 'popupState', tabUrl: tab?.url ?? null })
}

const MODE_LABEL: Record<Mode, string> = { auto: 'Auto', ask: 'Ask', off: 'Off' }
const MODE_HINT: Record<Mode, string> = {
	auto: 'Artifact links this account can’t open move to the profile that can.',
	ask: 'Artifact links this account can’t open show a prompt first.',
	off: 'Artifact links are left alone.',
}

const Check = () => (
	<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
		<path d="M3 7.5l2.5 2.5L11 4.5" />
	</svg>
)

const Back = () => (
	<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
		<path d="M10 3.5L5.5 8l4.5 4.5" />
	</svg>
)

function Avatar(props: { email: string }): JSX.Element {
	return (
		<span class="avatar" style={{ '--av': accountColor(props.email) }} aria-hidden="true">
			{initials(props.email)}
		</span>
	)
}

function orgNames(a: Account): string {
	return a.orgs.map(o => o.name).filter(Boolean).join(' · ')
}

function ago(ts: number): string {
	if (!ts) return ''
	const s = Math.max(0, (Date.now() - ts) / 1000)
	if (s < 60) return 'now'
	if (s < 3600) return `${Math.round(s / 60)}m ago`
	if (s < 86400) return `${Math.round(s / 3600)}h ago`
	return `${Math.round(s / 86400)}d ago`
}

export function Popup(): JSX.Element {
	const [data, { refetch }] = createResource(load)
	const [page, setPage] = createSignal<'main' | 'add'>('main')
	const [error, setError] = createSignal<string | null>(null)
	const [busy, setBusy] = createSignal(false)

	async function act(msg: PopupMessage, closeAfter = false): Promise<void> {
		setBusy(true)
		setError(null)
		try {
			await send(msg)
			if (closeAfter) window.close()
			else await refetch()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div class="popup">
			<Switch>
				<Match when={page() === 'add'}>
					<AddAccount distDir={data()?.distDir ?? null} onBack={() => setPage('main')} />
				</Match>
				<Match when={data.loading && !data()}>
					<Header />
					<p class="loading">Loading…</p>
				</Match>
				<Match when={data.error}>
					<Header />
					<div class="ctx">
						<div class="notice notice--error">
							<span class="notice__text">{String(data.error)}</span>
						</div>
					</div>
				</Match>
				<Match when={data()?.host.ok === false && data()}>
					{s => <HostMissing error={(s().host as { error: string }).error} onRetry={() => void refetch()} />}
				</Match>
				<Match when={data()?.dir === null && data()}>
					{s => (
						<PickProfile
							profiles={s().chromeProfiles}
							busy={busy()}
							onDetect={() => void act({ kind: 'detectDir' })}
							onPick={dir => void act({ kind: 'setDir', dir })}
						/>
					)}
				</Match>
				<Match when={data()}>
					{s => (
						<Main
							s={s()}
							busy={busy()}
							error={error()}
							onOpen={(dir, url) => void act({ kind: 'openProfile', dir, url }, true)}
							onMode={mode => void act({ kind: 'setMode', mode })}
							onForget={artifact => void act({ kind: 'forget', artifact })}
							onAdd={() => setPage('add')}
						/>
					)}
				</Match>
			</Switch>
		</div>
	)
}

function Header(props: { children?: JSX.Element }): JSX.Element {
	return (
		<header class="hdr">
			<div class="hdr__id">
				<span class="hdr__brand">Claude accounts</span>
			</div>
			<div class="hdr__actions">{props.children}</div>
		</header>
	)
}

type Row = { profile: ChromeProfile; entry: ProfileEntry | undefined }

function Main(props: {
	s: PopupState
	busy: boolean
	error: string | null
	onOpen: (dir: string, url: string) => void
	onMode: (mode: Mode) => void
	onForget: (artifact: string) => void
	onAdd: () => void
}): JSX.Element {
	const state = () => props.s.state
	const here = () => props.s.dir
	const rows = (): Row[] =>
		props.s.chromeProfiles
			.map(profile => ({ profile, entry: state()?.profiles[profile.dir] }))
			.sort((a, b) => {
				if (a.profile.dir === here()) return -1
				if (b.profile.dir === here()) return 1
				const ea = a.entry?.account?.email
				const eb = b.entry?.account?.email
				if (ea && !eb) return -1
				if (eb && !ea) return 1
				return (ea ?? a.profile.name).localeCompare(eb ?? b.profile.name)
			})
	const signedIn = () => rows().filter(r => r.entry?.account)
	const others = () => rows().filter(r => !r.entry?.account)

	const tabInfo = () => {
		const tab = props.s.tab
		if (!tab) return null
		const cached = state()?.artifacts[tab.artifact]
		const owner = cached ? Object.values(state()?.profiles ?? {}).find(p => p.account?.uuid === cached.accountUuid) : undefined
		return { tab, cached, owner }
	}

	return (
		<>
			<Header>
				<button class="icon-btn" type="button" aria-label="Add account" title="Add account" onClick={() => props.onAdd()}>
					+
				</button>
			</Header>

			<Show when={!props.s.me}>
				<div class="ctx">
					<div class="notice notice--warn">
						<span class="notice__text">
							{props.s.meKnown ? 'This profile isn’t signed in to claude.ai.' : 'Open claude.ai once in this profile.'}
							<span class="notice__sub">
								{props.s.meKnown
									? 'Sign in once; the extension picks the account up on its own.'
									: 'The extension learns which account is signed in here from the first claude.ai page.'}
							</span>
						</span>
						<button
							class="btn btn--sm"
							type="button"
							onClick={() =>
								void chrome.tabs
									.create({ url: props.s.meKnown ? 'https://claude.ai/login' : 'https://claude.ai/new' })
									.then(() => window.close())
							}
						>
							{props.s.meKnown ? 'Sign in' : 'Open'}
						</button>
					</div>
				</div>
			</Show>

			<Show when={props.error}>
				<div class="ctx">
					<div class="notice notice--error">
						<span class="notice__text">{props.error}</span>
					</div>
				</div>
			</Show>

			<Show when={tabInfo()}>
				{info => (
					<section class="tab" aria-label="This tab">
						<div class="tab__l1">
							<span class="tab__title">This tab</span>
							<span class="mono" style={{ color: 'var(--text-2)' }}>
								artifact {shortUuid(info().tab.artifact)}
							</span>
						</div>
						<div class="kv">
							<span>Opens with</span>
							<b>{info().owner?.account?.email ?? (info().cached ? 'an account not set up here' : 'not checked yet')}</b>
						</div>
						<Show when={info().cached}>
							<div class="tab__actions">
								<Show when={info().owner && info().owner?.dir !== here() && info().owner}>
									{owner => (
										<button
											class="btn btn--primary btn--sm"
											type="button"
											disabled={props.busy}
											onClick={() => props.onOpen(owner().dir, info().tab.url)}
										>
											Open as {owner().account?.email}
										</button>
									)}
								</Show>
								<button
									class="btn btn--ghost btn--sm"
									type="button"
									disabled={props.busy}
									onClick={() => props.onForget(info().tab.artifact)}
								>
									Forget
								</button>
							</div>
						</Show>
					</section>
				)}
			</Show>

			<ul class="list" aria-label="Accounts">
				<For each={signedIn()}>
					{row => {
						const account = row.entry!.account!
						const active = row.profile.dir === here()
						const meta = [orgNames(account), row.profile.name].filter(Boolean).join(' · ')
						return (
							<li>
								<Show
									when={!active}
									fallback={
										<div class="row is-active" aria-current="true">
											<Avatar email={account.email} />
											<span class="row__main">
												<span class="row__l1">
													<span class="row__title">{account.email}</span>
													<span class="row__state">This window</span>
												</span>
												<span class="row__meta">
													<span class="row__org">{meta}</span>
												</span>
											</span>
											<span class="row__check">
												<Check />
											</span>
										</div>
									}
								>
									<button
										class="row"
										type="button"
										disabled={props.busy}
										aria-label={`Open claude.ai as ${account.email}`}
										onClick={() => props.onOpen(row.profile.dir, 'https://claude.ai/new')}
									>
										<Avatar email={account.email} />
										<span class="row__main">
											<span class="row__l1">
												<span class="row__title">{account.email}</span>
												<span class="row__time">{ago(row.entry?.lastSeen ?? 0)}</span>
											</span>
											<span class="row__meta">
												<span class="row__org">{meta}</span>
											</span>
										</span>
										<span class="row__check row__check--empty" />
									</button>
								</Show>
							</li>
						)
					}}
				</For>
			</ul>

			<Show when={others().length > 0}>
				<p class="section-label">Other Chrome profiles</p>
				<ul class="list" aria-label="Other Chrome profiles">
					<For each={others()}>
						{row => (
							<li>
								<button
									class="row is-dim"
									type="button"
									disabled={props.busy}
									onClick={() => props.onOpen(row.profile.dir, 'https://claude.ai/login')}
								>
									<span class="avatar" aria-hidden="true">
										?
									</span>
									<span class="row__main">
										<span class="row__l1">
											<span class="row__title">{row.profile.name}</span>
										</span>
										<span class="row__meta">
											<span class="row__org">
												{row.entry ? 'Not signed in to claude.ai' : 'Extension not loaded or not used yet'}
											</span>
										</span>
									</span>
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>

			<Show when={state()}>
				{st => (
					<section class="group">
						<div class="group__hdr">
							<span>Artifact links</span>
						</div>
						<div class="seg" role="radiogroup" aria-label="Artifact links">
							<For each={MODES}>
								{mode => (
									<button
										class="seg__opt"
										type="button"
										role="radio"
										aria-checked={st().mode === mode}
										disabled={props.busy}
										onClick={() => props.onMode(mode)}
									>
										{MODE_LABEL[mode]}
									</button>
								)}
							</For>
						</div>
						<p class="group__hint">{MODE_HINT[st().mode]}</p>
					</section>
				)}
			</Show>
		</>
	)
}

function HostMissing(props: { error: string; onRetry: () => void }): JSX.Element {
	return (
		<>
			<Header />
			<div class="empty">
				<p class="empty__title">Helper not installed</p>
				<p class="empty__detail">
					The extension needs a small local helper to open links in other Chrome profiles. Run this once in the
					repo, then retry:
				</p>
				<code class="code" style={{ 'margin-top': '12px' }}>
					npm run install-host
				</code>
				<p class="err">{props.error}</p>
				<button class="btn btn--primary empty__action" type="button" onClick={() => props.onRetry()}>
					Retry
				</button>
			</div>
		</>
	)
}

function PickProfile(props: {
	profiles: ChromeProfile[]
	busy: boolean
	onDetect: () => void
	onPick: (dir: string) => void
}): JSX.Element {
	return (
		<>
			<Header />
			<div class="empty">
				<p class="empty__title">Which Chrome profile is this?</p>
				<p class="empty__detail">Automatic detection didn’t work yet. Pick this window’s profile.</p>
				<div class="pick">
					<For each={props.profiles}>
						{p => (
							<button class="btn btn--quiet" type="button" disabled={props.busy} onClick={() => props.onPick(p.dir)}>
								{p.name} <span class="menu__meta">{p.dir}</span>
							</button>
						)}
					</For>
				</div>
				<button class="btn btn--ghost empty__action" type="button" disabled={props.busy} onClick={() => props.onDetect()}>
					Try detecting again
				</button>
			</div>
		</>
	)
}

function AddAccount(props: { distDir: string | null; onBack: () => void }): JSX.Element {
	return (
		<>
			<div class="push">
				<button class="icon-btn icon-btn--28" type="button" aria-label="Back" onClick={() => props.onBack()}>
					<Back />
				</button>
				<span class="push__title">Add account</span>
			</div>
			<ol class="steps">
				<li class="step">
					<span>
						In Chrome’s profile menu choose <b>Add</b> and create a profile for the account. Name it after the account,
						for example “ucet1”.
					</span>
				</li>
				<li class="step">
					<span>
						In the new profile open <b>chrome://extensions</b>, turn on Developer mode, choose <b>Load unpacked</b> and
						pick:
						<code class="code">{props.distDir ?? '…/claude-accounts/dist'}</code>
					</span>
				</li>
				<li class="step">
					<span>
						Sign in to <b>claude.ai</b> in that profile with the account. It shows up here on its own.
					</span>
				</li>
			</ol>
			<p class="group__hint" style={{ padding: '0 16px 16px' }}>
				Never log out of an account in claude.ai: logging out ends that session everywhere. Close the profile instead.
			</p>
		</>
	)
}
