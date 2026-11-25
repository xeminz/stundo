"use strict";
// Stundenplan verbinden: Kalender-Link (iCal, z. B. WebUntis), .ics-Datei, Foto/Screenshot (KI) oder selbst eintragen.
// Wird vor app.js geladen; alle Funktionen hier nutzen die Helfer aus app.js erst beim Aufruf.

const DAYS = [[1, "Montag"], [2, "Dienstag"], [3, "Mittwoch"], [4, "Donnerstag"], [5, "Freitag"], [6, "Samstag"]];

// ---------- iCal lesen ----------
function parseICS(text) {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT") { if (ev) events.push(ev); ev = null; }
    else if (ev) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(";");
      ev[name.toUpperCase()] = { value: line.slice(i + 1), params: params.join(";") };
    }
  }
  const unesc = (s) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
  const toDate = (p) => {
    if (!p) return null;
    const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
    if (!m || !m[4]) return null; // ganztägige Einträge sind keine Stunden
    const [, y, mo, d, h, mi, , z] = m;
    return z ? new Date(Date.UTC(+y, mo - 1, +d, +h, +mi)) : new Date(+y, mo - 1, +d, +h, +mi); // TZID: als Ortszeit lesen
  };
  return events
    .filter((e) => !/CANCELLED/i.test(e.STATUS?.value || ""))
    .map((e) => ({ start: toDate(e.DTSTART), end: toDate(e.DTEND), title: unesc(e.SUMMARY?.value || ""), room: unesc(e.LOCATION?.value || "") }))
    .filter((e) => e.start && e.end && e.title);
}

