// App shell cache only; /api and /login always go to the network.
importScripts('version.js');
const CACHE = self.APP_VERSION;
const SHELL = ['./', 'index.html', 'style.css', 'vendor/marked.umd.js', 'vendor/purify.min.js', 'version.js', 'report.js',
  'approvals.js', 'attachments.js', 'avatars.js', 'blocks.js', 'botedit.js', 'chat.js', 'commands.js', 'composer.js', 'find.js', 'gateway.js', 'groups.js', 'history.js', 'main.js', 'mentions.js', 'msgmenu.js', 'nav.js', 'outbox.js', 'prefs.js', 'render.js', 'reply.js', 'roster.js', 'scroll.js', 'send.js', 'settings.js', 'share.js', 'state.js', 'store.js', 'tasks.js', 'util.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'badge-96.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(new URL('./', location).pathname) || u.pathname.includes('/push/') || u.pathname.endsWith('/prefs')) return;
  // Seules les réponses 200 entrent au cache (un 404 ou un 500 y restait et servait hors ligne) ; index.html ne remplace
  // qu'une page, jamais un script ou une feuille de style manquants (le navigateur lisait du HTML comme du JS).
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })
      .then((r) => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
// Web Push envoyé par server.ts (commande push) : { title, body, url, tag }. url = /bots/#<profil> ou #room-<id>.
const botOfUrl = (url) => { const h = (String(url || '').split('#')[1] || ''); return h.startsWith('room-') ? 'room:' + h.slice(5) : h || null; };
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data?.json() || {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Hermes Bots', {
    body: d.body || '', icon: 'icon-192.png', badge: 'badge-96.png', tag: d.tag || undefined,
    data: { bot: botOfUrl(d.url), url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const bot = e.notification.data?.bot;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs[0];
    if (c) { c.focus(); if (bot) c.postMessage({ bot }); } else self.clients.openWindow(bot ? './#' + (bot.startsWith('room:') ? 'room-' + bot.slice(5) : bot) : './');
  }));
});
