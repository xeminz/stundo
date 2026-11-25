// Entscheidet, welche Mitteilungen gerade fällig sind. Reine Funktion, damit sie sich testen lässt.

export function viennaNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, dow, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const dayNum = (iso) => Math.round(Date.UTC(...iso.split("-").map((n, i) => (i === 1 ? n - 1 : +n))) / 86400000);
const isoFromNum = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

const WINDOW = 4 * 60; // so lange nach dem Zeitpunkt wird noch nachgeschickt (falls ein Lauf ausfällt)

export function dueMessages(records, now) {
  const all = Object.values(records || {}).filter((r) => r && !r.del);
  const cfg = records?.settings || {};
  const lessons = (!records?.timetable?.del && records?.timetable?.lessons) || [];
  const holidays = records?.holidays?.ranges || [];
  const label = (f) => f || "";
  const out = [];

  const isHoliday = (iso) => holidays.some(([from, to]) => iso >= from && iso <= to);
  const tomorrow = isoFromNum(dayNum(now.date) + 1);

  // 1) Nach Schulschluss: "Hast du HÜ bekommen?"
  const paused = cfg.pauseUntil && now.date <= cfg.pauseUntil;
  if (cfg.notifySchool !== false && !paused && now.dow >= 1 && now.dow <= 6 && !isHoliday(now.date)) {
    const today = lessons.filter((l) => l.d === now.dow);
    if (today.length) {
      const end = Math.max(...today.map((l) => toMin(l.e))) + (cfg.schoolDelay ?? 5);
      const answered = records[`day:${now.date}`] && !records[`day:${now.date}`].del;
      if (!answered && now.minutes >= end && now.minutes < end + WINDOW) {
        const dueTomorrow = all.filter((r) => r.type === "hw" && !r.done && r.due === tomorrow);
        let body = "Hast du heute eine HÜ bekommen?";
        if (dueTomorrow.length) body += ` Morgen fällig: ${dueTomorrow.map((h) => label(h.subject)).join(", ")}.`;
        out.push({
          key: `school:${now.date}`, tag: "hue", title: "Schule aus! 🎒", body,
          url: "./app/?a=hue", date: now.date,
          actions: [{ action: "none", title: "Keine HÜ" }, { action: "add", title: "HÜ eintragen" }],
        });
      }
    }
  }

  // 2) Tests: 7 Tage vorher (Stoff), 1 Tag vorher, und Lernplan-Aufgaben für heute
  const at = toMin(cfg.testTime || "17:00");
  if (cfg.notifyTests !== false && !paused && now.minutes >= at && now.minutes < at + WINDOW) {
    const planToday = [];
    for (const t of all.filter((r) => r.type === "test")) {
      const diff = dayNum(t.date) - dayNum(now.date);
      const name = `${label(t.subject)} ${t.kind || "Test"}`.trim();
      if (diff === 7) {
        out.push(t.stoff?.trim()
          ? { key: `test7:${t.id}`, tag: `test-${t.id}`, title: `In 7 Tagen: ${name}`, body: "Dein Stoff ist eingetragen. Schau dir den Lernplan an.", url: `./app/?a=test&id=${t.id}` }
          : { key: `test7:${t.id}`, tag: `test-${t.id}`, title: `In 7 Tagen: ${name}`, body: "Schick mir den Stoff, dann mache ich dir einen Lernplan.", url: `./app/?a=stoff&id=${t.id}`,
              actions: [{ action: "stoff", title: "Stoff schicken" }] });
      } else if (diff === 1) {
        out.push({ key: `test1:${t.id}`, tag: `test-${t.id}`, title: `Morgen: ${name}`, body: t.stoff?.trim() ? `Stoff: ${t.stoff.trim().slice(0, 120)}` : "Viel Erfolg! 🍀", url: `./app/?a=test&id=${t.id}` });
      }
      if (diff > 0) for (const p of t.plan || []) if (p.date === now.date && !p.done) planToday.push(`${label(t.subject)}: ${p.task}`);
    }
    if (planToday.length && cfg.notifyPlan !== false) {
      out.push({ key: `plan:${now.date}`, tag: "plan", title: "Heute lernen 📚", body: planToday.join(" · ").slice(0, 200), url: "./app/?tab=heute" });
    }
  }
  return out;
}
