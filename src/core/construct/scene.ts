/**
 * The scene judge: what the requirements say must happen, played against a headless
 * page and judged by code. It is GENERIC — it reads the elements and the ids from the
 * page's own markup, and the wishes from the page's own scenarios (the model wrote them
 * from the requirements, in front of the same plan, for this page); it knows nothing
 * about a snake, a game, or a kind of program.
 *
 * The in-app test run uses these verdicts directly: `checkArtifact` plays the scenes and
 * a failing one lands in the test report (the page leaves the test run below its pass
 * mark as soon as one scene fails). The desktop window test uses scenarios.ts' `judge`
 * for the same verdicts; this is that judge without a window.
 */
import type { Scenario, Measure, ScenarioResult } from "./scenarios";
import { judge } from "./scenarios";
import { bundleHtml } from "../bundle";
import { inlineScripts, jsSyntaxError } from "../codecheck";
import { isolation } from "../isolate";

/** See modules: the page passes its scenes only when every scene holds (the requirements are checkable scenes). */
export const PASS_MARK = 1;

export interface SceneReport { results: ScenarioResult[]; held: number; total: number; belowMark: boolean }

/** The ids and tags of the page's own layout: the scene judge measures elements from the page's markup, never from a genre or a keyword. */
export function pageElements(html: string): { id: string; tag: string; attrs: Record<string, string> }[] {
  const out: { id: string; tag: string; attrs: Record<string, string> }[] = [];
  const re = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[2];
    const idm = /(?:^|\s)id\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]*))/i.exec(attrs);
    if (!idm) continue;
    const id = idm[2] ?? idm[3] ?? idm[4];
    if (!id || !/^[A-Za-z_]/.test(id)) continue;
    const rest: Record<string, string> = {};
    for (const am of attrs.matchAll(/([\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/g)) {
      const v = am[2];
      rest[am[1]] = v.startsWith('"') || v.startsWith("'") ? v.slice(1, -1) : v;
    }
    const i = out.findIndex((e) => e.id === id);
    if (i >= 0) out[i] = { id, tag: m[1].toLowerCase(), attrs: rest };
    else out.push({ id, tag: m[1].toLowerCase(), attrs: rest });
  }
  return out;
}
export const layoutIdsOf = (html: string): string[] => pageElements(html).map((e) => e.id);

