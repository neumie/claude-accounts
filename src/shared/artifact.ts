// claude.ai artifact links carry the artifact UUID either directly or as a
// 22-char base58 (bitcoin alphabet) encoding of its 128 bits.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_128 = (1n << 128n) - 1n

// /artifact/<id>, /code/artifact/<id>, /code/frame/<id>, optional "<vanity>-" before the id.
const PATH_RE =
	/^\/(?:artifact|code\/(?:artifact|frame))\/(?:[a-z0-9][a-z0-9-]{0,59}-)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[1-9A-HJ-NP-Za-km-z]{22})(?:\/|$)/
const SHARE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_RE.test(value)
}

export function base58ToUuid(id: string): string | null {
	if (id.length !== 22) return null
	let n = 0n
	for (const ch of id) {
		const digit = ALPHABET.indexOf(ch)
		if (digit < 0) return null
		n = n * 58n + BigInt(digit)
	}
	if (n > MAX_128) return null
	const hex = n.toString(16).padStart(32, '0')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function uuidToBase58(uuid: string): string {
	if (!isUuid(uuid)) throw new Error('not a uuid')
	let n = BigInt(`0x${uuid.replace(/-/g, '')}`)
	let out = ''
	while (n > 0n) {
		out = ALPHABET[Number(n % 58n)] + out
		n /= 58n
	}
	return out.padStart(22, ALPHABET[0])
}

export type ArtifactRef = {
	uuid: string
	shareKey: string | null
}

export function parseArtifactUrl(href: string): ArtifactRef | null {
	let url: URL
	try {
		url = new URL(href)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' || url.hostname !== 'claude.ai') return null
	const match = PATH_RE.exec(url.pathname)
	const id = match?.[1]
	if (!id) return null
	const uuid = id.length === 22 ? base58ToUuid(id) : id.toLowerCase()
	if (!uuid) return null
	const sk = url.searchParams.get('sk')
	return { uuid, shareKey: sk && SHARE_KEY_RE.test(sk) ? sk : null }
}

export function shortUuid(uuid: string): string {
	return `${uuid.slice(0, 4)}…${uuid.slice(-4)}`
}
