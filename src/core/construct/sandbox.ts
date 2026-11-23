/**
 * Runs the examples of a function in an isolated context with a time limit: the only way to know that a unit does what its task says,
 * short of asking the model again. Nothing from the app is visible inside (no require, no process, no page).
 */
import type { Example } from "./types";
import { isolation } from "../isolate";

type VmModule = typeof import("node:vm");
let vmModule: VmModule | null = null;
async function vm(): Promise<VmModule> { return (vmModule ??= await import("node:vm")); }

const show = (v: unknown): string => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 120 ? `${s.slice(0, 117)}...` : s; } catch { return String(v); } };
const same = (a: unknown, b: unknown): boolean => { try { return JSON.stringify(a) === JSON.stringify(b) || (Number.isNaN(a) && Number.isNaN(b)); } catch { return false; } };

export async function syntaxProblem(code: string): Promise<string | null> {
  try { const { Script } = await vm(); new Script(code); return null; } catch (e) { return (e as Error).message.split("\n")[0]; }
}

export interface ExampleResult { ok: boolean; failures: string[] }

/** `deps` are the code of the units this one uses; `code` is the unit; each example's `call` must equal its `expect`. */
export async function runExamples(deps: string[], code: string, examples: Example[]): Promise<ExampleResult> {
  const iso = isolation();
  return iso ? (iso.run("runExamples", [deps, code, examples]) as Promise<ExampleResult>) : runExamplesHere(deps, code, examples);
}

/** runExamples in this process (the tests, and the locked-down process the sidecar runs it in). */
export async function runExamplesHere(deps: string[], code: string, examples: Example[]): Promise<ExampleResult> {
  const { createContext, Script } = await vm();
  const failures: string[] = [];
  // The context is EMPTY: the fresh V8 context brings its own Object, Math, JSON and the
  // rest. Passing the host's own intrinsics in would hand the code `Object.constructor` —
  // the HOST Function — and with it the whole process (`Object.constructor("return process")()`).
  const ctx = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  try { new Script(`"use strict";\n${deps.join("\n")}\n${code}`).runInContext(ctx, { timeout: 1000 }); }
  catch (e) { return { ok: false, failures: [`the code does not load: ${(e as Error).message}`] }; }
  for (const ex of examples) {
    try {
      const got = new Script(`(${ex.call})`).runInContext(ctx, { timeout: 1000 });
      const want = new Script(`(${ex.expect})`).runInContext(ctx, { timeout: 1000 });
      if (!same(got, want)) failures.push(`${ex.call} gave ${show(got)}, expected ${show(want)}`);
    } catch (e) { failures.push(`${ex.call} failed: ${(e as Error).message.split("\n")[0]}`); }
  }
  return { ok: !failures.length, failures };
}

export interface SmokeInput {
  /** The kind of unit and its name. */
  kind: "fn" | "view" | "handler";
  name: string;
  code: string;
  /** The state S, as JSON text. */
  state: string;
  /** The code of the other units, so that what the unit calls exists. */
  others: string[];
  /** For a handler: the event that calls it (`keydown ArrowRight`, `tick 16`, `click #id`). */
  on?: string;
  /** For a function: its parameter names (they are filled from the keys of S of the same name; a function whose parameters are not keys is not tried). */
  params?: string[];
}

/**
 * The world a unit sees, built INSIDE the VM. Every stand-in, the console, the timers and
 * the state are created by the sandbox's own intrinsics: not one host object or host
 * function crosses over, so no property chain (`console.log.constructor`,
 * `S.constructor.constructor`, `performance.now.constructor`, ...) reaches the host
 * Function and, through it, the process.
 */
const SMOKE_WORLD = `
"use strict";
var S = typeof __stateText === "string" ? JSON.parse(__stateText) : undefined;
var __touched = { n: 0 };
var __noop = function () {};
function __stand() {
  var target = function () {};
  var self;
  self = new Proxy(target, {
    get: function (_t, k) {
      if (k === Symbol.toPrimitive) return function () { return ""; };
      if (k === "then" || k === Symbol.iterator) return undefined;
      if (k === "length") return 0;
      return self;
    },
    set: function () { __touched.n++; return true; },
    apply: function () { __touched.n++; return self; },
    construct: function () { return self; },
    has: function () { return true; },
    getPrototypeOf: function () { return null; },
    setPrototypeOf: function () { return true; }
  });
  return self;
}
var page = __stand();
var document = page, window = page, localStorage = page, sessionStorage = page, navigator = page;
var performance = { now: function () { return 0; } };
var Image = function () { return page; };
var Audio = function () { return page; };
var console = { log: __noop, warn: __noop, error: __noop, info: __noop };
var alert = __noop, setTimeout = __noop, setInterval = __noop, clearTimeout = __noop, clearInterval = __noop;
var requestAnimationFrame = __noop, cancelAnimationFrame = __noop;
var sprite = function () { return null; };
`;

