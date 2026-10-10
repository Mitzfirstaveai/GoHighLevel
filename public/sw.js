// Service worker: makes the app installable and keeps QR tickets available offline
// (venues often have poor signal). Pages are always fetched fresh when online.
const VERSION = 'gsa-v16';
const STATIC = ['/styles.css', '/logo.png', '/icon-192.png', '/offline.html', '/forms.js', '/app.js', '/checkin.js', '/checkin-result.js', '/reminders.js', '/vendor/html5-qrcode-2.3.8.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'gsa-tickets').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  // Sent on sign-out so the next person on this phone can't see someone else's tickets.
  if (event.data === 'clear-tickets') caches.delete('gsa-tickets');
});

// Event-day reminders: shown even when the app is closed. Tapping one opens the ticket.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'GSA', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag, data: { url: data.url || '/tickets' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/tickets', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => w.url.startsWith(self.location.origin));
    return open ? open.navigate(url).then((w) => (w || open).focus()) : self.clients.openWindow(url);
  }));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Ticket pages: network first, remember the latest copy, fall back to it offline.
  if (url.pathname === '/tickets' || url.pathname.startsWith('/tickets/')) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open('gsa-tickets').then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.open('gsa-tickets').then((c) => c.match(req)).then((hit) => hit || caches.match('/offline.html'))));
    return;
  }

  // Styles and scripts: always the latest when online (so app updates reach installed phones),
  // the saved copy when offline.
  if (STATIC.includes(url.pathname)) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  }
});
