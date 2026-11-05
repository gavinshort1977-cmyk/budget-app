// Holds the live document (registers) + device metadata and persists them.
import { Clock, buildModel, defaultRegs, isNewer, maxTime, mergeRegs, newId } from './doc.js';

export class Repo {
  constructor(store) {
    this.store = store;
    this.regs = {};
    this.meta = {};
    this.keyInfo = null;
    this.listeners = new Set();
    this.counter = 0; // increments on each local change
    this._model = null;
  }

  async load() {
    this.regs = (await this.store.get('regs')) || defaultRegs();
    this.meta = Object.assign({
      deviceId: newId('d'), clockLast: 0, linked: null, fileId: null,
      lastSync: null, lastError: null, pending: {}, token: null,
    }, (await this.store.get('meta')) || {});
    this.keyInfo = (await this.store.get('key')) || null;
    this.clock = new Clock(this.meta.deviceId, Math.max(this.meta.clockLast || 0, maxTime(this.regs)));
    this.counter = Math.max(0, ...Object.values(this.meta.pending || {}));
    await this.store.set('regs', this.regs);
    await this.saveMeta();
    this._model = null;
    return this;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { this._model = null; for (const fn of this.listeners) fn(kind); }

  model() {
    if (!this._model) this._model = buildModel(this.regs);
    return this._model;
  }

  get pendingCount() { return Object.keys(this.meta.pending || {}).length; }

  /** Set several values at once. entries: [[key, value], ...]. Returns undo entries. */
  async setMany(entries) {
    const undo = [];
    this.counter++;
    for (const [key, v] of entries) {
      const prev = this.regs[key];
      const prevV = prev ? prev.v : null;
      if (prev && prevV === v) continue;
      undo.push([key, prevV ?? null]);
      this.regs[key] = { v, t: this.clock.now(), d: this.meta.deviceId };
      this.meta.pending[key] = this.counter;
    }
    if (!undo.length) return undo;
    this.meta.clockLast = this.clock.last;
    await this.store.set('regs', this.regs);
    await this.saveMeta();
    this.emit('local');
    return undo;
  }

  set(key, v) { return this.setMany([[key, v]]); }

  /** Merge registers that came from Drive into the local document. */
  async mergeRemote(remoteRegs) {
    const { merged, localChanged } = mergeRegs(this.regs, remoteRegs);
    this.clock.observe(maxTime(remoteRegs));
    this.meta.clockLast = this.clock.last;
    if (localChanged) {
      this.regs = merged;
      await this.store.set('regs', this.regs);
      this.emit('remote');
    }
    await this.saveMeta();
    return localChanged;
  }

  /** Replace everything (used only after an explicit user choice). */
  async replaceAll(regs) {
    this.regs = regs;
    this.clock.observe(maxTime(regs));
    this.meta.clockLast = this.clock.last;
    this.meta.pending = {};
    await this.store.set('regs', this.regs);
    await this.saveMeta();
    this.emit('remote');
  }

  /**
   * Restore a backup: every value becomes the backup's value with a fresh
   * timestamp, so the restore also wins when synced to other devices.
   */
  async restore(backupRegs) {
    const entries = [];
    for (const [k, r] of Object.entries(backupRegs)) entries.push([k, r.v]);
    const ids = (regs) => {
      const s = new Set();
      for (const k of Object.keys(regs)) {
        const [p, id] = k.split(':');
        if ((p === 'g' || p === 'l' || p === 'a') && id) s.add(`${p}:${id}`);
      }
      return s;
    };
    const keep = ids(backupRegs);
    for (const ent of ids(this.regs)) if (!keep.has(ent)) entries.push([`${ent}:del`, true]);
    for (const k of Object.keys(this.regs)) {
      if (!(k in backupRegs) && (k.startsWith('v:') || k.startsWith('b:'))) entries.push([k, null]);
    }
    // Write everything, even unchanged values, so the restore propagates.
    this.counter++;
    for (const [key, v] of entries) {
      this.regs[key] = { v, t: this.clock.now(), d: this.meta.deviceId };
      this.meta.pending[key] = this.counter;
    }
    this.meta.clockLast = this.clock.last;
    await this.store.set('regs', this.regs);
    await this.saveMeta();
    this.emit('local');
  }

  clearPending(upToCounter) {
    for (const [k, c] of Object.entries(this.meta.pending)) if (c <= upToCounter) delete this.meta.pending[k];
  }

  async setKey(keyInfo) {
    this.keyInfo = keyInfo;
    await this.store.set('key', keyInfo);
  }

  async saveMeta() {
    await this.store.set('meta', this.meta);
  }
}

export { isNewer };
