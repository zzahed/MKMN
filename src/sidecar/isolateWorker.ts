// The locked-down process that runs code a model wrote (see src/core/isolate.ts).
// Started with Node's permission model: it may read the app's own code and nothing
// else — no writing, no child processes, no workers, no addons, no network. It reads ONE
// JSON request on stdin, runs it with the in-process implementation, writes ONE JSON
// line on stdout and exits. It never installs a runner itself, so nothing nests.

import { runExamplesHere, smokeRunHere, playPageRunHere } from "../core/construct/sandbox";
import { judgeScenesHere } from "../core/construct/scene";
import { codeChecksHere } from "../core/labCode";
import { runCasesHere } from "../core/benchChecks";
import type { IsolatedOp, IsolatedReply } from "../core/isolate";
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

// The permission model does not cover signals: process.kill (and the raw process._kill under it)
// would let an escape stop the sidecar or any other program of the person. This process never
// signals anything, so both are replaced, for good, before any generated code runs. The binding
// they come from is closed by the permission model, so the originals cannot be fetched again.
function refuseSignal(): never {
  throw Object.assign(new Error("Access to this API has been restricted: generated code may not signal other processes."), { code: "ERR_ACCESS_DENIED" });
}
for (const name of ["kill", "_kill"]) {
  Object.defineProperty(process, name, { value: refuseSignal, writable: false, configurable: false, enumerable: false });
}

function reply(r: IsolatedReply): void {
  process.stdout.write(`${JSON.stringify(r)}\n`, () => process.exit(0));
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  void (async () => {
    try {
      const { op, args } = JSON.parse(input) as { op: IsolatedOp; args: unknown[] };
      const fn = OPS[op];
      if (!fn) return reply({ ok: false, error: `unknown isolated operation ${op}` });
      // the arguments are what the parent sent as JSON for this operation
      reply({ ok: true, value: await (fn as (...a: unknown[]) => unknown)(...args) });
    } catch (e) {
      reply({ ok: false, error: (e as Error).message.split("\n")[0].slice(0, 300) });
    }
  })();
});
