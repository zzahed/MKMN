// The sidecar's runner for code a model wrote: every call is a fresh Node process with the
// permission model on (see src/core/isolate.ts). The process gets only what Node needs to
// start on Windows in its environment, never the sidecar's own variables.

import { execFile, spawn, spawnSync } from "child_process";
import * as path from "path";
import { IsolationUnsafeError, lockedNodeArgs, readReply, type IsolatedOp, type IsolationRunner } from "../core/isolate";

/** Long enough for a page played 200 ticks with its scenes; a runaway loop dies with its process. */
const LIMIT_MS = 60_000;

function bareEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** The app's compiled code (dist, or Runtime once installed) and the packages beside it: the
 *  only folders the locked-down process may read. Installed, node_modules sits inside Runtime;
 *  in a checkout it sits beside dist. */
export function codeDirs(sidecarDir: string): string[] {
  const code = path.resolve(sidecarDir, "..");
  return [code, path.join(code, "node_modules"), path.resolve(code, "..", "node_modules")];
}

/** A locked process tries one TCP connection and prints how it ended. Nothing needs to listen:
 *  a runtime that enforces the ban answers ERR_ACCESS_DENIED before any packet is sent, and one
 *  that does not answers ECONNREFUSED (or CONNECTED). */
const PROBE = `const s = require("net").connect(9, "127.0.0.1"); s.on("connect", () => { console.log("CONNECTED"); s.destroy(); }); s.on("error", (e) => console.log(e.code));`;
const PROBE_MS = 10_000;
/**
 * What the probe printed. Only ERR_ACCESS_DENIED proves the ban (true). CONNECTED or a socket
 * error code (ECONNREFUSED, EACCES...) proves the network open (false). No output, a timeout, a
 * crash or anything else cannot tell (null): never taken as proof, and asked again next run.
 */
export function probeVerdict(stdout: unknown): boolean | null {
  const out = String(stdout ?? "").trim();
  if (out === "ERR_ACCESS_DENIED") return true;
  if (/^(?:CONNECTED|E(?!RR_)[A-Z0-9]+)$/.test(out)) return false;
  return null;
}

/** Whether `nodePath`, started with the same locked flags as the isolated checks, really blocks
 *  network access (probeVerdict): true runs generated code, false and null refuse it. */
export function proveNetworkDenied(nodePath: string, readDirs: string[]): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(nodePath, [...lockedNodeArgs(readDirs, "-e"), PROBE], { windowsHide: true, timeout: PROBE_MS, env: {} }, (error, stdout) => resolve(error ? null : probeVerdict(stdout)));
  });
}

/** proveNetworkDenied for a synchronous first run. */
export function proveNetworkDeniedSync(nodePath: string, readDirs: string[]): boolean | null {
  const r = spawnSync(nodePath, [...lockedNodeArgs(readDirs, "-e"), PROBE], { windowsHide: true, timeout: PROBE_MS, encoding: "utf8", env: {} });
  return r.error || r.status !== 0 ? null : probeVerdict(r.stdout);
}

/** How the runner proves the runtime blocks the network (injected by tests). */
export interface NetworkProbe { probe?: () => Promise<boolean | null>; probeSync?: () => boolean | null }

export function lockedNodeRunner(nodeExe = process.execPath, worker = path.join(__dirname, "isolateWorker.js"), readDirs = codeDirs(__dirname), net: NetworkProbe = {}): IsolationRunner {
  const args = lockedNodeArgs(readDirs, worker);
  const probe = net.probe ?? (() => proveNetworkDenied(nodeExe, readDirs));
  const probeSync = net.probeSync ?? (() => proveNetworkDeniedSync(nodeExe, readDirs));
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
      if (proven !== true) throw new IsolationUnsafeError(proven === null);
      return new Promise((resolve, reject) => {
        const child = spawn(nodeExe, args, { windowsHide: true, env: bareEnv(), stdio: ["pipe", "pipe", "pipe"] });
        let out = "", err = "";
        const timer = setTimeout(() => { child.kill(); }, LIMIT_MS);
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          try { resolve(readReply(out, err, code)); } catch (e) { reject(e); }
        });
        child.stdin.end(JSON.stringify({ op, args: a }));
      });
    },
    runSync(op: IsolatedOp, a: unknown[]): unknown {
      const proven = safeSync();
      if (proven !== true) throw new IsolationUnsafeError(proven === null);
      const r = spawnSync(nodeExe, args, { windowsHide: true, env: bareEnv(), input: JSON.stringify({ op, args: a }), encoding: "utf8", timeout: LIMIT_MS, maxBuffer: 16 << 20 });
      if (r.error) throw r.error;
      return readReply(r.stdout ?? "", r.stderr ?? "", r.status);
    },
  };
}
