import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { inflateSync } from "zlib";
import { join, dirname, resolve } from "path";
import { setupOutcomeView, type SetupState, type SetupStep } from "../src/core/setupView";
import { initialSteps } from "../src/core/setup";
import { noModelHeading } from "../src/core/settingsUi";

const ROOT = resolve(join(__dirname, ".."));

const rendererEntry = join(ROOT, "dist", "renderer", "index.html");
it.skipIf(!existsSync(rendererEntry) && process.env.MKMN_REQUIRE_SIDECAR !== "1")(
  "keeps the page editor and its stylesheet out of the initial renderer assets",
  () => {
    expect(readFileSync(rendererEntry, "utf8")).not.toMatch(/assets\/(?:puck|PageEditor)-[^"\s]+\.(?:js|css)/i);
  },
);

// ---------------------------------------------------------------- ICO integrity
// An ICO directory entry stores width and height as one byte each, where 0 means
// 256. A mismatch advertises e.g. "16×256" for a square payload and confuses
// Windows shell scaling. Every entry must match its embedded PNG's IHDR, and the
// payload must lie within the file.

function pngIhdrSize(buf: Buffer, off: number): { w: number; h: number } {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.subarray(off, off + 8)).toEqual(sig);
  return { w: buf.readUInt32BE(off + 16), h: buf.readUInt32BE(off + 20) };
}

function checkIco(rel: string) {
  const buf = readFileSync(join(ROOT, rel));
  expect(buf.readUInt16LE(0)).toBe(0);
  expect(buf.readUInt16LE(2)).toBe(1); // icon type
  const count = buf.readUInt16LE(4);
  expect(count).toBeGreaterThanOrEqual(5);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const wByte = buf[o];
    const hByte = buf[o + 1];
    const pngOff = buf.readUInt32LE(o + 12);
    const pngLen = buf.readUInt32LE(o + 8);
    expect(pngOff, `${rel} entry ${i} offset inside file`).toBeGreaterThanOrEqual(6 + 16 * count);
    expect(pngOff + pngLen, `${rel} entry ${i} payload inside file`).toBeLessThanOrEqual(buf.length);
    const { w, h } = pngIhdrSize(buf, pngOff);
    const want = w >= 256 ? 0 : w;
    expect(hByte, `${rel} entry ${i} height byte`).toBe(want);
    expect(wByte, `${rel} entry ${i} width byte`).toBe(want);
    expect(h).toBe(w); // square payloads
    sizes.push(w);
  }
  expect(sizes).toContain(16);
  expect(sizes).toContain(256);
}

describe("ICO directory dimensions match the embedded PNG payloads", () => {
  it("build/icon.ico", () => checkIco("build/icon.ico"));
  it("src-tauri/icons/icon.ico", () => checkIco("src-tauri/icons/icon.ico"));
});

// ---------------------------------------------------------------- raster decoding
// Only filter-0 RGBA PNGs are produced by the generator.

