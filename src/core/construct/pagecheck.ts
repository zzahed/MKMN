/**
 * The page, checked where there is no window. The desktop build loads the page in a
 * hidden window and measures the screen; the sidecar has no window, so the page's
 * program is played in an isolated context instead (sandbox.ts: loaded, drawn, buttons
 * pressed, keys pressed, the clock ticking, the page replaced by stand-ins), after the
 * files it links are put in (bundle.ts) exactly as the preview would.
 *
 * What this checker can honestly say:
 * - ran "syntax": the script does not parse (or a bare script's page could not be found);
 * - ran "page":   the program RAN — errors it threw or reported through console.error
 *                 come back with the unit (function) they happened in, and state numbers
 *                 that went NaN or infinite are named;
 * - ran "none":   nothing ran (a page without a script).
 *
 * With the probe on, it also says whether the buttons and the keys actually changed
 * anything in the state S — the stand-in for the desktop's inert-control probe, which
 * compares the screen.
 *
 * The scenarios (the page's own tests, from its x-construct mark) are judged here
 * too, headlessly: the optional `scenarios` argument is played and measured against
 * the page, and `scenarios` in the report carries one verdict each, the same list
 * the desktop window check produces. What this build can honestly say about
 * scenarios stays what only a window can: nothing about how they LOOK — a scene
 * about the screen is judged as far as the ops the 2D context recorded go.
 * Unverified is never passed: the caller treats a missing list as unverified.
 */
import { bundleHtml, pageLinking, type FileLike } from "../bundle";
import { inlineScripts, isJs, jsSyntaxError } from "../codecheck";
import { playPageRun } from "./sandbox";
import { judgeScenes } from "./scene";
import type { Scenario } from "./scenarios";

export interface SandboxPageReport {
  ran: "page" | "syntax" | "none";
  errors: string[];
  notes: string[];
  /** How many handlers the page wires to ticks, keys and clicks (0 = nothing on the page can react); absent when the page never ran. */
  wired?: number;
  scenarios?: { text: string; ok: boolean; detail: string }[];
}

