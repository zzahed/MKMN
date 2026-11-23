/**
 * The independent acceptance judge.
 *
 * This judge stands outside the app: it imports nothing from src/, reads a finished
 * page's HTML, and plays it in its own headless machine (node:vm). The scenes it judges
 * are written from the acceptance request alone:
 *
 *   - snake: pressing an arrow key turns the snake (measured by where the head moves,
 *     never by "the screen changed"); reaching the food grows the body or raises a
 *     number; passing the edge or running into the body ends the game; after the end
 *     the game can be restarted.
 *   - tip: three fixed number pairs typed into the page's own inputs, the tip and the
 *     total checked as exact numbers, both input orders tried.
 *
 * A value the page draws on a canvas has no text to read, so positions, the body's
 * length and the numbers are read from the page's own state S and every detail says so.
 * A page PASSES only when every scene held. The scenes are frozen before the acceptance
 * runs: tests/judge-calibration.test.ts pins them against tests/fixtures/judge-*.html
 * (the working snake page takes full marks, the key-ignoring snake page must not pass,
 * the working tip page takes full marks) and they must not change while the runs happen.
 *
 * Usage: node tests/fixtures/acceptance-judge.mjs <page.html> [request words]
 */
import fs from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const EPS = 1e-6;

// ---------- reading the page ----------

/** The page's scripts, in order, with the escaped closing tags the bundler writes undone. */
export function pageScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    out.push(m[1].replace(/<\\\/script/gi, "</script"));
  }
  return out;
}

/** The page's own elements: id, tag and attributes, read from the markup. */
export function pageElements(html) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const idm = /(?:^|\s)id\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]*))/i.exec(m[2]);
    if (!idm) continue;
    const id = idm[2] ?? idm[3] ?? idm[4];
    if (!id || !/^[A-Za-z_]/.test(id)) continue;
    const attrs = {};
    for (const am of m[2].matchAll(/([\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g)) {
      const v = am[2];
      attrs[am[1]] = v.startsWith('"') || v.startsWith("'") ? v.slice(1, -1) : v;
    }
    const at = out.findIndex((e) => e.id === id);
    const el = { id, tag: m[1].toLowerCase(), attrs };
    if (at >= 0) out[at] = el; else out.push(el);
  }
  return out;
}

const firstLine = (e) => String(e && e.message ? e.message : e).split("\n")[0];

// ---------- the headless world the page runs in ----------

