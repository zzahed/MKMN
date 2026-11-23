/**
 * The harness kernel: one `Run` is an async generator of settled `Step`s that every
 * multi-step pipeline goes through. The loop is APP-DRIVEN: the run chooses each next
 * step, validates the typed output against its schema and validators, feeds an exact
 * retry reason back, journals everything, and can be inspected and cancelled between
 * steps. A small local model never drives this loop; it only fills a typed output.
 *
 * The run's final outcome is decided by settle() (src/core/harness/settle.ts), the
 * only writer of a run's end state; the run applies the verdict it is given. After
 * every step settles, the run's hooks see the record first — the identity guard
 * rides by default, so no answer the person sees or hears names anything but
 * MKMN AI.
 */
import { nextState } from "../../shared/stateMachines";
import {
  appendEntry,
  journalPath,
  readJournal,
  resumeReplay,
  type JournalStep,
  type JournalEntry,
  type PromptSectionRef,
  type StepUsage,
  type ValidationRecord,
} from "./journal";
import type { Schema } from "./schema";
import { settle, type SettleOutcome, type SettleGate } from "./settle";
import { identityGuardStep } from "./identity";
import { offloadPayload, offloadSection, previewText } from "./offload";
import * as nodePath from "node:path";

/** What kind of work a step does; the UI gives each kind its own drawing. */
export type StepKind = "model-call" | "validate" | "repair" | "retrieve" | "compact" | "stop-gate" | "transform" | "sub-run";

/** The run lifecycle, registered in src/shared/stateMachines.json as machine `run`. */
export type RunState = "queued" | "running" | "settling" | "done" | "unresolved" | "failed" | "cancelled";

export type RunEvent = "start" | "cancel" | "steps_done" | "verdict_ok" | "verdict_problems" | "verdict_error";

/** A validator's answer. `retry` spends one output retry and sends the exact fault back; `fail` is final and spends nothing. */
export type ValidatorVerdict = { verdict: "ok" } | { verdict: "retry"; reason: string } | { verdict: "fail"; reason: string };

export interface Validator<O> {
  name: string;
  check(output: O, input: unknown): ValidatorVerdict | Promise<ValidatorVerdict>;
}

/** What one attempt of a step's exec sees and may report. */
export interface StepAttempt<I> {
  /** 0-based attempt number. */
  attempt: number;
  /** The rejected output and the exact fault, when the last attempt was sent back to be done again. */
  previous?: { output: unknown; reason: string };
  input: I;
  signal: AbortSignal;
  /** Report the measured usage of the model call behind this attempt, when the server gave it. */
  reportUsage(usage: StepUsage): void;
}

/** What an exec returns: the typed output, plus what the journal should hold about the call that made it. */
export interface ExecResult<O> {
  output: O;
  reply?: string;
  promptSections?: PromptSectionRef[];
  usage?: StepUsage;
}

export interface StepDef<I, O> {
  id: string;
  kind: StepKind;
  input: I;
  schema: Schema<O>;
  validators?: Validator<O>[];
  /** Retries after a schema or validator rejection (default 1). */
  outputRetries?: number;
  /** Retries after the exec threw (default 1; the gateway counts transport faults here). */
  transportRetries?: number;
  exec(input: I, attempt: StepAttempt<I>): Promise<O | ExecResult<O>> | O | ExecResult<O>;
}

/** One settled step, as the journal holds it and the UI reads it. */
export type SettledStep<I = unknown, O = unknown> = JournalStep & {
  input: I;
  output?: O;
  /** True when the record was replayed from the journal on resume, not executed again. */
  replayed?: boolean;
};

/** The hooks a run runs on its own progress. */
export interface RunHooks {
  /** Ran on every settled step, before it is journaled and yielded; may rewrite the record (return it) or just observe. */
  afterStep?(step: SettledStep): SettledStep | void | Promise<SettledStep | void>;
}

