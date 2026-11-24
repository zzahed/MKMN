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
 *  own code and the packages it loads): no write, child process, worker, addon or network flag.
 *  node:sqlite is switched off: it opens, attaches and writes database files past the permission
 *  model's file-system rules (Node 26), so any SQLite file the person owns could be read and a
 *  file written anywhere they can write. The process's own builtins (Object, Array, JSON...) are
 *  frozen: an escape reaches them, and bending them would bend the verdict the worker computes
 *  and the reply it sends. The contexts generated code runs in keep builtins of their own, which
 *  it may change as before. That freeze is experimental in Node, so its warning is not printed. */
export function lockedNodeArgs(readDirs: string[], script: string): string[] {
  return ["--permission", "--no-experimental-sqlite", "--frozen-intrinsics", "--disable-warning=ExperimentalWarning", ...readDirs.map((d) => `--allow-fs-read=${d}`), script];
}

/** Raised instead of running generated code on a Node.js that does not enforce the network ban,
 *  or, with `unconfirmed`, when the check could not tell this time (it is asked again next run). */
export class IsolationUnsafeError extends Error {
  constructor(unconfirmed = false) {
    super(unconfirmed
      ? "Generated code is paused: MKMN could not confirm that this Node.js runtime blocks network access. It checks again on the next run."
      : "Generated code is turned off: this Node.js runtime cannot keep it away from the network and your files.");
    this.name = "IsolationUnsafeError";
  }
}

/** What crosses the process boundary: one JSON line in, one JSON line out. The request carries a
 *  random `nonce` and the worker's reply starts with it; code the worker runs never learns it. */
export interface IsolatedReply { nonce?: string; ok: boolean; value?: unknown; error?: string }

/** The start of the one reply line the worker writes for `nonce` (both sides build it the same way). */
export function replyPrefix(nonce: string): string { return `{"nonce":${JSON.stringify(nonce)},`; }

/** The worker's reply. With a `nonce`, only a line that starts with it counts, and exactly one
 *  must: whatever generated code printed (a reply of its own included) is ignored. Without one,
 *  the last line, as before. */
export function readReply(stdout: string, stderr: string, status: number | null, nonce?: string): unknown {
  const lines = stdout.trim().split(/\r?\n/);
  const mine = nonce === undefined ? lines.slice(-1) : lines.filter((l) => l.startsWith(replyPrefix(nonce)));
  const line = mine.length === 1 ? mine[0] : "";
  let r: IsolatedReply;
  try {
    r = JSON.parse(line) as IsolatedReply;
    if (nonce !== undefined && r.nonce !== nonce) throw new Error("not the worker's reply");
  } catch {
    // the last line of what the process said (stderr first); "" when it said nothing at all
    const last = (stderr.trim() || stdout.trim()).split("\n").pop()!.slice(0, 200);
    throw new Error(`the isolated check stopped${status !== null ? ` (exit ${status})` : ""}: ${last || "no output"}`);
  }
  if (!r.ok) throw new Error(r.error ?? "the isolated check failed");
  return r.value;
}
