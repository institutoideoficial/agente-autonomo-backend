// Service Worker do Speakers CRM Imperador (v4.32 + push real VAPID)
const CACHE = 'imperador-v32-push';
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

// v4.31: push notifications + click handler
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const title = data.title || 'Imperador CRM';
  const body = data.body || 'Nova atividade';
  const icon = '/icon-192.svg';
  const tag = data.tag || 'imperador-msg';
  e.waitUntil(self.registration.showNotification(title, { body, icon, badge: icon, tag, data: data.url || '/app' }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data || '/app';
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if (c.url.includes('/app') && 'focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
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
