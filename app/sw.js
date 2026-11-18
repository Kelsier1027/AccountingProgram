// Offline shell: cache the app files, never the GitHub API (data lives in localStorage).
const CACHE = 'ledger-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'js/main.js', 'js/store.js', 'js/github.js', 'js/ui.js', 'js/charts.js',
  'js/core/util.js', 'js/core/model.js', 'js/core/calc.js', 'js/core/match.js', 'js/core/importers.js',
  'js/core/merge.js', 'js/core/crypto.js', 'js/core/sample.js', 'js/core/moneybook.js', 'js/core/plan.js', 'js/core/split.js', 'js/core/forecast.js', 'js/core/payslip.js',
  'js/views/common.js', 'js/views/overview.js', 'js/views/transactions.js', 'js/views/match.js',
  'js/views/cards.js', 'js/views/stocks.js', 'js/views/simple.js', 'js/views/settings.js', 'js/views/moneybook.js', 'js/views/plan.js', 'js/views/split.js', 'js/views/forecast.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so updates show up immediately; fall back to cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
