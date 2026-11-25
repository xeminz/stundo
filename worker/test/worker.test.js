import test from "node:test";
import assert from "node:assert/strict";
import ece from "http_ece";
import { createECDH, randomBytes } from "node:crypto";
import { encryptPayload, bytesToB64u } from "../src/webpush.js";
import { dueMessages, viennaNow } from "../src/reminders.js";
import { mergeRecords } from "../src/index.js";

test("Verschlüsselung lässt sich mit unabhängiger Bibliothek (http_ece) entschlüsseln", async () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const sub = { keys: { p256dh: bytesToB64u(ua.getPublicKey()), auth: bytesToB64u(auth) } };
  const msg = JSON.stringify({ title: "Schule aus! 🎒", body: "Hast du HÜ?" });
  const body = Buffer.from(await encryptPayload(sub, msg));
  const plain = ece.decrypt(body, { version: "aes128gcm", privateKey: ua, authSecret: auth });
  assert.equal(plain.toString("utf8"), msg);
});

test("Wiener Zeit inkl. Sommer/Winter", () => {
  assert.deepEqual(viennaNow(new Date("2026-11-30T14:40:00Z")), { date: "2026-11-30", dow: 1, minutes: 15 * 60 + 40 });
  assert.deepEqual(viennaNow(new Date("2027-06-01T12:00:00Z")), { date: "2027-06-01", dow: 2, minutes: 14 * 60 });
});

const base = () => ({
  timetable: { id: "timetable", u: 1, lessons: [{ d: 1, s: "14:00", e: "15:35", f: "LWS3" }, { d: 2, s: "14:50", e: "16:20", f: "ETH" }] },
  holidays: { id: "holidays", u: 1, ranges: [["2026-12-07", "2026-12-08", "Feiertag"]] },
  settings: { id: "settings", u: 1 },
});

test("HÜ-Frage kommt Montag 5 Minuten nach 15:35, nicht davor", () => {
  const r = base();
  assert.equal(dueMessages(r, { date: "2026-11-30", dow: 1, minutes: 15 * 60 + 39 }).length, 0);
  const m = dueMessages(r, { date: "2026-11-30", dow: 1, minutes: 15 * 60 + 40 });
  assert.equal(m.length, 1);
  assert.equal(m[0].key, "school:2026-11-30");
});

test("Keine HÜ-Frage an Feiertagen, Wochenenden oder wenn schon beantwortet", () => {
  const r = base();
  assert.equal(dueMessages(r, { date: "2026-12-07", dow: 1, minutes: 16 * 60 }).length, 0);
  assert.equal(dueMessages(r, { date: "2026-12-05", dow: 6, minutes: 16 * 60 }).length, 0);
  r["day:2026-11-30"] = { id: "day:2026-11-30", u: 2, type: "day", status: "none" };
  assert.equal(dueMessages(r, { date: "2026-11-30", dow: 1, minutes: 16 * 60 }).length, 0);
});

test("Test-Erinnerung 7 Tage vorher um 17:00, mit Stoff-Bitte", () => {
  const r = base();
  r.t1 = { id: "t1", u: 1, type: "test", subject: "AM", kind: "Schularbeit", date: "2026-12-17" };
  const m = dueMessages(r, { date: "2026-12-10", dow: 4, minutes: 17 * 60 + 2 });
  const t = m.find((x) => x.key === "test7:t1");
  assert.ok(t);
  assert.match(t.body, /Stoff/);
  assert.equal(t.url, "./app/?a=stoff&id=t1");
  assert.equal(dueMessages(r, { date: "2026-12-10", dow: 4, minutes: 16 * 60 }).filter((x) => x.key.startsWith("test")).length, 0);
});

test("Zusammenführen: neuere Änderung gewinnt", () => {
  const s = { a: { id: "a", u: 5, text: "alt" } };
  mergeRecords(s, { a: { id: "a", u: 3, text: "älter" }, b: { id: "b", u: 1 } });
  assert.equal(s.a.text, "alt");
  mergeRecords(s, { a: { id: "a", u: 9, text: "neu" } });
  assert.equal(s.a.text, "neu");
  assert.ok(s.b);
});

test("VAPID-Token ist gültig signiert (ES256)", async () => {
  const { generateKeyPairSync, createPublicKey, verify } = await import("node:crypto");
  const { vapidHeader, b64uToBytes } = await import("../src/webpush.js");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = bytesToB64u(Buffer.concat([Buffer.from([4]), Buffer.from(b64uToBytes(jwk.x)), Buffer.from(b64uToBytes(jwk.y))]));
  const header = await vapidHeader("https://web.push.apple.com/abc", "https://example.org/", pub, jwk.d);
  const [, jwt] = header.match(/^vapid t=([^,]+), k=/);
  const [h, b, s] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(b, "base64url")).aud, "https://web.push.apple.com");
  assert.ok(verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
});

test("Pause und gelöschter Stundenplan: keine HÜ-Frage", () => {
  const r = base();
  r.settings.pauseUntil = "2026-12-01";
  assert.equal(dueMessages(r, { date: "2026-11-30", dow: 1, minutes: 16 * 60 }).length, 0);
  r.settings.pauseUntil = "";
  r.timetable.del = true;
  assert.equal(dueMessages(r, { date: "2026-11-30", dow: 1, minutes: 16 * 60 }).length, 0);
});
