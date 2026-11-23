// Generates the MKMN AI "Reservoir" brand assets from one geometry definition:
//   - SVG masters (build/mkmn-*.svg, src/renderer/public/mkmn-mark.svg)
//   - PNG icons and the tray icon
//   - Windows ICO (PNG-compressed entries) and a macOS ICNS (legacy completeness)
// Pure Node: no image libraries, no network. Run: node scripts/generate-brand-assets.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- palette
const C = {
  teal: [0x12, 0x3c, 0x3d],       // petroleum teal
  tealTop: [0x1a, 0x4e, 0x4f],    // tile gradient top
  tealBottom: [0x0d, 0x2e, 0x2f], // tile gradient bottom
  charcoal: [0x17, 0x21, 0x24],
  limestone: [0xf5, 0xf2, 0xea],
  brass: [0xbe, 0x94, 0x55],
};

// ---------------------------------------------------------------- geometry
// The Reservoir: three contour layers around a central opening, with a common
// access gap toward the upper right; a small brass point marks the deepest spot.
// Angles are mathematical (CCW, y-up), in degrees; 45° = upper right.
const GAP = 45;
const CONTOURS = [
  { r: 27, sw: 5, gap: 40 },
  { r: 18.5, sw: 5, gap: 60 },
  { r: 10.5, sw: 4.5, gap: 80 },
];
const DOT = { r: 3.4 };

function markShapes({ stroke, dot, mono = false }) {
  const shapes = [];
  for (const c of CONTOURS) {
    shapes.push({
      kind: "arc", cx: 32, cy: 32, r: c.r, sw: c.sw,
      a0: GAP + c.gap / 2, a1: GAP - c.gap / 2 + 360,
      color: mono ? stroke : (c === CONTOURS[2] ? dot : stroke),
    });
  }
  shapes.push({ kind: "disc", cx: 32, cy: 32, r: DOT.r, color: mono ? stroke : dot });
  return shapes;
}

const tileShapes = (inner) => [
  { kind: "rrect", x: 0, y: 0, w: 64, h: 64, r: 14, grad: [C.tealTop, C.tealBottom] },
  ...markShapes({ stroke: C.limestone, dot: C.brass }).map((s) =>
    inner ? { ...s, r: s.r * 0.94, sw: s.sw * 1.06 } : s),
];

const trayShapes = [
  { kind: "rrect", x: 0, y: 0, w: 64, h: 64, r: 16, grad: [C.tealTop, C.tealBottom] },
  { kind: "arc", cx: 32, cy: 32, r: 24.5, sw: 6.5, a0: 45 + 24, a1: 45 - 24 + 360, color: C.limestone },
  { kind: "arc", cx: 32, cy: 32, r: 13, sw: 6.5, a0: 45 + 36, a1: 45 - 36 + 360, color: C.limestone },
  { kind: "disc", cx: 32, cy: 32, r: 4.6, color: C.brass },
];

