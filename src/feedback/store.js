// Persistence for snapshots + their resolved/overridden outcomes.
//
// `SnapshotStore` is the abstract contract. Two implementations:
//   - IndexedDbStore : browser-persistent (used by the review UI).
//   - MemoryStore    : zero-dep, synchronous-ish (used by tests / SSR).
//
// A stored "record" wraps a snapshot together with its outcomes so the dataset
// (snapshot.features -> realized outcome) can be exported later. Outcomes carry a
// `resolver` of 'auto' (from resolve.js) or 'human' (set via the review UI).
//
// @typedef {Object} StoredRecord
// @property {string} id                     same as snapshot.id (the key)
// @property {import('./snapshot.js').Snapshot} snapshot
// @property {Object<string, OutcomeEntry>} outcomes  keyed by scenarioId
// @property {number} updatedTs              unix seconds of last write
//
// @typedef {Object} OutcomeEntry
// @property {('target-hit'|'invalidated'|'pending')} outcome
// @property {('auto'|'human')} resolver
// @property {number|null} [price]
// @property {number|null} [time]
// @property {string|null} [reason]

/**
 * Abstract store contract. All methods are async and return Promises so the
 * IndexedDB and in-memory backends are interchangeable.
 * @abstract
 */
export class SnapshotStore {
  /** @param {StoredRecord} record @returns {Promise<string>} the id */
  // eslint-disable-next-line no-unused-vars
  put(record) { throw new Error('not implemented'); }
  /** @param {string} id @returns {Promise<StoredRecord|undefined>} */
  // eslint-disable-next-line no-unused-vars
  get(id) { throw new Error('not implemented'); }
  /** @returns {Promise<StoredRecord[]>} all records, newest snapshot first */
  all() { throw new Error('not implemented'); }
  /** @param {string} id @returns {Promise<void>} */
  // eslint-disable-next-line no-unused-vars
  delete(id) { throw new Error('not implemented'); }
}

/** Sort records newest-snapshot-first (stable, by snapshot.ts then id). */
function byNewest(a, b) {
  const ta = a?.snapshot?.ts ?? 0;
  const tb = b?.snapshot?.ts ?? 0;
  return tb - ta || String(b.id).localeCompare(String(a.id));
}

/**
 * In-memory store — backing Map. Deep-clones on the way in/out so callers can't
 * mutate stored state by reference (mirrors the structured-clone IndexedDB does).
 */
export class MemoryStore extends SnapshotStore {
  constructor() {
    super();
    /** @type {Map<string, StoredRecord>} */
    this._map = new Map();
  }

  async put(record) {
    if (!record || !record.id) throw new Error('record.id required');
    this._map.set(record.id, clone({ ...record, updatedTs: record.updatedTs ?? nowSec() }));
    return record.id;
  }

  async get(id) {
    const r = this._map.get(id);
    return r ? clone(r) : undefined;
  }

  async all() {
    return [...this._map.values()].map(clone).sort(byNewest);
  }

  async delete(id) {
    this._map.delete(id);
  }
}

const DB_NAME = 'wave-engine-feedback';
const STORE = 'snapshots';
const DB_VERSION = 1;

/**
 * IndexedDB-backed store. Lazily opens the database on first use. Throws if
 * `indexedDB` is unavailable (e.g. Node) — use MemoryStore there.
 */
export class IndexedDbStore extends SnapshotStore {
  constructor({ dbName = DB_NAME, storeName = STORE } = {}) {
    super();
    this._dbName = dbName;
    this._storeName = storeName;
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    const idb = globalThis.indexedDB;
    if (!idb) return Promise.reject(new Error('IndexedDB unavailable in this environment'));
    this._dbPromise = new Promise((resolve, reject) => {
      const req = idb.open(this._dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this._storeName)) {
          db.createObjectStore(this._storeName, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  }

  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this._storeName, mode);
      const store = tx.objectStore(this._storeName);
      let result;
      Promise.resolve(fn(store))
        .then((r) => { result = r; })
        .catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  put(record) {
    if (!record || !record.id) return Promise.reject(new Error('record.id required'));
    const toStore = { ...record, updatedTs: record.updatedTs ?? nowSec() };
    return this._tx('readwrite', (store) => reqP(store.put(toStore)).then(() => record.id));
  }

  get(id) {
    return this._tx('readonly', (store) => reqP(store.get(id)).then((r) => r ?? undefined));
  }

  all() {
    return this._tx('readonly', (store) => reqP(store.getAll()).then((rs) => (rs ?? []).sort(byNewest)));
  }

  delete(id) {
    return this._tx('readwrite', (store) => reqP(store.delete(id)).then(() => undefined));
  }
}

/**
 * Pick the best available store for the current environment.
 * @returns {SnapshotStore}
 */
export function createStore(opts) {
  return globalThis.indexedDB ? new IndexedDbStore(opts) : new MemoryStore();
}

/** Wrap an IDBRequest in a Promise. */
function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Deep clone via structuredClone when present, else JSON round-trip. */
function clone(x) {
  if (typeof structuredClone === 'function') return structuredClone(x);
  return JSON.parse(JSON.stringify(x));
}
