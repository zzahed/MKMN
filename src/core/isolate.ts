// Where code a model wrote is run.
//
// The checks that RUN generated JavaScript (a unit's examples, its smoke run, playing the
// page, the page's scenes, the prompt lab's code checks, the benchmark's cases) used
// `node:vm` inside the sidecar itself. Node says plainly that vm is not a security
// boundary: an escape would have had the sidecar's rights (the person's files, the
// network, child processes). The sidecar now installs a runner that does each of these
// in a separate, one-shot Node process started with the permission model on: it may
// read the app's own code and nothing else — no writing, no child processes, no workers,
// no addons, no network. Without a runner (the tests, the browser preview) they run in
// place, exactly as before.

import { execFile, spawnSync } from "child_process";

export type IsolatedOp = "runExamples" | "smokeRun" | "playPageRun" | "judgeScenes" | "codeChecks" | "runCases";

export interface IsolationRunner {
  run(op: IsolatedOp, args: unknown[]): Promise<unknown>;
  runSync(op: IsolatedOp, args: unknown[]): unknown;
}

let current: IsolationRunner | null = null;

export function setIsolation(r: IsolationRunner | null): void { current = r; }
export function isolation(): IsolationRunner | null { return current; }

/** The arguments of a locked-down Node process that may only read `readDirs` (the app's
 *  own code and the packages it loads): no write, child process, worker, addon or network flag. */
export function lockedNodeArgs(readDirs: string[], script: string): string[] {
  return ["--permission", ...readDirs.map((d) => `--allow-fs-read=${d}`), script];
}

/** Raised instead of running generated code on a Node.js that does not enforce the network ban. */
export class IsolationUnsafeError extends Error {
  constructor() {
    super("Generated code is turned off: this Node.js runtime cannot block network access.");
    this.name = "IsolationUnsafeError";
  }
}

/** A locked process tries one TCP connection and prints how it ended. Nothing needs to listen:
 *  a runtime that enforces the ban answers ERR_ACCESS_DENIED before any packet is sent, and one
 *  that does not answers ECONNREFUSED (or CONNECTED). */
const PROBE = `const s = require("net").connect(9, "127.0.0.1"); s.on("connect", () => { console.log("CONNECTED"); s.destroy(); }); s.on("error", (e) => console.log(e.code));`;
const PROBE_MS = 10_000;
/** Only this answer proves the ban: no output, a timeout or a crash is never taken as proof. */
const denied = (stdout: unknown): boolean => String(stdout ?? "").trim() === "ERR_ACCESS_DENIED";

/** Whether `nodePath`, started with the same locked flags as the isolated checks, really blocks
 *  network access. Asked once before the first isolated run; false refuses generated code. */
export function proveNetworkDenied(nodePath: string, readDirs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(nodePath, [...lockedNodeArgs(readDirs, "-e"), PROBE], { windowsHide: true, timeout: PROBE_MS, env: {} }, (_e, stdout) => resolve(denied(stdout)));
  });
}

/** proveNetworkDenied for a synchronous first run. */
export function proveNetworkDeniedSync(nodePath: string, readDirs: string[]): boolean {
  const r = spawnSync(nodePath, [...lockedNodeArgs(readDirs, "-e"), PROBE], { windowsHide: true, timeout: PROBE_MS, encoding: "utf8", env: {} });
  return !r.error && denied(r.stdout);
}

/** What crosses the process boundary: one JSON line in, one JSON line out. */
export interface IsolatedReply { ok: boolean; value?: unknown; error?: string }

export function readReply(stdout: string, stderr: string, status: number | null): unknown {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  let r: IsolatedReply;
  try { r = JSON.parse(line) as IsolatedReply; }
  catch { throw new Error(`the isolated check stopped${status !== null ? ` (exit ${status})` : ""}: ${(stderr || stdout).trim().split("\n").pop()?.slice(0, 200) ?? "no output"}`); }
  if (!r.ok) throw new Error(r.error ?? "the isolated check failed");
  return r.value;
}
