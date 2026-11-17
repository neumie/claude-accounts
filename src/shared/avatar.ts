// All accounts share one domain, so the monogram comes from the local part:
// ucet1@ → "U1", ucet3@ → "U3".
export function initials(email: string): string {
	const local = email.split('@')[0] ?? ''
	const first = local.match(/[a-z]/i)?.[0]?.toUpperCase() ?? '?'
	const digits = local.match(/(\d+)$/)?.[1] ?? ''
	return (first + digits).slice(0, 3)
}

const PALETTE = ['#4c9aff', '#c08ae0', '#e08a41', '#4ec98a', '#54c6d6', '#e477b5', '#f2585b'] as const

export function accountColor(email: string): string {
	let h = 0
	for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
	return PALETTE[h % PALETTE.length] ?? PALETTE[0]
}
