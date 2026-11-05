// On-device storage. One IndexedDB database with a unique name; nothing else
// on the origin is touched.
import { IDB_NAME } from './constants.js';

const STORE = 'kv';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IdbStore {
  constructor(name = IDB_NAME) {
    this.name = name;
    this.db = null;
  }
  async open() {
    if (this.db) return this.db;
    const r = indexedDB.open(this.name, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    this.db = await req(r);
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }
  async get(key) {
    const db = await this.open();
    return req(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  }
  async set(key, value) {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  }
  /** Deletes ONLY this app's database. */
  async destroy() {
    if (this.db) { this.db.close(); this.db = null; }
    await req(indexedDB.deleteDatabase(this.name));
  }
}

function clone(v) {
  try { return structuredClone(v); } catch { return v; }
}

/** In-memory store with the same interface (used by tests). */
export class MemoryStore {
  constructor() { this.data = new Map(); }
  async get(key) { return clone(this.data.get(key)); }
  async set(key, value) { this.data.set(key, clone(value)); }
  async destroy() { this.data.clear(); }
}

/** Ask the browser not to evict this origin's storage. */
export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return 'unsupported';
    if (await navigator.storage.persisted()) return 'granted';
    return (await navigator.storage.persist()) ? 'granted' : 'denied';
  } catch { return 'unsupported'; }
}

export async function persistenceStatus() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return 'unsupported';
    return (await navigator.storage.persisted()) ? 'granted' : 'not granted';
  } catch { return 'unsupported'; }
}