/** The world script: element stand-ins, document, captured timers and keys, and the `__d` reader. */
function worldJs(elements) {
  const lit = elements
    .map((e) => `__els[${JSON.stringify(e.id)}] = mk(${JSON.stringify(e.id)}, ${JSON.stringify(e.tag)}, ${JSON.stringify(e.attrs)});`)
    .join("\n  ");
  return `"use strict";
var __errors = [];
var __clock = 0;
var __ticks = [];
var __rafQ = [];
var __keyL = [];
function __err(m) { try { __errors.push({ message: String(m && m.message !== undefined ? m.message : m), stack: String(m && m.stack ? m.stack : "") }); } catch (e) {} }
var console = { log: function () {}, warn: function () {}, info: function () {}, error: __err };
var setInterval = function (cb, ms) { __ticks.push({ cb: cb, ms: Number(ms) || 16 }); return __ticks.length; };
var clearInterval = function () {};
var setTimeout = function (cb) { if (typeof cb === "function") { __rafQ.push(cb); } return 0; };
var clearTimeout = function () {};
var requestAnimationFrame = function (cb) { __rafQ.push(cb); return 0; };
var cancelAnimationFrame = function () {};
var performance = { now: function () { return __clock; } };
var localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
var sessionStorage = localStorage;
var Image = function () { this.complete = false; this.naturalWidth = 0; };
var Audio = function () { return {}; };
var alert = function () {};
var confirm = function () { return true; };
var prompt = function () { return ""; };
var navigator = { userAgent: "acceptance-judge" };
function __ctx2d() {
  return new Proxy({}, {
    get: function (_t, k) {
      if (k === "measureText") { return function () { return { width: 10 }; }; }
      if (k === "canvas") { return null; }
      if (typeof k !== "string") { return undefined; }
      return function () {};
    },
    set: function () { return true; }
  });
}
function mk(id, tag, attrs) {
  var w = tag === "canvas" ? Number(attrs.width) || 400 : 140;
  var h = tag === "canvas" ? Number(attrs.height) || 320 : 30;
  var L = {};
  var el = {
    id: id,
    tagName: String(tag).toUpperCase(),
    style: { display: "", visibility: "", left: "", top: "", width: w + "px", height: h + "px" },
    className: attrs.class || "",
    value: attrs.value != null ? String(attrs.value) : "",
    textContent: "", innerText: "", innerHTML: "",
    checked: false, disabled: false, type: attrs.type || "", placeholder: attrs.placeholder || "",
    width: w, height: h, clientWidth: w, clientHeight: h, offsetWidth: w, offsetHeight: h,
    getBoundingClientRect: function () { return { left: 0, top: 0, x: 0, y: 0, width: w, height: h, right: w, bottom: h }; },
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function (t, fn) { (L[t] = L[t] || []).push(fn); },
    removeEventListener: function () {},
    appendChild: function () {}, removeChild: function () {},
    setAttribute: function (n, v) { attrs[String(n)] = String(v); },
    getAttribute: function (n) { return attrs[String(n)] != null ? String(attrs[String(n)]) : ""; },
    focus: function () {}, blur: function () {}, scrollIntoView: function () {}, select: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    __L: L
  };
  el.getContext = function () { return el.__c2d || (el.__c2d = __ctx2d()); };
  el.__fire = function (type, ev) { var l = L[type] || []; for (var i = 0; i < l.length; i++) { try { l[i](ev); } catch (e) { __err(e); } } };
  return el;
}
var __els = {};
${lit}
function __byIdSel(sel) {
  var m = /^\\[id\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([\\w-]+))\\]\\s*$/.exec(String(sel));
  if (!m) { return []; }
  var id = m[1] || m[2] || m[3];
  return id && __els[id] ? [__els[id]] : [];
}
var document = {
  getElementById: function (id) { return Object.prototype.hasOwnProperty.call(__els, id) ? __els[id] : null; },
  querySelector: function (sel) { var m = /^#([\\w-]+)$/.exec(String(sel)); if (m) { return __els[m[1]] || null; } var l = __byIdSel(sel); return l.length ? l[0] : null; },
  querySelectorAll: function (sel) { var m = /^#([\\w-]+)$/.exec(String(sel)); if (m) { return __els[m[1]] ? [__els[m[1]]] : []; } return __byIdSel(sel); },
  createElement: function (tag) { return mk("", String(tag || "div"), {}); },
  addEventListener: function (t, fn) { __keyL.push({ t: t, fn: fn }); },
  removeEventListener: function () {},
  body: mk("", "body", {}),
  documentElement: mk("", "html", {})
};
var window = {
  document: document, setInterval: setInterval, clearInterval: clearInterval, setTimeout: setTimeout,
  clearTimeout: clearTimeout, requestAnimationFrame: requestAnimationFrame, performance: performance,
  Image: Image, alert: alert, console: console, localStorage: localStorage
};
globalThis.__flush = function () {
  for (var r = 0; r < 6; r++) {
    var q = __rafQ;
    __rafQ = [];
    if (!q.length) { break; }
    __clock += 40;
    for (var i = 0; i < q.length; i++) { try { q[i](__clock); } catch (e) { __err(e); } }
  }
};
globalThis.__tick = function (n) {
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < __ticks.length; j++) { try { __ticks[j].cb(); } catch (e) { __err(e); } }
    globalThis.__flush();
  }
};
globalThis.__press = function (key, up) {
  var t = up ? "keyup" : "keydown";
  var ev = { key: key === "Space" ? " " : key, code: key, preventDefault: function () {}, target: document.body, repeat: false };
  for (var i = 0; i < __keyL.length; i++) {
    if (__keyL[i].t !== t) { continue; }
    try { __keyL[i].fn(ev); } catch (e) { __err(e); }
  }
  globalThis.__flush();
};
globalThis.__click = function (id) {
  var el = __els[id];
  if (el) { el.__fire("click", { preventDefault: function () {}, target: el, clientX: 0, clientY: 0, button: 0 }); }
  globalThis.__flush();
};
globalThis.__type = function (id, value) {
  var el = __els[id];
  if (!el) { return false; }
  el.value = value;
  var ev = { preventDefault: function () {}, target: el, data: value };
  el.__fire("input", ev);
  el.__fire("change", ev);
  globalThis.__flush();
  return true;
};
globalThis.__ids = function () {
  var out = [];
  for (var id in __els) {
    var el = __els[id];
    out.push({ id: id, tag: el.tagName, input: !!(el.__L.input && el.__L.input.length), clicks: !!(el.__L.click && el.__L.click.length), type: el.type });
  }
  return out;
};
globalThis.__errCount = function () { return __errors.length; };
globalThis.__d = (function () {
  function st() {
    try { if (typeof S === "object" && S !== null) { return S; } } catch (e) {}
    try { if (typeof globalThis.S === "object" && globalThis.S !== null) { return globalThis.S; } } catch (e) {}
    return null;
  }
  function isPt(v) { return !!v && typeof v === "object" && !Array.isArray(v) && typeof v.x === "number" && isFinite(v.x) && typeof v.y === "number" && isFinite(v.y); }
  function bodyArr() {
    var s = st();
    if (!s) { return null; }
    var best = null;
    (function scan(o, depth) {
      if (!o || typeof o !== "object" || depth > 2) { return; }
      for (var k in o) {
        var v = o[k];
        if (Array.isArray(v)) {
          if (v.length && isPt(v[0]) && (!best || v.length > best.arr.length)) { best = { key: k, arr: v }; }
        } else if (v && typeof v === "object") { scan(v, depth + 1); }
      }
    })(s, 0);
    return best;
  }
  function head() {
    var b = bodyArr();
    if (!b || !b.arr.length) { return null; }
    var h = b.arr[0];
    if (!h || typeof h !== "object") { return null; }
    return { x: Number(h.x), y: Number(h.y), w: typeof h.w === "number" && h.w > 0 ? h.w : 0 };
  }
  function seg(i) {
    var b = bodyArr();
    if (!b || i >= b.arr.length) { return null; }
    var p = b.arr[i];
    return p && typeof p === "object" ? { x: Number(p.x), y: Number(p.y) } : null;
  }
  function foods() {
    var s = st();
    if (!s) { return []; }
    var b = bodyArr();
    var out = [];
    function bad(o) {
      if (!b) { return false; }
      for (var i = 0; i < b.arr.length; i++) { if (b.arr[i] === o) { return true; } }
      for (var k in o) { if (o[k] === b.arr) { return true; } }
      return false;
    }
    (function w(v, path, depth) {
      if (out.length >= 4 || depth > 3 || !v || typeof v !== "object") { return; }
      if (Array.isArray(v)) { for (var i = 0; i < Math.min(v.length, 8); i++) { w(v[i], path + "[" + i + "]", depth + 1); } return; }
      if (isPt(v) && path !== "S" && !bad(v)) { out.push({ path: path }); }
      for (var k in v) { w(v[k], path + "." + k, depth + 1); }
    })(s, "S", 0);
    return out;
  }
  function points() {
    var s = st();
    if (!s) { return []; }
    var out = [];
    var seen = {};
    (function w(v, path, depth) {
      if (out.length >= 10 || depth > 2 || !v || typeof v !== "object" || Array.isArray(v)) { return; }
      if (isPt(v) && path !== "S" && !seen[path]) { seen[path] = true; out.push({ path: path, x: v.x, y: v.y }); }
      for (var k in v) { w(v[k], path + "." + k, depth + 1); }
    })(s, "S", 0);
    var b = bodyArr();
    if (b && b.arr.length && isPt(b.arr[0])) {
      var hp = "S." + b.key + "[0]";
      if (!seen[hp]) { out.push({ path: hp, x: Number(b.arr[0].x), y: Number(b.arr[0].y) }); }
    }
    return out;
  }
  function setPoint(path, x, y) {
    var s = st();
    if (!s || !path) { return false; }
    var parts = String(path).replace(/^S\\.?/, "").split(/[.\\[\\]]+/).filter(function (x2) { return x2 !== ""; });
    var cur = s;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== "object") { return false; }
      cur = cur[parts[i]];
    }
    if (!cur || typeof cur !== "object") { return false; }
    cur.x = x; cur.y = y;
    return true;
  }
  function foodObj(path) {
    var s = st();
    if (!s || !path) { return null; }
    var parts = String(path).replace(/^S\\.?/, "").split(/[.\\[\\]]+/).filter(function (x) { return x !== ""; });
    var cur = s;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== "object") { return null; }
      cur = cur[parts[i]];
    }
    return isPt(cur) ? { x: cur.x, y: cur.y } : null;
  }
  function numerics() {
    var s = st(); var out = {}; var body = bodyArr();
    if (!s) { return out; }
    (function w(v, path, depth) {
      if (!v || typeof v !== "object" || depth > 3) { return; }
      for (var k in v) {
        var val = v[k];
        if (typeof val === "number" && isFinite(val)) { out[path + "." + k] = val; }
        else if (val && typeof val === "object") {
          if (Array.isArray(val) || (body && val === body.arr)) { continue; }
          w(val, path + "." + k, depth + 1);
        }
      }
    })(s, "S", 0);
    return out;
  }
  function strings() {
    var s = st(); var out = {};
    if (!s) { return out; }
    (function w(v, path, depth) {
      if (!v || typeof v !== "object" || depth > 2) { return; }
      for (var k in v) {
        var val = v[k];
        if (typeof val === "string") { out[path + "." + k] = val; }
        else if (val && typeof val === "object" && !Array.isArray(val)) { w(val, path + "." + k, depth + 1); }
      }
    })(s, "S", 0);
    return out;
  }
  function bools() {
    var s = st(); var out = {};
    if (!s) { return out; }
    (function w(v, path, depth) {
      if (!v || typeof v !== "object" || depth > 2) { return; }
      for (var k in v) {
        var val = v[k];
        if (typeof val === "boolean") { out[path + "." + k] = val; }
        else if (val && typeof val === "object" && !Array.isArray(val)) { w(val, path + "." + k, depth + 1); }
      }
    })(s, "S", 0);
    return out;
  }
  function snap() { var s = st(); if (!s) { return null; } try { return JSON.stringify(s); } catch (e) { return null; } }
  function restore(text) {
    var s = st();
    if (!s || !text) { return false; }
    var o;
    try { o = JSON.parse(text); } catch (e) { return false; }
    for (var k in s) { if (!Object.prototype.hasOwnProperty.call(o, k)) { delete s[k]; } }
    for (var k2 in o) { s[k2] = o[k2]; }
    return true;
  }
  function tokens() {
    var out = [];
    var nums = numerics();
    for (var p in nums) { out.push({ where: p, n: nums[p] }); }
    for (var id in __els) {
      var el = __els[id];
      var t = String(el.textContent || "") + " " + String(el.innerText || "") + " " + String(el.value || "");
      var m = t.match(/-?\\d+(?:\\.\\d+)?/g);
      if (m) { for (var i = 0; i < m.length; i++) { out.push({ where: "#" + id, n: parseFloat(m[i]) }); } }
    }
    return out;
  }
  return { st: st, bodyArr: bodyArr, head: head, seg: seg, foods: foods, foodObj: foodObj, points: points, setPoint: setPoint, numerics: numerics, strings: strings, bools: bools, snap: snap, restore: restore, tokens: tokens };
})();
`;
}