export interface RunOptions {
  runId?: string;
  /** The pipeline the run serves ("build", "compaction", "knowledge", ...), for the journal header. */
  pipeline: string;
  /** The chat this run serves: written in the journal header so deleting the chat deletes the journal. */
  conversationId?: string;
  /** Explicit journal file; the default is journalPath(runId); `null` runs without a journal (tests). */
  journalFile?: string | null;
  /** A step reply bigger than this (bytes, from offloadThreshold(window)) is offloaded to a file next to the journal: the record keeps the preview and the pointer, never the whole text. Offload needs a journal folder; with `journalFile: null` it is off. */
  offloadBytes?: number;
  /** Hooks beyond the run's own (the identity guard always rides first). */
  hooks?: RunHooks;
  /** Called once per settled step, after it is journaled and counted in steps: the turn's host draws the run as it happens. Not awaited. */
  onStep?: (step: SettledStep) => void;
  now?: () => number;
}

export interface RunApi extends AsyncGenerator<SettledStep> {
  readonly runId: string;
  readonly state: RunState;
  readonly steps: readonly SettledStep[];
  readonly outcomeError?: string;
  cancel(reason?: string): void;
}

const DEFAULT_OUTPUT_RETRIES = 1;
const DEFAULT_TRANSPORT_RETRIES = 1;

/** Move the run lifecycle through the registry; an illegal move is logged, never a crash mid-run. */
function moveRun(from: RunState, event: RunEvent): RunState {
  const to = nextState("run", from, event);
  if (to === undefined) {
    console.error(`[harness] the run cannot legally move from ${from} on ${event}; it stays ${from}`);
    return from;
  }
  return to as RunState;
}

/** The offload of a settled step's long reply, shared by both run drivers: the record keeps the preview and the pointer (a PromptSectionRef), the payload goes to a file next to the journal. The guard has already ridden, so the offloaded text is the guarded text. */
export function offloadStepReply(s: SettledStep, journalFile: string, threshold: number): SettledStep {
  if (s.status !== "ok" || typeof s.reply !== "string" || s.reply.length <= threshold) return s;
  try {
    const dir = nodePath.join(nodePath.dirname(journalFile), "offload");
    const ref = offloadPayload(dir, `${s.runId}-${s.seq}-${s.id}`, s.reply);
    return { ...s, reply: previewText(ref), promptSections: [...(s.promptSections ?? []), offloadSection(ref)] };
  } catch (e) {
    console.error(`[harness] offload failed for step ${s.id}: ${(e as Error).message}`);
    return s; // the whole reply rides in the journal rather than the step being lost
  }
}

/**
 * Create a run over the given plan. Pull it with `next()` one step at a time; every
 * yielded value is a settled step (executed now, or replayed from the journal on a
 * resumed run). `cancel()` takes effect between steps.
 */
