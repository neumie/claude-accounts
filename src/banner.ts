// A small notice on top of claude.ai, isolated in a closed shadow root so the
// page's CSS can't touch it. Helm tokens, dark only.

export type BannerAction = { label: string; primary?: boolean; run: () => Promise<boolean> }

export type BannerOptions = {
	tone: 'info' | 'warn'
	text: string
	actions?: BannerAction[]
	autoHideMs?: number
}

const CSS = `
:host { all: initial; }
.wrap { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
  display: flex; align-items: center; gap: 12px; max-width: min(640px, calc(100vw - 24px));
  padding: 10px 12px 10px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);
  background: #1a1c1f; color: #ececee; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif; letter-spacing: -0.01em;
  -webkit-font-smoothing: antialiased; animation: in 150ms ease-out; }
@keyframes in { from { opacity: 0; transform: translate(-50%, -4px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (prefers-reduced-motion: reduce) { .wrap { animation: none; } }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #4c9aff; }
.warn .dot { background: #e0b341; }
.text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.btn { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; font: 600 12px -apple-system, BlinkMacSystemFont, sans-serif;
  letter-spacing: -0.01em; white-space: nowrap; cursor: pointer; background: rgba(255,255,255,0.09); color: #ececee;
  transition: background-color 140ms ease-out; }
.btn:hover { background: rgba(255,255,255,0.13); }
.btn.primary { background: #3b82f6; color: #fff; }
.btn.primary:hover { background: #5a9dff; }
.btn:focus-visible, .x:focus-visible { outline: 2px solid #4c9aff; outline-offset: 2px; }
.btn:disabled { opacity: .45; cursor: default; }
.x { width: 24px; height: 24px; border: 0; border-radius: 4px; background: none; color: #62666e; font-size: 16px; line-height: 1; cursor: pointer; }
.x:hover { color: #ececee; background: rgba(255,255,255,0.05); }
`

let current: HTMLElement | null = null

export function showBanner(opts: BannerOptions): void {
	current?.remove()
	const host = document.createElement('claude-accounts-banner')
	const root = host.attachShadow({ mode: 'closed' })
	const style = document.createElement('style')
	style.textContent = CSS
	const wrap = document.createElement('div')
	wrap.className = `wrap ${opts.tone}`
	wrap.setAttribute('role', opts.tone === 'warn' ? 'alert' : 'status')

	const dot = document.createElement('span')
	dot.className = 'dot'
	const text = document.createElement('span')
	text.className = 'text'
	text.textContent = opts.text
	wrap.append(dot, text)

	const close = () => {
		host.remove()
		if (current === host) current = null
	}
	for (const action of opts.actions ?? []) {
		const btn = document.createElement('button')
		btn.type = 'button'
		btn.className = action.primary ? 'btn primary' : 'btn'
		btn.textContent = action.label
		btn.addEventListener('click', async () => {
			btn.disabled = true
			if (await action.run()) close()
			else btn.disabled = false
		})
		wrap.append(btn)
	}
	const x = document.createElement('button')
	x.type = 'button'
	x.className = 'x'
	x.setAttribute('aria-label', 'Dismiss')
	x.textContent = '×'
	x.addEventListener('click', close)
	wrap.append(x)

	root.append(style, wrap)
	document.documentElement.append(host)
	current = host
	if (opts.autoHideMs) setTimeout(close, opts.autoHideMs)
}
