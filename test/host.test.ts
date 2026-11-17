// End-to-end over the real native messaging framing: spawn host/main.ts with
// a fake Chrome root and data dir.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { realpathSync } from 'node:fs'
import { extensionIdFromKey, shellQuote, stableNodePath } from '../host/install.ts'

const EXT = 'fnmjboognjamdkakgbbkjbfjmeeelfkc'
const ART = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACC = (n: number) => ({ uuid: `0000000${n}-0000-4000-8000-000000000000`, email: `a${n}@example.com`, orgs: [] })

function fixture() {
	const base = mkdtempSync(join(tmpdir(), 'claude-accounts-test-'))
	const chrome = join(base, 'chrome')
	const data = join(base, 'data')
	mkdirSync(chrome)
	writeFileSync(
		join(chrome, 'Local State'),
		JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'claude' } } } }),
	)
	const store = join(chrome, 'Profile 1', 'Local Extension Settings', EXT)
	mkdirSync(store, { recursive: true })
	writeFileSync(join(store, '000003.log'), Buffer.from('\x00\x01junk"nonce":"0123456789abcdef0123456789abcdef"junk'))
	return { chrome, data }
}

// HOST_ENTRY=dist-host/host.mjs runs the same suite against the bundle that install-host ships.
const ENTRY = process.env.HOST_ENTRY ?? 'host/main.ts'

async function call(fx: { chrome: string; data: string }, ...messages: unknown[]): Promise<{ replies: any[]; stderr: string }> {
	const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, `chrome-extension://${EXT}/`], {
		env: { ...process.env, CLAUDE_ACCOUNTS_CHROME_ROOT: fx.chrome, CLAUDE_ACCOUNTS_DATA_DIR: fx.data, CLAUDE_ACCOUNTS_DRY_OPEN: '1' },
	})
	const out: Buffer[] = []
	let stderr = ''
	child.stdout.on('data', d => out.push(d))
	child.stderr.on('data', d => (stderr += d))
	for (const m of messages) {
		const body = Buffer.from(JSON.stringify(m))
		const head = Buffer.alloc(4)
		head.writeUInt32LE(body.length)
		child.stdin.write(Buffer.concat([head, body]))
	}
	child.stdin.end()
	await new Promise(r => child.on('close', r))
	let buf = Buffer.concat(out)
	const replies = []
	while (buf.length >= 4) {
		const len = buf.readUInt32LE(0)
		replies.push(JSON.parse(buf.subarray(4, 4 + len).toString()))
		buf = buf.subarray(4 + len)
	}
	return { replies, stderr }
}

test('stable node path resolves to the same binary', () => {
	assert.equal(realpathSync(stableNodePath()), realpathSync(process.execPath))
	assert.equal(stableNodePath('/nonexistent/node'), '/nonexistent/node')
	assert.equal(shellQuote("a'b c"), "'a'\\''b c'")
})

test('extension id derives from the manifest key', () => {
	const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'))
	assert.equal(extensionIdFromKey(manifest.key), EXT)
})

test('hello, whoami, seen, route, open, access over stdio', async () => {
	const fx = fixture()
	const { replies, stderr } = await call(
		fx,
		{ type: 'hello' },
		{ type: 'whoami', nonce: '0123456789abcdef0123456789abcdef' },
		{ type: 'whoami', nonce: 'ffffffffffffffffffffffffffffffff' },
		{ type: 'seen', dir: 'Default', account: ACC(1) },
		{ type: 'seen', dir: 'Profile 1', account: ACC(2) },
		{ type: 'route', dir: 'Default', artifact: ART, outcome: 'no_access', ownerOrg: null },
		{ type: 'open', dir: 'Profile 1', url: `https://claude.ai/artifact/${ART}`, artifact: ART },
		{ type: 'access', dir: 'Profile 1', artifact: ART, accountUuid: ACC(2).uuid },
	)
	assert.equal(replies.length, 8)
	assert.deepEqual(replies[0].chromeProfiles, [
		{ dir: 'Default', name: 'Person 1' },
		{ dir: 'Profile 1', name: 'claude' },
	])
	assert.equal(replies[0].state.mode, 'auto')
	assert.deepEqual(replies[1], { ok: true, dir: 'Profile 1' })
	assert.deepEqual(replies[2], { ok: true, dir: null })
	assert.deepEqual(replies[5], { ok: true, mode: 'auto', target: { dir: 'Profile 1', email: 'a2@example.com' }, reason: 'next' })
	assert.deepEqual(replies[6], { ok: true })
	assert.match(stderr, /dry-run open Profile 1 https:\/\/claude\.ai\/artifact\//)
	assert.deepEqual(replies[7], { ok: true, routedFrom: 'a1@example.com' })

	const state = JSON.parse(readFileSync(join(fx.data, 'state.json'), 'utf8'))
	assert.equal(state.artifacts[ART].accountUuid, ACC(2).uuid)
	assert.equal(statSync(join(fx.data, 'state.json')).mode & 0o777, 0o600)
})

test('rejects foreign URLs, unknown profiles and junk', async () => {
	const fx = fixture()
	const { replies, stderr } = await call(
		fx,
		{ type: 'open', dir: 'Profile 1', url: 'https://evil.example/' },
		{ type: 'open', dir: 'Profile 1', url: 'http://claude.ai/' },
		{ type: 'open', dir: 'Profile 1', url: 'https://user:pw@claude.ai/' },
		{ type: 'open', dir: 'Profile 9', url: 'https://claude.ai/' },
		{ type: 'open', dir: '../../etc', url: 'https://claude.ai/' },
		{ type: 'seen', dir: 'Default', account: { uuid: 'x', email: 'y' } },
		{ type: 'setMode', mode: 'yolo' },
		{ type: 'nope' },
		'just a string',
	)
	assert.equal(replies.length, 9)
	for (const r of replies) assert.equal(r.ok, false, JSON.stringify(r))
	assert.doesNotMatch(stderr, /dry-run open/)
})

test('two hosts writing at once keep the state valid', async () => {
	const fx = fixture()
	await Promise.all([
		call(fx, { type: 'seen', dir: 'Default', account: ACC(1) }, { type: 'setMode', mode: 'ask' }),
		call(fx, { type: 'seen', dir: 'Profile 1', account: ACC(2) }),
	])
	const state = JSON.parse(readFileSync(join(fx.data, 'state.json'), 'utf8'))
	assert.deepEqual(Object.keys(state.profiles).sort(), ['Default', 'Profile 1'])
	assert.equal(state.mode, 'ask')
})
