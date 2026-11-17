// claude.ai remembers which account its cached data belongs to outside cookies
// (localStorage: rq-cache-confirmed-account, __qk_hint_account_uuid, ccd-sync-owner;
// IndexedDB keyval-store with the query cache). After a switch that state must go,
// or the app talks as the old account and logs the new session out.
// Device identity stays: the non-exportable device key and CDN attestation.

export const MARKER_COOKIE = 'ca_purge'
const DONE_KEY = 'ca_purged'
const KEEP_DBS = new Set(['claude-device-binding', 'x-ark-arid-db'])
const KEEP_PREFIXES = ['x-ark-arid-', 'anthropic-device-', 'test.', DONE_KEY]

export function purgeMarker(cookieString: string): string | null {
	const m = /(?:^|;\s*)ca_purge=([0-9a-f]{16})(?:;|$)/.exec(cookieString)
	return m?.[1] ?? null
}

export function keepKey(key: string): boolean {
	return KEEP_PREFIXES.some(p => key.startsWith(p))
}

/** Clears every non-kept key once per switch id. Returns how many keys were removed. */
export function purgeStorage(storage: Storage, switchId: string): number {
	if (storage.getItem(DONE_KEY) === switchId) return 0
	const doomed: string[] = []
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i)
		if (key !== null && !keepKey(key)) doomed.push(key)
	}
	for (const key of doomed) storage.removeItem(key)
	storage.setItem(DONE_KEY, switchId)
	return doomed.length
}

function clearDatabase(idb: IDBFactory, name: string): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, 2000)
		const finish = () => {
			clearTimeout(timer)
			resolve()
		}
		const req = idb.open(name)
		req.onerror = finish
		req.onblocked = finish
		req.onsuccess = () => {
			const db = req.result
			const stores = Array.from(db.objectStoreNames)
			if (stores.length === 0) {
				db.close()
				finish()
				return
			}
			try {
				// Clear the stores instead of deleteDatabase, which blocks while the page holds a connection.
				const tx = db.transaction(stores, 'readwrite')
				for (const s of stores) tx.objectStore(s).clear()
				tx.oncomplete = tx.onerror = tx.onabort = () => {
					db.close()
					finish()
				}
			} catch {
				db.close()
				finish()
			}
		}
	})
}

/**
 * Synchronous part first (web storage), then IndexedDB and Cache Storage in the
 * background. The shared storages purge once per switch id; sessionStorage per tab.
 */
export function purgeSiteData(
	switchId: string,
	local: Storage,
	session: Storage,
	idb: IDBFactory | undefined,
	cacheStorage: CacheStorage | undefined,
): void {
	let firstHere = false
	try {
		firstHere = local.getItem(DONE_KEY) !== switchId
		purgeStorage(local, switchId)
	} catch {
		// storage disabled
	}
	try {
		purgeStorage(session, switchId)
	} catch {
		// storage disabled
	}
	if (!firstHere) return
	if (idb?.databases) {
		void idb
			.databases()
			.then(dbs => Promise.all(dbs.map(d => d.name).filter((n): n is string => !!n && !KEEP_DBS.has(n)).map(n => clearDatabase(idb, n))))
			.catch(() => undefined)
	}
	if (cacheStorage) {
		void cacheStorage
			.keys()
			.then(keys => Promise.all(keys.map(k => cacheStorage.delete(k))))
			.catch(() => undefined)
	}
}
