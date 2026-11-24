// The locked-down process that runs code a model wrote (see src/core/isolate.ts).
// Started with Node's permission model: it may read the app's own code and nothing
// else — no writing, no child processes, no workers, no addons, no network. It reads ONE
// JSON request on stdin, runs it with the in-process implementation, writes ONE JSON
// line on stdout and exits. It never installs a runner itself, so nothing nests.

import { runExamplesHere, smokeRunHere, playPageRunHere } from "../core/construct/sandbox";
import { judgeScenesHere } from "../core/construct/scene";
import { codeChecksHere } from "../core/labCode";
import { runCasesHere } from "../core/benchChecks";
import { replyPrefix, type IsolatedOp, type IsolatedReply } from "../core/isolate";
import * as fs from "fs";
import type { Check } from "../core/promptLab";

const OPS: Record<IsolatedOp, (...args: never[]) => unknown> = {
  runExamples: runExamplesHere,
  smokeRun: smokeRunHere,
  playPageRun: playPageRunHere,
  judgeScenes: judgeScenesHere,
  // the result map is keyed by the caller's check objects: send positions, the caller maps them back
  codeChecks: async (answer: string, checks: Check[]) => [...(await codeChecksHere(answer, checks)).entries()].map(([c, v]) => [checks.indexOf(c), v]),
  runCases: runCasesHere,
};

// The permission model does not cover other processes: process.kill (and the raw process._kill
// under it) would let an escape stop the sidecar or any other program of the person, and
// os.setPriority would let it slow them to a crawl. This process does neither, so all three are
// replaced, for good, before any generated code runs. The bindings they come from are closed by
// the permission model, so the originals cannot be fetched again; os is the one shared module
// object (getBuiltinModule, not an import wrapper), so every way of reaching it sees the refusal.
function refuseOtherProcesses(): never {
  throw Object.assign(new Error("Access to this API has been restricted: generated code may not act on other processes."), { code: "ERR_ACCESS_DENIED" });
}
const sealed = { value: refuseOtherProcesses, writable: false, configurable: false, enumerable: false };
for (const name of ["kill", "_kill"]) Object.defineProperty(process, name, sealed);
Object.defineProperty(process.getBuiltinModule("os"), "setPriority", sealed);

// An escape could print a reply of its own and exit, or rewrite the real one on its way out
// through process.stdout or the fs module. So the reply is written with functions taken here,
// before any generated code runs, straight to fd 1, and it starts with the request's nonce, which
// only this closure holds. The builtins it is made with are frozen (--frozen-intrinsics).
const writeSync = fs.writeSync;
const prefix = replyPrefix; // the compiled import is read at each call: a patched module would see the nonce
const toBytes = Buffer.from.bind(Buffer);
const exit = process.exit.bind(process);
let nonce = "";

function reply(r: IsolatedReply): void {
  // on a line of its own: what the code printed last may not end with one
  const bytes = toBytes(`\n${prefix(nonce)}${JSON.stringify(r).slice(1)}\n`, "utf8");
  for (let at = 0; at < bytes.length;) {
    try { at += writeSync(1, bytes, at, bytes.length - at); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e; }
  }
  exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  void (async () => {
    try {
      const request = JSON.parse(input) as { op: IsolatedOp; args: unknown[]; nonce?: unknown };
      nonce = typeof request.nonce === "string" ? request.nonce : "";
      const { op, args } = request;
      const fn = OPS[op];
      if (!fn) return reply({ ok: false, error: `unknown isolated operation ${op}` });
      // the arguments are what the parent sent as JSON for this operation
      reply({ ok: true, value: await (fn as (...a: unknown[]) => unknown)(...args) });
    } catch (e) {
      reply({ ok: false, error: (e as Error).message.split("\n")[0].slice(0, 300) });
    }
  })();
});
