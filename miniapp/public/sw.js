// Минимальный service worker: держит оболочку приложения, чтобы оно открывалось
// с домашнего экрана мгновенно и без сети.
//
// Аудио сознательно не кешируем: файлы большие, запросы идут диапазонами (Range),
// и Cache API с частичными ответами ведёт себя непредсказуемо. Кешированием
// прослушанного стоит заниматься отдельно и осознанно.

const CACHE = 'telemusic-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
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
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API и стрим всегда идут в сеть: данные меняются, аудио отдаётся диапазонами.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
