// NetMirror Service Worker — Offline caching + PWA support
const CACHE_NAME = 'netmirror-v1';
const OFFLINE_URL = '/downloadapp/';

// Assets to pre-cache on install
const PRE_CACHE = [
  '/downloadapp/',
  '/downloadapp/manifest.json'
];

// Install: pre-cache critical assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRE_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: network-first with cache fallback for navigation
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET, API calls, download routes, and cross-origin
  if (request.method !== 'GET') return;
  if (request.url.includes('/api/')) return;
  if (request.url.includes('/dl/')) return;
  if (request.url.includes('/dlzip/')) return;
  if (request.url.includes('.apk')) return;

  // Navigation requests: network-first, fall back to cached page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        // Cache the latest version
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => {
        return caches.match(OFFLINE_URL) || caches.match(request);
      })
    );
    return;
  }

  // Static assets (fonts, images, CSS): cache-first
  if (request.destination === 'image' || request.destination === 'font' ||
      request.url.includes('fonts.googleapis.com') || request.url.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }
});
