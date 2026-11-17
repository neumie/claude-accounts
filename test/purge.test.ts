import assert from 'node:assert/strict'
import { test } from 'node:test'
import { purgeMarker, purgeSiteData, purgeStorage } from '../src/shared/purge.ts'

class MemStorage {
	map = new Map<string, string>()
	get length() {
		return this.map.size
	}
	key(i: number) {
		return [...this.map.keys()][i] ?? null
	}
	getItem(k: string) {
		return this.map.get(k) ?? null
	}
	setItem(k: string, v: string) {
		this.map.set(k, v)
	}
	removeItem(k: string) {
		this.map.delete(k)
	}
	clear() {
		this.map.clear()
	}
}

const ID = '0123456789abcdef'

test('marker is read from the cookie string', () => {
	assert.equal(purgeMarker(`a=1; ca_purge=${ID}; b=2`), ID)
	assert.equal(purgeMarker(`ca_purge=${ID}`), ID)
	assert.equal(purgeMarker('xca_purge=0123456789abcdef'), null)
	assert.equal(purgeMarker('ca_purge=nothex'), null)
})

test('account state goes, device identity stays, once per switch', () => {
	const s = new MemStorage()
	for (const k of ['rq-cache-confirmed-account', '__qk_hint_account_uuid', 'ccd-sync-owner', 'x-ark-arid-1', 'anthropic-device-x', 'test.flag'])
		s.setItem(k, 'v')
	assert.equal(purgeStorage(s as unknown as Storage, ID), 3)
	assert.deepEqual([...s.map.keys()].sort(), ['anthropic-device-x', 'ca_purged', 'test.flag', 'x-ark-arid-1'])
	s.setItem('rq-cache-confirmed-account', 'new account, written after the purge')
	assert.equal(purgeStorage(s as unknown as Storage, ID), 0) // second tab, same switch: no-op
	assert.equal(purgeStorage(s as unknown as Storage, 'fedcba9876543210'), 1)
})

test('IndexedDB: everything but the device key and attestation is cleared', async () => {
	const cleared: string[] = []
	const idb = {
		databases: async () => [{ name: 'keyval-store' }, { name: 'claude-device-binding' }, { name: 'x-ark-arid-db' }],
		open: (name: string) => {
			const req: Record<string, any> = {}
			setTimeout(() => {
				const tx: Record<string, any> = { objectStore: () => ({ clear: () => cleared.push(name) }) }
				req.result = { objectStoreNames: ['s'], transaction: () => tx, close: () => {} }
				req.onsuccess()
				setTimeout(() => tx.oncomplete(), 0)
			}, 0)
			return req
		},
	}
	purgeSiteData(ID, new MemStorage() as unknown as Storage, new MemStorage() as unknown as Storage, idb as unknown as IDBFactory, undefined)
	await new Promise(r => setTimeout(r, 20))
	assert.deepEqual(cleared, ['keyval-store'])
})
