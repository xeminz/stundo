# Stundo

**HÜs, Tests und Stundenplan. Mit Erinnerung nach Schulschluss und KI-Lernplan.**

👉 **Website:** https://xeminz.github.io/stundo/
👉 **App:** https://xeminz.github.io/stundo/app/

## Funktionen

- **Heute:** HÜ-Check nach Schulschluss, Lernaufgabe des Tages, bald fällige HÜs, nächste Tests, Stunden heute/morgen
- **Hausübungen:** eintragen (Fach, was, bis wann), bearbeiten, abhaken. „Bis wann“ schlägt automatisch die nächste Stunde des Fachs vor
- **Tests:** Countdown, Stoff eintragen, **KI-Lernplan** (Google Gemini) mit abhakbaren Tagesaufgaben
- **Stundenplan verbinden:** WebUntis oder jeder andere Kalender-Link (iCal), .ics-Datei, Foto/Screenshot (z. B. EduPage, die KI liest ihn aus) oder selbst eintragen. Ferien und Mitteilungs-Pause einstellbar
- **Sync:** Laptop und Handy über einen Sync-Code verbinden
- **Mitteilungen:**
  - Mo–Fr 5 Minuten nach Schulschluss: „Schule aus! Hast du heute eine HÜ bekommen?“ (nicht an Ferientagen und nicht, wenn du schon geantwortet hast)
  - 7 Tage vor einem Test: „Schick mir den Stoff“, und am Vortag eine Erinnerung
  - Lernplan-Aufgabe des Tages
  - Am Laptop (Chrome/Edge) und auf Android hat die Mitteilung die Knöpfe **Keine HÜ** / **HÜ eintragen**. Auf dem iPhone erlaubt Apple bei Web-Apps keine Knöpfe. Antippen öffnet direkt das Fenster mit „Keine HÜ“ und „HÜ eintragen“.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Website |
| `app/index.html`, `app/app.js` | Die App (reines HTML/CSS/JS, kein Build) |
| `app/timetable.js` | Stundenplan verbinden: Kalender-Link (iCal), .ics-Datei, Foto (KI) oder selbst eintragen |
| `app/config.js` | Adresse des Servers |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installierbare App, Offline-Start, Push-Mitteilungen |
| `worker/` | Server (Cloudflare Worker): Sync-Speicher (KV) und Mitteilungen per Cron alle 5 Minuten |
| `tools/` | Icons und VAPID-Schlüssel erzeugen |

## Lokal ausprobieren

```
node tools/gen-vapid.mjs > worker/.dev.vars
cd worker && npm install && npx wrangler dev --test-scheduled
node dev-server.mjs        # in einem zweiten Fenster → http://localhost:5174/stundo/app/
cd worker && npm test      # Tests für Verschlüsselung, Erinnerungen, Sync
```

## Veröffentlichen

1. **Server (Cloudflare, kostenlos):**
   ```
   cd worker
   npx wrangler login
   npx wrangler kv namespace create SP          # id in wrangler.toml eintragen
   node ../tools/gen-vapid.mjs                  # VAPID_PUBLIC in wrangler.toml eintragen
   npx wrangler secret put VAPID_PRIVATE        # VAPID_PRIVATE einfügen
   npx wrangler deploy                          # zeigt die Adresse, z. B. https://stundo.<name>.workers.dev
   ```
2. Die Adresse in `app/config.js` eintragen.
3. **App (GitHub Pages):** Repo `stundo` anlegen, pushen, Pages aktivieren → `https://xeminz.github.io/stundo/`
4. **iPhone:** Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“ → App öffnen → ⚙️ → Mitteilungen einschalten → Sync-Code vom Laptop eingeben.