export function createRun(defs: StepDef<unknown, unknown>[], opts: RunOptions): RunApi {
  const now = opts.now ?? (() => performance.now());
  const runId = opts.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = opts.journalFile === undefined ? journalPath(runId) : opts.journalFile;

  let state: RunState = "queued";
  let cancelled: string | undefined;
  const controller = new AbortController();
  const settled: SettledStep[] = [];

  function journalWrite(entry: JournalEntry): void {
    if (file === null) return;
    try {
      appendEntry(file, entry);
    } catch (e) {
      // A full disk or a locked file must not kill the run mid-step; the gap is visible on resume.
      console.error(`[harness] journal write failed for run ${runId}: ${(e as Error).message}`);
    }
  }

  function ensureRunning(): void {
    if (state === "queued") {
      state = moveRun(state, "start");
      journalWrite({ type: "run", runId, pipeline: opts.pipeline, startedAt: new Date().toISOString(), resumed: false, ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) });
    }
  }

  /** The hooks: the identity guard rides first, then the caller's, in order; then a long reply is offloaded. */
  async function runHooks(step: SettledStep): Promise<SettledStep> {
    let s = identityGuardStep(step);
    const extra = await opts.hooks?.afterStep?.(s);
    if (extra) s = extra;
    return file !== null && opts.offloadBytes !== undefined ? offloadStepReply(s, file, opts.offloadBytes) : s;
  }

  async function* generator(): AsyncGenerator<SettledStep> {
    // Resume: replay the settled steps of the journal, mark the dangling ones interrupted.
    let firstIndex = 0;
    if (file !== null && readJournal(file).entries.length > 0) {
      const { settled: replayed, dangling } = resumeReplay(file);
      for (const d of dangling) {
        journalWrite({
          type: "interrupted",
          runId,
          seq: d.seq,
          id: d.id,
          at: new Date().toISOString(),
          reason: "the run was interrupted before this step settled",
        });
      }
      // A resumed run must match the original plan's contiguous settled prefix.
      // Otherwise a changed graph or corrupted journal could silently skip a step,
      // then claim an incompatible checkpoint completed successfully.
      for (let i = 0; i < replayed.length; i++) {
        const rec = replayed[i];
        if (rec.seq !== i || defs[i]?.id !== rec.id) {
          throw new Error(`Cannot resume run ${runId}: checkpoint step ${rec.seq} (${rec.id}) does not match the current execution plan at position ${i}.`);
        }
      }
      for (const rec of replayed) {
        const def = defs[rec.seq];
        const copy: SettledStep = { ...rec, input: def.input, replayed: true };
        settled.push(copy);
        yield copy;
      }
      firstIndex = replayed.length;
      if (firstIndex >= defs.length) {
        ensureRunning();
        finishRun();
        return;
      }
    }

    for (let seq = firstIndex; seq < defs.length; seq++) {
      if (cancelled !== undefined) break;
      ensureRunning();
      const def = defs[seq] as StepDef<unknown, unknown>;
      journalWrite({ type: "step_started", runId, seq, id: def.id, startedAt: new Date().toISOString() });

      const record = await executeStep(def, seq, { runId, controller, now, cancelled: () => cancelled, journalWrite, afterStep: runHooks });
      settled.push(record);
      yield record;
      if (record.status === "failed") break; // a hard failure ends the run; later steps never had their chance
    }

    // Settling: the verdict is settle()'s — the only writer of the run's end state.
    finishRun();
  }

  /** Apply the verdict settle() returned to the lifecycle; the run itself never decides. */
  function finishRun(): void {
    state = moveRun(state, "steps_done");
    const verdict = settle({ steps: settled, cancelled });
    state = moveRun(state, verdict.event);
  }

  const gen = generator();
  const api: RunApi = {
    runId,
    get state() {
      return state;
    },
    get steps() {
      return settled;
    },
    cancel(reason?: string) {
      if (cancelled === undefined) {
        cancelled = reason ?? "the run was cancelled";
        controller.abort(cancelled);
      }
    },
    next(value?: unknown) {
      return gen.next(value as never);
    },
    return(value?: unknown) {
      return gen.return(value as never);
    },
    throw(error?: unknown) {
      return gen.throw(error);
    },
    [Symbol.asyncIterator]() {
      return api;
    },
  };
  Object.defineProperty(api, "outcomeError", {
    get: () => (settled.find((s) => s.status !== "ok")?.error) ?? cancelled,
  });
  return api;
}

