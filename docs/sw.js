// Service worker for the Monthly Budget app.
// - Registered with scope './' so it only controls this app's folder.
// - Uses its own cache-name prefix and only ever deletes caches with that prefix.
// - Never intercepts other origins (Google sign-in / Drive go straight to the network).
const PREFIX = 'mbapp-monthly-budget-aed-';
const VERSION = 'v1.0.0';
const CACHE = PREFIX + VERSION;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js', './js/auth.js', './js/calc.js', './js/chart.js', './js/config.js', './js/constants.js',
  './js/crypto.js', './js/doc.js', './js/drive.js', './js/exporting.js', './js/format.js',
  './js/repo.js', './js/store.js', './js/sync.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;

  // Network first (with a short timeout) so updates — including a newly added
  // Google client ID in config.js — arrive when online; cached copy when offline.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './index.html' : req;
    try {
      const res = await Promise.race([
        req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
      if (res.ok && (req.mode !== 'navigate' || url.pathname === scopePath || url.pathname === scopePath + 'index.html')) {
        await c.put(key, res.clone());
      }
      return res;
    } catch {
      const hit = await c.match(key, { ignoreSearch: true });
      return hit || (req.mode === 'navigate' ? await c.match('./') : null) || Response.error();
    }
  })());
});
