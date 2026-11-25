"use strict";
// Stundo: Hausübungen, Tests mit KI-Lernplan, Stundenplan. Sync + Mitteilungen über den Worker.

const API = (self.SP_CONFIG?.api || "").replace(/\/$/, "");
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const K = { records: "sp.records", dirty: "sp.dirty", code: "sp.code", key: "sp.geminiKey", push: "sp.push", lastSync: "sp.lastSync" };
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WD_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Datum ----------
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const today = () => iso(new Date());
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const dow = (s) => parse(s).getDay(); // 0 = Sonntag
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fmtShort = (s) => { const d = parse(s); return `${WD[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.`; };
function fmtRel(s) {
  const n = diffDays(today(), s);
  if (n === 0) return "heute";
  if (n === 1) return "morgen";
  if (n === -1) return "gestern";
  if (n > 1 && n < 7) return WD_LONG[dow(s)];
  return fmtShort(s);
}

// ---------- Speicher ----------
let records = JSON.parse(localStorage.getItem(K.records) || "null");
let dirty = new Set(JSON.parse(localStorage.getItem(K.dirty) || "[]"));

function persist() {
  localStorage.setItem(K.records, JSON.stringify(records));
  localStorage.setItem(K.dirty, JSON.stringify([...dirty]));
}
function put(rec) {
  rec.u = Math.max(Date.now(), (records[rec.id]?.u || 0) + 1);
  records[rec.id] = rec;
  dirty.add(rec.id);
  persist();
  scheduleSync();
  render();
}
function remove(id) {
  if (!records[id]) return;
  put({ id, type: records[id].type, del: true });
}
const all = (type) => Object.values(records).filter((r) => r.type === type && !r.del);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function seed() {
  records = {};
  // u = 1: jede echte Änderung (auch von einem anderen Gerät) gewinnt
  const add = (r) => { r.u = 1; records[r.id] = r; dirty.add(r.id); };
  add({ id: "settings", type: "config", notifySchool: true, notifyTests: true, notifyPlan: true, testTime: "17:00", schoolDelay: 5 });
  persist();
}
if (!records) seed();

const cfg = () => records.settings || {};
const lessons = () => (records.timetable && !records.timetable.del && records.timetable.lessons) || [];
const hasTimetable = () => lessons().length > 0;
const subjectsMap = () => records.timetable?.subjects || {};
const subjectList = () => [...new Set([...lessons().map((l) => l.f), ...Object.keys(subjectsMap())])].sort();
const subjName = (f) => subjectsMap()[f] || f;
const holidays = () => (records.holidays && !records.holidays.del && records.holidays.ranges) || [];
const holiday = (s) => holidays().find(([a, b]) => s >= a && s <= b);
const lessonsOn = (s) => { const d = dow(s); return d >= 1 && d <= 6 && !holiday(s) ? lessons().filter((l) => l.d === d).sort((a, b) => a.s.localeCompare(b.s)) : []; };
const schoolEnd = (s) => { const l = lessonsOn(s); return l.length ? l.reduce((m, x) => (x.e > m ? x.e : m), "00:00") : null; };

function nextLesson(subject, from = today()) {
  const base = subject.replace(/U$/, "");
  for (let i = 1; i <= 60; i++) {
    const d = addDays(from, i);
    const l = lessonsOn(d);
    if (l.some((x) => x.f === subject)) return d;
  }
  for (let i = 1; i <= 60; i++) {
    const d = addDays(from, i);
    if (lessonsOn(d).some((x) => x.f.replace(/U$/, "") === base)) return d;
  }
  return null;
}
function nextSchoolDay(from = today()) {
  for (let i = 1; i <= 30; i++) { const d = addDays(from, i); if (lessonsOn(d).length) return d; }
  return null;
}

function hue(f) {
  const base = f.replace(/(_\d+)?U?$/, "").replace(/_\d+$/, "");
  let h = 0;
  for (const c of base) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return Math.round((h * 137.508) % 360);
}
function subjectOptions(selected, placeholder) {
  const list = subjectList();
  if (selected && !list.includes(selected)) list.push(selected);
  return `<option value="">${placeholder}</option>${list.map((f) => `<option value="${esc(f)}" ${f === selected ? "selected" : ""}>${esc(f)}${subjName(f) !== f ? ` – ${esc(subjName(f))}` : ""}</option>`).join("")}<option value="__new">+ Neues Fach …</option>`;
}
function askNewSubject(sel, onPick) {
  const name = (prompt("Name oder Kürzel des Fachs (z. B. M, Deutsch, POS):") || "").trim().slice(0, 24);
  if (!name) { sel.value = ""; return onPick?.(""); }
  if (![...sel.options].some((o) => o.value === name)) sel.add(new Option(name, name), sel.options[sel.options.length - 1]);
  sel.value = name;
  onPick?.(name);
}
const subjTag = (f) => `<span class="subj" style="--h:${hue(f)}" title="${esc(subjName(f))}">${esc(f)}</span>`;

// ---------- Sync ----------
function newCode() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => a[b & 31]).join("");
}
let code = localStorage.getItem(K.code);
if (!code) { code = newCode(); localStorage.setItem(K.code, code); }
const prettyCode = (c) => c.match(/.{1,4}/g).join("-");

let syncState = API ? "idle" : "off";
let syncTimer, syncing = false, syncAgain = false;
function scheduleSync(ms = 800) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }

