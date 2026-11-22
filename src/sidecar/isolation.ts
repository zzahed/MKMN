// The sidecar's runner for code a model wrote: every call is a fresh Node process with the
// permission model on (see src/core/isolate.ts). The process gets only what Node needs to
// start on Windows in its environment, never the sidecar's own variables.

import { spawn, spawnSync } from "child_process";
import * as path from "path";
import { IsolationUnsafeError, lockedNodeArgs, proveNetworkDenied, proveNetworkDeniedSync, readReply, type IsolatedOp, type IsolationRunner } from "../core/isolate";

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

/** How the runner proves the runtime blocks the network (injected by tests). */
export interface NetworkProbe { probe?: () => Promise<boolean>; probeSync?: () => boolean }

export function lockedNodeRunner(nodeExe = process.execPath, worker = path.join(__dirname, "isolateWorker.js"), readDirs = codeDirs(__dirname), net: NetworkProbe = {}): IsolationRunner {
  const args = lockedNodeArgs(readDirs, worker);
  const probe = net.probe ?? (() => proveNetworkDenied(nodeExe, readDirs));
  const probeSync = net.probeSync ?? (() => proveNetworkDeniedSync(nodeExe, readDirs));
  // Asked once per sidecar start, before the first generated code runs, then remembered.
  // There is no fallback: a runtime that cannot block the network runs no generated code.
  let verdict: boolean | null = null;
  let asking: Promise<boolean> | null = null;
  const safe = async (): Promise<boolean> => {
    if (verdict !== null) return verdict;
    asking ??= probe().catch(() => false).then((v) => (verdict ??= v));
    return asking;
  };
  const safeSync = (): boolean => {
    if (verdict === null) { try { verdict = probeSync(); } catch { verdict = false; } }
    return verdict;
  };
  return {
    async run(op: IsolatedOp, a: unknown[]): Promise<unknown> {
      if (!(await safe())) throw new IsolationUnsafeError();
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
      if (!safeSync()) throw new IsolationUnsafeError();
      const r = spawnSync(nodeExe, args, { windowsHide: true, env: bareEnv(), input: JSON.stringify({ op, args: a }), encoding: "utf8", timeout: LIMIT_MS, maxBuffer: 16 << 20 });
      if (r.error) throw r.error;
      return readReply(r.stdout ?? "", r.stderr ?? "", r.status);
    },
  };
}
