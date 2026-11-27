// FitFactory — service worker : rend l'application installable et utilisable hors connexion.
// Stratégie « réseau d'abord » : la dernière version publiée est toujours servie quand le réseau répond ;
// le cache ne sert que de secours hors connexion. Les appels /api/ ne sont jamais mis en cache.
const CACHE = "fitfactory-v58";
const SHELL = [
  "/",
  "/index.html",
  "/js/core.js",
  "/js/sessions.js",
  "/js/programs.js",
  "/js/ai.js",
  "/js/export.js",
  "/js/session-form.js",
  "/js/reminders.js",
  "/js/admin.js",
  "/js/boxes.js",
  "/js/prs.js",
  "/js/nutrition.js",
  "/js/scan.js",
  "/js/timer.js",
  "/js/daily-wod.js",
  "/js/benchmarks.js",
  "/js/progress.js",
  "/js/report.js",
  "/js/account.js",
  "/js/coach.js",
  "/js/ui.js",
  "/js/boot.js",
  "/style.css",
  "/manifest.webmanifest",
  "/offline.js",
  "/fonts/dm-sans-latin-400-normal.woff2",
  "/fonts/dm-sans-latin-500-normal.woff2",
  "/fonts/dm-sans-latin-600-normal.woff2",
  "/fonts/dm-sans-latin-700-normal.woff2",
  "/fonts/manrope-latin-500-normal.woff2",
  "/fonts/manrope-latin-600-normal.woff2",
  "/fonts/manrope-latin-700-normal.woff2",
  "/fonts/manrope-latin-800-normal.woff2",
  "/fonts/saira-latin-800-normal.woff2",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", event => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then(hit => hit || (request.mode === "navigate" ? caches.match("/index.html") : Response.error()))
      )
  );
});
// Rappels : affiche la notification reçue ; un toucher ouvre (ou ramène au premier plan) l'application.
self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || "myFitFactory", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "fitfactory",
      data: {url: data.url || "/"},
    })
  );
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
      for (const client of list) if ("focus" in client) return client.focus();
      return self.clients.openWindow(event.notification.data?.url || "/");
    })
  );
});