async function sync() {
  if (!API) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; setSyncState("busy");
  const sent = {};
  for (const id of dirty) if (records[id]) sent[id] = records[id];
  try {
    const res = await fetch(`${API}/api/sync`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, records: sent }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const data = await res.json();
    let changed = false;
    for (const r of Object.values(data.records)) {
      const local = records[r.id];
      if (!local || r.u > local.u) { records[r.id] = r; changed = true; }
    }
    for (const [id, r] of Object.entries(sent)) if (records[id]?.u === r.u) dirty.delete(id);
    persist();
    localStorage.setItem(K.lastSync, String(Date.now()));
    setSyncState("ok");
    if (changed) render();
  } catch (e) {
    console.warn("Sync", e);
    setSyncState("err");
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}
function setSyncState(s) {
  syncState = s;
  const dot = $("#sync-dot");
  if (dot) dot.className = `sync-dot ${s}`;
}

async function joinCode(input) {
  const c = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (c.length !== 20) throw new Error("Der Code hat 20 Zeichen (A–Z, 2–7).");
  if (c === code) return;
  const old = code;
  code = c;
  localStorage.setItem(K.code, c);
  dirty = new Set(Object.keys(records));
  persist();
  await sync();
  if (localStorage.getItem(K.push)) await subscribePush(old).catch(() => {});
}

// ---------- Mitteilungen ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64uToBytes = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
const deviceName = () => (isIOS ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : /Windows/.test(navigator.userAgent) ? "Windows" : "Gerät");

async function subscribePush(oldCode) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Mitteilungen wurden nicht erlaubt. Du kannst das in den Einstellungen des Geräts ändern.");
  const reg = await navigator.serviceWorker.ready;
  const { key } = await fetch(`${API}/api/vapid`).then((r) => r.json());
  let sub = await reg.pushManager.getSubscription();
  if (sub && oldCode) {
    await fetch(`${API}/api/unsubscribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: oldCode, endpoint: sub.endpoint }) }).catch(() => {});
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  const res = await fetch(`${API}/api/subscribe`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, sub: sub.toJSON(), device: deviceName() }),
  });
  if (!res.ok) throw new Error("Server hat das Abo nicht angenommen.");
  localStorage.setItem(K.push, "1");
  await sync();
}
async function unsubscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await fetch(`${API}/api/unsubscribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe();
  }
  localStorage.removeItem(K.push);
}

// ---------- KI (Gemini) ----------
const geminiKey = () => localStorage.getItem(K.key) || localStorage.getItem("clipcards.geminiKey") || "";
async function gemini(prompt, schema) {
  const key = geminiKey();
  if (!key) throw Object.assign(new Error("Für den Lernplan brauchst du einen kostenlosen Gemini-Key (Einstellungen)."), { needKey: true });
  let last;
  for (const model of MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          contents: [{ parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        last = new Error(body.error?.message || `HTTP ${res.status}`);
        if ([400, 401, 403].includes(res.status) && !/model/i.test(last.message)) throw last;
        continue;
      }
      return JSON.parse(body.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "null");
    } catch (e) {
      last = e;
      if (e.name !== "TimeoutError" && e.name !== "TypeError" && !/model|HTTP 5|HTTP 429/i.test(e.message)) break;
    }
  }
  throw last || new Error("KI nicht erreichbar");
}

async function makePlan(test) {
  const start = today();
  const days = diffDays(start, test.date);
  if (days < 1) throw new Error("Der Test ist heute oder vorbei.");
  const first = days > 14 ? addDays(test.date, -14) : start;
  const dates = [];
  for (let d = first; d < test.date; d = addDays(d, 1)) dates.push(d);
  const others = all("test").filter((t) => t.id !== test.id && t.date >= start && t.date <= addDays(test.date, 3))
    .map((t) => `${t.date}: ${t.subject} ${t.kind}`);
  const busy = all("hw").filter((h) => !h.done && h.due >= start && h.due < test.date).map((h) => `${h.due}: HÜ ${h.subject}`);
  const prompt = `Du bist ein Lerncoach für einen Schüler einer HTL in Österreich. Erstelle einen Lernplan auf Deutsch.

Test: ${test.subject} (${subjName(test.subject)}), ${test.kind}${test.title ? ` "${test.title}"` : ""}, am ${test.date} (${WD_LONG[dow(test.date)]}).
Stoff:
${test.stoff}

Verfügbare Lerntage (nur diese Daten verwenden): ${dates.map((d) => `${d} (${WD[dow(d)]})`).join(", ")}
Andere Tests in der Zeit: ${others.join("; ") || "keine"}
Offene HÜs: ${busy.join("; ") || "keine"}

Regeln:
- Pro Tag höchstens eine Aufgabe, kurz und konkret (max. 90 Zeichen), z. B. "Kapitel 3 lesen + 5 Übungsbeispiele".
- Teile den Stoff sinnvoll auf, schwierige Teile früher. Lass an Tagen mit anderen Tests oder vielen HÜs lieber frei.
- Bei vielen Tagen nicht jeden Tag belegen, Pausen sind ok.
- Der letzte Tag vor dem Test ist Wiederholung (z. B. "Alles wiederholen, Probetest machen").
- Gib ein JSON-Array zurück: [{"date":"YYYY-MM-DD","task":"..."}], sortiert nach Datum.`;
  const plan = await gemini(prompt, {
    type: "array",
    items: { type: "object", properties: { date: { type: "string" }, task: { type: "string" } }, required: ["date", "task"] },
  });
  const ok = new Set(dates);
  const clean = (Array.isArray(plan) ? plan : []).filter((p) => ok.has(p.date) && p.task).map((p) => ({ date: p.date, task: String(p.task).slice(0, 140), done: false }));
  if (!clean.length) throw new Error("Die KI hat keinen brauchbaren Plan geliefert. Versuch es nochmal.");
  clean.sort((a, b) => a.date.localeCompare(b.date));
  return clean;
}

// ---------- UI-Helfer ----------
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
const dlg = $("#dlg");
function openDialog(html, onMount) {
  dlg.innerHTML = `<form method="dialog" class="dlg" onsubmit="return false">${html}</form>`;
  if (!dlg.open) dlg.showModal();
  onMount?.(dlg);
}
const closeDialog = () => dlg.open && dlg.close();
dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(); });
const closeBtn = `<button type="button" class="iconbtn" data-close aria-label="Schließen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
dlg.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDialog(); });

// ---------- Tabs ----------
let tab = "heute";
let planDay = null;
let weekOffset = 0;
const TITLES = { heute: "Heute", hue: "Hausübungen", tests: "Tests", plan: "Stundenplan" };
function setTab(t) {
  tab = t;
  window.scrollTo(0, 0);
  render();
}
document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

function render() {
  document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("#title").textContent = TITLES[tab];
  const d = new Date();
  $("#today-label").innerHTML = `${WD_LONG[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} ${API ? `· <span class="sync-dot ${syncState}" id="sync-dot" title="Sync"></span>` : ""}`;
  $("#wrap").classList.toggle("wide", tab === "plan");
  const open = all("hw").filter((h) => !h.done && h.due <= addDays(today(), 1)).length;
  const badge = $("#badge-hue");
  badge.hidden = !open;
  badge.textContent = open;
  $("#view").innerHTML = ({ heute: viewToday, hue: viewHw, tests: viewTests, plan: viewTimetable })[tab]();
}

// ---------- Ansicht: Heute ----------
function hwItem(h) {
  const n = diffDays(today(), h.due);
  const cls = h.done ? "" : n < 0 ? "late" : n <= 1 ? "soon" : "";
  return `<div class="item ${h.done ? "done" : ""}">
    <button class="tick" data-toggle-hw="${h.id}" aria-label="${h.done ? "Als offen markieren" : "Erledigt"}">${ICON_CHECK}</button>
    <div class="main" data-edit-hw="${h.id}">
      <div class="title">${esc(h.text) || "<span class='muted'>(ohne Text)</span>"}</div>
      <div class="meta">${subjTag(h.subject)}<span class="pill ${cls}">bis ${fmtRel(h.due)}</span></div>
    </div></div>`;
}
function countBox(t) {
  const n = diffDays(today(), t.date);
  const cls = n <= 1 ? "now" : n <= 7 ? "near" : "";
  const big = n === 0 ? "Heute" : n === 1 ? "1" : n;
  const small = n === 0 ? (t.time || "") : n === 1 ? "Tag" : "Tage";
  return `<div class="count ${cls}"><b style="${n === 0 ? "font-size:19px" : ""}">${big}</b><span>${small}</span></div>`;
}
function testItem(t) {
  const past = t.date < today();
  const done = (t.plan || []).filter((p) => p.done).length;
  const total = (t.plan || []).length;
  return `<div class="card test ${past ? "past" : ""}" data-edit-test="${t.id}" style="margin-bottom:8px;padding:12px">
    ${past ? `<div class="count"><b style="font-size:18px">✓</b><span>vorbei</span></div>` : countBox(t)}
    <div>
      <div class="title" style="font-weight:600">${subjTag(t.subject)} ${esc(t.kind || "Test")}${t.title ? ` · ${esc(t.title)}` : ""}</div>
      <div class="meta small muted" style="margin-top:3px">${fmtShort(t.date)}${t.time ? `, ${t.time}` : ""} · ${t.stoff?.trim() ? "Stoff eingetragen" : `<span style="color:var(--warn);font-weight:600">Stoff fehlt</span>`}</div>
      ${total ? `<div class="progress"><i style="width:${Math.round((done / total) * 100)}%"></i></div><div class="small muted">Lernplan: ${done}/${total}</div>` : ""}
    </div></div>`;
}

function viewToday() {
  const t = today();
  const end = schoolEnd(t);
  const day = records[`day:${t}`];
  const answered = day && !day.del;
  const enteredToday = all("hw").filter((h) => h.created === t);
  let check = "";
  if (end || enteredToday.length || answered) {
    if (answered && day.status === "none" && !enteredToday.length) {
      check = `<div class="card check done"><div class="row" style="align-items:center"><div style="flex:1"><b>✓ Heute keine HÜ</b><div class="small muted">Gemerkt. Schönen Nachmittag!</div></div><button class="btn" data-undo-day>Doch HÜ</button></div></div>`;
    } else if (enteredToday.length) {
      check = `<div class="card check done"><div class="row" style="align-items:center"><div style="flex:1"><b>✓ ${enteredToday.length} HÜ${enteredToday.length > 1 ? "s" : ""} heute eingetragen</b></div><button class="btn soft" data-add-hw>+ Noch eine</button></div></div>`;
    } else {
      const after = nowMin() >= toMin(end);
      check = `<div class="card check"><h2>${after ? "Schule aus! 🎒" : "HÜ-Check"}</h2>
        <p>${after ? "Hast du heute eine HÜ bekommen?" : `Um ${end} frage ich dich, ob du HÜ bekommen hast. Du kannst auch jetzt schon eintragen.`}</p>
        <div class="row"><button class="btn big ok" data-no-hw>Keine HÜ</button><button class="btn big primary" data-add-hw>HÜ eintragen</button></div></div>`;
    }
  }

  const learn = [];
  for (const test of all("test")) for (const [i, p] of (test.plan || []).entries()) if (p.date === t && test.date > t) learn.push({ test, p, i });
  const learnHtml = learn.length ? `<div class="section-head"><h2>Heute lernen</h2></div><div class="list">${learn.map(({ test, p, i }) => `
    <div class="item ${p.done ? "done" : ""}"><button class="tick" data-toggle-plan="${test.id}:${i}">${ICON_CHECK}</button>
    <div class="main" data-edit-test="${test.id}"><div class="title">${esc(p.task)}</div><div class="meta">${subjTag(test.subject)}<span class="pill soon">${test.kind} ${fmtRel(test.date)}</span></div></div></div>`).join("")}</div>` : "";

  const due = all("hw").filter((h) => !h.done && h.due <= addDays(t, 2)).sort((a, b) => a.due.localeCompare(b.due));
  const dueHtml = `<div class="section-head"><h2>Bald fällig</h2><button class="btn soft" data-add-hw>+ HÜ</button></div>
    ${due.length ? `<div class="list">${due.map(hwItem).join("")}</div>` : `<div class="empty">Nichts fällig in den nächsten 2 Tagen. 🎉</div>`}`;

  const tests = all("test").filter((x) => x.date >= t).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const testHtml = `<div class="section-head"><h2>Nächste Tests</h2><button class="btn" data-goto="tests">Alle</button></div>
    ${tests.length ? tests.map(testItem).join("") : `<div class="empty">Keine Tests eingetragen.</div>`}`;

  const showDay = end && nowMin() < toMin(end) ? t : nextSchoolDay(t);
  if (!hasTimetable()) return setupCard(false) + dueHtml + testHtml;
  const hol = holiday(t);
  const dayHtml = showDay ? `<div class="section-head"><h2>${showDay === t ? "Stunden heute" : `Stunden ${fmtRel(showDay)}`}</h2></div>
    <div class="card" style="padding:6px 16px">${lessonList(showDay)}</div>` : "";

  return (hol ? `<div class="note" style="margin-bottom:14px">🌴 ${esc(hol[2])}, heute ist schulfrei.</div>` : "") + check + learnHtml + dueHtml + testHtml + dayHtml;
}

function setupCard(big) {
  return `<div class="card check" style="${big ? "margin-top:8px" : ""}">
    <h2>Verbinde deinen Stundenplan</h2>
    <p>Dann weiß Stundo, wann deine Schule aus ist, fragt dich danach nach HÜs und schlägt Abgabetermine vor. Geht mit WebUntis, EduPage, einem Foto oder per Hand.</p>
    <div class="row"><button class="btn big primary" data-tt="start">Stundenplan verbinden</button></div></div>`;
}

function lessonList(s) {
  const l = lessonsOn(s);
  if (!l.length) { const h = holiday(s); return `<div class="empty">${h ? `🌴 ${esc(h[2])}` : "Kein Unterricht"}</div>`; }
  const isToday = s === today();
  const m = nowMin();
  const tests = all("test").filter((t) => t.date === s);
  const hws = all("hw").filter((h) => h.due === s && !h.done);
  return l.map((x) => {
    const now = isToday && m >= toMin(x.s) && m < toMin(x.e);
    const test = tests.find((t) => t.subject === x.f);
    const hw = hws.filter((h) => h.subject === x.f);
    return `<div class="lesson ${now ? "now" : ""}"><div class="t">${x.s}<br>${x.e}</div>
      <div><div class="n">${subjTag(x.f)} ${subjName(x.f) !== x.f ? esc(subjName(x.f)) : ""}</div>
      ${[x.r, x.t].filter(Boolean).length ? `<div class="small muted">${[x.r, x.t].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
      ${test ? `<div class="flag">📝 ${esc(test.kind)}${test.time ? ` um ${test.time}` : ""}</div>` : ""}
      ${hw.length ? `<div class="flag" style="color:var(--warn)">✏️ HÜ fällig: ${hw.map((h) => esc(h.text)).join("; ")}</div>` : ""}
      </div></div>`;
  }).join("");
}

