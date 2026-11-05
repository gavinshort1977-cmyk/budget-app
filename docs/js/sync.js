// Google Drive sync engine. Independent of the browser UI so it can be tested
// with a mocked Drive API.
import { mergeRegs, hasUserData, defaultRegs, val } from './doc.js';
import { seal, open, NeedsPassphrase, deriveKey } from './crypto.js';
import { DriveError } from './drive.js';

export class SyncEngine {
  /**
   * @param {object} o
   * @param {import('./repo.js').Repo} o.repo
   * @param {import('./drive.js').DriveClient} o.drive
   * @param {{token:(o:{interactive:boolean})=>Promise<string|null>, clear:()=>Promise<void>, signOut:()=>Promise<void>}} o.auth
   * @param {boolean} o.configured
   * @param {() => boolean} [o.isOnline]
   */
  constructor({ repo, drive, auth, configured, isOnline = () => true, onState = () => {} }) {
    Object.assign(this, { repo, drive, auth, configured, isOnline, onState });
    this.state = { status: configured ? 'idle' : 'not-configured' };
    this.running = null;
    this.again = false;
  }

  set(state) {
    this.state = state;
    this.onState(state);
  }

  /** Run one sync. Concurrent calls are coalesced. */
  sync(opts = {}) {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this._sync(opts).finally(() => {
      this.running = null;
      if (this.again && this.state.status === 'ok') {
        this.again = false;
        return this.sync();
      }
      this.again = false;
    });
    return this.running;
  }

  async _sync({ interactive = false, firstLink = null } = {}) {
    const { repo } = this;
    if (!this.configured) return this.set({ status: 'not-configured' });
    if (!this.isOnline()) return this.set({ status: 'offline' });
    this.set({ status: 'syncing' });
    try {
      const token = await this.auth.token({ interactive });
      if (!token) return this.set({ status: 'signin' });

      let user;
      try {
        user = await this.drive.about();
      } catch (e) {
        if (e.status === 401) {
          await this.auth.clear();
          return this.set({ status: 'signin' });
        }
        throw e;
      }
      repo.meta.currentUser = user;

      // Account safety: never touch data that belongs to another account.
      if (repo.meta.linked && repo.meta.linked.id !== user.id) {
        await repo.saveMeta();
        return this.set({ status: 'wrong-account', linked: repo.meta.linked, current: user });
      }

      // Find & read the Drive file.
      let fileId = repo.meta.linked ? repo.meta.fileId : null;
      let text = null;
      if (fileId) {
        text = await this.drive.download(fileId);
        if (text === null) fileId = null;
      }
      if (!fileId) {
        const f = await this.drive.findFile();
        if (f) {
          fileId = f.id;
          text = await this.drive.download(f.id);
        }
      }

      let remote = null;
      if (text !== null && text !== undefined) {
        try {
          remote = await open(text, repo.keyInfo);
        } catch (e) {
          if (e instanceof NeedsPassphrase) return this.set({ status: 'passphrase', kdf: e.kdf, wrong: e.wrong });
          throw e;
        }
      }

      // First time this device links to an account.
      if (!repo.meta.linked) {
        if (remote && hasUserData(repo.regs) && hasUserData(remote.regs) && !firstLink) {
          return this.set({ status: 'first-link', current: user });
        }
        if (firstLink === 'use-drive' && remote) await repo.replaceAll({ ...defaultRegs(), ...remote.regs });
        repo.meta.linked = { id: user.id, email: user.email, name: user.name, at: Date.now() };
      }
      repo.meta.fileId = fileId;

      const snapshot = repo.counter;
      let remoteChanged = true;
      if (remote) {
        await repo.mergeRemote(remote.regs);
        remoteChanged = mergeRegs(remote.regs, repo.regs).localChanged;
      }

      // Encryption mode follows the (synced) s:encrypt setting.
      const wantEncrypt = !!val(repo.regs, 's:encrypt', false);
      if (wantEncrypt && !repo.keyInfo) {
        return this.set({ status: 'passphrase', kdf: remote && remote.kdf ? remote.kdf : null, wrong: false });
      }
      if (!wantEncrypt && repo.keyInfo) await repo.setKey(null);
      const modeMismatch = remote && (remote.encrypted !== wantEncrypt ||
        (wantEncrypt && remote.kdf && remote.kdf.salt !== repo.keyInfo.salt));

      if (!remote || remoteChanged || modeMismatch) {
        const body = await seal(repo.regs, wantEncrypt ? repo.keyInfo : null);
        if (fileId) {
          try {
            await this.drive.update(fileId, body);
          } catch (e) {
            if (e.status !== 404) throw e;
            fileId = null;
          }
        }
        if (!fileId) fileId = (await this.drive.create(body)).id;
        repo.meta.fileId = fileId;
      }

      repo.clearPending(snapshot);
      repo.meta.lastSync = Date.now();
      repo.meta.lastError = null;
      await repo.saveMeta();
      if (repo.counter > snapshot) this.again = true;
      return this.set({ status: 'ok', user });
    } catch (e) {
      const offline = !this.isOnline() || (e instanceof TypeError && !(e instanceof DriveError));
      repo.meta.lastError = offline ? null : { message: String(e.message || e), at: Date.now() };
      await repo.saveMeta();
      return this.set(offline ? { status: 'offline' } : { status: 'error', message: String(e.message || e) });
    }
  }

  // ----- user decisions ---------------------------------------------------

  async unlock(passphrase) {
    const kdf = this.state.kdf;
    const keyInfo = kdf ? await deriveKey(passphrase, kdf.salt, kdf.iterations) : await deriveKey(passphrase);
    await this.repo.setKey(keyInfo);
    return this.sync();
  }

  async enableEncryption(passphrase) {
    await this.repo.setKey(await deriveKey(passphrase));
    await this.repo.set('s:encrypt', true);
    return this.sync();
  }

  async disableEncryption() {
    // Keep the key until the encrypted Drive copy has been read once more;
    // the sync drops it after merging and uploads a plain file.
    await this.repo.set('s:encrypt', false);
    return this.sync();
  }

  /** Wrong account: replace this device's data with the newly signed-in account's data. */
  async useNewAccount() {
    const user = this.state.current;
    if (!user) return;
    await this.repo.replaceAll(defaultRegs());
    await this.repo.setKey(null);
    this.repo.meta.linked = { id: user.id, email: user.email, name: user.name, at: Date.now() };
    this.repo.meta.fileId = null;
    this.repo.meta.lastSync = null;
    await this.repo.saveMeta();
    return this.sync();
  }

  /** Wrong account: move this device's data to the new account — only if it has no budget file yet. */
  async linkLocalToNewAccount() {
    const user = this.state.current;
    if (!user) return;
    const existing = await this.drive.findFile();
    if (existing) {
      this.set({ ...this.state, message: `${user.email || 'That account'} already has budget data in Drive. To avoid mixing two people's data, choose "Use that account's data" or sign out.` });
      return;
    }
    this.repo.meta.linked = { id: user.id, email: user.email, name: user.name, at: Date.now() };
    this.repo.meta.fileId = null;
    await this.repo.saveMeta();
    return this.sync();
  }

  async signOut() {
    await this.auth.signOut();
    this.repo.meta.currentUser = null;
    await this.repo.saveMeta();
    this.set({ status: 'signin' });
  }
}
