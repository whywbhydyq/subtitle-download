const CACHE_NAME = 'subtitle-download-v4-segment-asr-cache';
const STATIC_ASSETS = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/subtitle-download.js'
];

function isAsrAsset(url) {
  const host = url.hostname.toLowerCase();
  return host === 'cdn.jsdelivr.net' ||
    host === 'unpkg.com' ||
    host.endsWith('huggingface.co') ||
    host.endsWith('hf.co') ||
    host.endsWith('xethub.hf.co') ||
    host.endsWith('cdn-lfs.huggingface.co');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(STATIC_ASSETS.map((path) => new Request(path, { cache: 'reload' })));
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

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const shouldCache = sameOrigin || isAsrAsset(url);
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
