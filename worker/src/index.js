// Schulplaner-Server (Cloudflare Worker)
// - speichert die Daten pro Sync-Code (KV), damit Laptop und Handy dasselbe sehen
// - schickt alle 5 Minuten fällige Mitteilungen (Cron)
import { sendPush } from "./webpush.js";
import { dueMessages, viennaNow } from "./reminders.js";

const CODE = /^[A-Z2-7]{20}$/;
const MAX_BYTES = 512 * 1024;
const TOMBSTONE_DAYS = 60;

function cors(env, req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const ok = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, headers, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

export function mergeRecords(stored, incoming) {
  let changed = false;
  for (const r of Object.values(incoming || {})) {
    if (!r || typeof r.id !== "string" || typeof r.u !== "number") continue;
    const cur = stored[r.id];
    if (!cur || r.u > cur.u) { stored[r.id] = r; changed = true; }
  }
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
  for (const [id, r] of Object.entries(stored)) if (r.del && r.u < cutoff) { delete stored[id]; changed = true; }
  return changed;
}

async function loadRecords(env, code) {
  return (await env.SP.get(`data:${code}`, "json")) || {};
}

async function sendToAll(env, code, message) {
  const subs = (await env.SP.get(`subs:${code}`, "json")) || [];
  const keep = [];
  let sent = 0;
  for (const s of subs) {
    try {
      const status = await sendPush(s.sub, { ...message, code }, env);
      if (status === 404 || status === 410) continue;
      if (status < 300) sent++;
      keep.push(s);
    } catch (e) {
      console.log("push error", e?.message);
      keep.push(s);
    }
  }
  if (keep.length !== subs.length) await env.SP.put(`subs:${code}`, JSON.stringify(keep));
  return { sent, devices: subs.length };
}

export async function runReminders(env, date = new Date()) {
  const now = viennaNow(date);
  const log = [];
  let cursor;
  do {
    const page = await env.SP.list({ prefix: "subs:", cursor });
    for (const k of page.keys) {
      const code = k.name.slice(5);
      const records = await loadRecords(env, code);
      for (const msg of dueMessages(records, now)) {
        const sentKey = `sent:${code}:${msg.key}`;
        if (await env.SP.get(sentKey)) continue;
        await env.SP.put(sentKey, "1", { expirationTtl: 3 * 86400 });
        const r = await sendToAll(env, code, msg);
        log.push({ code: code.slice(0, 4) + "…", key: msg.key, ...r });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { now, log };
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
    const url = new URL(req.url);

    if (url.pathname === "/api/vapid") return json({ key: env.VAPID_PUBLIC }, h);
    if (req.method !== "POST") return json({ ok: true, app: "stundo" }, h);

    const raw = await req.text();
    if (raw.length > MAX_BYTES) return json({ error: "zu groß" }, h, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "kein JSON" }, h, 400); }
    const code = String(body.code || "");
    if (!CODE.test(code)) return json({ error: "Sync-Code ungültig" }, h, 400);

    switch (url.pathname) {
      case "/api/sync": {
        const stored = await loadRecords(env, code);
        if (mergeRecords(stored, body.records)) await env.SP.put(`data:${code}`, JSON.stringify(stored));
        return json({ records: stored, time: Date.now() }, h);
      }
      case "/api/subscribe": {
        const sub = body.sub;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ error: "Abo fehlt" }, h, 400);
        const subs = ((await env.SP.get(`subs:${code}`, "json")) || []).filter((s) => s.sub.endpoint !== sub.endpoint);
        subs.push({ sub, device: String(body.device || "").slice(0, 60), added: Date.now() });
        await env.SP.put(`subs:${code}`, JSON.stringify(subs.slice(-10)));
        return json({ ok: true, devices: subs.length }, h);
      }
      case "/api/unsubscribe": {
        const subs = ((await env.SP.get(`subs:${code}`, "json")) || []).filter((s) => s.sub.endpoint !== body.endpoint);
        await env.SP.put(`subs:${code}`, JSON.stringify(subs));
        return json({ ok: true, devices: subs.length }, h);
      }
      case "/api/ical": {
        // Lädt einen Stundenplan-Kalender (iCal), weil Browser fremde Kalender wegen CORS nicht direkt lesen dürfen
        let target;
        try { target = new URL(String(body.url || "").replace(/^webcal:/i, "https:")); } catch { return json({ error: "Ungültiger Link" }, h, 400); }
        if (!/^https?:$/.test(target.protocol) || /^(localhost|127.|10.|192.168.|169.254.)/.test(target.hostname)) return json({ error: "Ungültiger Link" }, h, 400);
        let res;
        try { res = await fetch(target, { headers: { "User-Agent": "Stundo/1.0 (Stundenplan-Import)", Accept: "text/calendar,*/*" }, signal: AbortSignal.timeout(15000) }); }
        catch { return json({ error: "Der Kalender-Server antwortet nicht." }, h, 502); }
        if (!res.ok) return json({ error: res.status === 401 || res.status === 403 ? "Kein Zugriff auf den Kalender. Ist der Link noch gültig?" : `Kalender nicht gefunden (Fehler ${res.status}).` }, h, 502);
        const text = await res.text();
        if (text.length > 4 * 1024 * 1024) return json({ error: "Kalender ist zu groß." }, h, 413);
        if (!text.includes("BEGIN:VCALENDAR")) return json({ error: "Unter dem Link ist kein Kalender (iCal)." }, h, 422);
        return json({ text }, h);
      }
      case "/api/test-push": {
        const r = await sendToAll(env, code, {
          tag: "hue", title: "Schule aus! 🎒 (Test)", body: "Hast du heute eine HÜ bekommen?", url: "./app/?a=hue",
          date: viennaNow().date, test: true,
          actions: [{ action: "none", title: "Keine HÜ" }, { action: "add", title: "HÜ eintragen" }],
        });
        return json(r, h);
      }
    }
    return json({ error: "unbekannt" }, h, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, new Date(event.scheduledTime)).then((r) => r.log.length && console.log(JSON.stringify(r))));
  },
};