// ---------- Ansicht: Hausübungen ----------
let showDone = false;
function viewHw() {
  const open = all("hw").filter((h) => !h.done).sort((a, b) => a.due.localeCompare(b.due));
  const done = all("hw").filter((h) => h.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const groups = {};
  for (const h of open) {
    const n = diffDays(today(), h.due);
    const g = n < 0 ? "Überfällig" : n === 0 ? "Heute fällig" : n === 1 ? "Morgen fällig" : n < 7 ? "Diese Woche" : "Später";
    (groups[g] ||= []).push(h);
  }
  let html = `<div class="row" style="margin-bottom:6px"><button class="btn big primary" data-add-hw>+ HÜ eintragen</button></div>`;
  html += open.length ? Object.entries(groups).map(([g, list]) => `<div class="section-head"><h2>${g}</h2><span class="muted small">${list.length}</span></div><div class="list">${list.map(hwItem).join("")}</div>`).join("")
    : `<div class="empty" style="margin-top:20px">Keine offenen Hausübungen. 🎉</div>`;
  if (done.length) {
    html += `<div class="section-head"><h2>Erledigt</h2><button class="btn" data-toggle-done>${showDone ? "Ausblenden" : `Zeigen (${done.length})`}</button></div>`;
    if (showDone) html += `<div class="list">${done.slice(0, 40).map(hwItem).join("")}</div>`;
  }
  return html;
}

// ---------- Ansicht: Tests ----------
let showPast = false;
function viewTests() {
  const t = today();
  const up = all("test").filter((x) => x.date >= t).sort((a, b) => a.date.localeCompare(b.date));
  const past = all("test").filter((x) => x.date < t).sort((a, b) => b.date.localeCompare(a.date));
  let html = `<div class="row" style="margin-bottom:14px"><button class="btn big primary" data-add-test>+ Test eintragen</button></div>`;
  html += up.length ? up.map(testItem).join("") : `<div class="empty">Keine Tests in Sicht.</div>`;
  if (past.length) {
    html += `<div class="section-head"><h2>Vorbei</h2><button class="btn" data-toggle-past>${showPast ? "Ausblenden" : `Zeigen (${past.length})`}</button></div>`;
    if (showPast) html += past.map(testItem).join("");
  }
  return html;
}

// ---------- Ansicht: Stundenplan ----------
function viewTimetable() {
  const t = today();
  if (!hasTimetable()) return setupCard(true);
  const monday = addDays(t, -((dow(t) + 6) % 7) + weekOffset * 7);
  const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
  if (!planDay || !days.includes(planDay)) planDay = days.includes(t) && lessonsOn(t).length ? t : days.find((d) => lessonsOn(d).length) || days[0];
  const nav = `<div class="row" style="align-items:center;margin-bottom:12px">
    <button class="btn" data-week="-1" aria-label="Woche zurück">‹</button>
    <div style="flex:1;text-align:center;font-weight:600">${weekOffset === 0 ? "Diese Woche" : weekOffset === 1 ? "Nächste Woche" : `${fmtShort(days[0])} – ${fmtShort(days[4])}`}</div>
    <button class="btn" data-week="1" aria-label="Woche vor">›</button></div>`;
  const pick = `<div class="daypick onlymobile">${days.map((d) => `<button data-day="${d}" aria-pressed="${d === planDay}">${WD[dow(d)]}<small>${parse(d).getDate()}.${parse(d).getMonth() + 1}.${all("test").some((x) => x.date === d) ? " 📝" : ""}</small></button>`).join("")}</div>`;
  const week = `<div class="week">${days.map((d) => {
    const l = lessonsOn(d);
    const tests = all("test").filter((x) => x.date === d);
    const h = holiday(d);
    return `<div class="col"><h3 style="${d === t ? "color:var(--accent)" : ""}">${WD_LONG[dow(d)]} ${parse(d).getDate()}.${parse(d).getMonth() + 1}.</h3>
      ${h ? `<div class="note">🌴 ${esc(h[2])}</div>` : ""}
      ${l.map((x) => `<div class="cell subj-cell" style="--h:${hue(x.f)}"><b>${esc(x.f)}${tests.some((q) => q.subject === x.f) ? " 📝" : ""}</b>${x.s}–${x.e} · ${esc(x.r)}</div>`).join("")}
      ${l.length ? `<div class="small muted">Schluss ${schoolEnd(d)}</div>` : ""}</div>`;
  }).join("")}</div>`;
  const dayview = `<div class="dayview card" style="padding:6px 16px">${lessonList(planDay)}${lessonsOn(planDay).length ? `<div class="small muted" style="padding:8px 0">Schulschluss ${schoolEnd(planDay)}</div>` : ""}</div>`;
  const src = records.timetable?.source;
  return nav + pick + week + dayview + `<div class="row tools" style="margin-top:4px"><button class="btn" data-tt="edit">Bearbeiten</button>${src?.type === "ical" ? `<button class="btn" data-tt="refresh">Neu laden</button>` : ""}<button class="btn" data-tt="start">Andere Quelle</button></div>
    <p class="small muted">Vertretungen und Ausfälle siehst du weiterhin in deinem Schulsystem. Wenn sich der Stundenplan ändert (z. B. neues Semester), lade ihn hier neu.</p>`;
}

// ---------- Dialog: HÜ ----------
function openHwDialog(id, { offerNone = false } = {}) {
  const h = id ? records[id] : null;
  const t = today();
  const todays = [...new Set(lessonsOn(t).map((l) => l.f))];
  const recent = todays.length ? todays : [...new Set(lessonsOn(addDays(t, -1)).map((l) => l.f))];
  let subject = h?.subject || "";
  let due = h?.due || "";
  const day = records[`day:${t}`];
  const showNone = !h && (offerNone || (schoolEnd(t) && !(day && !day.del)));

  openDialog(`
    <div class="head"><h2>${h ? "HÜ bearbeiten" : "HÜ eintragen"}</h2>${closeBtn}</div>
    ${showNone ? `<button type="button" class="btn big ok" id="hw-none">Heute keine HÜ bekommen ✓</button><div class="divider">oder eintragen</div>` : ""}
    <div><div class="f small muted" style="font-weight:600;margin-bottom:6px">Fach${todays.length ? " (heute)" : ""}</div>
      <div class="chips" id="hw-subjects">${recent.map((f) => `<button type="button" class="chip" data-subj="${esc(f)}">${esc(f)}</button>`).join("")}
      <select class="inp" id="hw-subject-sel" style="width:auto;max-width:100%;padding:6px 10px;font-size:14px;border-radius:999px">
        ${subjectOptions("", recent.length ? "Anderes…" : "Fach wählen…")}</select></div></div>
    <label class="f">Was ist zu tun?<textarea class="inp" id="hw-text" placeholder="z. B. Buch S. 42, Nr. 3–5">${esc(h?.text || "")}</textarea></label>
    <div><div class="f small muted" style="font-weight:600;margin-bottom:6px">Bis wann?</div>
      <div class="chips" id="hw-due-chips"></div>
      <input type="date" class="inp" id="hw-due" style="margin-top:8px" value="${esc(due)}"></div>
    <div class="row">
      ${h ? `<button type="button" class="btn danger" id="hw-del">Löschen</button>` : `<button type="button" class="btn" id="hw-save-more">Speichern + noch eine</button>`}
      <button type="button" class="btn primary" id="hw-save">Speichern</button></div>`, (root) => {
    const sel = $("#hw-subject-sel", root);
    const setSubject = (f) => {
      subject = f;
      root.querySelectorAll("[data-subj]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.subj === f)));
      sel.value = recent.includes(f) ? "" : f;
      const next = f ? nextLesson(f) : null;
      const opts = [];
      if (next) opts.push([next, `Nächste ${f}-Stunde (${fmtShort(next)})`]);
      const tm = addDays(t, 1);
      if (tm !== next) opts.push([tm, "Morgen"]);
      opts.push([addDays(t, 7), "In 1 Woche"]);
      $("#hw-due-chips", root).innerHTML = opts.map(([d, l]) => `<button type="button" class="chip" data-due="${d}" aria-pressed="${d === due}">${l}</button>`).join("");
      if (!h && !id && next && (!due || !opts.some(([d]) => d === due))) setDue(next);
    };
    const setDue = (d) => {
      due = d;
      $("#hw-due", root).value = d;
      root.querySelectorAll("[data-due]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.due === d)));
    };
    root.querySelectorAll("[data-subj]").forEach((b) => b.addEventListener("click", () => setSubject(b.dataset.subj)));
    sel.addEventListener("change", () => (sel.value === "__new" ? askNewSubject(sel, setSubject) : setSubject(sel.value)));
    $("#hw-due-chips", root).addEventListener("click", (e) => { const b = e.target.closest("[data-due]"); if (b) setDue(b.dataset.due); });
    $("#hw-due", root).addEventListener("change", (e) => setDue(e.target.value));
    setSubject(subject);
    if (due) setDue(due);
    if (h) $("#hw-text", root).focus();

    const save = (more) => {
      const text = $("#hw-text", root).value.trim();
      if (!subject) return toast("Bitte ein Fach wählen.");
      if (!due) return toast("Bitte ein Datum wählen.");
      put({ ...(h || { id: `hw-${uid()}`, type: "hw", done: false, created: t }), subject, text, due });
      if (!h) put({ id: `day:${t}`, type: "day", date: t, status: "entered" });
      toast("HÜ gespeichert ✓");
      if (more) openHwDialog(null); else closeDialog();
    };
    $("#hw-save", root).addEventListener("click", () => save(false));
    $("#hw-save-more", root)?.addEventListener("click", () => save(true));
    $("#hw-del", root)?.addEventListener("click", () => { if (confirm("Diese HÜ löschen?")) { remove(h.id); closeDialog(); toast("Gelöscht"); } });
    $("#hw-none", root)?.addEventListener("click", () => { markNoHw(); closeDialog(); });
  });
}
function markNoHw() {
  const t = today();
  put({ id: `day:${t}`, type: "day", date: t, status: "none" });
  toast("Alles klar, heute keine HÜ ✓");
}

// ---------- Dialog: Test ----------
function openTestDialog(id, { focusStoff = false } = {}) {
  const x = id ? structuredClone(records[id]) : { id: `test-${uid()}`, type: "test", subject: "", kind: "Test", date: addDays(today(), 7), time: "", title: "", stoff: "", plan: [] };
  const isNew = !id;
  const kinds = ["Test", "Schularbeit", "Mündlich", "Abgabe"];
  const planHtml = () => (x.plan || []).length ? `<div class="plan">${x.plan.map((p, i) => `
      <div class="item ${p.done ? "done" : ""}"><button type="button" class="tick" data-plan-tick="${i}">${ICON_CHECK}</button>
      <div class="main"><div class="date">${fmtRel(p.date)}</div><div class="title" style="font-weight:500">${esc(p.task)}</div></div></div>`).join("")}</div>` : "";

  openDialog(`
    <div class="head"><h2>${isNew ? "Test eintragen" : `${esc(x.subject)} ${esc(x.kind)}`}</h2>${closeBtn}</div>
    ${!isNew ? `<div class="muted small" style="margin-top:-6px">${fmtShort(x.date)}${x.time ? `, ${x.time}` : ""} · noch ${Math.max(0, diffDays(today(), x.date))} Tage</div>` : ""}
    <details ${isNew ? "open" : ""}><summary class="small muted" style="cursor:pointer;font-weight:600">Details ${isNew ? "" : "ändern"}</summary>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
        <div class="row">
          <label class="f" style="flex:1">Fach<select class="inp" id="t-subject">${subjectOptions(x.subject, "wählen…")}</select></label>
          <label class="f" style="flex:1">Art<select class="inp" id="t-kind">${kinds.map((k) => `<option ${k === x.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        </div>
        <div class="row">
          <label class="f" style="flex:1">Datum<input type="date" class="inp" id="t-date" value="${esc(x.date)}"></label>
          <label class="f" style="flex:1">Uhrzeit<input type="time" class="inp" id="t-time" value="${esc(x.time)}"></label>
        </div>
        <label class="f">Titel (optional)<input class="inp" id="t-title" value="${esc(x.title)}"></label>
      </div></details>
    <label class="f">Stoff<textarea class="inp" id="t-stoff" placeholder="z. B. Kapitel 4–6, Integrale, Arbeitsblätter 3 und 4 …">${esc(x.stoff)}</textarea></label>
    <div class="row"><button type="button" class="btn soft" id="t-plan">${x.plan?.length ? "Lernplan neu erstellen" : "✨ Lernplan erstellen"}</button></div>
    <div id="t-plan-list">${planHtml()}</div>
    <div class="row">
      ${!isNew ? `<button type="button" class="btn danger" id="t-del">Löschen</button>` : ""}
      <button type="button" class="btn primary" id="t-save">Speichern</button></div>`, (root) => {
    const read = () => {
      x.subject = $("#t-subject", root).value;
      x.kind = $("#t-kind", root).value;
      x.date = $("#t-date", root).value;
      x.time = $("#t-time", root).value;
      x.title = $("#t-title", root).value.trim();
      x.stoff = $("#t-stoff", root).value.trim();
    };
    const valid = () => { if (!x.subject) { toast("Bitte ein Fach wählen."); return false; } if (!x.date) { toast("Bitte ein Datum wählen."); return false; } return true; };
    $("#t-subject", root).addEventListener("change", (e) => { if (e.target.value === "__new") askNewSubject(e.target); });
    if (focusStoff) setTimeout(() => $("#t-stoff", root).focus(), 50);
    $("#t-plan-list", root).addEventListener("click", (e) => {
      const b = e.target.closest("[data-plan-tick]");
      if (!b) return;
      const p = x.plan[+b.dataset.planTick];
      p.done = !p.done;
      b.closest(".item").classList.toggle("done", p.done);
      if (!isNew) { read(); put(structuredClone(x)); }
    });
    $("#t-plan", root).addEventListener("click", async (e) => {
      read();
      if (!valid()) return;
      if (!x.stoff) return toast("Trag zuerst den Stoff ein.");
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `<span class="spin"></span> KI plant …`;
      try {
        x.plan = await makePlan(x);
        put(structuredClone(x));
        $("#t-plan-list", root).innerHTML = planHtml();
        btn.textContent = "Lernplan neu erstellen";
        toast("Lernplan fertig ✓");
      } catch (err) {
        btn.textContent = "✨ Lernplan erstellen";
        if (err.needKey) { closeDialog(); openSettings("ki"); }
        toast(err.message);
      } finally { btn.disabled = false; }
    });
    $("#t-save", root).addEventListener("click", () => { read(); if (!valid()) return; put(structuredClone(x)); closeDialog(); toast("Gespeichert ✓"); });
    $("#t-del", root)?.addEventListener("click", () => { if (confirm("Diesen Test löschen?")) { remove(x.id); closeDialog(); } });
  });
}

// ---------- Dialog: Einstellungen ----------
function openSettings(focus) {
  const s = cfg();
  const pushOn = localStorage.getItem(K.push) && Notification?.permission === "granted";
  const last = Number(localStorage.getItem(K.lastSync) || 0);
  let pushBlock;
  if (!API) pushBlock = `<div class="note warn">Server ist noch nicht eingerichtet (config.js). Sync und Mitteilungen gehen erst danach.</div>`;
  else if (isIOS && !standalone) pushBlock = `<div class="note warn">Auf dem iPhone gehen Mitteilungen nur in der installierten App: In Safari auf <b>Teilen</b> → <b>Zum Home-Bildschirm</b>, dann die App vom Home-Bildschirm öffnen und hier einschalten.</div>`;
  else if (!pushSupported) pushBlock = `<div class="note warn">Dieser Browser kann keine Mitteilungen empfangen.</div>`;
  else pushBlock = pushOn
    ? `<div class="row"><button type="button" class="btn" id="s-push-test">Test-Mitteilung</button><button type="button" class="btn danger" id="s-push-off">Ausschalten</button></div>`
    : `<button type="button" class="btn primary" id="s-push-on">🔔 Mitteilungen auf diesem Gerät einschalten</button>`;

  openDialog(`
    <div class="head"><h2>Einstellungen</h2>${closeBtn}</div>
    <h3 style="font-size:17px">Mitteilungen</h3>
    ${pushBlock}
    ${isIOS ? `<div class="small muted">Hinweis: Auf dem iPhone gibt es in Mitteilungen von Web-Apps keine Knöpfe. Tipp die Mitteilung an, dann öffnet sich gleich das Fenster mit „Keine HÜ“ und „HÜ eintragen“.</div>` : ""}
    <label class="row" style="align-items:center;gap:8px"><input type="checkbox" id="s-school" ${s.notifySchool !== false ? "checked" : ""}> Mo–Fr nach Schulschluss nach HÜs fragen</label>
    <label class="row" style="align-items:center;gap:8px"><input type="checkbox" id="s-tests" ${s.notifyTests !== false ? "checked" : ""}> Tests: 7 Tage vorher und am Vortag erinnern</label>
    <label class="row" style="align-items:center;gap:8px"><input type="checkbox" id="s-plan" ${s.notifyPlan !== false ? "checked" : ""}> Lernplan-Aufgabe des Tages schicken</label>
    <label class="f">Uhrzeit für Test- und Lernerinnerungen<input type="time" class="inp" id="s-time" value="${esc(s.testTime || "17:00")}" style="max-width:160px"></label>

    <label class="f">Mitteilungen pausieren bis (z. B. Ferien)<input type="date" class="inp" id="s-pause" value="${esc(s.pauseUntil || "")}" style="max-width:200px"></label>

    <h3 style="font-size:17px;margin-top:6px">Stundenplan</h3>
    <div class="small muted">${hasTimetable() ? `${lessons().length} Stunden${records.timetable?.source?.type === "ical" ? ", aus Kalender-Link" : records.timetable?.source?.type === "image" ? ", aus Foto" : ""}${records.timetable?.updated ? ` · aktualisiert ${fmtShort(records.timetable.updated)}` : ""}` : "Noch kein Stundenplan verbunden."}</div>
    <div class="row"><button type="button" class="btn soft" id="s-tt">${hasTimetable() ? "Stundenplan ändern" : "Stundenplan verbinden"}</button></div>

    <h3 style="font-size:17px;margin-top:6px">Laptop + Handy verbinden</h3>
    ${API ? `<div class="small muted">Dein Sync-Code. Gib ihn am anderen Gerät unten ein, dann sehen beide dieselben Daten. Behandle ihn wie ein Passwort.</div>
    <div class="codebox" id="s-code">${prettyCode(code)}</div>
    <div class="row"><button type="button" class="btn" id="s-copy">Code kopieren</button></div>
    <div class="row"><input class="inp" id="s-join" placeholder="Code vom anderen Gerät" style="flex:2" autocomplete="off" autocapitalize="characters"><button type="button" class="btn soft" id="s-join-btn">Verbinden</button></div>
    <div class="small muted">Zuletzt synchronisiert: ${last ? new Date(last).toLocaleString("de-AT") : "noch nie"}</div>` : `<div class="note warn">Noch kein Server eingerichtet.</div>`}

    <h3 style="font-size:17px;margin-top:6px" id="s-ki">KI-Lernplan</h3>
    <div class="small muted">Der Lernplan kommt von Google Gemini. Hol dir einen kostenlosen Key auf <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Er bleibt nur auf diesem Gerät.</div>
    <div class="row"><input class="inp" id="s-key" type="password" placeholder="Gemini-API-Key" value="${esc(localStorage.getItem(K.key) || "")}" style="flex:2" autocomplete="off"><button type="button" class="btn soft" id="s-key-save">Speichern</button></div>
    ${!localStorage.getItem(K.key) && geminiKey() ? `<div class="small muted">Gerade wird der Key aus ClipCards verwendet.</div>` : ""}

    <h3 style="font-size:17px;margin-top:6px">Daten</h3>
    <div class="row"><button type="button" class="btn" id="s-export">Sichern (JSON)</button><label class="btn" style="cursor:pointer">Wiederherstellen<input type="file" id="s-import" accept="application/json" hidden></label></div>
    <div class="small muted">Ferien und freie Tage trägst du beim Stundenplan ein (Stundenplan ändern → Ferien).</div>`, (root) => {
    const saveCfg = () => put({ ...cfg(), id: "settings", type: "config",
      notifySchool: $("#s-school", root).checked, notifyTests: $("#s-tests", root).checked, notifyPlan: $("#s-plan", root).checked,
      testTime: $("#s-time", root).value || "17:00", pauseUntil: $("#s-pause", root).value || "" });
    $("#s-tt", root).addEventListener("click", () => openTimetableDialog());
    ["#s-school", "#s-tests", "#s-plan", "#s-time", "#s-pause"].forEach((q) => $(q, root).addEventListener("change", saveCfg));
    const busy = async (btn, fn) => { btn.disabled = true; const t = btn.textContent; btn.innerHTML = `<span class="spin"></span>`; try { await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = t; } };
    $("#s-push-on", root)?.addEventListener("click", (e) => busy(e.currentTarget, async () => { await subscribePush(); toast("Mitteilungen sind an ✓"); openSettings(); }));
    $("#s-push-off", root)?.addEventListener("click", (e) => busy(e.currentTarget, async () => { await unsubscribePush(); toast("Mitteilungen aus"); openSettings(); }));
    $("#s-push-test", root)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const r = await fetch(`${API}/api/test-push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }).then((x) => x.json());
      toast(r.sent ? `Gesendet an ${r.sent} Gerät${r.sent > 1 ? "e" : ""}` : "Kein Gerät erreicht. Mitteilungen aus- und wieder einschalten.");
    }));
    $("#s-copy", root)?.addEventListener("click", async () => { await navigator.clipboard?.writeText(prettyCode(code)); toast("Code kopiert"); });
    $("#s-join-btn", root)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const v = $("#s-join", root).value;
      if (!v.trim()) throw new Error("Bitte den Code vom anderen Gerät eingeben.");
      await joinCode(v);
      toast("Verbunden ✓");
      openSettings();
    }));
    $("#s-key-save", root).addEventListener("click", () => {
      const v = $("#s-key", root).value.trim();
      if (v) localStorage.setItem(K.key, v); else localStorage.removeItem(K.key);
      toast(v ? "Key gespeichert ✓" : "Key entfernt");
    });
    $("#s-export", root).addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ app: "stundo", version: 1, records }, null, 2)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `stundo-${today()}.json` });
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $("#s-import", root).addEventListener("change", async (e) => {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        if (!["schulplaner", "stundo"].includes(data.app) || !data.records) throw new Error("Das ist keine Stundo-Sicherung.");
        if (!confirm("Sicherung laden? Neuere Einträge bleiben erhalten.")) return;
        for (const r of Object.values(data.records)) if (!records[r.id] || r.u > records[r.id].u) { records[r.id] = r; dirty.add(r.id); }
        persist(); scheduleSync(100); render(); toast("Sicherung geladen ✓");
      } catch (err) { toast(err.message); }
    });
    if (focus === "ki") $("#s-key", root).focus();
  });
}
$("#btn-settings").addEventListener("click", () => openSettings());