export interface Wired {
  ticks: { name: string; ms: number }[];
  down: { name: string; key: string }[];
  up: { name: string; key: string }[];
  clicksById: Record<string, string>;
}
/** Which handler is wired to which per-id wiring, and which ticks run on setInterval: read from the page's own wiring, never a guess. */
export function wiredEvents(script: string): Wired {
  const out: Wired = { ticks: [], down: [], up: [], clicksById: {} };
  for (const m of script.matchAll(/setInterval\(function \(\) \{ __run\(([\w$]+)\); __go\(\); \}, (\d+)\)/g)) {
    const name = m[1], ms = Number(m[2]);
    if (!out.ticks.some((t) => t.name === name)) out.ticks.push({ name, ms });
  }
  for (const m of script.matchAll(/document\.addEventListener\("(keydown|keyup)", function \(e\) \{ if \(([\s\S]*?)\) \{ e\.preventDefault\(\); __run\(([\w$]+), e\);/g)) {
    const lit = /e\.code === "Space"/.test(m[2]) ? null : /e\.key === ("(?:[^"\\]|\\.)*")/.exec(m[2])?.[1];
    let key: string | null;
    try { key = lit !== null && lit !== undefined ? (JSON.parse(lit) as string) : (/e\.code === "Space"/.test(m[2]) ? "Space" : null); } catch { key = null; }
    if (key) (m[1] === "keydown" ? out.down : out.up).push({ name: m[3], key });
  }
  for (const m of script.matchAll(/Array\.prototype\.forEach\.call\(document\.querySelectorAll\('\[id= \+ JSON\.stringify\("([\w-]+)"\) \+ '\]'\), function \(el\) \{ el\.addEventListener\("(click|input|change|submit)", function \(e\) \{ (?:e\.preventDefault\(\); )?__run\(([\w$]+), e\);/g)) {
    out.clicksById[m[1]] = m[3];
  }
  return out;
}

/** Build the JS world the script sees: one register for every id found in the layout, each with offsets, class, value, a 2D-context-recording canvas, and getBoundingClientRect. */
function buildWorldJs(elements: { id: string; tag: string; attrs: Record<string, string> }[]): string {
  const lit = elements.map((e, i) => {
    const left = 8 + (i % 8) * 138, top = 8 + Math.floor(i / 8) * 56, w = e.tag === "canvas" ? Number(e.attrs.width) || 400 : 140, h = e.tag === "canvas" ? Number(e.attrs.height) || 320 : 30;
    return `__els[${JSON.stringify(e.id)}] = mk(${JSON.stringify(e.id)}, ${JSON.stringify(e.tag)}, ${left}, ${top}, ${w}, ${h}, ${e.attrs.hidden ? "true" : "false"}, ${JSON.stringify(e.attrs.class ?? "")}, ${JSON.stringify(e.attrs.value ?? "")});`;
  }).join("\n    ");
  return `    "use strict";
    var __els = {};
    var __opCount = 0;
    function canvasOf(el) { return new Proxy({}, { get: function (_t, k) { if (typeof k !== "string") return undefined; if (k === "measureText") return function () { return { width: 10 }; }; if (k === "canvas") return el; return function () { __opCount++; return undefined; }; } }); }
    function mk(id, tag, x, y, w, h, hidden, cls, value) {
      var rect = { left: x, top: y, x, y, width: w, height: h, right: x + w, bottom: y + h };
      var style = { display: hidden ? "none" : "", visibility: "", left: "0px", top: "0px", width: w + "px", height: h + "px" };
      var o = { id: id, tagName: String(tag || "div").toUpperCase(), style: style, className: cls || "", value: value == null ? "" : value, textContent: "", innerText: "", innerHTML: "", checked: false, disabled: false, scrollLeft: 0, scrollTop: 0, offsetWidth: w, offsetHeight: h, offsetLeft: x, offsetTop: y, clientWidth: w, clientHeight: h, _hidden: !!hidden, getBoundingClientRect: function () { return rect; }, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } }, addEventListener: function () {}, removeEventListener: function () {}, appendChild: function () {}, removeChild: function () {}, setAttribute: function () {}, getAttribute: function () { return ""; }, click: function () {}, focus: function () {}, scrollIntoView: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return [] }, getContext: function () { return this.__ctx; } };
      o.__ctx = canvasOf(o);
      o._measure = function () { return { x: x, y: y, w: rect.width, h: rect.height, text: o.textContent || "", shown: style.display !== "none" && style.visibility !== "hidden" && !o._hidden, cls: o.className || "" }; };
      return o;
    }
    ${lit}
    var document = { getElementById: function (id) { return __els[id] || null; }, querySelector: function (sel) { var m = /^#([\\w-]+)$/.exec(String(sel)); return m ? (__els[m[1]] || null) : null; }, querySelectorAll: function (sel) { return []; }, createElement: function (tag) { return mk("", String(tag || "div").toUpperCase(), 0, 0, 0, 0, false, "", ""); }, addEventListener: function () {}, removeEventListener: function () {}, body: mk("", "body", 0, 0, 800, 600, false, "", "") };
    var console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {} };
    var localStorage = { getItem: function () { return null }, setItem: function () {}, removeItem: function () {} };
    var sessionStorage = localStorage;
    // the clock: a page that schedules its game loop must not crash the judge; the loop itself is played by the judge, not by wall time
    var setInterval = function () { return 1; }, clearInterval = function () {}, setTimeout = function () { return 1; }, clearTimeout = function () {};
    // requestAnimationFrame / performance are deliberately NOT defined: the engine's draw() falls back to running directly, which is the only way the page's own view updates headlessly
    var Image = function () { this.complete = false; this.naturalWidth = 0; };
    var alert = function () {}, confirm = function () { return true; }, prompt = function () { return ""; };
    var window = { document: document, setInterval: setInterval, clearInterval: clearInterval, setTimeout: setTimeout, clearTimeout: clearTimeout, Image: Image, alert: alert };
    var globalThis = window;
    function ops() { return __opCount; }`;
}

/** Count of recorded 2D-context operations; captured before and after a scene so "screen changed" can be measured without a window. */
const opsCount = (ctx: import("node:vm").Context, Script: typeof import("node:vm").Script): number => {
  try { const s = String(new Script(`ops()`).runInContext(ctx, { timeout: 300 })); return JSON.parse(s) as number; } catch { return -1; }
};

/** The first number in a text, or null. */
const firstNumber = (t: string): number | null => { const m = String(t).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };

/** The whole judge over a headless page: each scene played, each element measured, scenarios.ts' verdict returned for the check signature. */
export async function judgeScenes(html: string, scenarios: Scenario[]): Promise<SceneReport> {
  const iso = isolation();
  return iso ? (iso.run("judgeScenes", [html, scenarios]) as Promise<SceneReport>) : judgeScenesHere(html, scenarios);
}

/** judgeScenes in this process. */
export async function judgeScenesHere(html: string, scenarios: Scenario[]): Promise<SceneReport> {
  const { createContext, Script } = await import("node:vm");
  const bundled = bundleHtml(html, []);
  const script = inlineScripts(bundled.html).map((s) => s.code.replace(/<\\\/script/gi, "</script")).join("\n;\n");
  if (!script.trim()) return { results: scenarios.map((s) => ({ text: s.text, ok: false, detail: "the page has no script to play" })), held: 0, total: scenarios.length, belowMark: scenarios.length > 0 };
  const syntax = jsSyntaxError(script);
  if (syntax) return { results: scenarios.map((s) => ({ text: s.text, ok: false, detail: `the script does not parse: ${syntax.split("\n")[0]}` })), held: 0, total: scenarios.length, belowMark: scenarios.length > 0 };
  const wired = wiredEvents(script);
  const elements = pageElements(html);
  const world = buildWorldJs(elements);

  const results: ScenarioResult[] = [];
  let held = 0;
  for (const s of scenarios) {
    const ctx = createContext({}, { codeGeneration: { strings: false, wasm: false } });
    try { new Script(world).runInContext(ctx, { timeout: 1500 }); } catch { results.push({ text: s.text, ok: false, detail: "the page could not be played (world load failed)" }); continue; }
    try { new Script(script).runInContext(ctx, { timeout: 1500 }); } catch { /* a page bug: the unknown-failure path */ }

    const measure = (id: string): Measure | null => {
      try { const t = String(new Script(`JSON.stringify(__els[${JSON.stringify(id)}] ? __els[${JSON.stringify(id)}]._measure() : null)`).runInContext(ctx, { timeout: 300 })); return t !== "null" ? (JSON.parse(t) as Measure) : null; } catch { return null; }
    };
    const flushRender = () => { try { new Script(`if (typeof render === 'function') { try { render(); } catch (e) {} }`).runInContext(ctx, { timeout: 300 }); } catch { /* ignored */ } };
    const burst = (n: number) => {
      for (const t of wired.ticks) {
        try { new Script(`for (var i = 0; i < ${n}; i++) { try { ${t.name}(); } catch (e) {} }`).runInContext(ctx, { timeout: 1000 }); } catch { /* ignored */ }
      }
      flushRender();
    };
    // the event is written as a literal: the context forbids code generation from strings, so eval() threw and no key ever reached the page
    const keyEvent = (key: string) => `{ key: ${JSON.stringify(key === "Space" ? " " : key)}, code: ${JSON.stringify(key === "Space" ? "Space" : key)}, preventDefault: function () {}, target: document }`;
    const doDown = (key: string) => { const d = wired.down.find((x) => x.key === key); if (!d) return; try { new Script(`${d.name}(${keyEvent(key)})`).runInContext(ctx, { timeout: 500 }); } catch { /* ignored */ } };
    const doUp = (key: string) => { const u = wired.up.find((x) => x.key === key); if (!u) return; try { new Script(`${u.name}(${keyEvent(key)})`).runInContext(ctx, { timeout: 150 }); } catch { /* ignored */ } };
    const doClick = (id: string) => { const fn = wired.clicksById[id]; if (!fn) return; try { new Script(`${fn}({ preventDefault: function () {}, target: document.getElementById(${JSON.stringify(id)}) })`).runInContext(ctx, { timeout: 500 }); } catch { /* ignored */ } };
    const doType = (id: string, value: string) => { try { new Script(`(function () { var el = document.getElementById(${JSON.stringify(id)}); if (el) { el.value = ${JSON.stringify(value)}; el.textContent = ${JSON.stringify(value)}; el.innerHTML = ${JSON.stringify(value)}; } })();`).runInContext(ctx, { timeout: 150 }); } catch { /* ignored */ } };

    const e = s.expect;
    const target = e.kind === "screen" ? null : e.id;
    const readsValue = e.kind === "up" || e.kind === "down";
    // the page's own state, when the element shows its value some other way (a score drawn as pixels on a canvas has no text to read):
    // the state key of the same name is the value the page keeps, so it is measured as the element's own value and the detail says so
    const stateValue = (k: string): number | null => {
      try {
        const t = String(new Script(`JSON.stringify(typeof S === "object" && S !== null ? S[${JSON.stringify(k)}] : null)`).runInContext(ctx, { timeout: 300 }));
        const v = JSON.parse(t);
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      } catch { return null; }
    };
    const before: Measure | null = target ? measure(target) : null;
    const stateBefore = target && readsValue ? stateValue(target) : null;
    const opsBefore = opsCount(ctx, Script);
    for (const step of s.steps) {
      if (step.do === "press") { for (let i = 0; i < step.times; i++) { doDown(step.key); burst(2); doUp(step.key); } }
      else if (step.do === "hold") { doDown(step.key); burst(Math.max(1, Math.ceil((step.ms ?? 1000) / 100))); doUp(step.key); }
      else if (step.do === "click") { doClick(step.id); burst(2); }
      else if (step.do === "type") { doType(step.id, step.value); burst(1); }
      else if (step.do === "wait") { burst(Math.max(1, Math.ceil(step.ms / 100))); }
    }
    flushRender();
    let after: Measure | null = target ? measure(target) : null;
    // a target that exists but never shows a number in its text (a canvas the value is drawn on) is measured by the state key of its own name
    let viaState = false;
    if (readsValue && target && before && after && firstNumber(before.text) === null && firstNumber(after.text) === null) {
      const sa = stateValue(target);
      if (stateBefore !== null && sa !== null) {
        before.text = String(stateBefore);
        after = { ...after, text: String(sa) };
        viaState = true;
      }
    }
    const screenChanged = e.kind === "screen" ? opsCount(ctx, Script) > opsBefore : false;
    const verdict = judge(e, before, after, screenChanged);
    results.push({ text: s.text, ok: verdict.ok, detail: verdict.detail + (viaState ? " (read from the page's own state S)" : "") });
    if (verdict.ok) held++;
  }
  return { results, held, total: scenarios.length, belowMark: scenarios.length > 0 && held < PASS_MARK };
}
