import { spawnSync } from "child_process";
import * as os from "os";
import * as vm from "vm";
import { isolation } from "./isolate";

/** The result of checking one answer: 0 to 1, why, and `skip` when the check could not be run on this PC. */
export interface Check { score: number; note: string; skip?: string }

export const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
export const norm = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Share of the letters of a text that are plain English letters: 1 = all of them, 0 = none (an answer in another script). */
export function englishShare(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 1;
  return letters.filter((c) => /[A-Za-z]/.test(c)).length / letters.length;
}

/** The code of an answer: the first fenced block, or the whole text. */
export function codeOf(answer: string): string {
  const m = /```[\w+-]*\n([\s\S]*?)```/.exec(answer);
  if (m) return m[1];
  const open = /```[\w+-]*\n([\s\S]*)$/.exec(answer);
  return (open ? open[1] : answer).trim();
}

/** A JSON value in an answer: the whole text, a fenced block, or the first {...} / [...] found. */
export function jsonOf(answer: string): { value: unknown; clean: boolean } | null {
  const text = answer.trim();
  const tries: { s: string; clean: boolean }[] = [{ s: text, clean: true }];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fence) tries.push({ s: fence[1].trim(), clean: text.replace(fence[0], "").trim().length < 20 });
  const a = text.search(/[{[]/);
  const b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) tries.push({ s: text.slice(a, b + 1), clean: false });
  for (const t of tries) { try { return { value: JSON.parse(t.s), clean: t.clean }; } catch { /* next */ } }
  return null;
}

/** The last number in a text ("The answer is 8." gives 8). */
export function lastNumber(s: string): number | null {
  const m = s.replace(/(\d),(\d{3})/g, "$1$2").match(/-?\d+(?:\.\d+)?/g);
  return m ? parseFloat(m[m.length - 1]) : null;
}

/** Weighted yes/no checks: the score is the weight of those that hold. */
export function points(list: [boolean, number, string][]): Check {
  const total = list.reduce((a, [, w]) => a + w, 0);
  const got = list.reduce((a, [ok, w]) => a + (ok ? w : 0), 0);
  const missed = list.filter(([ok]) => !ok).map(([, , n]) => n);
  return { score: clamp(got / total), note: missed.length ? `missing: ${missed.join(", ")}` : "all good" };
}

export const exact = (ok: boolean, good: string, bad: string): Check => (ok ? { score: 1, note: good } : { score: 0, note: bad });

// ------------------------------------------------------------------ running what the model wrote

/** JavaScript the model wrote, made runnable in a bare context: no export / module syntax. */
const plainJs = (code: string) => code.replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "").replace(/^\s*module\.exports[^\n]*$/gm, "");

/** Runs a JavaScript function the model wrote against cases, in a bare context with a time limit. Each case is [expression, expected]. */
export function runCases(code: string, cases: [string, unknown][]): { passed: number; total: number; error?: string } {
  const iso = isolation();
  return iso ? (iso.runSync("runCases", [code, cases]) as { passed: number; total: number; error?: string }) : runCasesHere(code, cases);
}

/** runCases in this process. */
export function runCasesHere(code: string, cases: [string, unknown][]): { passed: number; total: number; error?: string } {
  let passed = 0;
  let error: string | undefined;
  const src = plainJs(code);
  for (const [expr, want] of cases) {
    try {
      const ctx = vm.createContext({});
      vm.runInContext(src, ctx, { timeout: 1000 });
      const got = vm.runInContext(`JSON.stringify(${expr})`, ctx, { timeout: 1000 });
      if (got === JSON.stringify(want)) passed++;
    } catch (e) {
      error = (e as Error).message.slice(0, 120);
      if (/timed out/i.test(error)) break; // a loop that never ends: the other cases would only wait as long
    }
  }
  return { passed, total: cases.length, error };
}

export function jsCheck(answer: string, cases: [string, unknown][]): Check {
  const r = runCases(codeOf(answer), cases);
  return { score: r.total ? r.passed / r.total : 0, note: `${r.passed}/${r.total} cases pass${r.error ? ` (${r.error})` : ""}` };
}

/** Only what Python needs to start on Windows: never the app's own variables. */
const pythonEnv = (): NodeJS.ProcessEnv => { const e: NodeJS.ProcessEnv = {}; for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]) if (process.env[k]) e[k] = process.env[k]; return e; };

let pythonCache: string | null | undefined;
/** The Python program of this PC, found once. */
export function findPython(): string | null {
  if (pythonCache !== undefined) return pythonCache;
  for (const cmd of process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]) {
    try { if (spawnSync(cmd, ["--version"], { timeout: 5000, windowsHide: true }).status === 0) return (pythonCache = cmd); } catch { /* next */ }
  }
  return (pythonCache = null);
}

/** Code that touches the system is not run: a benchmark must not let a model's code loose on the PC. */
const SYSTEM_ACCESS = /\b(import\s+(os|subprocess|shutil|socket|requests|urllib|pathlib|ctypes|http|ftplib|smtplib)\b|from\s+(os|subprocess|shutil|socket|pathlib|ctypes|urllib|http)\b)|__import__|\bopen\s*\(|\b(eval|exec|compile)\s*\(|\binput\s*\(/;

/**
 * Put before the model's Python: an audit hook (PEP 578, which Python code cannot remove)
 * that refuses what a benchmark answer never needs — starting programs, sockets, ctypes and
 * the Windows API modules, writing files, and reading or listing anything outside Python's
 * own install. The word list above stopped only code that SAID `import os`; getattr,
 * importlib or a name built from pieces walked past it. This is a guard inside the Python
 * process, not an operating-system boundary.
 */
export const PY_GUARD = `import sys as _s, os as _o
def _mkguard():
    roots = tuple({_o.path.join(_o.path.normcase(_o.path.realpath(p)), "") for p in (_s.prefix, _s.base_prefix, _s.exec_prefix, _s.base_exec_prefix) if p})
    def inside(path):
        p = _o.path.normcase(_o.path.realpath(path))
        return _o.path.join(p, "").startswith(roots)
    banned_ev = ("subprocess.", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.startfile", "os.kill",
                 "os.remove", "os.unlink", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.truncate", "os.link", "os.utime", "os.chown", "os.chflags",
                 "os.symlink", "os.putenv", "os.unsetenv", "os.chdir", "shutil.", "socket.", "ctypes.", "winreg.",
                 "_winapi.", "msvcrt.", "webbrowser.", "sqlite3.connect")
    banned_mod = {"ctypes", "_ctypes", "subprocess", "_winapi", "socket", "_socket", "winreg", "msvcrt", "multiprocessing",
                  "_posixsubprocess", "nt", "posix", "_overlapped", "asyncio", "ssl", "_ssl", "http", "urllib", "ftplib", "smtplib"}
    def guard(ev, args):
        if ev.startswith(banned_ev):
            raise PermissionError(ev + " is blocked")
        if ev == "import" and str(args[0]).split(".")[0] in banned_mod:
            raise PermissionError("import " + str(args[0]) + " is blocked")
        if ev in ("os.listdir", "os.scandir"):
            if not inside(str(args[0]) if args and args[0] is not None else "."):
                raise PermissionError(ev + " is blocked")
            return
        if ev == "open":
            path, mode = args[0], (args[1] if len(args) > 1 else "r")
            if isinstance(mode, str) and any(c in mode for c in "wax+"):
                raise PermissionError("writing files is blocked")
            # os.open raises the same event with mode None and the flags as a third argument
            flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
            if flags & (_o.O_WRONLY | _o.O_RDWR | _o.O_CREAT | _o.O_APPEND | _o.O_TRUNC):
                raise PermissionError("writing files is blocked")
            if not isinstance(path, int) and not inside(str(path)):
                raise PermissionError("reading files is blocked")
    return guard
_s.addaudithook(_mkguard())
del _mkguard
`;

/** Runs Python the model wrote against cases (one process for all of them). Each case is [expression, expected], compared as JSON. */
export function pythonCheck(answer: string, cases: [string, unknown][]): Check {
  const code = codeOf(answer);
  if (SYSTEM_ACCESS.test(code)) return { score: 0, note: "uses system access or input(), not run" };
  const py = findPython();
  if (!py) return { score: 0, note: "", skip: "Python is not installed on this PC" };
  const script = [
    PY_GUARD, code, "", "import json as __j",
    ...cases.map(([expr]) => `try:\n    print(__j.dumps(${expr}))\nexcept Exception as __e:\n    print("ERR " + type(__e).__name__)`)
  ].join("\n");
  const runOnce = () => spawnSync(py, py === "py" ? ["-3", "-I", "-c", script] : ["-I", "-c", script], { timeout: 8000, cwd: os.tmpdir(), encoding: "utf8", windowsHide: true, maxBuffer: 1 << 20, env: pythonEnv() });
  let r = runOnce();
  // timed out before printing a single line: Python was slow to start on a busy PC, not the code slow on its cases (a correct answer scored 0 on a loaded CI runner). One more try; code that hangs still scores 0.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" && !(r.stdout ?? "").trim()) r = runOnce();
  if (r.error) return { score: 0, note: `could not run: ${r.error.message.slice(0, 80)}` };
  const lines = (r.stdout ?? "").split(/\r?\n/);
  let passed = 0;
  cases.forEach(([, want], i) => { try { if (JSON.stringify(JSON.parse(lines[i] ?? "")) === JSON.stringify(want)) passed++; } catch { /* wrong or error */ } });
  const err = (r.stderr ?? "").trim().split("\n").pop()?.slice(0, 100);
  return { score: passed / cases.length, note: `${passed}/${cases.length} cases pass${passed < cases.length && err ? ` (${err})` : ""}` };
}

/** The regular expression an answer proposes: /.../flags, or the text of the first code span / block. */
export function regexOf(answer: string): RegExp | null {
  const lit = /\/((?:\\.|[^/\n\\])+)\/([gimsuy]*)/.exec(answer.replace(/```[\w]*\n?/g, ""));
  const raw = lit ? { src: lit[1], flags: lit[2] } : (() => { const c = /`([^`\n]+)`/.exec(answer); return c ? { src: c[1], flags: "" } : null; })();
  if (!raw) return null;
  try { return new RegExp(raw.src, raw.flags.replace(/g/g, "")); } catch { return null; }
}

// ------------------------------------------------------------------ static checks for markup

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "!doctype"]);
/** Every opened tag is closed in the right order (void tags excepted). */
export function htmlBalanced(html: string): boolean {
  const stack: string[] = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "<$1></$1>");
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*|!doctype)[^>]*?(\/?)>/g)) {
    const [, close, tag0, self] = m;
    const tag = tag0.toLowerCase();
    if (VOID.has(tag) || self) continue;
    if (!close) stack.push(tag);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0;
}

/** Braces match and every declaration inside a rule ends with a semicolon or the closing brace. */
export function cssWellFormed(css: string): boolean {
  const c = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  for (const ch of c) { if (ch === "{") depth++; else if (ch === "}") depth--; if (depth < 0) return false; }
  return depth === 0 && /[^{}]+\{[^{}]*:[^{}]*\}/.test(c);
}

/** Does the script in an HTML page parse? */
export function pageScriptParses(html: string): boolean | null {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
  if (!scripts.trim()) return null;
  try { new vm.Script(scripts); return true; } catch { return false; }
}
