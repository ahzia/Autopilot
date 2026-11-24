// SPDX-License-Identifier: MIT
// Service worker for the Autopilot Inbox.
// Caches only the static shell so the app opens offline. API traffic is never
// intercepted or cached: cards and status always come from the live server.

// v2: v1 could store a non-page file (e.g. app.js opened directly) as the page.
const CACHE = 'autopilot-shell-v4';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg'];
const PAGE_PATHS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/agent/')) return;
  // Only opening the app itself ("/" or "/index.html", any query) is the page. Opening another
  // shell file directly (say /icon.svg) is cached under its own path, never as the page.
  const isPage = request.mode === 'navigate' && PAGE_PATHS.includes(url.pathname);
  const path = isPage ? '/' : url.pathname;
  if (!SHELL.includes(path)) return;
  event.respondWith(networkFirst(request, path));
});

/**
 * Fresh shell when the server answers (so updates apply on the next load), the
 * cached copy when it does not: no network at all, or a proxy such as Tailscale
 * Serve answering 502/503/504 because Autopilot itself is not running.
 */
async function networkFirst(request, path) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    const cached = await cache.match(path);
    if (cached) return cached;
    throw err;
  }
  if (response.status >= 500) {
    const cached = await cache.match(path);
    if (cached) return cached;
    return response;
  }
  if (cacheable(path, response)) cache.put(path, response.clone()).catch(() => {});
  return response;
}

/** Only complete same-origin answers are stored, and the page entries only ever hold HTML. */
function cacheable(path, response) {
  if (!response.ok || response.type !== 'basic') return false;
  if (!PAGE_PATHS.includes(path)) return true;
  const type = response.headers.get('content-type') || '';
  return type.toLowerCase().startsWith('text/html');
}

// ------------------------------------------------------------- notifications
// Web Push from the Autopilot server: counts only ("My App: 2 decisions need you"),
// never card text. Every push shows a visible notification (iOS revokes otherwise).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Autopilot';
  const body = typeof data.body === 'string' && data.body ? data.body : 'A decision needs you.';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === 'string' ? data.tag : 'autopilot',
      renotify: true,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: sameOriginPath(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = sameOriginPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) await client.navigate(target).catch(() => {});
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/** Notification links only ever open this inbox. */
function sameOriginPath(raw) {
  try {
    const url = new URL(typeof raw === 'string' && raw ? raw : '/', self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}
