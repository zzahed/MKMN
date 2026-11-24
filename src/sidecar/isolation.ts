// The sidecar's runner for code a model wrote: every call is a fresh Node process with the
// permission model on (see src/core/isolate.ts). The process gets only what Node needs to
// start on Windows in its environment (lockedEnv), never the sidecar's own variables.

import { execFile, spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import * as path from "path";
import { IsolationUnsafeError, lockedNodeArgs, plainPath, readReply, type IsolatedOp, type IsolationRunner } from "../core/isolate";

/** Long enough for a page played 200 ticks with its scenes; a runaway loop dies with its process. */
const LIMIT_MS = 60_000;
/** What the process may print on stdout or stderr: a script printing in a loop would otherwise
 *  grow the sidecar's memory without end. */
const MAX_OUTPUT = 16 << 20;
const FLOODED = "the isolated check printed more than 16 MiB and was stopped";

/** On Windows libuv copies these from the sidecar into a child whose environment lacks them, so
 *  leaving them out still told generated code the person's name and profile folder. Passed
 *  blank, they are left as they are. The locked process writes nothing and starts nothing, so it
 *  needs neither a temp folder nor PATH. */
const BLANKED = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "TEMP", "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE"];

/** The environment of every locked process (the checks and the probe alike): the Windows folder
 *  Node needs to start, and nothing that names the person or their files. */
export function lockedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of BLANKED) env[k] = "";
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** The app's compiled code (dist, or Runtime once installed) and the packages beside it: the
 *  only folders the locked-down process may read. Installed, node_modules sits inside Runtime;
 *  in a checkout it sits beside dist. Always plain paths (plainPath): the permission model does
 *  not match verbatim ones. */
export function codeDirs(sidecarDir: string): string[] {
  const code = path.resolve(plainPath(sidecarDir), "..");
  return [code, path.join(code, "node_modules"), path.resolve(code, "..", "node_modules")];
}

/**
 * What a locked process runs to prove, with the runner's own flags and environment, every
 * restriction generated code relies on. It stops at the first one the runtime lacks and prints:
 * - SQLITE_AVAILABLE: node:sqlite is still there (it writes files past the permission model);
 * - FS_WRITE_OPEN, CHILD_PROCESS_OPEN, WORKER_OPEN: that call worked (a written file is removed);
 * - FS_WRITE_UNKNOWN (and so on): it failed for another reason than the permission model;
 * - INTRINSICS_OPEN: the process's builtins are not frozen (--frozen-intrinsics), which the
 *   worker's reply relies on: an escape could bend the verdict and the reply it is sent in;
 * - and then, all of them denied, how one TCP connection ended. Nothing needs to listen: a
 *   runtime that enforces the ban answers ERR_ACCESS_DENIED before any packet is sent, and one
 *   that does not answers ECONNREFUSED (or CONNECTED).
 */
export const ISOLATION_PROBE = [
  `const p = process, fs = require("fs"), file = require("path").join(require("os").tmpdir(), "mkmn-isolation-probe-" + p.pid);`,
  `const tryIt = (f) => { try { f(); return "OPEN"; } catch (e) { return e && e.code === "ERR_ACCESS_DENIED" ? "" : "UNKNOWN"; } };`,
  `const checks = [`,
  `  ["FS_WRITE", () => fs.writeFileSync(file, "")],`,
  `  ["CHILD_PROCESS", () => require("child_process").execFileSync(p.execPath, ["-e", ""], { windowsHide: true, timeout: 5000 })],`,
  `  ["WORKER", () => new (require("worker_threads").Worker)("", { eval: true }).terminate()],`,
  `];`,
  `let out = p.getBuiltinModule("node:sqlite") ? "SQLITE_AVAILABLE" : "";`,
  `for (const [name, f] of checks) { if (out) break; const r = tryIt(f); if (r) out = name + "_" + r; }`,
  `if (!out && ![Object.prototype, Array.prototype, Function.prototype, JSON].every(Object.isFrozen)) out = "INTRINSICS_OPEN";`,
  `if (out) { try { fs.rmSync(file, { force: true }); } catch {} console.log(out); }`,
  `else { const s = require("net").connect(9, "127.0.0.1"); s.on("connect", () => { console.log("CONNECTED"); s.destroy(); }); s.on("error", (e) => console.log(e.code)); }`,
].join("\n");
const PROBE_MS = 10_000;
/**
 * What the probe printed. Only ERR_ACCESS_DENIED proves every restriction (true). CONNECTED, a
 * socket error code (ECONNREFUSED, EACCES...), SQLITE_AVAILABLE or an ..._OPEN proves the runtime
 * unsafe (false). No output, a ..._UNKNOWN, a timeout, a crash or anything else cannot tell
 * (null): never taken as proof, and asked again next run.
 */
export function probeVerdict(stdout: unknown): boolean | null {
  const out = String(stdout ?? "").trim();
  if (out === "ERR_ACCESS_DENIED") return true;
  if (/^(?:CONNECTED|SQLITE_AVAILABLE|INTRINSICS_OPEN|(?:FS_WRITE|CHILD_PROCESS|WORKER)_OPEN|E(?!RR_)[A-Z0-9]+)$/.test(out)) return false;
  return null;
}

/** Whether `nodePath`, started with the same locked flags and environment as the isolated checks,
 *  really enforces them (ISOLATION_PROBE, probeVerdict): true runs generated code, false and null
 *  refuse it. The name predates the file, process and worker checks. */
