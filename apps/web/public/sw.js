const CACHE = 'gma-pos-shell-v2';
const APP_SHELL = ['/', '/manifest.webmanifest', '/favicon.ico', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PURGE_PRIVATE_CACHES') return;
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/v1/') || event.request.headers.has('authorization')) return;
  const isNavigation = event.request.mode === 'navigate';
  const isStaticAsset = url.pathname.startsWith('/_next/static/');
  if (!isNavigation && !isStaticAsset && !APP_SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && (isStaticAsset || APP_SHELL.includes(url.pathname))) {
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, response.clone())));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request, { ignoreSearch: isNavigation })) || (isNavigation ? caches.match('/') : Response.error())),
  );
});
