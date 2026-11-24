import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRun, type StepDef, type SettledStep } from "../src/core/harness/run";
import { appendEntry, journalKeyFile, journalPath, readJournal, resumeReplay, settledSteps, useJournalKeyFile } from "../src/core/harness/journal";
import { mkmnPaths } from "../src/shared/paths";
import { sArray, sNumber, sObject, sString } from "../src/core/harness/schema";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mkmn-harness-run-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string): string {
  return path.join(dir, name);
}

describe("the harness run and its journal", () => {
  it("executes one step at a time, journals each, and ends done when every step settles ok", async () => {
    const ran: string[] = [];
    const defs: StepDef<unknown, unknown>[] = [
      {
        id: "plan",
        kind: "model-call",
        input: "make a snake",
        schema: sObject("plan", { title: sString() }),
        exec: (input) => {
          ran.push(`plan:${String(input)}`);
          return { output: { title: "Snake" }, reply: '{"title":"Snake"}', promptSections: [{ name: "identity", bytes: 120 }], usage: { prompt: 300, output: 20, measured: true } };
        },
      },
      {
        id: "write",
        kind: "model-call",
        input: { title: "Snake" },
        schema: sObject("page", { html: sString() }),
        exec: () => {
          ran.push("write");
          return { output: { html: "<html></html>" }, usage: { prompt: 500, output: 900, measured: true } };
        },
      },
    ];
    const run = createRun(defs, { runId: "r-ok", pipeline: "test", journalFile: file("r-ok.jsonl") });
    expect(run.state).toBe("queued");

    const first = await run.next();
    expect(first.done).toBe(false);
    expect(ran).toEqual(["plan:make a snake"]);
    expect(run.state).toBe("running");
    const firstStep = first.value as SettledStep;
    expect(firstStep.status).toBe("ok");
    expect(firstStep.promptSections).toEqual([{ name: "identity", bytes: 120 }]);
    expect(firstStep.tokens).toEqual({ prompt: 300, output: 20, measured: true });

    const second = await run.next();
    expect((second.value as SettledStep).status).toBe("ok");

    const end = await run.next();
    expect(end.done).toBe(true);
    expect(run.state).toBe("done");
    expect(run.steps).toHaveLength(2);

    const entries = readJournal(file("r-ok.jsonl")).entries;
    expect(entries[0]).toMatchObject({ type: "run", runId: "r-ok", pipeline: "test" });
    expect(entries.filter((e) => e.type === "step_started")).toHaveLength(2);
    const steps = entries.filter((e) => e.type === "step") as typeof entries extends infer T ? Extract<T, { type: "step" }>[] : never[];
    expect(steps.every((s) => s.status === "ok")).toBe(true);
    // The prompt sections the step saw are names and sizes only, never the assembled text.
    expect(steps[0].promptSections).toEqual([{ name: "identity", bytes: 120 }]);
    expect(steps.every((s) => typeof s.tokens.measured === "boolean")).toBe(true);
  });

  it("closes the run iterator when it is disposed", async () => {
    const step: StepDef<unknown, unknown> = { id: "first", kind: "model-call", input: null, schema: sString(), exec: () => ({ output: "first" }) };
    const run = createRun([step, { ...step, id: "second" }], { pipeline: "test", journalFile: file("r-dispose.jsonl") });

    expect((await run.next()).done).toBe(false);
    await run[Symbol.asyncDispose]();
    expect((await run.next()).done).toBe(true);
    expect(run.steps).toHaveLength(1);
  });

  it("feeds a schema fault back with its exact reason and spends the output retry budget apart from the transport budget", async () => {
    const seen: (string | undefined)[] = [];
    let calls = 0;
    const defs: StepDef<unknown, unknown>[] = [
      {
        id: "plan",
        kind: "model-call",
        input: "x",
        schema: sObject("plan", { count: sNumber({ min: 1 }) }),
        outputRetries: 1,
        exec: (_input, attempt) => {
          calls++;
          seen.push(attempt.previous?.reason);
          if (calls === 1) return { output: { count: 0 } }; // schema fault: count below min
          return { output: { count: 3 } };
        },
      },
    ];
    const run = createRun(defs, { runId: "r-retry", pipeline: "test", journalFile: file("r-retry.jsonl") });
    const only = await run.next();
    expect(calls).toBe(2);
    expect(seen[1]).toContain("plan.count: expected a number, at least 1, got 0");
    expect((only.value as SettledStep).status).toBe("ok");
    expect((only.value as SettledStep).outputRetriesUsed).toBe(1);
    expect((only.value as SettledStep).attempts).toBe(2);
    const rec = (only.value as SettledStep).validations[0];
    expect(rec).toMatchObject({ validator: "schema", verdict: "retry" });
  });

  it("marks retry_exhausted and the run unresolved when the output never validates", async () => {
    const defs: StepDef<unknown, unknown>[] = [
      {
        id: "plan",
        kind: "model-call",
        input: "x",
        schema: sObject("plan", { title: sString() }),
        outputRetries: 1,
        exec: () => ({ output: { title: 42 } }),
      },
    ];
    const run = createRun(defs, { runId: "r-exhausted", pipeline: "test", journalFile: file("r-exhausted.jsonl") });
    await run.next();
    await run.next();
    expect(run.state).toBe("unresolved");
    expect(run.outcomeError).toContain("expected a string");
    const step = settledSteps(file("r-exhausted.jsonl"))[0];
    expect(step.status).toBe("retry_exhausted");
    expect(step.output).toBeUndefined();
  });

  it("a validator retry sends its exact reason back; a validator fail is final and spends no budget", async () => {
    const reasons: (string | undefined)[] = [];
    const defs: StepDef<unknown, unknown>[] = [
      {
        id: "answer",
        kind: "model-call",
        input: "q",
        schema: sObject("answer", { text: sString() }),
        validators: [
          {
            name: "must-name-mkmn",
            check: (out: { text: string }) =>
              out.text.includes("MKMN AI") ? { verdict: "ok" } : { verdict: "retry", reason: "the answer must name MKMN AI" },
          },
        ],
        exec: (_i, attempt) => {
          reasons.push(attempt.previous?.reason);
          return { output: { text: attempt.previous ? "I am MKMN AI" : "I am someone" } };
        },
      },
    ];
    const run = createRun(defs, { runId: "r-validator", pipeline: "test", journalFile: file("r-validator.jsonl") });
    const res = await run.next();
    expect(reasons[1]).toBe("the answer must name MKMN AI");
    expect((res.value as SettledStep).status).toBe("ok");

    const failDefs: StepDef<unknown, unknown>[] = [
      {
        id: "answer",
        kind: "model-call",
        input: "q",
        schema: sObject("answer", { text: sString() }),
        validators: [{ name: "never", check: () => ({ verdict: "fail", reason: "unacceptable" }) }],
        exec: () => ({ output: { text: "x" } }),
      },
    ];
    const run2 = createRun(failDefs, { runId: "r-fail", pipeline: "test", journalFile: file("r-fail.jsonl") });
    await run2.next();
    await run2.next();
    expect(run2.state).toBe("failed");
    const step = settledSteps(file("r-fail.jsonl"))[0];
    expect(step.status).toBe("failed");
    expect(step.attempts).toBe(1); // fail is final: no retry was spent
    expect(step.validations[0]).toMatchObject({ validator: "never", verdict: "fail" });
  });

  it("retries a thrown exec from the transport budget and fails the run when it is spent", async () => {
    let calls = 0;
    const defs: StepDef<unknown, unknown>[] = [
      {
        id: "call",
        kind: "model-call",
        input: "x",
        schema: sString(),
        transportRetries: 2,
        exec: () => {
          calls++;
          if (calls < 3) throw new Error("connection reset");
          return { output: "fine" };
        },
      },
    ];
    const run = createRun(defs, { runId: "r-transport", pipeline: "test", journalFile: file("r-transport.jsonl") });
    const res = await run.next();
    expect(calls).toBe(3);
    expect((res.value as SettledStep).transportRetriesUsed).toBe(2);
    expect((res.value as SettledStep).status).toBe("ok");

    const alwaysThrows: StepDef<unknown, unknown>[] = [
      { id: "call", kind: "model-call", input: "x", schema: sString(), exec: () => { throw new Error("down"); } },
    ];
    const run2 = createRun(alwaysThrows, { runId: "r-down", pipeline: "test", journalFile: file("r-down.jsonl") });
    await run2.next();
    await run2.next();
    expect(run2.state).toBe("failed");
    expect(run2.outcomeError).toContain("down");
  });

  it("is cancellable between steps and journals the unfinished step as interrupted", async () => {
    const defs: StepDef<unknown, unknown>[] = [
      { id: "a", kind: "model-call", input: 1, schema: sNumber(), exec: () => ({ output: 1 }) },
      { id: "b", kind: "model-call", input: 2, schema: sNumber(), exec: () => ({ output: 2 }) },
    ];
    const run = createRun(defs, { runId: "r-cancel", pipeline: "test", journalFile: file("r-cancel.jsonl") });
    await run.next();
    run.cancel("the person pressed stop");
    const second = await run.next();
    // The step that never started is simply never started; the run ends cancelled.
    expect(second.done).toBe(true);
    expect(run.state).toBe("cancelled");
    expect(run.steps.map((s) => s.id)).toEqual(["a"]);
    const entries = readJournal(file("r-cancel.jsonl")).entries;
    expect(entries.some((e) => e.type === "step" && (e as { id: string }).id === "b")).toBe(false);
  });

  it("appends to the journal without ever rewriting it", async () => {
    const jf = file("r-append.jsonl");
    const defs: StepDef<unknown, unknown>[] = [
      { id: "a", kind: "model-call", input: 1, schema: sNumber(), exec: () => ({ output: 1 }) },
    ];
    const run = createRun(defs, { runId: "r-append", pipeline: "test", journalFile: jf });
    await run.next();
    await run.next();
    const before = readFileSync(jf, "utf8");
    // A second run appending to the same file (a re-judgement scenario) keeps every earlier byte.
    const run2 = createRun(defs, { runId: "r-append", pipeline: "test", journalFile: jf });
    await run2.next();
    await run2.next();
    const after = readFileSync(jf, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("resumes a run: settled steps are replayed, a step that never finished is marked interrupted", async () => {
    const jf = file("r-resume.jsonl");
    const defs: StepDef<unknown, unknown>[] = [
      { id: "plan", kind: "model-call", input: "p", schema: sObject("plan", { title: sString() }), exec: () => ({ output: { title: "T" } }) },
      { id: "write", kind: "model-call", input: "w", schema: sObject("page", { html: sString() }), exec: () => ({ output: { html: "<b/>" } }) },
      { id: "check", kind: "stop-gate", input: "c", schema: sObject("verdict", { pass: sString() }), exec: () => ({ output: { pass: "yes" } }) },
    ];
    // A first life of the run that died mid-second-step: plan settled, write started, nothing more.
    appendEntry(jf, { type: "run", runId: "r-resume", pipeline: "test", startedAt: new Date().toISOString(), resumed: false });
    appendEntry(jf, { type: "step_started", runId: "r-resume", seq: 0, id: "plan", startedAt: new Date().toISOString() });
    appendEntry(jf, {
      type: "step", runId: "r-resume", seq: 0, id: "plan", kind: "model-call", status: "ok",
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), seconds: 1, attempts: 1,
      outputRetriesUsed: 0, transportRetriesUsed: 0, validations: [], tokens: { prompt: 0, output: 0, measured: false },
      input: "p", // a run journals the whole settled record, its input with it
    });
    appendEntry(jf, { type: "step_started", runId: "r-resume", seq: 1, id: "write", startedAt: new Date().toISOString() });

    expect(resumeReplay(jf).dangling).toEqual([{ seq: 1, id: "write" }]);

    const executed: string[] = [];
    for (const d of defs) {
      const inner = d.exec;
      d.exec = (input, attempt) => {
        executed.push(d.id);
        return inner.call(d, input, attempt);
      };
    }
    const run = createRun(defs, { runId: "r-resume", pipeline: "test", journalFile: jf });
    const first = (await run.next()).value as SettledStep;
    expect(first.replayed).toBe(true); // replayed, not executed again
    expect(executed).toEqual([]);
    const second = (await run.next()).value as SettledStep;
    expect(second.replayed).toBeUndefined();
    expect(second.id).toBe("write");
    expect(executed).toEqual(["write"]);
    const third = (await run.next()).value as SettledStep;
    expect(third.id).toBe("check");
    const end = await run.next();
    expect(end.done).toBe(true);
    expect(run.state).toBe("done");

    const entries = readJournal(jf).entries;
    const interrupted = entries.find((e) => e.type === "interrupted");
    expect(interrupted).toMatchObject({ seq: 1, id: "write" });
  });

  it("refuses to replay an incompatible checkpoint after the execution plan changed", async () => {
    const jf = file("r-mismatched-plan.jsonl");
    const original: StepDef<unknown, unknown>[] = [
      { id: "old-plan", kind: "transform", input: 1, schema: sNumber(), exec: () => ({ output: 1 }) },
      { id: "write", kind: "transform", input: 2, schema: sNumber(), exec: () => ({ output: 2 }) },
    ];
    const first = createRun(original, { runId: "r-mismatched", pipeline: "test", journalFile: jf });
    await first.next();
    await first.next();
    await first.next();
    expect(first.state).toBe("done");

    let executed = 0;
    const revised: StepDef<unknown, unknown>[] = [
      { id: "new-plan", kind: "transform", input: 1, schema: sNumber(), exec: () => { executed++; return { output: 1 }; } },
      { id: "write", kind: "transform", input: 2, schema: sNumber(), exec: () => { executed++; return { output: 2 }; } },
    ];
    const resumed = createRun(revised, { runId: "r-mismatched", pipeline: "test", journalFile: jf });
    await expect(resumed.next()).rejects.toThrow(/checkpoint step 0.*does not match/);
    expect(executed).toBe(0);
  });

  it("refuses a noncontiguous journal checkpoint rather than skipping missing steps", async () => {
    const jf = file("r-noncontiguous.jsonl");
    appendEntry(jf, {
      type: "step", runId: "r-gap", seq: 1, id: "second", kind: "transform",
      status: "ok", startedAt: "", endedAt: "", seconds: 0, attempts: 1,
      outputRetriesUsed: 0, transportRetriesUsed: 0, validations: [],
      tokens: { prompt: 0, output: 0, measured: false },
    });
    let executed = 0;
    const defs: StepDef<unknown, unknown>[] = [
      { id: "first", kind: "transform", input: 0, schema: sNumber(), exec: () => { executed++; return { output: 0 }; } },
      { id: "second", kind: "transform", input: 1, schema: sNumber(), exec: () => { executed++; return { output: 1 }; } },
    ];
    const resumed = createRun(defs, { runId: "r-gap", pipeline: "test", journalFile: jf });
    await expect(resumed.next()).rejects.toThrow(/checkpoint step 1.*does not match/);
    expect(executed).toBe(0);
  });

  // Security pre-review 2026-11-24, F5: what a resume must refuse, or stop at, before it replays
  // or re-runs anything. Every refusal leaves the journal exactly as it found it.
  describe("a resume fails closed on a checkpoint it cannot trust", () => {
    const step = (id: string, input: unknown, seen: string[], extra: Partial<StepDef<unknown, unknown>> = {}): StepDef<unknown, unknown> =>
      ({ id, kind: "transform", input, schema: sNumber(), exec: () => { seen.push(id); return { output: 1 }; }, ...extra });
    const settledRecord = (runId: string, seq: number, id: string, input: unknown, status = "ok") => ({
      type: "step" as const, runId, seq, id, kind: "transform", status: status as "ok", startedAt: "", endedAt: "", seconds: 0, attempts: 1,
      outputRetriesUsed: 0, transportRetriesUsed: 0, validations: [], tokens: { prompt: 0, output: 0, measured: false }, input,
    });

    it("stops at a step that failed, as a fresh run does, instead of running the steps after it", async () => {
      const jf = file("r-failed.jsonl");
      const seen: string[] = [];
      const first = createRun([step("a", 1, seen), { ...step("b", 2, seen), exec: () => { throw new Error("down"); }, transportRetries: 0 }, step("c", 3, seen)], { runId: "r-failed", pipeline: "test", journalFile: jf });
      for (let r = await first.next(); !r.done; r = await first.next()) { /* run it out */ }
      expect(first.state).toBe("failed");
      expect(seen).toEqual(["a"]);

      seen.length = 0;
      const resumed = createRun([step("a", 1, seen), step("b", 2, seen), step("c", 3, seen)], { runId: "r-failed", pipeline: "test", journalFile: jf });
      const ids: string[] = [];
      for (let r = await resumed.next(); !r.done; r = await resumed.next()) ids.push((r.value as SettledStep).id);
      expect(ids).toEqual(["a", "b"]); // both replayed; c never had its chance in the first life either
      expect(seen).toEqual([]);
      expect(resumed.state).toBe("failed");
    });

    it("refuses a checkpoint whose step ids match but whose input changed", async () => {
      const jf = file("r-input.jsonl");
      const seen: string[] = [];
      const first = createRun([step("plan", { topic: "cats" }, seen), step("write", 2, seen)], { runId: "r-input", pipeline: "test", journalFile: jf });
      await first.next();
      const before = readFileSync(jf, "utf8");
      seen.length = 0;
      const resumed = createRun([step("plan", { topic: "dogs" }, seen), step("write", 2, seen)], { runId: "r-input", pipeline: "test", journalFile: jf });
      await expect(resumed.next()).rejects.toThrow(/checkpoint step 0 \(plan\) was recorded with a different input/);
      expect(seen).toEqual([]);
      expect(readFileSync(jf, "utf8")).toBe(before);
    });

    it("refuses a journal with an unreadable line before its end, but resumes past a torn last line", async () => {
      const seen: string[] = [];
      const defs = () => [step("a", 1, seen), step("b", 2, seen)];
      const torn = file("r-torn.jsonl");
      appendEntry(torn, settledRecord("r-torn", 0, "a", 1));
      appendFileSync(torn, `{"type":"step","runId":"r-torn","seq":1,"id":"b"`); // the process died mid-write
      const ok = createRun(defs(), { runId: "r-torn", pipeline: "test", journalFile: torn });
      for (let r = await ok.next(); !r.done; r = await ok.next()) { /* run it out */ }
      expect(seen).toEqual(["b"]);
      expect(ok.state).toBe("done");

      seen.length = 0;
      const corrupt = file("r-corrupt.jsonl");
      appendEntry(corrupt, settledRecord("r-corrupt", 0, "a", 1));
      appendFileSync(corrupt, "#garbage#\n");
      appendEntry(corrupt, { type: "step_started", runId: "r-corrupt", seq: 1, id: "b", startedAt: "" });
      const before = readFileSync(corrupt, "utf8");
      const refused = createRun(defs(), { runId: "r-corrupt", pipeline: "test", journalFile: corrupt });
      await expect(refused.next()).rejects.toThrow(/1 unreadable line/);
      expect(seen).toEqual([]);
      expect(readFileSync(corrupt, "utf8")).toBe(before);
    });

    // Codex review of #53: the first resume appended onto the torn fragment, so the fragment became
    // an inner line and every later resume refused the journal as corrupt.
    it("seals a torn last line, so the journal can be resumed again and loses no entry", async () => {
      const jf = file("r-torn-twice.jsonl");
      const seen: string[] = [];
      appendEntry(jf, settledRecord("r-torn2", 0, "a", 1));
      appendFileSync(jf, `{"type":"step_started","runId":"r-torn2","seq":1`); // the process died mid-write
      const defs = () => [step("a", 1, seen), step("b", 2, seen), step("c", 3, seen)];
      const once = createRun(defs(), { runId: "r-torn2", pipeline: "test", journalFile: jf });
      await once.next(); // a, replayed
      await once.next(); // b, executed and journaled
      expect(seen).toEqual(["b"]);
      expect(readJournal(jf).entries.some((e) => e.type === "step" && e.id === "b")).toBe(true); // not glued onto the fragment

      seen.length = 0;
      const twice = createRun(defs(), { runId: "r-torn2", pipeline: "test", journalFile: jf });
      for (let r = await twice.next(); !r.done; r = await twice.next()) { /* run it out */ }
      expect(seen).toEqual(["c"]);
      expect(twice.state).toBe("done");
    });

    // Codex review of #53: a step inserted before the interrupted one moved it, and the side-effect
    // check read the inserted step at the old position.
    it("refuses when an interrupted step no longer stands at its position in the plan", async () => {
      const jf = file("r-moved.jsonl");
      appendEntry(jf, settledRecord("r-moved", 0, "plan", 1));
      appendEntry(jf, { type: "step_started", runId: "r-moved", seq: 1, id: "send", startedAt: "" });
      const before = readFileSync(jf, "utf8");
      const seen: string[] = [];
      const resumed = createRun([step("plan", 1, seen), step("tidy", 2, seen), step("send", 3, seen, { sideEffects: true })], { runId: "r-moved", pipeline: "test", journalFile: jf });
      await expect(resumed.next()).rejects.toThrow(/interrupted step 1 \(send\) does not match the current execution plan/);
      expect(seen).toEqual([]);
      expect(readFileSync(jf, "utf8")).toBe(before);
    });

    it("refuses a journal that holds another run's entries", async () => {
      const jf = file("r-mixed.jsonl");
      appendEntry(jf, settledRecord("r-mine", 0, "a", 1));
      appendEntry(jf, settledRecord("r-other", 1, "b", 2));
      const seen: string[] = [];
      const resumed = createRun([step("a", 1, seen), step("b", 2, seen)], { runId: "r-mine", pipeline: "test", journalFile: jf });
      await expect(resumed.next()).rejects.toThrow(/entr(y|ies) of another run/);
      expect(seen).toEqual([]);
    });

    it("never runs again, on its own, an interrupted step that has side effects", async () => {
      const jf = file("r-side.jsonl");
      appendEntry(jf, settledRecord("r-side", 0, "plan", 1));
      appendEntry(jf, { type: "step_started", runId: "r-side", seq: 1, id: "send", startedAt: "" });
      const before = readFileSync(jf, "utf8");
      const seen: string[] = [];
      const resumed = createRun([step("plan", 1, seen), step("send", 2, seen, { sideEffects: true })], { runId: "r-side", pipeline: "test", journalFile: jf });
      await expect(resumed.next()).rejects.toThrow(/step 1 \(send\) was interrupted.*side effects/);
      expect(seen).toEqual([]);
      expect(readFileSync(jf, "utf8")).toBe(before); // not even marked interrupted: nothing was decided
    });

    // F5 item 5: anything that could write the journal could forge the outputs a resume replays.
    // Every line is now signed with the install's key, chained to the line before it.
    describe("the journal is signed, and a resume replays only what this install wrote", () => {
      const finished = async (jf: string, runId: string, seen: string[]) => {
        const first = createRun([step("a", 1, seen), step("b", 2, seen)], { runId, pipeline: "test", journalFile: jf });
        await first.next(); // a settles; b never starts, as if the process died here
        seen.length = 0;
      };
      const resume = (jf: string, runId: string, seen: string[]) => createRun([step("a", 1, seen), step("b", 2, seen)], { runId, pipeline: "test", journalFile: jf });
      const UNTRUSTED = /cannot be verified as written by this install/;

      it("signs every line, and resumes a journal nobody touched", async () => {
        const jf = file("r-signed.jsonl");
        const seen: string[] = [];
        await finished(jf, "r-signed", seen);
        const lines = readFileSync(jf, "utf8").trim().split("\n");
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) expect(l).toMatch(/,"mac":"[0-9a-f]{64}"\}$/);
        const r = resume(jf, "r-signed", seen);
        for (let x = await r.next(); !x.done; x = await r.next()) { /* run it out */ }
        expect(seen).toEqual(["b"]);
        expect(r.state).toBe("done");
      });

      it("refuses a journal whose recorded step was changed, even when it is still valid JSON", async () => {
        const jf = file("r-edited.jsonl");
        const seen: string[] = [];
        await finished(jf, "r-edited", seen);
        writeFileSync(jf, readFileSync(jf, "utf8").replace('"attempts":1', '"attempts":2'));
        const before = readFileSync(jf, "utf8");
        await expect(resume(jf, "r-edited", seen).next()).rejects.toThrow(UNTRUSTED);
        expect(seen).toEqual([]);
        expect(readFileSync(jf, "utf8")).toBe(before);
      });

      it("refuses a journal a line was taken out of", async () => {
        const jf = file("r-cut.jsonl");
        const seen: string[] = [];
        await finished(jf, "r-cut", seen);
        const lines = readFileSync(jf, "utf8").trim().split("\n");
        expect(lines.length).toBeGreaterThanOrEqual(3); // run, step_started, step
        writeFileSync(jf, `${[lines[0], ...lines.slice(2)].join("\n")}\n`);
        await expect(resume(jf, "r-cut", seen).next()).rejects.toThrow(UNTRUSTED);
        expect(seen).toEqual([]);
      });

      it("refuses a line written without a signature, as an older or a foreign writer leaves", async () => {
        const jf = file("r-unsigned.jsonl");
        const seen: string[] = [];
        await finished(jf, "r-unsigned", seen);
        appendFileSync(jf, `${JSON.stringify(settledRecord("r-unsigned", 1, "b", 2))}\n`);
        await expect(resume(jf, "r-unsigned", seen).next()).rejects.toThrow(UNTRUSTED);
        expect(seen).toEqual([]);
      });

      it("refuses a journal signed with another key, as one copied from another install is", async () => {
        const jf = file("r-other-key.jsonl");
        const seen: string[] = [];
        await finished(jf, "r-other-key", seen);
        const installKey = journalKeyFile();
        expect(readFileSync(installKey).length).toBe(32);
        const other = file("other-install.key");
        writeFileSync(other, Buffer.alloc(32, 7));
        useJournalKeyFile(other); // as the app on another install reads it
        try {
          await expect(resume(jf, "r-other-key", seen).next()).rejects.toThrow(UNTRUSTED);
          expect(seen).toEqual([]);
        } finally { useJournalKeyFile(installKey); }
      });

      // Codex review of #56: a headless run journals to `<workspace>/harness.jsonl`, and a key beside
      // the journal was trusted, so a copied-in workspace could bring a key that vouched for its own
      // forged journal. The key is now the install's, wherever the journal is.
      it("does not trust a key that came with the journal, as a copied-in workspace brings one", async () => {
        const installKey = journalKeyFile();
        const workspace = file("copied-workspace");
        const jf = path.join(workspace, "harness.jsonl");
        const seen: string[] = [];
        useJournalKeyFile(path.join(workspace, "journal.key")); // whoever forged it signed with a key of their own, kept beside it
        try { await finished(jf, "r-copied", seen); } finally { useJournalKeyFile(installKey); }
        expect(existsSync(path.join(workspace, "journal.key"))).toBe(true);
        await expect(resume(jf, "r-copied", seen).next()).rejects.toThrow(UNTRUSTED);
        expect(seen).toEqual([]);
      });

      it("keeps the install's key in its Config folder, whatever folder a journal is in", () => {
        const testKey = journalKeyFile();
        useJournalKeyFile(null);
        try {
          const env = { LOCALAPPDATA: dir } as NodeJS.ProcessEnv;
          expect(journalKeyFile(env)).toBe(path.join(mkmnPaths(env).configDir, "journal.key"));
        } finally { useJournalKeyFile(testKey); }
      });
    });
  });

  it("runs without a journal when the caller asks for it", async () => {
    const defs: StepDef<unknown, unknown>[] = [
      { id: "a", kind: "transform", input: 1, schema: sNumber(), exec: () => ({ output: 2 }) },
    ];
    const run = createRun(defs, { runId: "r-nojournal", pipeline: "test", journalFile: null });
    const res = await run.next();
    expect((res.value as SettledStep).status).toBe("ok");
    expect(run.state).toBe("running");
    await run.next();
    expect(run.state).toBe("done");
    expect(existsSync(journalPath("r-nojournal"))).toBe(false);
  });

  it("replays a fully settled journal to its outcome without executing anything", async () => {
    const jf = file("r-replay-all.jsonl");
    let ran = false;
    const defs: StepDef<unknown, unknown>[] = [
      { id: "a", kind: "model-call", input: 1, schema: sNumber(), exec: () => { ran = true; return { output: 1 }; } },
    ];
    const first = createRun(defs, { runId: "r-replay-all", pipeline: "test", journalFile: jf });
    await first.next();
    await first.next();
    expect(first.state).toBe("done");
    expect(ran).toBe(true);
    ran = false; // from here, any execution would be a resume bug

    const replay = createRun(defs, { runId: "r-replay-all", pipeline: "test", journalFile: jf });
    const res = await replay.next();
    expect(res.done).toBe(false);
    expect((res.value as SettledStep).replayed).toBe(true);
    const end = await replay.next();
    expect(end.done).toBe(true);
    expect(replay.state).toBe("done");
    expect(ran).toBe(false); // nothing was executed again
  });

  it("keeps an array schema honest about item faults", async () => {
    const defs: StepDef<unknown, unknown>[] = [
      {
        id: "list",
        kind: "transform",
        input: "x",
        schema: sArray(sString(), { minLength: 2 }),
        exec: () => ({ output: ["one", 2] }),
      },
    ];
    const run = createRun(defs, { runId: "r-list", pipeline: "test", journalFile: file("r-list.jsonl") });
    await run.next();
    await run.next();
    expect(run.state).toBe("unresolved");
    expect(run.outcomeError).toContain("list[1]");
  });
});
