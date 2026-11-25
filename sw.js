// Service Worker: Offline-Start, Push-Mitteilungen und Klicks darauf.
importScripts("app/config.js"); // setzt self.SP_CONFIG
const CACHE = "stundo-v2";
const SHELL = ["./", "./app/", "./app/app.js", "./app/timetable.js", "./app/config.js", "./manifest.webmanifest", "./fonts/fonts.css",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/favicon-32.png", "./icons/badge-96.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Eigene Dateien: erst Netz (damit Updates ankommen), sonst Cache.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data.json(); } catch { m = { title: "Stundo", body: e.data?.text() || "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Stundo", {
    body: m.body || "",
    tag: m.tag,
    renotify: !!m.tag,
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    actions: m.actions || [], // Android/Windows zeigen Knöpfe, iPhone ignoriert sie
    data: { url: m.url || "./app/", code: m.code, date: m.date },
  }));
});

async function openApp(url) {
  const target = new URL(url, self.registration.scope).href;
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of wins) {
    if (w.url.startsWith(self.registration.scope)) {
      await w.focus();
      w.postMessage({ type: "open", url: target });
      return;
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const { url, code, date } = n.data || {};
  n.close();
  if (e.action === "none" && code && date) {
    // "Keine HÜ" direkt aus der Mitteilung: ohne die App zu öffnen beim Server eintragen
    e.waitUntil((async () => {
      const base = self.SP_CONFIG?.api;
      if (!base) return openApp("./app/?a=none");
      await fetch(`${base.replace(/\/$/, "")}/api/sync`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, records: { [`day:${date}`]: { id: `day:${date}`, type: "day", date, status: "none", u: Date.now() } } }),
      });
      (await self.clients.matchAll({ type: "window" })).forEach((c) => c.postMessage({ type: "synced" }));
    })().catch(() => openApp("./app/?a=none")));
    return;
  }
  if (e.action === "add") return e.waitUntil(openApp("./app/?a=hue"));
  e.waitUntil(openApp(url || "./app/"));
});
