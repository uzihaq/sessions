// pretty-PTY app-shell service worker.
//
// Goals:
//   1. Tap the home-screen icon → app opens INSTANTLY from cache (no
//      network round-trip blocking first paint).
//   2. /api/* and /ws are NEVER intercepted — those must always hit
//      prettyd live; caching a session list or replaying a stale WS
//      handshake would be a footgun.
//   3. Survive offline / prettyd-not-yet-up: the bundle still loads
//      from cache, the React app boots, hydrates from localStorage
//      (last seen sessions list, lastSeq per session), and shows the
//      familiar tabs even before the WS connects.
//
// Strategy:
//   • install: precache a tiny static shell (just enough to render
//     "loading…").
//   • fetch:
//       /api/* or /ws/*       → bypass entirely (let browser network it).
//       navigation requests   → network-first, fall back to cached
//                               /index.html when offline. Also opportun-
//                               istically refreshes the cached index so
//                               next cold-load gets the latest HTML.
//       same-origin GET asset → cache-first with background refresh
//                               (stale-while-revalidate). Hashed asset
//                               names mean the cached entry is naturally
//                               immutable for that hash; new builds add
//                               new entries.
//   • activate: drop any old caches whose key isn't the current version.

const CACHE_VERSION = 'pretty-pty-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg'];

self.addEventListener('install', (event) => {
  // We deliberately do NOT call self.skipWaiting() — a new SW version
  // should wait until the user closes/reopens the app, so a mid-session
  // reload doesn't reset the live view out from under them.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/DELETE always hit network

  const url = new URL(req.url);

  // Bypass: anything talking to prettyd (proxied through vite's /api or
  // /ws) must never be served from cache. Returning early lets the
  // browser handle the request normally.
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  // Bypass: vite dev-server internals (HMR, /@vite/, /@react-refresh).
  // Caching them would break hot reload while we're working on the app.
  if (url.pathname.startsWith('/@vite/')) return;
  if (url.pathname.startsWith('/@react-refresh')) return;
  if (url.pathname.startsWith('/@id/')) return;
  if (url.pathname.startsWith('/@fs/')) return;

  // Navigation requests (typing the URL, tapping the icon): network-
  // first with cache fallback. The cache update on success keeps
  // /index.html fresh for offline starts.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put('/index.html', clone)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match('/index.html').then((m) => m || new Response('offline', { status: 503 }))
        )
    );
    return;
  }

  // Same-origin assets (JS/CSS/images): cache-first with background
  // refresh. First load fetches + caches; subsequent loads serve from
  // cache instantly while a background fetch updates the entry.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fresh = fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const clone = res.clone();
              caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
  }
});