// ---------- Klicks in den Ansichten ----------
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-toggle-hw],[data-edit-hw],[data-add-hw],[data-no-hw],[data-undo-day],[data-edit-test],[data-add-test],[data-toggle-plan],[data-goto],[data-day],[data-week],[data-toggle-done],[data-toggle-past],[data-tt]");
  if (!el || dlg.contains(el)) return;
  const d = el.dataset;
  if (d.toggleHw) { const h = records[d.toggleHw]; put({ ...h, done: !h.done, doneAt: !h.done ? Date.now() : null }); }
  else if (d.editHw) openHwDialog(d.editHw);
  else if ("addHw" in d) openHwDialog(null);
  else if ("noHw" in d) markNoHw();
  else if ("undoDay" in d) { remove(`day:${today()}`); openHwDialog(null); }
  else if (d.editTest) openTestDialog(d.editTest);
  else if ("addTest" in d) openTestDialog(null);
  else if (d.togglePlan) { const [id, i] = d.togglePlan.split(":"); const t = structuredClone(records[id]); t.plan[+i].done = !t.plan[+i].done; put(t); }
  else if (d.goto) setTab(d.goto);
  else if (d.day) { planDay = d.day; render(); }
  else if (d.week) { weekOffset += +d.week; planDay = null; render(); }
  else if ("toggleDone" in d) { showDone = !showDone; render(); }
  else if ("togglePast" in d) { showPast = !showPast; render(); }
  else if (d.tt === "refresh") refreshCalendar();
  else if (d.tt) openTimetableDialog(d.tt);
});

// ---------- Start ----------
function handleUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.size) return;
  const a = p.get("a"), id = p.get("id"), t = p.get("tab");
  history.replaceState(null, "", location.pathname);
  if (t && TITLES[t]) setTab(t);
  if (a === "hue") { setTab("heute"); openHwDialog(null, { offerNone: true }); }
  else if (a === "none") markNoHw();
  else if ((a === "stoff" || a === "test") && records[id]) { setTab("tests"); openTestDialog(id, { focusStoff: a === "stoff" }); }
}

render();
handleUrl();
if (API) sync();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); sync(); } });
setInterval(() => { if (document.visibilityState === "visible") { sync(); if (!dlg.open) render(); } }, 30000);
window.addEventListener("storage", (e) => { if (e.key === K.records) { records = JSON.parse(e.newValue); render(); } });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("../sw.js", { scope: "../" }).catch((e) => console.warn("SW", e));
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "synced") sync();
    if (e.data?.type === "open") { history.replaceState(null, "", e.data.url); handleUrl(); }
  });
}
