import { createResource, createSignal, For, Show, type JSX } from 'solid-js'
import { shortUuid } from '../shared/artifact.ts'
import { accountColor, initials } from '../shared/avatar.ts'
import type { PopupMessage, PopupState, Reply } from '../shared/messages.ts'
import { MODES, type AccountView, type Mode } from '../shared/types.ts'

async function send<T>(msg: PopupMessage): Promise<T> {
	const res = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined
	if (!res?.ok) throw new Error(res?.error ?? 'No reply from the extension')
	return res.data
}

async function load(): Promise<PopupState> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
	return send<PopupState>({ kind: 'popupState', tabUrl: tab?.url ?? null })
}

const MODE_LABEL: Record<Mode, string> = {
	auto: 'Auto',
	ask: 'Ask',
	off: 'Off',
}
const MODE_HINT: Record<Mode, string> = {
	auto: 'An artifact the active account can’t open switches to the account that can.',
	ask: 'An artifact the active account can’t open asks before switching.',
	off: 'Artifact links never switch accounts.',
}

const Check = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 14 14"
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		aria-hidden="true"
	>
		<path d="M3 7.5l2.5 2.5L11 4.5" />
	</svg>
)

function Avatar(props: { email: string }): JSX.Element {
	return (
		<span class="avatar" style={{ '--av': accountColor(props.email) }} aria-hidden="true">
			{initials(props.email)}
		</span>
	)
}