const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Aus vielen Terminen eine typische Woche machen: pro Wochentag den kommenden Tag mit den meisten Stunden nehmen.
function weekFromEvents(events) {
  const from = addDays(today(), -7);
  const byDate = {};
  for (const e of events) {
    const d = iso(e.start);
    if (d < from || d > addDays(today(), 35)) continue;
    (byDate[d] ||= []).push(e);
  }
  const lessons = [];
  for (const [n] of DAYS) {
    const dates = Object.keys(byDate).filter((d) => dow(d) === n);
    if (!dates.length) continue;
    const best = Math.max(...dates.map((d) => byDate[d].length));
    const pick = dates.filter((d) => byDate[d].length === best).sort((a, b) => Math.abs(diffDays(today(), a)) - Math.abs(diffDays(today(), b)) || b.localeCompare(a))[0];
    const day = byDate[pick].sort((a, b) => a.start - b.start);
    for (const e of day) {
      const prev = lessons[lessons.length - 1];
      const s = hhmm(e.start), en = hhmm(e.end);
      if (prev && prev.d === n && prev.f === shortSubject(e.title) && toMin(s) - toMin(prev.e) <= 15) { prev.e = en; continue; }
      lessons.push({ d: n, s, e: en, f: shortSubject(e.title), r: e.room.slice(0, 30), t: "", long: e.title });
    }
  }
  return lessons;
}
function shortSubject(title) {
  const t = title.replace(/\s+/g, " ").trim();
  const m = t.match(/^([A-Za-zÄÖÜäöü0-9_]{1,10})\s*[-–(:]/); // "D - Deutsch", "AM (Angewandte Mathematik)"
  return (m ? m[1] : t).slice(0, 24);
}

async function fetchCalendar(url) {
  url = url.trim().replace(/^webcal:\/\//i, "https://");
  if (!/^https?:\/\//i.test(url)) throw new Error("Das sieht nicht wie ein Link aus. Er beginnt meist mit https:// oder webcal://");
  if (!API) throw new Error("Server nicht erreichbar.");
  const res = await fetch(`${API}/api/ical`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, url }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Kalender konnte nicht geladen werden.");
  return body.text;
}

function lessonsFromICS(text) {
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("Das ist keine Kalender-Datei (iCal).");
  const events = parseICS(text);
  if (!events.length) throw new Error("Im Kalender sind keine Stunden.");
  const l = weekFromEvents(events);
  if (!l.length) throw new Error("Für die nächsten Wochen sind keine Stunden im Kalender.");
  return l;
}

// ---------- Foto / Screenshot mit KI ----------
async function imageToBase64(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.88).split(",")[1];
}
async function lessonsFromImage(file) {
  const data = await imageToBase64(file);
  const result = await gemini([
    { inlineData: { mimeType: "image/jpeg", data } },
    { text: `Das ist ein Stundenplan eines Schülers (Foto oder Screenshot, z. B. aus WebUntis, EduPage, Schoolfox oder auf Papier).
Lies alle Unterrichtsstunden einer normalen Woche aus.
- day: 1 = Montag … 6 = Samstag
- start, end: Uhrzeit "HH:MM". Wenn nur Stundennummern stehen und keine Zeiten, nimm übliche österreichische Zeiten (1. Stunde 07:50–08:40, je 50 Minuten, 5 Minuten Pause, nach der 4. Stunde 15 Minuten Pause).
- subject: Fachkürzel wie im Plan (z. B. "M", "D", "AM", "POS1"), höchstens 12 Zeichen
- name: voller Fachname, falls erkennbar, sonst leer
- room: Raum, falls erkennbar, sonst leer
Fasse Doppelstunden zu einem Eintrag zusammen. Lass Pausen, Mittagspause und leere Felder weg.` },
  ], {
    type: "array",
    items: { type: "object", properties: { day: { type: "integer" }, start: { type: "string" }, end: { type: "string" }, subject: { type: "string" }, name: { type: "string" }, room: { type: "string" } }, required: ["day", "start", "end", "subject"] },
  });
  const ok = /^\d{1,2}:\d{2}$/;
  const l = (Array.isArray(result) ? result : [])
    .filter((x) => x.day >= 1 && x.day <= 6 && ok.test(x.start) && ok.test(x.end) && x.subject)
    .map((x) => ({ d: x.day, s: x.start.padStart(5, "0"), e: x.end.padStart(5, "0"), f: String(x.subject).trim().slice(0, 24), r: String(x.room || "").slice(0, 30), t: "", long: String(x.name || "").slice(0, 60) }));
  if (!l.length) throw new Error("Auf dem Bild habe ich keinen Stundenplan erkannt. Versuch ein schärferes Foto oder einen Screenshot.");
  return l;
}

// ---------- Dialog ----------
function openTimetableDialog(step = "start", draft = null, source = null) {
  if (step === "edit") return openTimetableEditor(draft || structuredClone(lessons()), source || records.timetable?.source || null);
  const src = records.timetable?.source;
  openDialog(`
    <div class="head"><h2>Stundenplan verbinden</h2>${closeBtn}</div>
    <p class="muted small" style="margin:-4px 0 0">Stundo braucht deinen Stundenplan, damit es weiß, wann deine Schule aus ist und welche Fächer du hast. Wähle, wie du ihn hast:</p>

    <div class="src">
      <div class="src-h"><b>Kalender-Link</b><span class="small muted">WebUntis, Google Kalender, Outlook, Untis Mobile …</span></div>
      <input class="inp" id="tt-url" placeholder="https://… oder webcal://…" value="${esc(src?.type === "ical" ? src.url : "")}" autocomplete="off">
      <div class="row"><button type="button" class="btn primary" id="tt-url-go">Laden</button>
        <label class="btn" style="cursor:pointer">.ics-Datei wählen<input type="file" id="tt-file" accept=".ics,text/calendar" hidden></label></div>
      <details class="small muted"><summary style="cursor:pointer">So findest du den Link in WebUntis</summary>
        <ol style="margin:8px 0 0;padding-left:18px;line-height:1.6">
          <li>WebUntis im Browser öffnen und anmelden</li>
          <li>Rechts oben auf dein Profil → <b>Freigaben</b></li>
          <li>Bei „Zugriff über Kalender“ (iCal) auf <b>Link erstellen</b> bzw. Link kopieren</li>
          <li>Hier einfügen. Falls deine Schule das ausgeschaltet hat: Im Stundenplan auf das Kalender-Symbol (.ics) klicken und die Datei oben wählen, oder ein Foto nehmen.</li>
        </ol></details>
    </div>

    <div class="src">
      <div class="src-h"><b>Foto oder Screenshot</b><span class="small muted">EduPage, Schoolfox, Papier, alles andere. Die KI liest ihn aus.</span></div>
      <label class="btn soft" style="cursor:pointer">Bild auswählen<input type="file" id="tt-img" accept="image/*" hidden></label>
    </div>

    <div class="src">
      <div class="src-h"><b>Selbst eintragen</b><span class="small muted">Fach, Uhrzeit, Raum, für jeden Tag.</span></div>
      <button type="button" class="btn" id="tt-manual">${hasTimetable() ? "Stundenplan bearbeiten" : "Leer anfangen"}</button>
    </div>
    <div id="tt-status" class="small" role="status"></div>`, (root) => {
    const status = $("#tt-status", root);
    const run = async (btn, label, fn, src) => {
      const old = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spin"></span> ${label}`;
      status.textContent = "";
      try { openTimetableEditor(await fn(), src); }
      catch (e) {
        status.innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
        if (e.needKey) status.innerHTML += `<div class="row" style="margin-top:8px"><input class="inp" id="tt-key" type="password" placeholder="Gemini-API-Key" style="flex:2"><button type="button" class="btn soft" id="tt-key-save">Speichern</button></div>
          <div class="small muted" style="margin-top:4px">Kostenlos auf <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>, dann nochmal das Bild wählen.</div>`;
        $("#tt-key-save", root)?.addEventListener("click", () => { const v = $("#tt-key", root).value.trim(); if (v) { localStorage.setItem(K.key, v); toast("Key gespeichert ✓"); } });
      } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
    };
    $("#tt-url-go", root).addEventListener("click", (e) => {
      const url = $("#tt-url", root).value;
      run(e.currentTarget, "Lade …", async () => lessonsFromICS(await fetchCalendar(url)), { type: "ical", url: url.trim() });
    });
    $("#tt-file", root).addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) run($("#tt-url-go", root), "Lese …", async () => lessonsFromICS(await f.text()), { type: "file" });
    });
    $("#tt-img", root).addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) run(e.target.closest("label"), "KI liest …", () => lessonsFromImage(f), { type: "image" });
    });
    $("#tt-manual", root).addEventListener("click", () => openTimetableEditor(structuredClone(lessons()), records.timetable?.source || { type: "manual" }));
  });
}

