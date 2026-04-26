// Service Worker do Speakers CRM Imperador (v4.25)
const CACHE = 'imperador-v1';
const SHELL = ['/app', '/welcome.html', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // SSE, webhooks, APIs sempre passam direto (network only)
  if (url.pathname.startsWith('/events') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/oauth/')) {
    return; // deixa browser handlear normal
  }
  // Static (HTML/SVG/JSON): network-first, fallback cache
  if (e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        return r;
      }).catch(() => caches.match(e.request))
    );
  }
});