/** One played page: a fresh machine, the world, then the page's own script. */
export function openPage(html) {
  const elements = pageElements(html);
  const code = pageScripts(html).join("\n;\n");
  if (!code.trim()) return { elements, error: "the page has no script to play" };
  try { new vm.Script(code); } catch (e) { return { elements, error: `the page's script does not parse: ${firstLine(e)}` }; }
  const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const run = (chunk, ms = 1500) => String(new vm.Script(chunk).runInContext(ctx, { timeout: ms }));
  const j = (expr, ms) => JSON.parse(run(`JSON.stringify(${expr} ?? null)`, ms));
  try { run(worldJs(elements), 1000); } catch (e) { return { elements, error: `the judge's world failed to load: ${firstLine(e)}` }; }
  let loadError = null;
  try { run(code, 3000); } catch (e) { loadError = firstLine(e); }
  const guard = (fn) => (...args) => {
    if (loadError) throw new Error(`the page's script failed on load: ${loadError}`);
    return fn(...args);
  };
  return {
    elements,
    body: guard(() => j("globalThis.__d.bodyArr()")),
    head: guard(() => j("globalThis.__d.head()")),
    seg: guard((i) => j(`globalThis.__d.seg(${JSON.stringify(i)})`)),
    foods: guard(() => j("globalThis.__d.foods()")),
    foodObj: guard((p) => j(`globalThis.__d.foodObj(${JSON.stringify(p)})`)),
    points: guard(() => j("globalThis.__d.points()")),
    setPoint: guard((path, x, y) => j(`globalThis.__d.setPoint(${JSON.stringify(path)}, ${JSON.stringify(x)}, ${JSON.stringify(y)})`)),
    numerics: guard(() => j("globalThis.__d.numerics()")),
    strings: guard(() => j("globalThis.__d.strings()")),
    bools: guard(() => j("globalThis.__d.bools()")),
    snap: guard(() => j("globalThis.__d.snap()")),
    restore: guard((text) => { run(`globalThis.__d.restore(${JSON.stringify(text)})`); return true; }),
    tokens: guard(() => j("globalThis.__d.tokens()", 2000)),
    ids: guard(() => j("globalThis.__ids()")),
    errCount: guard(() => j("globalThis.__errCount()")),
    tick: guard((n) => { run(`globalThis.__tick(${JSON.stringify(n)})`, 5000); return true; }),
    track: guard((n) => j(`(function () { var out = []; for (var i = 0; i < ${JSON.stringify(n)}; i++) { globalThis.__tick(1); var ps = globalThis.__d.points() ?? []; var row = {}; for (var j = 0; j < ps.length; j++) { row[ps[j].path] = { x: ps[j].x, y: ps[j].y }; } out.push(row); } return out; })()`, 8000)),
    press: guard((key) => { run(`globalThis.__press(${JSON.stringify(key)})`, 1000); return true; }),
    click: guard((id) => { run(`globalThis.__click(${JSON.stringify(id)})`, 1000); return true; }),
    type: guard((id, value) => j(`globalThis.__type(${JSON.stringify(id)}, ${JSON.stringify(value)})`, 1000)),
  };
}

