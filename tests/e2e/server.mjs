// Tiny static server that mimics GitHub Pages hosting two apps on one origin:
//   /budget-app/  -> this app (docs/)
//   /expense-tracker/ -> a stand-in "other app" used to prove isolation
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const MOUNTS = { '/budget-app/': join(root, 'docs'), '/expense-tracker/': join(root, 'tests/e2e/other-app') };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function startServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const mount = Object.keys(MOUNTS).find((m) => url.pathname.startsWith(m));
    if (!mount) { res.writeHead(url.pathname === '/budget-app' ? 301 : 404, { Location: '/budget-app/' }); return res.end(); }
    if (server.configOverride && url.pathname === '/budget-app/js/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      return res.end(server.configOverride);
    }
    let rel = decodeURIComponent(url.pathname.slice(mount.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(MOUNTS[mount], rel));
    if (!file.startsWith(MOUNTS[mount])) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer(Number(process.env.PORT) || 8080);
  console.log(`Serving on http://127.0.0.1:${s.address().port}/budget-app/`);
}