/**
 * Runs a unit once on the REAL state, with the page replaced by stand-ins: a name that does not exist, or a key read where S has none,
 * fails here exactly as it would in the page, before the whole page is run. Only those two kinds of failure are reported (a name that is
 * not defined, a property read on nothing): what a program decides is not judged here.
 */
export async function smokeRun(input: SmokeInput): Promise<string[]> {
  const iso = isolation();
  return iso ? (iso.run("smokeRun", [input]) as Promise<string[]>) : smokeRunHere(input);
}

/** smokeRun in this process. */
export async function smokeRunHere(input: SmokeInput): Promise<string[]> {
  const { createContext, Script } = await vm();
  let stateText: string;
  try { stateText = JSON.stringify(JSON.parse(input.state)); } catch { return []; }
  const ctx = createContext({ __stateText: stateText }, { codeGeneration: { strings: false, wasm: false } });
  new Script(SMOKE_WORLD).runInContext(ctx, { timeout: 500 });
  for (const code of input.others) { try { new Script(code).runInContext(ctx, { timeout: 500 }); } catch { /* an unwritten or broken unit is not this one's fault */ } }
  try { new Script(`"use strict";\n${input.code}`).runInContext(ctx, { timeout: 500 }); } catch (e) { return [`it does not load: ${(e as Error).message.split("\n")[0]}`]; }
  let call: string;
  if (input.kind === "view") call = `${input.name}(S)`;
  else if (input.kind === "handler") {
    const k = /^key(?:down|up) (\S+)$/.exec(input.on ?? "")?.[1] ?? "ArrowRight";
    call = `${input.name}({ key: ${JSON.stringify(k === "Space" ? " " : k)}, code: ${JSON.stringify(k === "Space" ? "Space" : k)}, preventDefault: function () {}, target: document })`;
  }
  else {
    // a function with no argument is called as it is (a global it reaches for does not exist); one whose parameters are not keys of S cannot be tried
    const ps = input.params ?? [];
    let hostState: Record<string, unknown>;
    try { hostState = JSON.parse(stateText) as Record<string, unknown>; } catch { return []; }
    if (ps.some((p) => !(p in hostState))) return [];
    // the arguments are frozen: a function that changes what it was given fails here, and one that returns nothing is not a calculation
    call = `(function () { var f = function d(o) { if (o && typeof o === "object") { Object.freeze(o); for (var k in o) d(o[k]); } return o; }; return ${input.name}(${ps.map((p) => `f(JSON.parse(JSON.stringify(S[${JSON.stringify(p)}])))`).join(", ")}) === undefined ? "__nothing__" : "ok"; })()`;
  }
  try {
    const before = String(new Script("JSON.stringify(S)").runInContext(ctx, { timeout: 500 }));
    const got = String(new Script(input.kind === "handler" && input.on && /^tick /.test(input.on) ? `for (var i = 0; i < 30; i++) { ${call}; }` : call).runInContext(ctx, { timeout: 1000 }));
    const after = String(new Script("JSON.stringify(S)").runInContext(ctx, { timeout: 500 }));
    const touched = Number(new Script("__touched.n").runInContext(ctx, { timeout: 500 }));
    // what the unit is for, seen on the real state: a view that touches nothing of the page drew nothing; a clock that leaves S as it was never moves anything; a key that changes nothing does nothing
    if (input.kind === "view" && after !== before) return ["it changed S while drawing: a view only reads S and draws (the tick handler moves things and applies physics); copy a value before changing it"];
    if (input.kind === "view" && touched < 2) return ["it ran and drew nothing: it must put something into its element (draw on the canvas, or set the text of the element)"];
    if (input.kind === "handler" && input.on && /^(tick \d+|keydown \S+)$/.test(input.on) && after === before) return [`it ran for ${input.on.startsWith("tick") ? "30 ticks" : "the key being pressed"} and S did not change at all: it must change S (S.something = ...); check that the condition it tests can be true with the values S starts with`];
    if (got === "__nothing__") return ["it returns nothing: a function ends with `return` of a NEW value (it never changes its arguments)"];
    return [];
  }
  catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    if (/Script execution timed out/i.test(msg)) return ["it did not finish (a loop that never ends)"];
    if (/read.only property|object is not extensible|Cannot add property|Cannot assign to read only/i.test(msg)) return [`it changes an argument it was given (${msg}): copy what it changes (with {...x} or [...x]) and return the new value`];
    if (/is not defined/.test(msg)) return [`it failed when run on the real state: ${msg}. A name must come from S (S.something), from a parameter, from a function listed under "Functions you can call", or be declared in the unit`];
    if (/Cannot read propert(?:y|ies) of (?:undefined|null)|Cannot set propert(?:y|ies) of (?:undefined|null)/.test(msg)) return [`it failed when run on the real state: ${msg}. The state S holds exactly the keys listed under "The state S": use those`];
    return [];
  }
}


