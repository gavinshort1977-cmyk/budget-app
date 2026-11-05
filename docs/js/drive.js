// Minimal Google Drive v3 REST client (fetch only, no Google libraries).
// With the drive.file scope Google only lets this app see files it created.
import { APP_ID, DRIVE_FILE_NAME } from './constants.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class DriveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class DriveClient {
  /** @param {() => Promise<string>} getToken  @param {typeof fetch} fetchFn */
  constructor(getToken, fetchFn = (...a) => globalThis.fetch(...a)) {
    this.getToken = getToken;
    this.fetch = fetchFn;
  }

  async call(url, opts = {}) {
    const token = await this.getToken();
    const res = await this.fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      let msg = `Google Drive error ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) msg += `: ${j.error.message}`;
      } catch { /* ignore */ }
      throw new DriveError(res.status, msg);
    }
    return res;
  }

  /** Who is signed in. Works with the drive.file scope (no extra scope needed). */
  async about() {
    const res = await this.call(`${API}/about?fields=user(emailAddress,displayName,permissionId)`);
    const j = await res.json();
    const u = j.user || {};
    if (!u.permissionId) throw new DriveError(500, 'Google did not return an account id.');
    return { id: u.permissionId, email: u.emailAddress || '', name: u.displayName || '' };
  }

  async findFile() {
    const q = encodeURIComponent(`name = '${DRIVE_FILE_NAME}' and trashed = false`);
    const res = await this.call(`${API}/files?q=${q}&spaces=drive&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,appProperties)`);
    const j = await res.json();
    const files = (j.files || []).filter((f) => !f.appProperties || !f.appProperties.app || f.appProperties.app === APP_ID);
    return files[0] || null;
  }

  /** Returns file text, or null if the file no longer exists. */
  async download(id) {
    try {
      const res = await this.call(`${API}/files/${encodeURIComponent(id)}?alt=media`);
      return await res.text();
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async create(text) {
    const boundary = 'mbapp' + Math.random().toString(36).slice(2);
    const meta = { name: DRIVE_FILE_NAME, mimeType: 'application/json', appProperties: { app: APP_ID }, description: 'Data for the Monthly Budget app. Do not edit by hand.' };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const res = await this.call(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    return res.json();
  }

  async update(id, text) {
    const res = await this.call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text,
    });
    return res.json();
  }
}
