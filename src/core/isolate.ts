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

/** Raised instead of running generated code on a Node.js that does not enforce the network ban,
 *  or, with `unconfirmed`, when the check could not tell this time (it is asked again next run). */
export class IsolationUnsafeError extends Error {
  constructor(unconfirmed = false) {
    super(unconfirmed
      ? "Generated code is paused: MKMN could not confirm that this Node.js runtime blocks network access. It checks again on the next run."
      : "Generated code is turned off: this Node.js runtime cannot block network access.");
    this.name = "IsolationUnsafeError";
  }
}

/** What crosses the process boundary: one JSON line in, one JSON line out. */
export interface IsolatedReply { ok: boolean; value?: unknown; error?: string }

export function readReply(stdout: string, stderr: string, status: number | null): unknown {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  let r: IsolatedReply;
  try { r = JSON.parse(line) as IsolatedReply; }
  catch {
    // the last line of what the process said (stderr first); "" when it said nothing at all
    const last = (stderr.trim() || stdout.trim()).split("\n").pop()!.slice(0, 200);
    throw new Error(`the isolated check stopped${status !== null ? ` (exit ${status})` : ""}: ${last || "no output"}`);
  }
  if (!r.ok) throw new Error(r.error ?? "the isolated check failed");
  return r.value;
}