export interface PlayInput {
  /** The script of the page. */
  script: string;
  /** The state S, to start from is whatever the script holds. */
  ticks: string[];
  down: { name: string; key: string }[];
  up: { name: string; key: string }[];
  clicks: string[];
}

export interface PlayError { unit: string | null; message: string; /** A number of S that is not a number any more: the path in S. */ nan?: string }

/** What one full play of a page found: its errors, and whether the buttons and the keys actually changed anything in the state S. */
export interface PlayRun {
  errors: PlayError[];
  /** True when the state S after the buttons and the clock differs from the state after the load and draw alone. */
  clicksChanged: boolean;
  /** True when the state after the keys and the clock differs from the state after the buttons. */
  keysChanged: boolean;
}

/**
 * The page's own script, run in an isolated context with the page replaced by stand-ins: it is loaded and drawn, the keys are pressed,
 * the clock ticks a couple of hundred times (what moves by itself), the keys are released and it is drawn again. What fails is the
 * program failing as it would in a window, found before a window is opened, and the function it failed in is read from the error.
 */
export async function playPage(input: PlayInput, units: string[]): Promise<PlayError[]> {
  return (await playPageRun(input, units)).errors;
}

/**
 * The full play (see playPage), with what a fix loop or a checker also wants to know:
 * whether the buttons and the keys changed anything in the state at all. A page whose
 * handlers run but touch nothing is the sandbox's honest stand-in for the desktop's
 * "inert control" probe (which compares the screen; there is no screen here).
 */
export async function playPageRun(input: PlayInput, units: string[]): Promise<PlayRun> {
  const iso = isolation();
  return iso ? (iso.run("playPageRun", [input, units]) as Promise<PlayRun>) : playPageRunHere(input, units);
}