function decodePng(rel: string) {
  const buf = readFileSync(join(ROOT, rel));
  const size = buf.readUInt32BE(16);
  expect(buf.readUInt32BE(20), `${rel} square`).toBe(size);
  expect(buf[24], `${rel} bit depth`).toBe(8);
  expect(buf[25], `${rel} color type RGBA`).toBe(6);
  const idats: Buffer[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idats.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = size * 4 + 1;
  expect(raw.length).toBe(size * stride);
  for (let y = 0; y < size; y++) expect(raw[y * stride], `${rel} filter byte row ${y}`).toBe(0);
  const at = (x: number, y: number): [number, number, number, number] => {
    const o = y * stride + 1 + x * 4;
    return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
  };
  return { rel, size, at };
}

/** True if (ux,uy) on the 64-unit grid lies inside a rounded rect shrunk by
    `margin` units (the tile's safe interior, clear of its own anti-aliased edge). */
const insideShrunkTile = (ux: number, uy: number, cornerR: number, margin = 1.5) => {
  const lo = margin, hi = 64 - margin, r = cornerR - margin;
  if (ux < lo || ux > hi || uy < lo || uy > hi) return false;
  const qx = Math.max(lo + r - ux, ux - (hi - r), 0);
  const qy = Math.max(lo + r - uy, uy - (hi - r), 0);
  return Math.hypot(qx, qy) <= r;
};

/** The tile must be opaque everywhere except its rounded exterior corners: the
    source-over compositing must never leave translucent pixels inside. */
function expectOpaqueInterior(png: ReturnType<typeof decodePng>, cornerR: number) {
  const u = 64 / png.size;
  let bad = 0, worst = 255;
  for (let y = 0; y < png.size; y++) {
    for (let x = 0; x < png.size; x++) {
      const a = png.at(x, y)[3];
      if (insideShrunkTile((x + 0.5) * u, (y + 0.5) * u, cornerR)) {
        worst = Math.min(worst, a);
        if (a !== 255) bad++;
      }
    }
  }
  expect(bad, `${png.rel}: opaque interior pixels (worst alpha ${worst})`).toBe(0);
}

function expectTransparentCorners(png: ReturnType<typeof decodePng>) {
  const s = png.size;
  for (const [x, y] of [[1, 1], [s - 2, 1], [1, s - 2], [s - 2, s - 2]] as const) {
    expect(png.at(x, y)[3], `${png.rel} corner (${x},${y})`).toBe(0);
  }
}

describe("generated app icon keeps opaque interiors and intentional corners", () => {
  // The 512 master (build/icon.png) and representative packaged variants.
  const tiles: [string, number][] = [
    ["build/icon.png", 14],
    ["build/icons/mkmn-128.png", 14],
    ["src-tauri/icons/32x32.png", 14],
  ];
  for (const [rel, cornerR] of tiles) {
    it(`${rel}: interior region fully opaque, corners transparent`, () => {
      const png = decodePng(rel);
      expectOpaqueInterior(png, cornerR);
      expectTransparentCorners(png);
    });
  }
  it("build/icon.png: center dot is opaque brass", () => {
    const png = decodePng("build/icon.png");
    const [r, g, b, a] = png.at(png.size / 2, png.size / 2);
    expect(a).toBe(255);
    expect([r, g, b]).toEqual([190, 148, 85]); // #BE9455
  });
  it("build/icon.png: ring stroke is opaque limestone", () => {
    const png = decodePng("build/icon.png");
    const s = png.size / 64;
    const [r, g, b, a] = png.at(Math.round((32 - 27) * s), Math.round(32 * s));
    expect(a).toBe(255);
    expect([r, g, b]).toEqual([245, 242, 234]); // #F5F2EA
  });
});

describe("tray artwork: the thicker-ring variant", () => {
  for (const rel of ["build/tray.png", "src-tauri/icons/tray.png"]) {
    it(`${rel}: rings, dot and corners render at 32 px`, () => {
      const png = decodePng(rel);
      expect(png.size).toBe(32);
      const s = png.size / 64;
      const [r, g, b, a] = png.at(png.size / 2, png.size / 2);
      expect(a).toBe(255);
      expect([r, g, b]).toEqual([190, 148, 85]); // brass dot (r 4.6 covers the center)
      const ring = png.at(Math.round((32 - 24.5) * s), Math.round(32 * s));
      expect(ring[3]).toBe(255);
      expect([ring[0], ring[1], ring[2]]).toEqual([245, 242, 234]); // limestone ring
      expectOpaqueInterior(png, 16);
      expectTransparentCorners(png);
    });
  }
});

// ---------------------------------------------------------------- edge quality
// On the opaque teal tile the ring edges are RGB transitions — alpha stays 255
// across them, so alpha scans cannot measure their sharpness. The check below
// rebuilds every pixel of the horizontal centerline from the documented
// geometry (contours r27/r18.5/r10.5, dot r3.4 — all painted at 180°/0°) and
// the tile gradient, and bounds how far the raster may deviate from that model
// in RGB. The ~1 px anti-aliasing ramp stays well inside the tolerance; a
// blurred render does not (the fixture test below proves the check
// discriminates). Honest scope: this repo's dev toolchain has no independent
// SVG rasterizer, so raster-vs-SVG parity is pinned only indirectly — by the
// shared-geometry test above (the renderer's module carries the master's arcs
// verbatim) and by these geometry-model checks. True SVG-vs-raster parity is
// reviewed visually with the brand sheet, not here.

const LIME = [245, 242, 234], BRASS = [190, 148, 85];
const TEAL_TOP = [26, 78, 79], TEAL_BOTTOM = [13, 46, 47]; // tile gradient stops
/** x-intervals on the 64-unit centerline where each shape paints, with its color. */
const CENTERLINE_SHAPES: [number, number, number[]][] = [
  [2.5, 7.5, LIME],       // outer contour r27 sw5, left flank
  [11, 16, LIME],         // mid contour r18.5 sw5, left flank
  [19.25, 23.75, BRASS],  // inner contour r10.5 sw4.5 (accent color), left flank
  [28.6, 35.4, BRASS],    // center dot r3.4
  [40.25, 44.75, BRASS],  // inner contour, right flank
  [48, 53, LIME],         // mid contour, right flank
  [56.5, 61.5, LIME],     // outer contour, right flank
];
/** Max RGB deviation from the box-coverage model still produced by the ~1 px
    anti-aliasing ramp at the smallest size (measured 46; blur1 measured ≥75). */
const EDGE_TOLERANCE = 55;

function centerlineDeviation(png: ReturnType<typeof decodePng>): { worst: number; at: string } {
  const u = png.size / 64, y = png.size >> 1, px = 1 / u;
  const t = y / png.size;
  const base = [0, 1, 2].map((i) => TEAL_TOP[i] + (TEAL_BOTTOM[i] - TEAL_TOP[i]) * t);
  let worst = 0, at = "";
  for (let x = 0; (x + 1) * px <= 36; x++) { // just past the dot's right edge
    const s0 = x * px, s1 = (x + 1) * px;
    const exp = [...base];
    for (const [a, b, c] of CENTERLINE_SHAPES) {
      const cov = Math.max(0, Math.min(s1, b) - Math.max(s0, a)) / px;
      for (let i = 0; i < 3; i++) exp[i] += cov * (c[i] - base[i]);
    }
    const o = png.at(x, y);
    const d = Math.max(Math.abs(o[0] - exp[0]), Math.abs(o[1] - exp[1]), Math.abs(o[2] - exp[2]));
    if (d > worst) { worst = d; at = `x=${x}`; }
  }
  return { worst, at };
}

describe("icon rasters match the documented geometry at every size (RGB, not alpha)", () => {
  for (const rel of ["build/icons/mkmn-512.png", "build/icons/mkmn-128.png", "build/icons/mkmn-32.png", "build/icons/mkmn-16.png"]) {
    it(`${rel}: centerline pixels stay within the anti-aliasing budget`, () => {
      const d = centerlineDeviation(decodePng(rel));
      expect(d.worst, `${rel} worst centerline RGB deviation at ${d.at}`).toBeLessThanOrEqual(EDGE_TOLERANCE);
    });
  }
  it("a deliberately blurred icon fails the same check (the check discriminates)", () => {
    const src = decodePng("build/icons/mkmn-512.png");
    // box blur radius 1 over the RGB channels, in place on a copy of the rows
    const soft: ReturnType<typeof decodePng> = { ...src, at: (x: number, y: number) => {
      let acc = [0, 0, 0], n = 0;
      for (let k = -1; k <= 1; k++) {
        const xx = Math.min(src.size - 1, Math.max(0, x + k));
        const o = src.at(xx, y);
        acc = [acc[0] + o[0], acc[1] + o[1], acc[2] + o[2]];
        n++;
      }
      return [Math.round(acc[0] / n), Math.round(acc[1] / n), Math.round(acc[2] / n), 255];
    } };
    const d = centerlineDeviation(soft);
    expect(d.worst, "blurred fixture must exceed the anti-aliasing budget").toBeGreaterThan(EDGE_TOLERANCE);
  });
  it("raster silhouettes agree across sizes", () => {
    // Honest scope: this compares the rasters against EACH OTHER (there is no
    // independent SVG rasterizer in the toolchain — see the note above), which
    // pins size-consistent compositing, not SVG parity.
    const frac = (rel: string) => {
      const png = decodePng(rel);
      let on = 0;
      for (let y = 0; y < png.size; y++) for (let x = 0; x < png.size; x++) if (png.at(x, y)[3] >= 128) on++;
      return on / (png.size * png.size);
    };
    const base = frac("build/icons/mkmn-512.png");
    expect(base).toBeGreaterThan(0.5); // the teal tile dominates
    for (const rel of ["build/icons/mkmn-16.png", "build/icons/mkmn-32.png", "build/icons/mkmn-128.png"]) {
      expect(Math.abs(frac(rel) - base), `${rel} vs 512 area fraction`).toBeLessThan(0.04);
    }
  });
});

// ---------------------------------------------------------------- setup copy
// The setup screen must describe what actually happened: consent first, busy
// while installing, failures, skipped components — and only then "ready".
// Imported from src/core/setupView.ts, the browser-safe module.

const state = (steps: Partial<Record<SetupStep["id"], Partial<SetupStep>>>, over: Partial<SetupState> = {}): SetupState => {
  const base = initialSteps({ geniex: true, llama: true, stt: true, tts: true }, { stt: "Whisper", tts: "Piper" })
    .map((s) => ({ ...s, state: "done" as const, message: "Installed" }));
  return {
    active: true,
    awaitingConfirm: false,
    steps: base.map((s) => ({ ...s, ...(steps[s.id] ?? {}) })),
    ...over,
  };
};

describe("setup copy follows the real outcome", () => {
  it("asks for consent before anything downloads", () => {
    const v = setupOutcomeView(state({}, { awaitingConfirm: true }));
    expect(v.outcome).toBe("confirm");
    expect(v.heading).toMatch(/Welcome to MKMN AI/);
    expect(v.description).toMatch(/Nothing is downloaded until you agree/);
  });
  it("stays neutral while installing (no 'this happens once')", () => {
    const v = setupOutcomeView(state({ geniex: { state: "running", percent: 40 } }));
    expect(v.outcome).toBe("busy");
    expect(v.heading).toMatch(/Setting things up/);
    expect(v.description).not.toMatch(/once/i);
  });
  it("names the failed components and offers retry or limited continuation", () => {
    const v = setupOutcomeView(state({
      geniex: { state: "error", error: "Installer exited with code 5" },
      "voice-tts": { state: "error", error: "Download failed (HTTP 403)" },
    }));
    expect(v.outcome).toBe("failed");
    expect(v.heading).toMatch(/couldn't be installed/);
    expect(v.description).toContain("AI engine for the NPU (Qualcomm GenieX)");
    expect(v.description).toContain("Read-aloud model: Piper");
    expect(v.description).toMatch(/Retry below|continue with limited features/);
  });
  it("distinguishes skipped components from success", () => {
    const v = setupOutcomeView(state({ "voice-stt": { state: "skipped", message: "Skipped" }, "voice-tts": { state: "skipped", message: "Skipped" } }));
    expect(v.outcome).toBe("partial");
    expect(v.heading).toMatch(/were skipped/);
    expect(v.description).toContain("Dictation model: Whisper");
    expect(v.description).toMatch(/related features are limited/);
  });
  it("claims ready only when every component is done", () => {
    const allDone = initialSteps({ geniex: true, llama: true, stt: true, tts: true }, { stt: "Whisper", tts: "Piper" })
      .map((s) => ({ ...s, state: "done" as const }));
    const v = setupOutcomeView({ active: false, awaitingConfirm: false, steps: allDone });
    expect(v.outcome).toBe("ready");
    expect(v.heading).toBe("MKMN AI is ready");
  });
  it("never claims ready when a step failed", () => {
    const v = setupOutcomeView(state({ llama: { state: "error", error: "boom" } }));
    expect(v.outcome).toBe("failed");
    expect(v.heading).not.toMatch(/ready/i);
  });
});

// ---------------------------------------------------------------- browser-safe dependency boundary
// The renderer must not runtime-import Node modules. setupOutcomeView used to
// live in src/core/setup.ts (which imports node:path) and was imported by
// SetupScreen as a runtime value — this check pins the boundary.

describe("SetupScreen's module graph stays browser-safe", () => {
  const runtimeImports = (file: string): string[] => {
    const text = readFileSync(file, "utf8");
    const out: string[] = [];
    // single-line imports only (the codebase style); skip `import type`
    for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?!type\b)[^'"]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
    for (const m of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
    return out;
  };
  const resolves = (fromFile: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null; // bare or absolute package: not part of the graph we walk
    const base = resolve(dirname(fromFile), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      try { readFileSync(c); return c; } catch { /* try next */ }
    }
    return null;
  };
  const NODE_BUILTIN = /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s+["'](node:)?(?:path|fs|os|url|zlib|crypto|child_process|net|http|https|stream)["']|require\(\s*["'](node:)?(?:path|fs|os|url|zlib|crypto|child_process)["']/;

  it("no src/core module reachable from SetupScreen imports Node built-ins", () => {
    const seen = new Set<string>();
    const queue = [join(ROOT, "src/renderer/SetupScreen.tsx")];
    const coreWithNode: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (file.startsWith(join(ROOT, "src", "core"))) {
        if (NODE_BUILTIN.test(readFileSync(file, "utf8"))) coreWithNode.push(file);
      }
      for (const spec of runtimeImports(file)) {
        const r = resolves(file, spec);
        if (r) queue.push(r);
      }
    }
    expect(coreWithNode, "core modules with Node imports in SetupScreen's runtime graph").toEqual([]);
  });
});

// ---------------------------------------------------------------- model-selection copy
// "No model selected" must not imply "no model installed".

describe("empty-chat heading distinguishes selection from installation", () => {
  it("asks to choose when models are installed but none is selected", () => {
    expect(noModelHeading(true)).toBe("Choose a model to get started.");
  });
  it("asks to download only when the inventory confirms none is installed", () => {
    expect(noModelHeading(false)).toBe("Download a model to get started.");
  });
});

// ---------------------------------------------------------------- privacy disclosures
// Two facts the interface must not overclaim (verified in code, then pinned here):
//  - web queries are DERIVED from the conversation — user-message text parts
//    include attachment text (core/attachments.ts userContent), so connected
//    searches can carry words from attached documents, while the files themselves
//    are never uploaded;
//  - the no-key search provider falls through DuckDuckGo's html and lite pages
//    to Mojeek (core/websearch.ts), so the disclosure cannot name DuckDuckGo alone.

describe("privacy disclosures stay accurate", () => {
  const settings = readFileSync(join(ROOT, "src/renderer/SettingsView.tsx"), "utf8");
  const brand = readFileSync(join(ROOT, "src/shared/brand.ts"), "utf8");
  const humain = readFileSync(join(ROOT, "src/renderer/HumainSettings.tsx"), "utf8");
  it("discloses the conversation and attachments sent to HUMAIN", () => {
    expect(settings).toContain("BRAND.connectedNote");
    expect(humain).toContain("sends conversation context and attached content");
    expect(brand).toContain("sends conversation context and attachments");
  });
  it("discloses that cloud chat sends data only to the selected provider", () => {
    expect(humain).toContain("only to the selected provider");
  });
  it("keeps storage and inference local in the About summary", () => {
    expect(brand).toContain("Local inference runs separately on this PC, where your chats and documents are stored");
  });
});

// ---------------------------------------------------------------- shared geometry
// The renderer draws the exported mark from the generated module: every arc in
// the SVG master must appear verbatim in src/renderer/logoGeometry.ts.

describe("renderer geometry matches the exported SVG master", () => {
  const svg = readFileSync(join(ROOT, "build/mkmn-mark.svg"), "utf8");
  const ts = readFileSync(join(ROOT, "src/renderer/logoGeometry.ts"), "utf8");
  const ds = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  it("the SVG master has the three contour arcs", () => expect(ds.length).toBe(3));
  it("every master arc is present in the generated module", () => {
    for (const d of ds) expect(ts).toContain(d);
  });
  it("the generated module is the single RESERVOIR_ARCS source (no hand copy in Icons.tsx)", () => {
    const icons = readFileSync(join(ROOT, "src/renderer/Icons.tsx"), "utf8");
    expect(icons).toContain('from "./logoGeometry"');
    for (const d of ds) expect(icons).not.toContain(d);
  });
});
