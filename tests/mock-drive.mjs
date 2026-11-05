// In-memory imitation of the parts of the Google Drive v3 REST API the app uses.
// Each access token maps to a Google account; each account has its own files,
// and (like drive.file) only files created through this "app" are listed.
export function createMockDrive() {
  const users = new Map();   // token -> { id, email, name }
  const files = new Map();   // fileId -> { id, owner, name, content, appProperties, modifiedTime, trashed }
  const log = [];
  let n = 0;
  let offline = false;

  function json(status, obj) {
    return { status, body: JSON.stringify(obj), contentType: 'application/json' };
  }

  function handle({ url, method = 'GET', headers = {}, body = '' }) {
    if (offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const auth = headers.Authorization || headers.authorization || '';
    const user = users.get(auth.replace(/^Bearer\s+/, ''));
    log.push({ method, path: u.pathname, user: user && user.email });
    if (!user) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });

    const p = u.pathname;
    if (method === 'GET' && p === '/drive/v3/about') {
      return json(200, { user: { emailAddress: user.email, displayName: user.name, permissionId: user.id } });
    }
    if (method === 'GET' && p === '/drive/v3/files') {
      const q = u.searchParams.get('q') || '';
      const m = /name = '([^']+)'/.exec(q);
      const list = [...files.values()]
        .filter((f) => f.owner === user.id && !f.trashed && (!m || f.name === m[1]))
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
        .map(({ id, name, modifiedTime, appProperties }) => ({ id, name, modifiedTime, appProperties }));
      return json(200, { files: list });
    }
    let mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (method === 'GET' && mm) {
      const f = files.get(decodeURIComponent(mm[1]));
      if (!f || f.owner !== user.id || f.trashed) return json(404, { error: { code: 404, message: 'File not found' } });
      return { status: 200, body: f.content, contentType: 'application/json' };
    }
    if (method === 'POST' && p === '/upload/drive/v3/files') {
      const ct = headers['Content-Type'] || headers['content-type'] || '';
      const boundary = /boundary=(.+)$/.exec(ct)[1];
      const parts = body.split(`--${boundary}`).slice(1, -1).map((s) => s.replace(/^\r\n/, '').replace(/\r\n$/, ''));
      const [mHead, ...mRest] = parts[0].split('\r\n\r\n');
      const meta = JSON.parse(mRest.join('\r\n\r\n'));
      const content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
      void mHead;
      const id = 'file' + (++n);
      const modifiedTime = new Date(Date.now() + n).toISOString();
      files.set(id, { id, owner: user.id, name: meta.name, content, appProperties: meta.appProperties, mimeType: meta.mimeType, modifiedTime, trashed: false });
      return json(200, { id, modifiedTime });
    }
    mm = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (method === 'PATCH' && mm) {
      const f = files.get(decodeURIComponent(mm[1]));
      if (!f || f.owner !== user.id || f.trashed) return json(404, { error: { code: 404, message: 'File not found' } });
      f.content = body;
      f.modifiedTime = new Date(Date.now() + (++n)).toISOString();
      return json(200, { id: f.id, modifiedTime: f.modifiedTime });
    }
    return json(400, { error: { code: 400, message: `Mock does not handle ${method} ${p}` } });
  }

  async function fetchFn(url, opts = {}) {
    const r = handle({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || '' });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.contentType } });
  }

  return {
    handle, fetch: fetchFn, files, log,
    addUser(token, user) { users.set(token, user); },
    setOffline(v) { offline = v; },
    filesOf(userId) { return [...files.values()].filter((f) => f.owner === userId); },
  };
}

/** Fake auth provider for Node tests. */
export function fakeAuth(tokenRef) {
  return {
    async token() { return tokenRef.value; },
    async clear() { tokenRef.value = null; },
    async signOut() { tokenRef.value = null; },
  };
}
