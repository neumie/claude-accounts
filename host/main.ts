// Chrome native messaging host. Chrome starts one process per
// runtime.sendNativeMessage call: read one framed JSON request, answer, exit.
// Frame = 4-byte little-endian length + UTF-8 JSON.

import { openInProfile, type Opener } from './chrome.ts'
import { handle } from './handler.ts'

const MAX_REQUEST_BYTES = 64 * 1024

function extensionIdFromArgs(argv: readonly string[]): string {
	for (const arg of argv) {
		const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(arg)
		if (m?.[1]) return m[1]
	}
	return ''
}

function write(message: unknown): void {
	const body = Buffer.from(JSON.stringify(message), 'utf8')
	const header = Buffer.alloc(4)
	header.writeUInt32LE(body.length, 0)
	process.stdout.write(Buffer.concat([header, body]))
}

const dryRunOpen: Opener = async (dir, url) => {
	process.stderr.write(`dry-run open ${dir} ${url}\n`)
}

async function main(): Promise<void> {
	const extensionId = extensionIdFromArgs(process.argv.slice(2))
	const open = process.env.CLAUDE_ACCOUNTS_DRY_OPEN === '1' ? dryRunOpen : openInProfile
	let buf = Buffer.alloc(0)
	let busy = Promise.resolve()

	process.stdin.on('data', (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk])
		while (buf.length >= 4) {
			const len = buf.readUInt32LE(0)
			if (len > MAX_REQUEST_BYTES) {
				write({ ok: false, error: 'request too large' })
				process.exit(1)
			}
			if (buf.length < 4 + len) break
			const body = buf.subarray(4, 4 + len)
			buf = buf.subarray(4 + len)
			let request: unknown
			try {
				request = JSON.parse(body.toString('utf8'))
			} catch {
				request = null
			}
			busy = busy.then(async () => write(await handle(request, { extensionId, now: Date.now, open })))
		}
	})
	process.stdin.on('end', () => {
		void busy.then(() => process.exit(0))
	})
}

void main()
