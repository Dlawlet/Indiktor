// Promise-based IndexedDB with two stores:
//   'kv'        — tiny JSON values by string key (annotations, misc).
//   'snapshots' — one record per snapshot (keyPath 'id'), indexed by paramHash /
//                 asset / tf / outcome, so the ① feedback loop can attribute
//                 realized outcomes to a param config and segment, at volume
//                 (no localStorage quota, no single re-serialized blob).
//
// Phase ① structured store lives here on top of the same database.

const DB_NAME   = 'indiktor';
const KV_STORE  = 'kv';
const SNAP_STORE = 'snapshots';
const VERSION   = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error('IndexedDB unavailable'));
  dbPromise = new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(SNAP_STORE)) {
        const s = db.createObjectStore(SNAP_STORE, { keyPath: 'id' });
        s.createIndex('paramHash', 'paramHash', { unique: false });
        s.createIndex('asset',     'asset',     { unique: false });
        s.createIndex('tf',        'tf',        { unique: false });
        s.createIndex('outcome',   'outcome',   { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
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

// ── kv store ──────────────────────────────────────────────────────────────────
export function idbGet(key)      { return tx(KV_STORE, 'readonly',  s => reqP(s.get(key))); }
export function idbSet(key, val) { return tx(KV_STORE, 'readwrite', s => reqP(s.put(val, key))); }
export function idbDel(key)      { return tx(KV_STORE, 'readwrite', s => reqP(s.delete(key))); }

// ── snapshots store (one record per snapshot, keyPath 'id') ───────────────────
export function snapPut(record)  { return tx(SNAP_STORE, 'readwrite', s => reqP(s.put(record))); }
export function snapGetAll()     { return tx(SNAP_STORE, 'readonly',  s => reqP(s.getAll())).then(r => r ?? []); }
export function snapDelete(id)   { return tx(SNAP_STORE, 'readwrite', s => reqP(s.delete(id))); }
export function snapClear()      { return tx(SNAP_STORE, 'readwrite', s => reqP(s.clear())); }

// Bulk insert (used by migration). Returns count written.
export async function snapBulkPut(records) {
  if (!records?.length) return 0;
  await tx(SNAP_STORE, 'readwrite', (s) => { for (const r of records) s.put(r); return null; });
  return records.length;
}