/** playPageRun in this process. */
export async function playPageRunHere(input: PlayInput, units: string[]): Promise<PlayRun> {
  const { createContext, Script } = await vm();
  const errors: PlayError[] = [];
  const seen = new Set<string>();
  const note = (e: unknown) => {
    const err = e as { message?: string; stack?: string } | string;
    const message = String(typeof err === "string" ? err : err?.message ?? err).split("\n")[0];
    const stack = typeof err === "string" ? "" : String(err?.stack ?? "");
    const frame = [...stack.matchAll(/at (?:Object\.)?([\w$]+) \(/g)].map((m) => m[1]).find((n) => units.includes(n));
    const key = `${frame ?? ""}|${message}`;
    if (seen.has(key) || errors.length >= 8) return;
    seen.add(key);
    errors.push({ unit: frame ?? null, message });
  };
  // The world is built inside the VM (see SMOKE_WORLD); the only things passed in are
  // strings, and everything read back out is a string or a number.
  const ctx = createContext({
    __eventsText: JSON.stringify({
      ticks: input.ticks,
      down: input.down.map((d) => [d.name, d.key]),
      up: input.up.map((d) => [d.name, d.key]),
      clicks: input.clicks,
    }),
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(`
    "use strict";
    ${SMOKE_WORLD}
    globalThis.__errors = [];
    console = { log: __noop, warn: __noop, info: __noop, error: function (m) { __errors.push({ message: String(m && m.message !== undefined ? m.message : m), stack: String(m && m.stack ? m.stack : "") }); } };
    globalThis.__play = JSON.parse(__eventsText);
  `).runInContext(ctx, { timeout: 500 });
  try { new Script(input.script).runInContext(ctx, { timeout: 1500 }); } catch (e) { note(e); return { errors, clicksChanged: false, keysChanged: false }; }
  try {
    new Script(`(function () {
      var p = globalThis.__play, g = globalThis;
      function ev(key) { return { key: key === " " ? " " : key, code: key === " " ? "Space" : key, preventDefault: function () {}, target: document }; }
      function run(n, e) { if (typeof g[n] === "function") g.__run ? g.__run(g[n], e) : (e ? g[n](e) : g[n]()); }
      function fp() { try { return JSON.stringify(g.S); } catch (e) { return ""; } }
      // the first unit after which S holds a number that is not finite: the one that made it, not one whose text happens to name the same key
      function bad() {
        var out = [];
        (function w(v, path) {
          if (typeof v === "number") { if (!isFinite(v)) out.push(path); return; }
          if (v && typeof v === "object" && out.length < 3) { var i = 0; for (var k in v) { if (i++ > 40) break; w(v[k], path + "." + k); } }
        })(g.S, "S");
        return out;
      }
      globalThis.__nan = null;
      function watch(n) {
        if (globalThis.__nan) return;
        var b = bad();
        if (b.length) globalThis.__nan = { unit: typeof n === "string" ? n : null, path: b[0] };
      }
      g.render ? g.render() : 0;
      watch(null);
      // A control is followed by a short run of the page's own clock, so a control that
      // STARTS the program (a start button) is exercised while the program plays. Without
      // this, pressing every control first (start, then the restart or end control) left
      // the page in its terminal state, and the ticks that ran afterwards did nothing —
      // so the page's real playing was never run and its errors were never seen.
      function few() { for (var k = 0; k < 10; k++) p.ticks.forEach(function (n) { run(n); watch(n); }); }
      var s0 = fp();
      // a click or input event carries the target such an event has in a browser: an element that holds nothing (its value cannot be
      // known here, and an input event with an empty value is what a cleared field gives). A handler that reads e.target is exercised,
      // not crashed for a missing event part that no browser omits.
      p.clicks.forEach(function (n) { run(n, { preventDefault: function () {}, target: { value: "", checked: false, id: "", textContent: "" } }); watch(n); few(); });
      var s1 = fp();
      p.down.forEach(function (d) { run(d[0], ev(d[1])); watch(d[0]); few(); });
      for (var i = 0; i < 200; i++) { p.ticks.forEach(function (n) { run(n); watch(n); }); if (i % 20 === 0 && g.render) g.render(); }
      p.up.forEach(function (d) { run(d[0], ev(d[1])); watch(d[0]); });
      if (g.render) g.render();
      watch(null);
      globalThis.__fingerprint = { before: s0, afterClicks: s1, after: fp() };
    })()`).runInContext(ctx, { timeout: 3000 });
    let clicksChanged = false, keysChanged = false;
    try {
      const fpInfo = JSON.parse(String(new Script("JSON.stringify(globalThis.__fingerprint)").runInContext(ctx, { timeout: 500 }))) as { before?: string; afterClicks?: string; after?: string };
      // a control "changed something" against the state as it stood before the controls ran — never against the end state (which the ticks keep moving)
      clicksChanged = fpInfo.afterClicks !== undefined && fpInfo.before !== undefined && fpInfo.afterClicks !== fpInfo.before;
      keysChanged = fpInfo.after !== undefined && fpInfo.afterClicks !== undefined && fpInfo.after !== fpInfo.afterClicks;
    } catch { /* no fingerprint: the honest answer is "unknown", reported as false with no claim made */ }
    // a number of S that is NaN or infinite has been calculated from something that was not a number: the path, and the unit that first made it
    let nanInfo: { unit?: string | null; path?: string } | null = null;
    try { nanInfo = JSON.parse(String(new Script("JSON.stringify(globalThis.__nan)").runInContext(ctx, { timeout: 500 }))) as { unit?: string | null; path?: string } | null; } catch { /* no watch */ }
    if (nanInfo?.path) {
      errors.push({ unit: nanInfo.unit && units.includes(nanInfo.unit) ? nanInfo.unit : null, message: `${nanInfo.path} is not a number any more`, nan: nanInfo.path });
    } else {
      const bad = String(new Script(`(function () { var out = []; (function w(v, p) { if (typeof v === "number") { if (!isFinite(v)) out.push(p); } else if (v && typeof v === "object" && out.length < 3) { var i = 0; for (var k in v) { if (i++ > 40) break; w(v[k], p + "." + k); } } })(globalThis.S, "S"); return out.join(" "); })()`).runInContext(ctx, { timeout: 500 }));
      for (const p of bad ? bad.split(" ") : []) errors.push({ unit: null, message: `${p} is not a number any more`, nan: p });
    }
    // errors the page reported through console.error, read back as plain strings and
    // attributed to a unit by the stack the VM kept
    const reported = JSON.parse(String(new Script("JSON.stringify(globalThis.__errors)").runInContext(ctx, { timeout: 500 }))) as { message: string; stack: string }[];
    for (const r of reported) note({ message: r.message, stack: r.stack });
    return { errors, clicksChanged, keysChanged };
  } catch (e) { note(e); return { errors, clicksChanged: false, keysChanged: false }; }
}