// ---------- shared scene helpers ----------

const dirOf = (dx, dy) => {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < EPS) return null;
  return ax >= ay ? { axis: "x", sign: dx > 0 ? 1 : -1 } : { axis: "y", sign: dy > 0 ? 1 : -1 };
};
const sameDir = (a, b) => !!a && !!b && a.axis === b.axis && a.sign === b.sign;
const axisWord = (d) => (!d ? "nowhere" : d.axis === "x" ? (d.sign > 0 ? "right" : "left") : d.sign > 0 ? "down" : "up");

const okScene = (req, text, detail) => ({ req, text, ok: true, detail });
const failScene = (req, text, detail) => ({ req, text, ok: false, detail });

/** The point that actually moved over a track is the head this page keeps — no shape is assumed. The head is the point with the longest run of steps in one direction (a food that respawns jumps once and then sits still). */
function mover(track) {
  if (!track?.length) return null;
  let best = null;
  for (const p of Object.keys(track[0] ?? {})) {
    const series = track.map((row) => row?.[p]).filter(Boolean);
    if (series.length < 4) continue;
    let run = 0, runRef = null, bestRun = 0, bestRef = null, total = 0, prev = series[0];
    for (let i = 1; i < series.length; i++) {
      const d = Math.hypot(series[i].x - prev.x, series[i].y - prev.y);
      total += d;
      const step = d > EPS ? dirOf(series[i].x - prev.x, series[i].y - prev.y) : null;
      if (step && runRef && sameDir(step, runRef)) run += 1;
      else if (step) { run = 1; runRef = step; }
      else { run = 0; runRef = null; }
      if (run > bestRun) { bestRun = run; bestRef = runRef; }
      prev = series[i];
    }
    if (bestRun >= 3 && (!best || bestRun > best.run || (bestRun === best.run && total > best.total))) best = { path: p, ref: bestRef, run: bestRun, total };
  }
  return best ? { path: best.path, ref: best.ref } : null;
}