/** The play events derived from a page's own wiring: this engine's assembled pages (assemble.ts) are read exactly; hand-written pages get their on-attributes read too. */
export function derivePlayEvents(html: string, script: string): { ticks: string[]; down: { name: string; key: string }[]; up: { name: string; key: string }[]; clicks: string[] } {
  const ticks = [...new Set([...script.matchAll(/setInterval\(function \(\) \{ __run\(([\w$]+)\); __go\(\); \}, \d+\)/g)].map((m) => m[1]))];
  const clicks = [
    ...new Set([
      // this engine's wiring: el.addEventListener("click", function (e) { [e.preventDefault(); ]__run(name, e); ... })
      ...[...script.matchAll(/el\.addEventListener\("(?:click|input|change|submit)", function \(e\) \{ (?:e\.preventDefault\(\); )?__run\(([\w$]+), e\);/g)].map((m) => m[1]),
      // a hand-written button: <button onclick="start()"> / onsubmit="send()"
      ...[...html.matchAll(/\bon(?:click|submit|change|input)\s*=\s*["']([\w$]+)\(/g)].map((m) => m[1])
    ])
  ];
  const down: { name: string; key: string }[] = [], up: { name: string; key: string }[] = [];
  for (const m of script.matchAll(/document\.addEventListener\("(keydown|keyup)", function \(e\) \{ if \(([\s\S]*?)\) \{ e\.preventDefault\(\); __run\(([\w$]+), e\);/g)) {
    // the key the wiring tests: the space test (e.key === " " || e.code === "Space") is the engine's convention for "Space"; a hand-written page's e.key literal stands for itself
    const lit = /e\.code === "Space"/.test(m[2]) ? null : /e\.key === ("(?:[^"\\]|\\.)*")/.exec(m[2])?.[1];
    let key: string | null;
    try { key = lit !== undefined && lit !== null ? JSON.parse(lit) as string : (/e\.code === "Space"/.test(m[2]) ? "Space" : null); } catch { key = null; }
    if (!key) continue;
    (m[1] === "keydown" ? down : up).push({ name: m[3], key });
  }
  // a bare addEventListener("keydown", name) on a hand-written page: the key is the handler's own business
  for (const m of script.matchAll(/document\.addEventListener\("keydown",\s*([\w$]+)\)/g)) down.push({ name: m[1], key: "a" });
  return { ticks, down, up, clicks };
}

/** The function names of a page's script, so a runtime error can be blamed on its unit. */
const unitNames = (script: string): string[] => [
  ...new Set([
    ...[...script.matchAll(/\/\* unit:([\w$]+) \*\//g)].map((m) => m[1]),
    ...[...script.matchAll(/function\s+([\w$]+)\s*\(/g)].map((m) => m[1])
  ])
];

/**
 * One artifact, run as far as a windowless build can — the same dispatch as the desktop's
 * checkArtifact (runcheck.ts): a page is played; a script or a stylesheet through the page
 * that links it; a kind nothing runs here (python, data, …) gets "none", never a pretend
 * pass. The shape checks that need no run (quickErrors) are the CALLER's to add: they are
 * cheap and some callers have already run them.
 */
export async function checkArtifactWithoutWindow(a: { title?: string; kind?: string; language?: string; content: string }, files: FileLike[], scenarios?: Scenario[]): Promise<SandboxPageReport> {
  const title = a.title ?? "file";
  if (a.kind === "html") return checkPageWithoutWindow({ title, kind: "html", language: "", content: a.content }, files, scenarios);
  if (a.kind === "code" && isJs(a.language ?? "")) {
    const e = jsSyntaxError(a.content);
    const p = pageLinking({ title, kind: "code", language: a.language ?? "", content: a.content }, files);
    if (e || !p) return { ran: "syntax", errors: e ? [e] : [], notes: [] };
    return checkPageWithoutWindow(p, files, scenarios);
  }
  if (a.kind === "code" && /^css$/i.test(a.language ?? "")) {
    const p = pageLinking({ title, kind: "code", language: "css", content: a.content }, files);
    return p ? checkPageWithoutWindow(p, files, scenarios) : { ran: "none", errors: [], notes: [] };
  }
  return { ran: "none", errors: [], notes: [] };
}

/**
 * One file, run as far as this build can: a page (or a stylesheet/script through the page
 * that links it) is bundled, its script is parsed, and the program is played. The report
 * has the same shape as the desktop's CheckReport minus what only a window can produce.
 */
export async function checkPageWithoutWindow(page: FileLike, files: FileLike[], scenarios?: Scenario[]): Promise<SandboxPageReport> {
  const b = bundleHtml(page.content, files.filter((f) => f !== page));
  const missing = b.missing.map((n) => `${page.title} links ${n}, but no file with that name was written.`);
  // this engine escapes "</script" inside its units; the page as a browser sees it has it back
  const script = inlineScripts(b.html).map((s) => s.code.replace(/<\\\/script/gi, "</script")).join("\n;\n");
  if (!script.trim()) return { ran: "none", errors: missing, notes: [] };
  const syntax = jsSyntaxError(script);
  if (syntax) {
    const rep = { ran: "syntax" as const, errors: [...missing, syntax], notes: [] as string[] };
    return rep;
  }
  const events = derivePlayEvents(b.html, script);
  const run = await playPageRun({ script, ticks: events.ticks, down: events.down, up: events.up, clicks: events.clicks }, unitNames(script));
  const errors = [...missing, ...run.errors.map((e) => `${e.unit ? `${e.unit}: ` : ""}${e.message}`)];
  const notes: string[] = [];
  const wired = events.clicks.length + events.down.length + events.up.length + events.ticks.length;
  if (wired && !errors.length && !run.clicksChanged && !run.keysChanged) {
    notes.push(`Its ${wired} control(s) ran and changed nothing in the state (what they draw cannot be seen without a window).`);
  }
  const report: SandboxPageReport = { ran: "page", errors, notes, wired };
  // the page's own tests, played headlessly against the same stand-ins the run used
  if (scenarios && scenarios.length) {
    const judged = await judgeScenes(page.content, scenarios);
    report.scenarios = judged.results;
  }
  return report;
}