function orgNames(a: { orgs: { name: string }[] }): string {
	return a.orgs
		.map(o => o.name)
		.filter(Boolean)
		.join(' · ')
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
	const [busy, setBusy] = createSignal<string | null>(null)
	const [error, setError] = createSignal<string | null>(null)
	const [warning, setWarning] = createSignal<string | null>(null)
	const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null)

	async function act(msg: PopupMessage, label: string, closeAfter = false): Promise<void> {
		setBusy(label)
		setError(null)
		setWarning(null)
		try {
			const res = await send<{ warning?: string } | undefined>(msg)
			if (res && typeof res === 'object' && 'warning' in res && res.warning) {
				setWarning(res.warning)
				await refetch()
			} else if (closeAfter) window.close()
			else await refetch()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
			await refetch()
		} finally {
			setBusy(null)
		}
	}

	const s = () => data()
	const active = () => s()?.accounts.find(a => a.uuid === s()?.activeUuid)
	const others = () =>
		(s()?.accounts ?? [])
			.filter(a => a.uuid !== s()?.activeUuid)
			.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.email.localeCompare(b.email))
	const tabOwner = () => {
		const cached = s()?.tab?.cached
		return cached ? s()?.accounts.find(a => a.uuid === cached.accountUuid) : undefined
	}

	function switchTo(a: AccountView): void {
		void act({ kind: 'switch', uuid: a.uuid, url: s()?.tab?.url ?? null }, `Switching to ${a.email}…`, true)
	}

	return (
		<div class="popup">
			<header class="hdr">
				<div class="hdr__id">
					<span class="hdr__brand">Claude accounts</span>
				</div>
			</header>

			<Show when={data.loading && !data()}>
				<p class="loading">Loading…</p>
			</Show>

			<Show when={busy()}>
				<div class="ctx">
					<div class="notice notice--info">
						<span class="dot bg-blue dot--pulse" style={{ 'margin-top': '6px' }} />
						<span class="notice__text">
							{busy()}
							<span class="notice__sub">claude.ai tabs reload when it’s done.</span>
						</span>
					</div>
				</div>
			</Show>

			<Show when={error() ?? s()?.lastError ?? (data.error ? String(data.error) : null)}>
				{msg => (
					<div class="ctx">
						<div class="notice notice--error">
							<span class="notice__text">{msg()}</span>
						</div>
					</div>
				)}
			</Show>

			<Show when={warning()}>
				{msg => (
					<div class="ctx">
						<div class="notice notice--warn">
							<span class="notice__text">{msg()}</span>
						</div>
					</div>
				)}
			</Show>

			<Show when={s()?.switching && !busy()}>
				<div class="ctx">
					<div class="notice notice--info">
						<span class="notice__text">Switching accounts…</span>
					</div>
				</div>
			</Show>

			<Show when={s()?.unsaved}>
				{u => (
					<div class="ctx">
						<div class="notice notice--warn">
							<span class="notice__text">
								Signed in as {u().email}
								<span class="notice__sub">
									Not saved yet. Save it to switch back to it later (switching saves it too).
								</span>
							</span>
							<button
								class="btn btn--primary btn--sm"
								type="button"
								disabled={!!busy()}
								onClick={() => void act({ kind: 'save' }, 'Saving…')}
							>
								Save
							</button>
						</div>
					</div>
				)}
			</Show>

			<Show when={s() && !s()?.signedIn && !busy()}>
				<div class="ctx">
					<div class="notice notice--info">
						<span class="notice__text">
							Not signed in to claude.ai.
							<span class="notice__sub">Sign in, or switch to a saved account below.</span>
						</span>
						<button
							class="btn btn--sm"
							type="button"
							onClick={() => void chrome.tabs.create({ url: 'https://claude.ai/login' }).then(() => window.close())}
						>
							Sign in
						</button>
					</div>
				</div>
			</Show>

			<Show when={s()?.tab}>
				{tab => (
					<section class="tab" aria-label="This tab">
						<div class="tab__l1">
							<span class="tab__title">This tab</span>
							<span class="mono" style={{ color: 'var(--text-2)' }}>
								artifact {shortUuid(tab().artifact)}
							</span>
						</div>
						<div class="kv">
							<span>Opens with</span>
							<b>{tabOwner()?.email ?? (tab().cached ? 'a removed account' : 'not checked yet')}</b>
						</div>
						<Show when={tab().cached}>
							<div class="tab__actions">
								<Show when={tabOwner() && tabOwner()?.uuid !== s()?.activeUuid && tabOwner()}>
									{owner => (
										<button
											class="btn btn--primary btn--sm"
											type="button"
											disabled={!!busy()}
											onClick={() => switchTo(owner())}
										>
											Switch to {owner().email}
										</button>
									)}
								</Show>
								<button
									class="btn btn--ghost btn--sm"
									type="button"
									disabled={!!busy()}
									onClick={() => void act({ kind: 'forget', artifact: tab().artifact }, 'Forgetting…')}
								>
									Forget
								</button>
							</div>
						</Show>
					</section>
				)}
			</Show>

			<ul class="list" aria-label="Saved accounts">
				<Show when={active()}>
					{a => (
						<li class="row-wrap">
							<Show
								when={confirmRemove() !== a().uuid}
								fallback={
									<div class="row row--static">
										<span class="row__main">
											<span class="row__title">Remove {a().email}?</span>
											<span class="row__meta">
												Forgets the saved session. claude.ai stays signed in until you switch.
											</span>
										</span>
										<button
											class="btn btn--danger btn--sm"
											type="button"
											onClick={() => {
												setConfirmRemove(null)
												void act({ kind: 'remove', uuid: a().uuid }, 'Removing…')
											}}
										>
											Remove
										</button>
										<button class="btn btn--ghost btn--sm" type="button" onClick={() => setConfirmRemove(null)}>
											Cancel
										</button>
									</div>
								}
							>
								<div class="row is-active" aria-current="true">
									<Avatar email={a().email} />
									<span class="row__main">
										<span class="row__l1">
											<span class="row__title">{a().email}</span>
											<span class="row__state">Active</span>
										</span>
										<span class="row__meta">
											<span class="row__org">{orgNames(a())}</span>
										</span>
									</span>
									<span class="row__check">
										<Check />
									</span>
								</div>
								<button
									class="icon-btn row__remove"
									type="button"
									aria-label={`Remove ${a().email}`}
									title="Remove"
									onClick={() => setConfirmRemove(a().uuid)}
								>
									×
								</button>
							</Show>
						</li>
					)}
				</Show>
				<For each={others()}>
					{a => (
						<li class="row-wrap">
							<Show
								when={confirmRemove() !== a.uuid}
								fallback={
									<div class="row row--static">
										<span class="row__main">
											<span class="row__title">Remove {a.email}?</span>
											<span class="row__meta">Forgets the saved session. You’d sign in again to add it back.</span>
										</span>
										<button
											class="btn btn--danger btn--sm"
											type="button"
											onClick={() => {
												setConfirmRemove(null)
												void act({ kind: 'remove', uuid: a.uuid }, 'Removing…')
											}}
										>
											Remove
										</button>
										<button class="btn btn--ghost btn--sm" type="button" onClick={() => setConfirmRemove(null)}>
											Cancel
										</button>
									</div>
								}
							>
								<button
									class="row"
									type="button"
									disabled={!!busy() || !!s()?.switching}
									aria-label={a.expired ? `${a.email}: session expired, sign in again` : `Switch to ${a.email}`}
									onClick={() => (a.expired ? void act({ kind: 'add' }, 'Opening sign-in…', true) : switchTo(a))}
								>
									<Avatar email={a.email} />
									<span class="row__main">
										<span class="row__l1">
											<span class={a.expired ? 'row__title row__title--dim' : 'row__title'}>{a.email}</span>
											<span class="row__time">{ago(a.lastUsedAt)}</span>
										</span>
										<span class="row__meta">
											<Show when={a.expired} fallback={<span class="row__org">{orgNames(a)}</span>}>
												<span class="chip chip-amber">Session expired · sign in again</span>
											</Show>
										</span>
									</span>
								</button>
								<button
									class="icon-btn row__remove"
									type="button"
									aria-label={`Remove ${a.email}`}
									title="Remove"
									onClick={() => setConfirmRemove(a.uuid)}
								>
									×
								</button>
							</Show>
						</li>
					)}
				</For>
			</ul>

			<Show when={s() && s()?.accounts.length === 0 && !s()?.unsaved}>
				<div class="empty">
					<p class="empty__title">No saved accounts</p>
					<p class="empty__detail">Sign in to claude.ai and save the account, then add the others.</p>
				</div>
			</Show>

			<Show when={s()}>
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
										disabled={!!busy()}
										onClick={() => void act({ kind: 'setMode', mode }, 'Saving…')}
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

			<footer class="actions">
				<span class="group__hint" style={{ margin: 0 }}>
					Never log out in claude.ai: it ends the session for good.
				</span>
				<span class="spacer" />
				<button
					class="btn btn--quiet"
					type="button"
					disabled={!!busy() || !!s()?.switching}
					onClick={() => void act({ kind: 'add' }, 'Opening sign-in…', true)}
				>
					Add account
				</button>
			</footer>
		</div>
	)
}