async function executeStep(
  def: StepDef<unknown, unknown>,
  seq: number,
  ctx: {
    runId: string;
    controller: AbortController;
    now: () => number;
    cancelled: () => string | undefined;
    journalWrite: (entry: JournalEntry) => void;
    afterStep: (step: SettledStep) => Promise<SettledStep>;
  },
): Promise<SettledStep> {
  const t0 = ctx.now();
  const startedAt = new Date().toISOString();
  const validations: ValidationRecord[] = [];
  let usage: StepUsage = { prompt: 0, output: 0, measured: false };
  let reply: string | undefined;
  let promptSections: PromptSectionRef[] | undefined;
  let outputRetriesUsed = 0;
  let transportRetriesUsed = 0;
  let attempts = 0;
  let status: JournalStep["status"] = "ok";
  let error: string | undefined;
  let output: unknown;
  let previous: { output: unknown; reason: string } | undefined;

  const outputBudget = def.outputRetries ?? DEFAULT_OUTPUT_RETRIES;
  const transportBudget = def.transportRetries ?? DEFAULT_TRANSPORT_RETRIES;

  attemptLoop: for (;;) {
    if (ctx.cancelled()) {
      status = "interrupted";
      error = ctx.cancelled();
      break;
    }
    attempts++;
    try {
      const raw = await def.exec(def.input, {
        attempt: attempts - 1,
        previous,
        input: def.input,
        signal: ctx.controller.signal,
        reportUsage(u: StepUsage) {
          usage = u;
        },
      });
      // Unpack the exec result: the typed output plus what the call behind it reported.
      if (raw !== null && typeof raw === "object" && "output" in (raw as Record<string, unknown>) && !Array.isArray(raw)) {
        const r = raw as ExecResult<unknown>;
        output = r.output;
        reply = r.reply;
        promptSections = r.promptSections;
        if (r.usage) usage = r.usage;
      } else {
        output = raw;
      }
    } catch (e) {
      error = `${def.id}: ${(e as Error).message}`;
      if (ctx.cancelled()) {
        // the run was cancelled while the call was in flight (a send took the NPU back,
        // the turn was stopped): the step did not fail, it was interrupted
        status = "interrupted";
        break;
      }
      if (transportRetriesUsed < transportBudget) {
        transportRetriesUsed++;
        validations.push({ validator: "transport", verdict: "retry", reason: error });
        continue;
      }
      validations.push({ validator: "transport", verdict: "fail", reason: error });
      status = "failed";
      break;
    }

    // 1. The output schema. A schema fault is a retry whose reason names the exact faults,
    // with the step's id as the root of every path.
    const check = def.schema.check(output, def.id);
    if (!check.ok) {
      const reason = check.errors.join("; ");
      if (outputRetriesUsed < outputBudget && !ctx.cancelled()) {
        outputRetriesUsed++;
        validations.push({ validator: "schema", verdict: "retry", reason });
        previous = { output, reason };
        continue;
      }
      validations.push({ validator: "schema", verdict: "fail", reason });
      status = "retry_exhausted";
      error = reason;
      break;
    }

    // 2. The validators, in order; the first that speaks decides.
    for (const validator of def.validators ?? []) {
      const v = await validator.check(check.value as never, def.input);
      if (v.verdict === "ok") {
        validations.push({ validator: validator.name, verdict: "ok" });
        continue;
      }
      if (v.verdict === "retry") {
        validations.push({ validator: validator.name, verdict: "retry", reason: v.reason });
        if (outputRetriesUsed < outputBudget && !ctx.cancelled()) {
          outputRetriesUsed++;
          previous = { output, reason: v.reason };
          continue attemptLoop;
        }
        status = "retry_exhausted";
        error = `${validator.name}: ${v.reason}`;
        break attemptLoop;
      }
      // fail: final, no budget spent.
      validations.push({ validator: validator.name, verdict: "fail", reason: v.reason });
      status = "failed";
      error = `${validator.name}: ${v.reason}`;
      break attemptLoop;
    }
    break; // every validator accepted
  }

  const seconds = Math.round((ctx.now() - t0) / 100) / 10;
  const record: SettledStep = {
    type: "step",
    runId: ctx.runId,
    seq,
    id: def.id,
    kind: def.kind,
    status,
    startedAt,
    endedAt: new Date().toISOString(),
    seconds,
    attempts,
    outputRetriesUsed,
    transportRetriesUsed,
    promptSections,
    reply,
    validations,
    tokens: usage,
    error,
    input: def.input,
    output: status === "ok" ? output : undefined,
  };
  // The hooks see the record before it exists anywhere: what they return is what is
  // journaled and yielded, so the delivered answer and the record are one text.
  const hooked = (await ctx.afterStep(record)) ?? record;
  ctx.journalWrite(hooked);
  return hooked;
}

