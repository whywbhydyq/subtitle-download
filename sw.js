const CACHE_NAME = 'subtitle-download-v10-deep-audit-cache';
const STATIC_ASSETS = new Set([
  './',
  './index.html',
  './play.html',
  './404.html',
  './assets/styles.css',
  './assets/subtitle-download.js'
]);

function isAsrAsset(url) {
  const host = url.hostname.toLowerCase();
  return host === 'cdn.jsdelivr.net' ||
    host === 'unpkg.com' ||
    host.endsWith('huggingface.co') ||
    host.endsWith('hf.co') ||
    host.endsWith('xethub.hf.co') ||
    host.endsWith('cdn-lfs.huggingface.co');
}

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  const path = './' + url.pathname.replace(/^\//, '');
  return STATIC_ASSETS.has(path) || (url.pathname === '/' && STATIC_ASSETS.has('./'));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(Array.from(STATIC_ASSETS).map(async (path) => {
      try { await cache.add(new Request(path, { cache: 'reload' })); } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('subtitle-download-') && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  const url = new URL(request.url);
  const shouldCache = isStaticAsset(url) || isAsrAsset(url);
  if (!shouldCache) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && (response.ok || response.type === 'opaque' || response.type === 'cors')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      const fallback = await cache.match(request, { ignoreSearch: true });
      if (fallback) return fallback;
      throw error;
    }
  })());
});
