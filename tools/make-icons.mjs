// Erzeugt die App-Icons als PNG (ohne Abhängigkeiten): node tools/make-icons.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const inRound = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x)), cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return Math.hypot(x - cx, y - cy) <= r;
};

// Farbe an Punkt (u,v in 0..1). mode: "full" | "maskable" | "badge"
function shade(u, v, mode) {
  const BLUE = [36, 87, 214], PAPER = [255, 253, 248], LINE = [201, 220, 234], ORANGE = [217, 72, 15];
  const s = mode === "maskable" ? 0.78 : 1; // maskable: Inhalt in der sicheren Zone
  const x = (u - 0.5) / s + 0.5, y = (v - 0.5) / s + 0.5;
  if (mode === "badge") {
    const d = Math.min(segDist(u, v, 0.2, 0.52, 0.42, 0.74), segDist(u, v, 0.42, 0.74, 0.82, 0.28));
    return d < 0.09 ? [255, 255, 255, 255] : [0, 0, 0, 0];
  }
  const bg = mode === "maskable" || inRound(u, v, 0, 0, 1, 1, 0.22);
  if (!bg) return [0, 0, 0, 0];
  let c = BLUE;
  if (inRound(x, y, 0.22, 0.2, 0.78, 0.84, 0.06)) {
    c = PAPER;
    for (const ly of [0.42, 0.55, 0.68]) if (Math.abs(y - ly) < 0.012 && x > 0.3 && x < 0.7) c = LINE;
    if (x > 0.22 && x < 0.3 && Math.abs(x - 0.29) < 0.006) c = [232, 160, 160];
  }
  for (const rx of [0.35, 0.5, 0.65]) if (Math.abs(x - rx) < 0.025 && y > 0.14 && y < 0.26) c = [60, 60, 70];
  const d = Math.min(segDist(x, y, 0.36, 0.56, 0.47, 0.67), segDist(x, y, 0.47, 0.67, 0.68, 0.42));
  if (d < 0.045) c = ORANGE;
  return [...c, 255];
}
function render(size, mode) {
  const ss = 4, px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const c = shade((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size, mode);
      acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
    }
    const o = (y * size + x) * 4, a = acc[3];
    px[o] = a ? acc[0] / a : 0; px[o + 1] = a ? acc[1] / a : 0; px[o + 2] = a ? acc[2] / a : 0; px[o + 3] = a / (ss * ss);
  }
  return png(size, px);
}
const out = new URL("../icons/", import.meta.url);
fs.mkdirSync(out, { recursive: true });
for (const [name, size, mode] of [["icon-192.png", 192, "full"], ["icon-512.png", 512, "full"], ["icon-maskable-512.png", 512, "maskable"],
  ["apple-touch-icon.png", 180, "maskable"], ["favicon-32.png", 32, "full"], ["badge-96.png", 96, "badge"]]) {
  fs.writeFileSync(new URL(name, out), render(size, mode));
}
console.log("Icons erstellt");