/** The board size: the page's own canvas markup, else the board numbers in S, else a common default. */
function boundsOf(elements, nums) {
  const c = elements.find((e) => e.tag === "canvas");
  if (c) return { w: Number(c.attrs.width) || 400, h: Number(c.attrs.height) || 320 };
  const w = nums?.["S.canvasWidth"], h = nums?.["S.canvasHeight"];
  return { w: typeof w === "number" && w > 0 ? w : 400, h: typeof h === "number" && h > 0 ? h : 400 };
}

/** Which top-of-state values changed the way an end of the game looks: a boolean that flipped, a string that changed, or (with the head confirmed still) a number that fell. */
function endSignal(n0, s0, b0, n1, s1, b1, frozen) {
  const sig = [];
  for (const k in b0) if (b1[k] !== undefined && b1[k] !== b0[k]) sig.push(`${k} became ${b1[k]}`);
  for (const k in s0) if (s1[k] !== undefined && s1[k] !== s0[k]) sig.push(`${k} became "${s1[k]}"`);
  if (frozen) for (const k in n0) if (n1[k] !== undefined && n1[k] < n0[k]) sig.push(`${k} fell from ${n0[k]} to ${n1[k]}`);
  return sig;
}

/** Run ticks one at a time after an end was forced, watching the state for an end signal and the head for stillness. */
function watchEnd(s, snap0, headPath, ticks = 10) {
  const nums0 = s.numerics() ?? {}, strs0 = s.strings() ?? {}, bools0 = s.bools() ?? {};
  const errs0 = s.errCount() ?? 0;
  let prev = s.points()?.find((p) => p.path === headPath) ?? null;
  let frozen = 0;
  for (let i = 0; i < ticks; i++) {
    s.tick(1);
    if ((s.errCount() ?? 0) > errs0) return { ok: false, detail: "the page threw errors instead of ending" };
    const now = s.points() ?? [];
    const p = now.find((q) => q.path === headPath) ?? null;
    if (!p && prev) return { ok: false, detail: "the body disappeared from the state without any end the state names" };
    if (p && prev && Math.abs(p.x - prev.x) < EPS && Math.abs(p.y - prev.y) < EPS) frozen += 1; else frozen = 0;
    prev = p;
    const sig = endSignal(nums0, strs0, bools0, s.numerics() ?? {}, s.strings() ?? {}, s.bools() ?? {}, frozen >= 4);
    if (sig.length) return { ok: true, detail: `the state changed the way an end looks (${sig.join("; ")}) (read from the page's own state S)` };
    if (frozen >= 6) return { ok: false, detail: "the head stopped at the edge but nothing in the state marked an end, so the game went on" };
  }
  return { ok: false, detail: "the game went on (no end signal in the state, the head kept moving)" };
}

// ---------- the snake scenes ----------

const TURN_TEXT = "pressing an arrow key turns the snake: afterwards the head moves another way than before";
const EAT_TEXT = "when the head reaches the food, the snake grows or the score rises";
const END_TEXT = "when the snake passes the edge or runs into itself, the game ends";
const RESTART_TEXT = "after the game has ended, it can be restarted: the snake plays again from the start";

/**
 * The game must actually be playing before a scene measures it: a page that opens on a
 * start screen is started the way a player would start it — the page's own clickable
 * elements one at a time, then the Space and Enter keys — and the direction it settled
 * into is returned as the baseline. A page already playing is left alone.
 */
function ensurePlaying(s) {
  let m = mover(s.track(6));
  if (m) return { ...m, how: null };
  for (const w of (s.ids() ?? []).filter((e) => e.clicks)) {
    s.click(w.id);
    m = mover(s.track(6));
    if (m) return { ...m, how: `#${w.id} was clicked` };
  }
  for (const key of ["Space", "Enter"]) {
    s.press(key);
    m = mover(s.track(6));
    if (m) return { ...m, how: `the ${key} key was pressed` };
  }
  return null;
}