// ---------------------------------------------------------------- rasterizer
function hex(a) {
  if (typeof a === "string") return a;
  return `#${a.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function insideRrect(px, py, s) {
  const { x, y, w, h, r } = s;
  const qx = Math.max(x + r - px, px - (x + w - r), 0);
  const qy = Math.max(y + r - py, py - (y + h - r), 0);
  return Math.hypot(qx, qy) <= r;
}

function coverageAt(px, py, s, aa = 0) {
  if (s.kind === "rrect") return insideRrect(px, py, s) ? 1 : 0;
  if (s.kind === "disc") {
    const d = Math.hypot(px - s.cx, py - s.cy);
    // `aa` is the edge-smoothing width in 64-unit space (one output pixel):
    // coverage falls from 1 to 0 across it, so edges stay crisp at every size.
    return aa > 0 ? Math.max(0, Math.min(1, 0.5 + (s.r - d) / aa)) : d <= s.r ? 1 : 0;
  }
  // arc: annulus sector with round caps
  const dx = px - s.cx, dy = s.cy - py; // y-up
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const norm = (a) => ((a % 360) + 360) % 360;
  const rel = norm(ang - s.a0);
  const sweep = norm(s.a1 - s.a0);
  const inSweep = rel <= sweep;
  let d;
  if (inSweep) d = Math.abs(Math.hypot(dx, dy) - s.r);
  else {
    const e0 = [s.cx + s.r * Math.cos((s.a0 * Math.PI) / 180), s.cy - s.r * Math.sin((s.a0 * Math.PI) / 180)];
    const e1 = [s.cx + s.r * Math.cos((s.a1 * Math.PI) / 180), s.cy - s.r * Math.sin((s.a1 * Math.PI) / 180)];
    d = Math.min(Math.hypot(px - e0[0], py - e0[1]), Math.hypot(px - e1[0], py - e1[1]));
  }
  return aa > 0
    ? Math.max(0, Math.min(1, 0.5 - (d - s.sw / 2) / aa))
    : Math.max(0, Math.min(1, 0.5 - (d - s.sw / 2)));
}

function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }

function raster(shapes, size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = size / 64;
  // Edge smoothing spans exactly one output pixel (in 64-unit source space),
  // combined with 4×4 geometric supersampling: crisp at 512, smooth at 16.
  const aa = 64 / size;
  const SUB = 4, SUB2 = SUB * SUB;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Per subsample: composite every shape source-over in paint order, in
      // premultiplied form (out = fill*c + dst*(1-c)). Then average the 16
      // subsamples. A ring partially covering the tile therefore keeps the
      // tile's contribution underneath — no translucent holes in the tile.
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = (x + (sx + 0.5) / SUB) / scale;
          const py = (y + (sy + 0.5) / SUB) / scale;
          let r = 0, g = 0, b = 0, a = 0;
          for (const s of shapes) {
            const c = coverageAt(px, py, s, aa);
            if (c <= 0) continue;
            const fill = s.grad ? mix(s.grad[0], s.grad[1], Math.min(1, Math.max(0, py / 64))) : s.color;
            r = fill[0] * c + r * (1 - c);
            g = fill[1] * c + g * (1 - c);
            b = fill[2] * c + b * (1 - c);
            a = c + a * (1 - c);
          }
          R += r; G += g; B += b; A += a;
        }
      }
      const i = (y * size + x) * 4;
      const outA = A / SUB2;
      if (outA > 0) {
        buf[i] = Math.round(R / SUB2 / outA); buf[i + 1] = Math.round(G / SUB2 / outA); buf[i + 2] = Math.round(B / SUB2 / outA);
        buf[i + 3] = Math.round(outA * 255);
      }
    }
  }
  return buf;
}

// ---------------------------------------------------------------- PNG / ICO / ICNS
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function encodeIco(sizes, rasterFn) {
  const entries = sizes.map((s) => ({ size: s, png: encodePng(s, rasterFn(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    // In ICO metadata, a 0 byte means 256 px; smaller entries must advertise
    // their real width and height (they were square renders).
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}
function encodeIcns(sizes, rasterFn) {
  const types = { 16: "icp4", 32: "icp5", 128: "ic07", 256: "ic08", 512: "ic09" };
  const parts = [];
  for (const s of sizes) {
    const png = encodePng(s, rasterFn(s));
    const head = Buffer.alloc(8);
    head.write(types[s], 0, "ascii"); head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii"); head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------- SVG emitters
const P = (cx, cy, r, aDeg) => {
  const a = (aDeg * Math.PI) / 180;
  return [+(cx + r * Math.cos(a)).toFixed(2), +(cy - r * Math.sin(a)).toFixed(2)];
};
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = P(cx, cy, r, a0);
  const [x1, y1] = P(cx, cy, r, a1);
  const large = ((a1 - a0) % 360 + 360) % 360 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 0 ${x1} ${y1}`;
}
function markSvg({ stroke, dot, mono = false }) {
  const parts = markShapes({ stroke, dot, mono }).map((s) =>
    s.kind === "arc"
      ? `  <path d="${arcPath(s.cx, s.cy, s.r, s.a0, s.a1)}" stroke="${mono ? hex(stroke) : hex(s.color)}" stroke-width="${s.sw}" stroke-linecap="round" fill="none"/>`
      : `  <circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${mono ? hex(stroke) : hex(s.color)}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">\n${parts.join("\n")}\n</svg>\n`;
}
function tileSvg(shapes, { tileR = 14 } = {}) {
  const parts = shapes.map((s) => {
    if (s.kind === "rrect") {
      const [t, b] = s.grad;
      return `  <rect width="64" height="64" rx="${tileR}" fill="url(#g)"/>` +
        `\n  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hex(t)}"/><stop offset="1" stop-color="${hex(b)}"/></linearGradient></defs>`;
    }
    if (s.kind === "arc") return `  <path d="${arcPath(s.cx, s.cy, s.r, s.a0, s.a1)}" stroke="${hex(s.color)}" stroke-width="${s.sw}" stroke-linecap="round" fill="none"/>`;
    return `  <circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${hex(s.color)}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">\n${parts.join("\n")}\n</svg>\n`;
}

// ---------------------------------------------------------------- wordmark
// Monoline geometric letters, cap height 64, stroke 9, round caps/joins.
const LETTERS = {
  M: { w: 52, d: "M4.5 64 L4.5 0 L26 38 L47.5 0 L47.5 64" },
  K: { w: 44, d: "M4.5 0 L4.5 64 M40 0 L4.5 36 M16 24.3 L41 64" },
  N: { w: 46, d: "M4.5 64 L4.5 0 L41.5 64 L41.5 0" },
  A: { w: 34, cap: 40, d: "M2 40 L17 0 L32 40 M8.5 26 L25.5 26", sw: 7 },
  I: { w: 9, cap: 40, d: "M4.5 0 L4.5 40", sw: 7 },
};
function wordmarkSvg({ color, accent, withAI = false }) {
  const CAP = 64, BASE = 72, SW = 9;
  let x = 92;
  const letters = [];
  for (const ch of ["M", "K", "M", "N"]) {
    const L = LETTERS[ch];
    letters.push(`  <path d="${L.d}" transform="translate(${x} ${BASE - CAP})" stroke="${color}" stroke-width="${SW}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
    x += L.w + 18;
  }
  if (withAI) {
    const ruleX = x + 8;
    letters.push(`  <path d="M${ruleX} 40 L${ruleX} 72" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>`);
    let ax = ruleX + 16;
    for (const ch of ["A", "I"]) {
      const L = LETTERS[ch];
      letters.push(`  <path d="${L.d}" transform="translate(${ax} ${BASE - L.cap})" stroke="${accent}" stroke-width="${L.sw}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
      ax += L.w + 10;
    }
    x = ax;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 6} 80" fill="none">\n  <!-- MKMN AI horizontal lockup: The Reservoir symbol + monoline wordmark -->\n  <g transform="translate(4 4) scale(1.125)">${markSvg({ stroke: color, dot: accent }).replace(/^[\s\S]*?<\/defs>\n|^[\s\S]*?<svg[^>]*>\n/, "").replace("</svg>", "").trimEnd()}</g>\n${letters.join("\n")}\n</svg>\n`;
}

// ---------------------------------------------------------------- shared geometry for the renderer
// The renderer (src/renderer/Icons.tsx) draws the SAME geometry as the exported
// assets, from this generated module — one source of truth, no hand duplication.
// Intentional optical variants stay in the script only: the tray icon uses two
// thicker rings, and app-icon sizes bump stroke weight slightly.
function geometryTs() {
  const arcs = CONTOURS.map((c) => ({
    d: arcPath(32, 32, c.r, GAP + c.gap / 2, GAP - c.gap / 2 + 360),
    sw: c.sw,
  }));
  const arcsLit = JSON.stringify(arcs, null, 2).replace(/"([a-z_]+)":/g, "$1:");
  const lettersLit = JSON.stringify(LETTERS, null, 2);
  return `// GENERATED by scripts/generate-brand-assets.mjs — the shared geometry of
// "The Reservoir" mark and the MKMN wordmark. Do not edit by hand: run
// \`node scripts/generate-brand-assets.mjs\` after changing the script.
// Colors are applied by the renderer (currentColor + --logo-accent), never here.

/** Three geological contour layers around a central opening; each path opens
 *  toward the upper right (45°). The innermost arc is the accent layer. */
export const RESERVOIR_ARCS = ${arcsLit};

/** The accent point at the deepest spot of the reservoir. */
export const RESERVOIR_DOT = { cx: 32, cy: 32, r: ${DOT.r} } as const;

/** Monoline wordmark letters, cap height 64, stroke 9, round caps/joins.
 *  Letters with a smaller \`cap\` are the shorter "AI" descriptor glyphs. */
export const WORDMARK_LETTERS: Record<string, { w: number; d: string; sw?: number; cap?: number }> = ${lettersLit};

/** Layout of the horizontal lockup on the symbol's 64-unit grid: baseline,
 *  letter gap and first letter x (the symbol occupies x 0..80, translate(4 4) scale(1.125)). */
export const WORDMARK_LAYOUT = { capHeight: 64, baseline: 72, strokeWidth: 9, letterGap: 18, startX: 92 } as const;
`;
}

// ---------------------------------------------------------------- write everything
const write = (rel, data) => {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  console.log("wrote", rel, typeof data === "string" ? `${data.length} B` : `${data.length} B`);
};

const tileRaster = (inner) => (size) => raster(tileShapes(inner), size);
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// SVG masters
write("build/mkmn-mark.svg", markSvg({ stroke: C.charcoal, dot: C.brass }));
write("build/mkmn-mark-dark.svg", markSvg({ stroke: C.limestone, dot: C.brass }));
write("build/mkmn-mark-mono.svg", markSvg({ stroke: C.charcoal, mono: true }));
write("build/mkmn-app-icon.svg", tileSvg(tileShapes(false)));
write("build/mkmn-tray.svg", tileSvg(trayShapes, { tileR: 16 }));
write("build/mkmn-wordmark.svg", wordmarkSvg({ color: hex(C.charcoal), accent: hex(C.brass) }));
write("build/mkmn-wordmark-dark.svg", wordmarkSvg({ color: hex(C.limestone), accent: hex(C.brass) }));
write("build/mkmn-wordmark-ai.svg", wordmarkSvg({ color: hex(C.charcoal), accent: hex(C.brass), withAI: true }));
write("build/mkmn-wordmark-ai-dark.svg", wordmarkSvg({ color: hex(C.limestone), accent: hex(C.brass), withAI: true }));
// public renderer copy of the symbol (kept for the asset inventory)
write("src/renderer/public/mkmn-mark.svg", markSvg({ stroke: C.charcoal, dot: C.brass }));

// Shared geometry module consumed by src/renderer/Icons.tsx (single source of truth)
write("src/renderer/logoGeometry.ts", geometryTs());

// Windows packaging: build/ (NSIS) and src-tauri/icons/ (Tauri)
write("build/icon.ico", encodeIco(ICO_SIZES, tileRaster(false)));
write("build/icon.png", encodePng(512, raster(tileShapes(false), 512)));
write("build/tray.png", encodePng(32, raster(trayShapes, 32)));
write("src-tauri/icons/icon.ico", encodeIco(ICO_SIZES, tileRaster(false)));
write("src-tauri/icons/icon.png", encodePng(512, raster(tileShapes(false), 512)));
write("src-tauri/icons/32x32.png", encodePng(32, raster(tileShapes(false), 32)));
write("src-tauri/icons/128x128.png", encodePng(128, raster(tileShapes(false), 128)));
write("src-tauri/icons/128x128@2x.png", encodePng(256, raster(tileShapes(false), 256)));
write("src-tauri/icons/tray.png", encodePng(32, raster(trayShapes, 32)));
write("src-tauri/icons/icon.icns", encodeIcns([16, 32, 128, 256, 512], tileRaster(false)));
for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
  write(`src-tauri/icons/Square${s}x${s}Logo.png`, encodePng(s, raster(tileShapes(true), s)));
}
write("src-tauri/icons/StoreLogo.png", encodePng(50, raster(tileShapes(true), 50)));

// build/icons/ PNG set (16..512) plus the dark-surface mark variant
for (const s of [16, 20, 24, 32, 40, 48, 64, 128, 256, 512]) {
  write(`build/icons/mkmn-${s}.png`, encodePng(s, raster(tileShapes(false), s)));
}
write("build/icons/mkmn-dark-256.png", encodePng(256, raster(markShapes({ stroke: C.limestone, dot: C.brass }), 256)));

console.log("done");
