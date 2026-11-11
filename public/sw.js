// Service worker NEYAMI: оболочка приложения работает без сети, музыка и API — всегда из сети.
// Стратегия «сначала сеть»: обновления видны сразу, кэш — только запасной вариант.
const CACHE = 'neyami-shell-v2';
const SHELL = [
  '/', '/app.js', '/style.css', '/audio-features.js', '/icons.js', '/eq.js', '/id3.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // API, стрим и чужие адреса не трогаем: аудио идёт Range-запросами, кэшировать его здесь нельзя
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(req.mode === 'navigate' ? '/' : req);
      return cached ?? new Response('Нет сети', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