// ---------------------------------------------------------------- the live run

/**
 * The live run: the driver for pipelines whose steps are decided while the work
 * unfolds — the chat turn above all, where the answer path chooses its calls as
 * it goes (a summary here, a locator there, sub-agent sessions). It is the same
 * run as `createRun`, not a second engine: the same journal format, the same
 * step execution (retries, schema, validators, hooks), the same settle() at the
 * end, the same registered lifecycle. The one difference is the driver: instead
 * of pulling a fixed plan, the pipeline declares each step at the moment it
 * makes the call, and nested calls (a summary inside the answer's own stream)
 * are steps of the same run, journaled in the order they happened.
 *
 * A live run is not resumable: the person watches it; a turn that died is a
 * failure on the screen, not something to replay.
 */
export interface LiveRunStep<I, O> {
  id: string;
  kind: StepKind;
  /** Small, journal-sized input (a model name, a count) — never a full prompt. */
  input: I;
  schema: Schema<O>;
  validators?: Validator<O>[];
  /** Retries after a schema or validator rejection (default 0: the caller owns its retry policy). */
  outputRetries?: number;
  /** Retries after the exec threw (default 0: the gateway and the caller own transport retries). */
  transportRetries?: number;
  exec(input: I, attempt: StepAttempt<I>): Promise<O | ExecResult<O>> | O | ExecResult<O>;
}

export interface LiveRun {
  readonly runId: string;
  readonly journalFile: string | null;
  readonly state: RunState;
  readonly steps: readonly SettledStep[];
  /** One step, now: journaled, executed, guarded, and part of the run's settle. */
  step<I, O>(def: LiveRunStep<I, O>): Promise<SettledStep<I, O>>;
  /** Hand the pipeline's own rules (gates) to the run: finish() settles with them, so the run's verdict and the pipeline's final status are one decision. */
  setGates(gates: readonly SettleGate[]): void;
  /** Cancel the run between and DURING steps: the step in flight settles interrupted (a send took the NPU back, the turn was stopped). finish() settles the run afterwards. */
  cancel(reason: string): void;
  /** Set the offload threshold once the served window is known (offloadThreshold(nctx)): a step reply over it is offloaded to a file, the record keeps the preview and the pointer. */
  setOffload(bytes: number): void;
  /** The person pressed skip (leave the work out) or go-back-a-step (write the one before again) while the run worked: the press is appended to the journal as a rewind entry, and the step it landed on is marked superseded — settle() reads the steps that stood, the redo's steps decide. */
  rewind(action: "skip" | "back", reason: string): void;
  /** End the run: settle() reads every step that ran and the lifecycle moves to its verdict. `cancelledBecause` is the person's stop (the verdict is cancelled); `policyStop` names the app rule that stopped the run instead (the turn's budget) — the verdict is then unresolved with that cause, never cancelled. */
  finish(cancelledBecause?: string, policyStop?: string): SettleOutcome;
}