const NEVER_STARTED = "the game never starts: the head never moves on its own, and the page's own clickable elements and the Space and Enter keys did not start it (positions read from the page's own state S)";

/** One try of one key: fresh page, the game started, then the key and a watch on where the head moves. */
function turnAttempt(html, turnKey) {
  const s = openPage(html);
  if (s.error) return { ok: false, detail: s.error, noref: true };
  if (!s.body()) return { ok: false, detail: "no body of positions (a list of {x, y}) was found in the page's own state S", noref: true };
  const started = ensurePlaying(s);
  if (!started) return { ok: false, detail: NEVER_STARTED, noref: true };
  const before = (s.points() ?? []).find((p) => p.path === started.path);
  if (!before) return { ok: false, detail: "the moving point of the state could not be read again", noref: true };
  s.press(turnKey);
  const t = (s.track(8) ?? []).map((row) => row?.[started.path]).filter(Boolean);
  for (let i = 0; i < t.length; i++) {
    const d = dirOf(t[i].x - before.x, t[i].y - before.y);
    if (d && !sameDir(d, started.ref)) {
      // a second step along the same new way confirms the turn (a wrapped edge position is a single odd sample, not a turn)
      const step = i + 1 < t.length ? dirOf(t[i + 1].x - t[i].x, t[i + 1].y - t[i].y) : null;
      if (step && !sameDir(step, started.ref)) {
        return { ok: true, detail: `after ${turnKey} was pressed the head moved ${axisWord(step)} where before it moved ${axisWord(started.ref)} (head positions read from the page's own state S)` };
      }
    }
  }
  return { ok: false, detail: `after ${turnKey} was pressed the head kept moving ${axisWord(started.ref)} (positions read from the page's own state S)` };
}

function sceneTurn(html) {
  const first = turnAttempt(html, "ArrowUp");
  if (first.ok) return okScene("A1", TURN_TEXT, first.detail);
  const second = turnAttempt(html, "ArrowLeft");
  if (second.ok) return okScene("A1", TURN_TEXT, second.detail);
  return failScene("A1", TURN_TEXT, first.detail || "the keys never turned the head");
}

/** A number rose between two readings, ignoring what rose on its own and the food's own coordinates. */
function riseOf(before, after, skip, foodPaths) {
  for (const k in after) {
    if (skip.has(k)) continue;
    if (foodPaths.some((p) => k === p || k.startsWith(p + "."))) continue;
    if (before[k] === undefined || after[k] > before[k]) return `${k} (${before[k] === undefined ? "new" : `from ${before[k]}`}, now ${after[k]})`;
  }
  return null;
}

function sceneEat(html) {
  const s = openPage(html);
  if (s.error) return failScene("A2", EAT_TEXT, s.error);
  const b0 = s.body();
  if (!b0) return failScene("A2", EAT_TEXT, "no body of positions (a list of {x, y}) was found in the page's own state S");
  const started = ensurePlaying(s);
  if (!started) return failScene("A2", EAT_TEXT, NEVER_STARTED);
  const h0 = s.head();
  const snap = s.snap();
  const len0 = (s.body() ?? b0).arr.length;
  const nums0 = s.numerics() ?? {};
  // the control: two ticks as the page stands — anything that rises here rises without eating
  s.track(2);
  const controlNums = s.numerics() ?? {};
  const unconditional = new Set();
  for (const k in controlNums) if (nums0[k] === undefined || controlNums[k] > nums0[k]) unconditional.add(k);
  s.restore(snap);
  const foods = s.foods() ?? [];
  if (!foods.length) return failScene("A2", EAT_TEXT, "no second position was found in the state to stand for the food");
  const step = h0 && h0.w > 0 ? h0.w : 1;
  const spots = [[0, 0], [-step, 0], [0, -step], [step, 0], [0, step]];
  const foodPaths = foods.map((f) => f.path);
  for (const f of foods) {
    const fo = s.foodObj(f.path);
    if (!fo || typeof fo.x !== "number") continue;
    for (const [dx, dy] of spots) {
      s.restore(snap);
      s.setPoint(started.path, fo.x + dx, fo.y + dy);
      s.track(2);
      const b = s.body();
      if (b && b.arr.length > len0) return okScene("A2", EAT_TEXT, `with the head placed at the food (${f.path}) the body grew from ${len0} to ${b.arr.length} (read from the page's own state S)`);
      const r = riseOf(nums0, s.numerics() ?? {}, unconditional, foodPaths);
      if (r) return okScene("A2", EAT_TEXT, `with the head placed at the food (${f.path}) ${r} rose (read from the page's own state S)`);
    }
  }
  return failScene("A2", EAT_TEXT, `with the head placed at the food (${foodPaths.join(", ")}) and the clock run, the body stayed at ${len0} and no number rose beyond what rises on its own`);
}

