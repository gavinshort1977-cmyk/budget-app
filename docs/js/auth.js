// Google sign-in with Google Identity Services (token model, browser only).
// - No client secret is used or needed.
// - Only the drive.file scope is requested. The signed-in email address is
//   read from Drive's "about" endpoint, which needs no extra scope.
// - The Google account picker is always shown when signing in.
import { DRIVE_SCOPE } from './constants.js';

const GIS_URL = 'https://accounts.google.com/gsi/client';

let gisPromise = null;
function loadGis() {
  if (globalThis.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in. Are you online?')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export class GoogleAuth {
  constructor({ clientId, repo }) {
    this.clientId = clientId;
    this.repo = repo;
  }

  cached() {
    const t = this.repo.meta.token;
    return t && t.expiresAt > Date.now() + 60_000 ? t.accessToken : null;
  }

  /** Get an access token. Shows the Google account picker only if interactive. */
  async token({ interactive }) {
    const c = this.cached();
    if (c) return c;
    if (!interactive) return null;
    await loadGis();
    const resp = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: DRIVE_SCOPE,
        prompt: 'select_account',
        callback: (r) => (r && r.access_token ? resolve(r) : reject(new Error(r && r.error_description ? r.error_description : 'Sign-in was not completed.'))),
        error_callback: (err) => reject(new Error(err && err.type === 'popup_closed' ? 'Sign-in window was closed.' : (err && err.message) || 'Sign-in failed.')),
      });
      const hint = this.repo.meta.linked && this.repo.meta.linked.email;
      client.requestAccessToken({ prompt: 'select_account', ...(hint ? { login_hint: hint } : {}) });
    });
    if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      throw new Error('Google Drive access was not allowed. Tick the Drive box when signing in.');
    }
    this.repo.meta.token = { accessToken: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
    await this.repo.saveMeta();
    return resp.access_token;
  }

  async clear() {
    this.repo.meta.token = null;
    await this.repo.saveMeta();
  }

  async signOut() {
    const t = this.repo.meta.token;
    if (t && globalThis.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(t.accessToken, () => {}); } catch { /* ignore */ }
    }
    await this.clear();
  }
}