function openTimetableEditor(list, source) {
  const longNames = { ...subjectsMap() };
  for (const l of list) if (l.long && l.long !== l.f) longNames[l.f] = l.long;
  const row = (l, i) => `<div class="tt-row" data-i="${i}">
      <input class="inp tt-f" value="${esc(l.f)}" placeholder="Fach" aria-label="Fach">
      <input class="inp tt-s" type="time" value="${esc(l.s)}" aria-label="Beginn">
      <input class="inp tt-e" type="time" value="${esc(l.e)}" aria-label="Ende">
      <input class="inp tt-r" value="${esc(l.r || "")}" placeholder="Raum" aria-label="Raum">
      <button type="button" class="iconbtn tt-del" aria-label="Stunde löschen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
  const draw = () => DAYS.filter(([n]) => n <= 5 || list.some((l) => l.d === 6)).map(([n, name]) => {
    const items = list.map((l, i) => [l, i]).filter(([l]) => l.d === n).sort(([a], [b]) => a.s.localeCompare(b.s));
    const end = items.length ? items.reduce((m, [l]) => (l.e > m ? l.e : m), "00:00") : null;
    return `<div class="tt-day"><div class="tt-dh"><b>${name}</b><span class="small muted">${end ? `Schluss ${end}` : "frei"}</span></div>
      ${items.map(([l, i]) => row(l, i)).join("")}
      <button type="button" class="btn sm-add" data-add="${n}">+ Stunde</button></div>`;
  }).join("") + (list.some((l) => l.d === 6) ? "" : `<button type="button" class="btn sm-add" data-add="6">+ Samstag</button>`);

  openDialog(`
    <div class="head"><h2>Stundenplan prüfen</h2>${closeBtn}</div>
    <p class="muted small" style="margin:-4px 0 0">Schau kurz drüber und korrigier, was nicht passt. Wichtig ist vor allem die <b>letzte Stunde</b> jedes Tages, denn danach kommt die HÜ-Frage.</p>
    <div id="tt-days">${draw()}</div>
    <details class="small"><summary style="cursor:pointer;font-weight:600">Ferien und freie Tage (${holidays().length})</summary>
      <div class="muted" style="margin:6px 0">An diesen Tagen kommt keine HÜ-Frage.</div>
      <div id="tt-hol">${holidays().map(([a, b, n], i) => `<div class="row tt-hrow" style="align-items:center;margin-bottom:6px"><span style="flex:1">${esc(n || "Frei")}: ${fmtShort(a)}${a !== b ? ` – ${fmtShort(b)}` : ""}</span><button type="button" class="btn" data-hdel="${i}">Entfernen</button></div>`).join("")}</div>
      <div class="row" style="margin-top:6px"><input class="inp" id="tt-h-name" placeholder="z. B. Weihnachtsferien" style="flex:2;min-width:140px"><input class="inp" type="date" id="tt-h-from" style="flex:1;min-width:130px"><input class="inp" type="date" id="tt-h-to" style="flex:1;min-width:130px"><button type="button" class="btn soft" id="tt-h-add">Hinzufügen</button></div>
    </details>
    <div class="row">
      <button type="button" class="btn" id="tt-back">Andere Quelle</button>
      <button type="button" class="btn primary" id="tt-save">Speichern</button></div>`, (root) => {
    const readAll = () => root.querySelectorAll(".tt-row").forEach((r) => {
      const l = list[+r.dataset.i];
      l.f = $(".tt-f", r).value.trim(); l.s = $(".tt-s", r).value; l.e = $(".tt-e", r).value; l.r = $(".tt-r", r).value.trim();
    });
    const redraw = () => { readAll(); $("#tt-days", root).innerHTML = draw(); };
    $("#tt-days", root).addEventListener("click", (e) => {
      const add = e.target.closest("[data-add]");
      const del = e.target.closest(".tt-del");
      if (add) {
        readAll();
        const d = +add.dataset.add;
        const last = list.filter((l) => l.d === d).sort((a, b) => b.e.localeCompare(a.e))[0];
        const s = last ? last.e : "08:00";
        const e2 = `${pad(Math.floor((toMin(s) + 50) / 60) % 24)}:${pad((toMin(s) + 50) % 60)}`;
        list.push({ d, s, e: e2, f: "", r: "", t: "" });
        $("#tt-days", root).innerHTML = draw();
        const rows = root.querySelectorAll(`.tt-row`);
        rows[rows.length - 1] && [...rows].find((r) => +r.dataset.i === list.length - 1)?.querySelector(".tt-f").focus();
      } else if (del) {
        readAll();
        list.splice(+del.closest(".tt-row").dataset.i, 1);
        $("#tt-days", root).innerHTML = draw();
      }
    });
    $("#tt-days", root).addEventListener("change", (e) => { if (e.target.matches(".tt-s, .tt-e")) redraw(); });
    $("#tt-h-add", root).addEventListener("click", () => {
      const a = $("#tt-h-from", root).value, b = $("#tt-h-to", root).value || a, n = $("#tt-h-name", root).value.trim();
      if (!a) return toast("Bitte ein Datum wählen.");
      readAll();
      put({ id: "holidays", type: "config", ranges: [...holidays(), [a, b < a ? a : b, n || "Frei"]].sort((x, y) => x[0].localeCompare(y[0])) });
      openTimetableEditor(list, source);
      $("details", dlg).open = true;
    });
    root.querySelectorAll("[data-hdel]").forEach((b) => b.addEventListener("click", () => {
      readAll();
      const r = holidays().filter((_, i) => i !== +b.dataset.hdel);
      put({ id: "holidays", type: "config", ranges: r });
      openTimetableEditor(list, source);
      $("details", dlg).open = true;
    }));
    $("#tt-back", root).addEventListener("click", () => { readAll(); openTimetableDialog(); });
    $("#tt-save", root).addEventListener("click", () => {
      readAll();
      const clean = list.filter((l) => l.f && /^\d{2}:\d{2}$/.test(l.s) && /^\d{2}:\d{2}$/.test(l.e) && l.e > l.s)
        .map(({ d, s, e, f, r, t }) => ({ d, s, e, f, r: r || "", t: t || "" }));
      if (!clean.length) return toast("Trag mindestens eine Stunde ein.");
      const subjects = {};
      for (const l of clean) if (longNames[l.f]) subjects[l.f] = longNames[l.f];
      put({ id: "timetable", type: "config", lessons: clean, subjects, source: source || { type: "manual" }, updated: today() });
      closeDialog();
      toast("Stundenplan gespeichert ✓");
      planDay = null;
      setTab("plan");
    });
  });
}

async function refreshCalendar() {
  const src = records.timetable?.source;
  if (src?.type !== "ical") return;
  try { openTimetableEditor(lessonsFromICS(await fetchCalendar(src.url)), src); }
  catch (e) { toast(e.message); }
}