function sceneEnd(html) {
  const s = openPage(html);
  if (s.error) return failScene("A3", END_TEXT, s.error);
  if (!s.body()) return failScene("A3", END_TEXT, "no body of positions (a list of {x, y}) was found in the page's own state S");
  const started = ensurePlaying(s);
  if (!started) return failScene("A3", END_TEXT, NEVER_STARTED);
  const snap = s.snap();
  const bounds = boundsOf(s.elements, s.numerics() ?? {});
  const h = s.head();
  const pad = h && h.w > 0 ? h.w : 1;
  // the edge
  s.restore(snap);
  const hw = s.head();
  if (hw) s.setPoint(started.path, -(bounds.w + pad * 2 + 10), hw.y);
  const wall = watchEnd(s, snap, started.path);
  if (wall.ok) return okScene("A3", END_TEXT, `with the head placed past the edge, ${wall.detail}`);
  // its own body
  let selfTried = false;
  s.restore(snap);
  const seg = s.seg(1);
  if (seg) {
    selfTried = true;
    s.setPoint(started.path, seg.x, seg.y);
    const self = watchEnd(s, snap, started.path);
    if (self.ok) return okScene("A3", END_TEXT, `with the head placed on the body behind it, ${self.detail}`);
  }
  return failScene("A3", END_TEXT, `with the head placed past the edge${selfTried ? " and on the body behind it" : ""}, ${wall.detail}`);
}

