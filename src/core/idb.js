// Minimal promise-based IndexedDB key→value store.
//
// localStorage is reserved for tiny synchronous boot prefs (pins, lastTF, lastK,
// theme); bulky/growing data (snapshots, annotations) lives here so it never
// saturates the 5 MB localStorage quota. A single 'kv' object store holds JSON
// values addressed by string key — same mental model as localStorage, async.
//
// Phase ① will add structured stores (provenance-indexed snapshots) on top of
// the same database; this KV layer stays as the simple substrate.

const DB_NAME = 'indiktor';
const STORE   = 'kv';
const VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error('IndexedDB unavailable'));
  dbPromise = new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror    = () => reject(t.error);
    t.onabort    = () => reject(t.error);
  }));
}

const reqP = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror   = () => reject(r.error);
});

export function idbGet(key)      { return tx('readonly',  s => reqP(s.get(key))); }
export function idbSet(key, val) { return tx('readwrite', s => reqP(s.put(val, key))); }
export function idbDel(key)      { return tx('readwrite', s => reqP(s.delete(key))); }