export function createLiveRun(opts: RunOptions): LiveRun {
  const now = opts.now ?? (() => performance.now());
  const runId = opts.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = opts.journalFile === undefined ? journalPath(runId) : opts.journalFile;

  let state: RunState = "queued";
  let cancelled: string | undefined;
  let gates: readonly SettleGate[] = [];
  let offloadBytes = opts.offloadBytes;
  let seq = 0;
  const settled: SettledStep[] = [];
  // the person's skip/back presses: a press lands on the step in
  // flight — its work was thrown away, so settle() must not read it; the redo's
  // steps follow in the journal after the press's rewind entry.
  const superseded = new Set<number>();
  let flying: number | null = null; // the step issued and not yet settled

  function journalWrite(entry: JournalEntry): void {
    if (file === null) return;
    try {
      appendEntry(file, entry);
    } catch (e) {
      console.error(`[harness] journal write failed for run ${runId}: ${(e as Error).message}`);
    }
  }

  function ensureRunning(): void {
    if (state === "queued") {
      state = moveRun(state, "start");
      journalWrite({ type: "run", runId, pipeline: opts.pipeline, startedAt: new Date().toISOString(), resumed: false, ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) });
    }
  }

  async function runHooks(step: SettledStep): Promise<SettledStep> {
    let s = identityGuardStep(step);
    const extra = await opts.hooks?.afterStep?.(s);
    if (extra) s = extra;
    return file !== null && offloadBytes !== undefined ? offloadStepReply(s, file, offloadBytes) : s;
  }

  return {
    runId,
    get journalFile() {
      return file;
    },
    get state() {
      return state;
    },
    get steps() {
      return settled;
    },
    async step<I, O>(def: LiveRunStep<I, O>): Promise<SettledStep<I, O>> {
      ensureRunning();
      const s = seq++;
      flying = s;
      if (cancelled !== undefined) {
        const record: SettledStep = {
          type: "step", runId, seq: s, id: def.id, kind: def.kind, status: "interrupted",
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), seconds: 0,
          attempts: 0, outputRetriesUsed: 0, transportRetriesUsed: 0, validations: [],
          tokens: { prompt: 0, output: 0, measured: false }, error: cancelled, input: def.input,
        };
        const hooked = (await runHooks(record)) as SettledStep<I, O>;
        journalWrite(hooked);
        settled.push(hooked);
        flying = null;
        try { opts.onStep?.(hooked); } catch { /* a drawing that fails never stops the run */ }
        return hooked;
      }
      journalWrite({ type: "step_started", runId, seq: s, id: def.id, startedAt: new Date().toISOString() });
      const full: StepDef<I, O> = {
        id: def.id, kind: def.kind, input: def.input, schema: def.schema,
        validators: def.validators, outputRetries: def.outputRetries,
        transportRetries: def.transportRetries, exec: def.exec,
      };
      const record = (await executeStep(full as StepDef<unknown, unknown>, s, {
        runId,
        controller: new AbortController(),
        now,
        cancelled: () => cancelled,
        journalWrite,
        afterStep: runHooks,
      })) as SettledStep<I, O>;
      settled.push(record as SettledStep);
      flying = null;
      try { opts.onStep?.(record as SettledStep); } catch { /* a drawing that fails never stops the run */ }
      return record;
    },
    setGates(g: readonly SettleGate[]): void {
      gates = g;
    },
    cancel(reason: string): void {
      if (cancelled === undefined) cancelled = reason;
    },
    setOffload(bytes: number): void {
      offloadBytes = bytes;
    },
    rewind(action: "skip" | "back", reason: string): void {
      ensureRunning();
      const landedOn = flying ?? Math.max(0, seq - 1); // the step in flight, or the last issued one when the press landed between steps
      if (flying !== null) superseded.add(landedOn); // only the work a press threw away is superseded; a press between steps changes the course, not the steps that stood
      journalWrite({ type: "rewind", runId, seq: landedOn, action, at: new Date().toISOString(), reason });
    },
    finish(cancelledBecause?: string, policyStop?: string): SettleOutcome {
      // a stop by policy is not the person's cancel: the cause goes to settle()
      // as the policy stop, and the run does not read as cancelled
      if (policyStop === undefined && cancelledBecause !== undefined && cancelled === undefined) cancelled = cancelledBecause;
      ensureRunning();
      state = moveRun(state, "steps_done");
      const verdict = settle({ steps: settled, cancelled: policyStop === undefined ? cancelled : undefined, gates, superseded: [...superseded], stoppedBy: policyStop });
      state = moveRun(state, verdict.event);
      return verdict;
    },
  };
}