function sceneRestart(html) {
  const s = openPage(html);
  if (s.error) return failScene("A4", RESTART_TEXT, s.error);
  const b0 = s.body();
  if (!b0) return failScene("A4", RESTART_TEXT, "no body of positions (a list of {x, y}) was found in the page's own state S");
  const started = ensurePlaying(s);
  if (!started) return failScene("A4", RESTART_TEXT, NEVER_STARTED);
  const snap = s.snap();
  const preNums = s.numerics() ?? {};
  const preStrs = s.strings() ?? {};
  const len0 = (s.body() ?? b0).arr.length;
  const bounds = boundsOf(s.elements, preNums);
  const h = s.head();
  const pad = h && h.w > 0 ? h.w : 1;
  // force an end the way the player would lose: the head past the edge
  s.restore(snap);
  const hw = s.head();
  if (hw) s.setPoint(started.path, -(bounds.w + pad * 2 + 10), hw.y);
  const end = watchEnd(s, snap, started.path);
  if (!end.ok) return failScene("A4", RESTART_TEXT, `the game never ended (with the head placed past the edge, ${end.detail}), so there was nothing to restart`);
  const snapEnd = s.snap();
  const strsEnd = s.strings() ?? {};
  const numsEnd = s.numerics() ?? {};
  const bEnd = s.body();
  const lenEnd = bEnd ? bEnd.arr.length : len0;
  const resumed = () => {
    const before = (s.points() ?? []).find((p) => p.path === started.path);
    const series = (s.track(10) ?? []).map((row) => row?.[started.path]).filter(Boolean);
    if (!before || !series.length) return { moved: false, inside: false, fresh: null };
    const last = series[series.length - 1];
    const moved = series.some((p) => Math.abs(p.x - before.x) > EPS || Math.abs(p.y - before.y) > EPS);
    const inside = last.x >= -EPS && last.y >= -EPS && last.x <= bounds.w + EPS && last.y <= bounds.h + EPS;
    const strs = s.strings() ?? {};
    const nums = s.numerics() ?? {};
    const bNow = s.body();
    const len = bNow ? bNow.arr.length : undefined;
    let fresh = null;
    for (const k in preStrs) if (strsEnd[k] !== undefined && strsEnd[k] !== preStrs[k] && strs[k] === preStrs[k]) fresh = `${k} is back to "${preStrs[k]}"`;
    if (!fresh && len !== undefined && lenEnd !== len0 && len === len0) fresh = `the body is back to ${len0}`;
    if (!fresh) for (const k in preNums) if (numsEnd[k] !== undefined && numsEnd[k] > preNums[k] && nums[k] !== undefined && nums[k] <= preNums[k]) fresh = `${k} is back to ${preNums[k]}`;
    return { moved, inside, fresh };
  };
  const passes = (r) => r.moved && (r.inside || !!r.fresh);
  let r = resumed();
  if (passes(r)) return okScene("A4", RESTART_TEXT, `the game came back on its own after the end: the head plays again${r.fresh ? ` and ${r.fresh}` : ""} (read from the page's own state S)`);
  const wired = (s.ids() ?? []).filter((e) => e.clicks);
  for (const w of wired) {
    s.restore(snapEnd);
    s.click(w.id);
    r = resumed();
    if (passes(r)) return okScene("A4", RESTART_TEXT, `after #${w.id} was clicked the game plays again from the start${r.fresh ? `: ${r.fresh}` : ""} (read from the page's own state S)`);
  }
  for (const key of ["Space", "Enter", "r", "R"]) {
    s.restore(snapEnd);
    s.press(key);
    r = resumed();
    if (passes(r)) return okScene("A4", RESTART_TEXT, `after the ${key} key was pressed the game plays again from the start${r.fresh ? `: ${r.fresh}` : ""} (read from the page's own state S)`);
  }
  const tried = ["the page on its own", ...(wired.length ? [`clicking ${wired.map((w) => `#${w.id}`).join(", ")}`] : []), "the keys Space, Enter, r and R"];
  return failScene("A4", RESTART_TEXT, `no restart happened: tried ${tried.join(", ")} and the head never played again from inside the board`);
}

// ---------- the tip scenes ----------

const TIP_PAIRS = [
  { req: "T1", bill: 100, pct: 15 },
  { req: "T2", bill: 80, pct: 10 },
  { req: "T3", bill: 250, pct: 18 },
];
const tipText = (p) => `with ${p.bill} typed as the bill and ${p.pct} as the percent, the page shows a tip of ${Math.round(p.bill * p.pct) / 100} and a total of ${p.bill + Math.round(p.bill * p.pct) / 100}`;

function sceneTip(html, p) {
  const s = openPage(html);
  if (s.error) return failScene(p.req, tipText(p), s.error);
  const els = s.ids() ?? [];
  // type into the fields the page actually listens to; a page that renders inputs but wires
  // nothing fails here honestly (the typed numbers never reach it)
  let inputs = els.filter((e) => e.input).map((e) => e.id);
  if (inputs.length < 2) inputs = els.filter((e) => e.tag === "INPUT" || e.tag === "TEXTAREA").map((e) => e.id);
  if (inputs.length < 2) return failScene(p.req, tipText(p), `the page has ${inputs.length} input field(s) to type into; a tip and a total need a bill and a percent`);
  const wantTip = Math.round(p.bill * p.pct) / 100;
  const wantTotal = p.bill + wantTip;
  const check = (toks) => {
    const tipHits = toks.filter((t) => typeof t.n === "number" && Math.abs(t.n - wantTip) < 1e-9);
    const totalHits = toks.filter((t) => typeof t.n === "number" && Math.abs(t.n - wantTotal) < 1e-9);
    if (!tipHits.length || !totalHits.length) return null;
    const where = (hits) => {
      const shown = hits.find((t) => t.where.startsWith("#")) ?? hits[0];
      return shown.where.startsWith("S.") ? `${shown.where} (read from the page's own state S)` : shown.where;
    };
    return `the tip is read at ${where(tipHits)} and the total at ${where(totalHits)}`;
  };
  const clicks = (s.ids() ?? []).filter((e) => e.clicks).map((e) => e.id);
  for (const order of [[0, 1], [1, 0]]) {
    const typed = `typing ${p.bill} into #${inputs[order[0]]} and ${p.pct} into #${inputs[order[1]]}`;
    s.type(inputs[order[0]], String(p.bill));
    s.type(inputs[order[1]], String(p.pct));
    let hit = check(s.tokens() ?? []);
    if (hit) return okScene(p.req, tipText(p), `${typed}: ${hit}`);
    for (const id of clicks) {
      s.click(id);
      s.tick(2);
      hit = check(s.tokens() ?? []);
      if (hit) return okScene(p.req, tipText(p), `${typed}, then #${id} was clicked: ${hit}`);
    }
  }
  return failScene(p.req, tipText(p), `no reading of the tip ${wantTip} and the total ${wantTotal} appeared (both input orders tried, with every clickable element)`);
}

// ---------- the judge ----------

export async function judge(html, request) {
  const kind = /\bsnake\b/i.test(String(request)) ? "snake" : /\btip\b/i.test(String(request)) ? "tip" : "unknown";
  const run = (fn, ...args) => {
    try { return fn(...args); } catch (e) { return failScene("?", "?", `the judge could not play the page: ${firstLine(e)}`); }
  };
  let results;
  if (kind === "snake") {
    results = [
      run(sceneTurn, html),
      run(sceneEat, html),
      run(sceneEnd, html),
      run(sceneRestart, html),
    ];
  } else if (kind === "tip") {
    results = TIP_PAIRS.map((p) => run(sceneTip, html, p));
  } else {
    return { kind, results: [], held: 0, total: 0, pass: false, note: "the judge has no scenes for this request" };
  }
  const held = results.filter((r) => r.ok).length;
  return { kind, results, held, total: results.length, pass: results.length > 0 && held === results.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error("usage: node tests/fixtures/acceptance-judge.mjs <page.html> [request words]"); process.exit(2); }
  const html = fs.readFileSync(file, "utf8");
  const r = await judge(html, rest.join(" ") || "a snake game in html");
  console.log(`${file}: ${r.held}/${r.total} ${r.pass ? "PASS" : "FAIL"} (${r.kind})`);
  for (const x of r.results) console.log(`  ${x.ok ? "held  " : "FAILED"} ${x.req}: ${x.detail}`);
}