export function proveNetworkDenied(nodePath: string, readDirs: string[]): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(nodePath, [...lockedNodeArgs(readDirs, "-e"), ISOLATION_PROBE], { windowsHide: true, timeout: PROBE_MS, env: lockedEnv() }, (error, stdout) => resolve(error ? null : probeVerdict(stdout)));
  });
}

/** proveNetworkDenied for a synchronous first run. */
export function proveNetworkDeniedSync(nodePath: string, readDirs: string[]): boolean | null {
  const r = spawnSync(nodePath, [...lockedNodeArgs(readDirs, "-e"), ISOLATION_PROBE], { windowsHide: true, timeout: PROBE_MS, encoding: "utf8", env: lockedEnv() });
  return r.error || r.status !== 0 ? null : probeVerdict(r.stdout);
}

/** How the runner proves the runtime blocks the network (injected by tests). */
export interface NetworkProbe { probe?: () => Promise<boolean | null>; probeSync?: () => boolean | null }

/** One request to a fresh locked worker process: its reply's value, or the error it stopped with. */
function runLocked(nodeExe: string, args: string[], op: IsolatedOp, a: unknown[]): Promise<unknown> {
  const nonce = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, args, { windowsHide: true, env: lockedEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", flooded = false;
    const timer = setTimeout(() => { child.kill(); }, LIMIT_MS);
    // what the process may print, on each stream, before it is stopped (as runLockedSync's maxBuffer)
    const take = (d: Buffer | string, add: (s: string) => number) => {
      if (!flooded && add(String(d)) > MAX_OUTPUT) { flooded = true; child.kill(); }
    };
    child.stdout.on("data", (d) => take(d, (s) => (out += s).length));
    child.stderr.on("data", (d) => take(d, (s) => (err += s).length));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (flooded) return reject(new Error(FLOODED));
      try { resolve(readReply(out, err, code, nonce)); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({ op, args: a, nonce }));
  });
}

/** runLocked for a synchronous caller. */
function runLockedSync(nodeExe: string, args: string[], op: IsolatedOp, a: unknown[]): unknown {
  const nonce = randomBytes(16).toString("hex");
  const r = spawnSync(nodeExe, args, { windowsHide: true, env: lockedEnv(), input: JSON.stringify({ op, args: a, nonce }), encoding: "utf8", timeout: LIMIT_MS, maxBuffer: MAX_OUTPUT });
  if (r.error) throw (r.error as NodeJS.ErrnoException).code === "ENOBUFS" ? new Error(FLOODED) : r.error;
  return readReply(r.stdout ?? "", r.stderr ?? "", r.status, nonce);
}

/** The smallest real request: a function with no examples. The probe runs with -e and never loads
 *  the worker, so a worker that cannot start under the locked flags (its code outside the read
 *  rules) passed it and then failed every check; this proves the worker answers. */
const WORKER_CHECK: [IsolatedOp, unknown[]] = ["runExamples", [[], "function f() {}", []]];
const problemOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function lockedNodeRunner(nodeExe = plainPath(process.execPath), worker = plainPath(path.join(__dirname, "isolateWorker.js")), readDirs = codeDirs(__dirname), net: NetworkProbe = {}): IsolationRunner {
  const args = lockedNodeArgs(readDirs, worker);
  const networkProbe = net.probe ?? (() => proveNetworkDenied(nodeExe, readDirs));
  const networkProbeSync = net.probeSync ?? (() => proveNetworkDeniedSync(nodeExe, readDirs));
  // A runtime proven safe is only used once the worker itself has answered under the same flags.
  // A worker that did not start is "could not tell" (null): refused with what it said, asked again.
  let workerProblem: string | null = null;
  const probe = async (): Promise<boolean | null> => {
    workerProblem = null;
    const v = await networkProbe();
    if (v !== true) return v;
    try { await runLocked(nodeExe, args, ...WORKER_CHECK); } catch (e) { workerProblem = problemOf(e); return null; }
    return true;
  };
  const probeSync = (): boolean | null => {
    workerProblem = null;
    const v = networkProbeSync();
    if (v !== true) return v;
    try { runLockedSync(nodeExe, args, ...WORKER_CHECK); } catch (e) { workerProblem = problemOf(e); return null; }
    return true;
  };
  const refusal = (proven: boolean | null) => new IsolationUnsafeError(proven === null, proven === null ? workerProblem ?? undefined : undefined);
  // Asked before the first generated code runs; a definite answer (proven blocked, proven open)
  // is remembered for the sidecar's life. "Could not tell" (no output, a timeout, a probe that
  // threw) refuses that run and is asked again next time: a slow first start under load is not
  // kept as "unsafe" for the session. There is no fallback: only a proof runs generated code.
  let verdict: boolean | null = null;
  let asking: Promise<boolean | null> | null = null;
  const safe = async (): Promise<boolean | null> => {
    if (verdict !== null) return verdict;
    asking ??= probe().catch(() => null).then((v) => {
      asking = null;
      if (v !== null) verdict ??= v;
      return verdict ?? v;
    });
    return asking;
  };
  const safeSync = (): boolean | null => {
    if (verdict !== null) return verdict;
    let v: boolean | null;
    try { v = probeSync(); } catch { v = null; }
    if (v !== null) verdict = v;
    return v;
  };
  return {
    async run(op: IsolatedOp, a: unknown[]): Promise<unknown> {
      const proven = await safe();
      if (proven !== true) throw refusal(proven);
      return runLocked(nodeExe, args, op, a);
    },
    runSync(op: IsolatedOp, a: unknown[]): unknown {
      const proven = safeSync();
      if (proven !== true) throw refusal(proven);
      return runLockedSync(nodeExe, args, op, a);
    },
  };
}
