// Pure logic behind the settings screens, kept out of the components so the status
// claims and the validation rules can be pinned by tests: what the interface says
// about hardware, memory and capabilities must never exceed the evidence.
import type {
  ComputeTarget, HardwareProfile, MemoryEstimate, ServerStatus, Settings, VoiceModel, VoiceSettings,
} from "../shared/types";
import { readBool, voiceSettings } from "../shared/settingsSchema";

// ---------------------------------------------------------------- model-selection copy

/**
 * The empty-chat heading when nothing is selected. "No selection" does NOT mean
 * "nothing installed": the download wording is reserved for the case the model
 * inventory actually confirms (no usable installed model exists).
 */
export function noModelHeading(anyInstalled: boolean): string {
  return anyInstalled ? "Choose a model to get started." : "Download a model to get started.";
}

/**
 * Files open in the panel beside the chat unless the person turned that off.
 * The default (on) lives once, in the settings schema.
 */
export function filesOpenBesideChat(settings: Pick<Settings, "openFilesBesideChat"> | null | undefined): boolean {
  return readBool(settings, "openFilesBesideChat");
}

// ---------------------------------------------------------------- execution status

export type ExecutionKind =
  | "not-running"
  | "starting"
  /** Ready, and driver counters verified NPU execution. */
  | "verified-npu"
  /** Ready, and the runtime itself reported it moved the model to the CPU. */
  | "cpu-fallback"
  /** Ready with NPU requested, but nothing observed yet either way. */
  | "unverified"
  /** Ready on the CPU or GPU because the user asked for exactly that. */
  | "intentional-off-npu";

export interface ExecutionStatusView {
  kind: ExecutionKind;
  /** Short status line for the badge. Never claims more than the evidence. */
  label: string;
  tone: "ok" | "warn" | "neutral";
  /** One sentence of context: what is known, what is not, and what to do next. */
  detail: string;
}

/**
 * The honest state of model execution, from the server status alone:
 * "CPU Fallback Active" requires the runtime to have REPORTED a fallback — a missing
 * verification is not evidence of one. An intentional CPU/GPU request is not a
 * fallback either.
 */
export function executionStatus(server: ServerStatus | null | undefined, requestedCompute: ComputeTarget): ExecutionStatusView {
  if (!server || server.state === "stopped" || server.state === "unloaded") {
    return {
      kind: "not-running",
      label: "Not running",
      tone: "neutral",
      detail: "No model is loaded right now. Sending a message starts the runtime and loads the selected model.",
    };
  }
  if (server.state === "starting" || server.state === "loading" || server.state === "restarting") {
    return {
      kind: "starting",
      label: "Starting…",
      tone: "neutral",
      detail: "The runtime is loading the model; nothing has been measured yet.",
    };
  }
  if (server.state === "failed") {
    return {
      kind: "not-running",
      label: "Failed",
      tone: "warn",
      detail: server.lastError?.title ?? "The runtime could not start. See the error details in Advanced.",
    };
  }
  // ready / busy
  if (requestedCompute === "cpu" || requestedCompute === "gpu") {
    return {
      kind: "intentional-off-npu",
      label: `Running on the ${requestedCompute === "gpu" ? "GPU" : "CPU"} (as chosen)`,
      tone: "neutral",
      detail: "You chose this device for the chat model; this is not a fallback.",
    };
  }
  const ver = server.hardwareVerification;
  if (ver?.cpuFallbackDetected) {
    return {
      kind: "cpu-fallback",
      label: "Fallback: running on the CPU",
      tone: "warn",
      detail: "The runtime reported that the NPU load did not hold and the model moved to the CPU. Re-detect the hardware and check the memory fit in Settings → Speed & memory.",
    };
  }
  if (ver?.verifiedNpu) {
    return {
      kind: "verified-npu",
      label: "Verified on the NPU",
      tone: "ok",
      detail: "Driver telemetry (Hexagon HTP counters) confirmed the model executes on the NPU.",
    };
  }
  return {
    kind: "unverified",
    label: "NPU requested — execution not verified yet",
    tone: "neutral",
    detail: "No driver counters have confirmed NPU execution so far. This is not evidence of a fallback; a benchmark measurement verifies it.",
  };
}

/** The device the runtime OBSERVED (a string it reported), or null when it reported none. */
export function observedExecutionTarget(server: ServerStatus | null | undefined): string | null {
  const t = server?.hardwareVerification?.executionTarget;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

// ---------------------------------------------------------------- memory estimate

export interface MemoryEstimateView {
  /** "loading" = no estimate yet; "unavailable" = an estimate came back without usable numbers. */
  phase: "loading" | "unavailable" | "fits" | "over";
  weightsGB: string;
  kvCacheGB: string;
  scratchpadGB: string;
  totalRequiredGB: string;
  /** Live available RAM, or null when this machine reports none (never a substituted number). */
  availableRamGB: string | null;
  /** The PC's total RAM as measured, or null when unknown (never a guessed 32 GB). */
  totalRamGB: string | null;
  /** Progress-bar fill in percent, or null when the numbers for one do not exist. */
  barPercent: number | null;
  /** The estimator's own note, when it wrote one. Nothing is invented in its place. */
  note: string | null;
}

const gb = (v: number | undefined | null): string =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? String(Math.round(v * 10) / 10) : "--";

/**
 * Renders a memory estimate with honest empty states: missing data is shown as
 * missing ("--", no bar, no note), never as a default or a warning.
 */
export function memoryEstimateView(est: MemoryEstimate | null | undefined): MemoryEstimateView {
  if (!est) {
    return {
      phase: "loading", weightsGB: "--", kvCacheGB: "--", scratchpadGB: "--", totalRequiredGB: "--",
      availableRamGB: null, totalRamGB: null, barPercent: null,
      note: "Measuring…",
    };
  }
  const available = typeof est.availableRamGB === "number" && Number.isFinite(est.availableRamGB) && est.availableRamGB > 0 ? est.availableRamGB : null;
  const totalRam = typeof est.totalRamGB === "number" && Number.isFinite(est.totalRamGB) && est.totalRamGB > 0 ? est.totalRamGB : null;
  const required = typeof est.totalRequiredGB === "number" && Number.isFinite(est.totalRequiredGB) && est.totalRequiredGB > 0 ? est.totalRequiredGB : null;
  const note = typeof est.note === "string" && est.note.trim() ? est.note.trim() : null;
  const hasNumbers = required !== null && est.weightsGB > 0;
  return {
    phase: !hasNumbers ? "unavailable" : est.fits ? "fits" : "over",
    weightsGB: gb(est.weightsGB),
    kvCacheGB: gb(est.kvCacheGB),
    scratchpadGB: gb(est.scratchpadGB),
    totalRequiredGB: gb(est.totalRequiredGB),
    availableRamGB: available === null ? null : String(Math.round(available * 10) / 10),
    totalRamGB: totalRam === null ? null : String(Math.round(totalRam * 10) / 10),
    barPercent: available !== null && required !== null ? Math.min(100, (required / available) * 100) : null,
    note,
  };
}

// ---------------------------------------------------------------- capability gating

/**
 * Whether a speech model can run on the NPU at all: a bundle made for the NPU
 * (Foundry Local build) can; the downloaded sherpa-onnx models have no NPU build
 * and always run on the CPU, so the NPU choice is disabled for them instead of
 * being offered and silently ignored.
 */
export function voiceDeviceCapable(model: VoiceModel | null | undefined): boolean {
  return !!model && (typeof model.foundryAlias === "string" || model.device === "NPU");
}

/**
 * A saved "npu" placement for a model without an NPU build is kept as-is (never
 * silently rewritten), and the UI explains that the model runs on the CPU until an
 * NPU-capable model is chosen.
 */
export function voicePlacementWarning(kind: "stt" | "tts", saved: "cpu" | "npu", model: VoiceModel | null | undefined): string | null {
  if (saved !== "npu" || voiceDeviceCapable(model)) return null;
  const what = kind === "stt" ? "Dictation" : "Read-aloud";
  return `${what} is set to NPU, but this model has no NPU build: it runs on the CPU. NPU dictation needs a speech model with an NPU build.`;
}

// ---------------------------------------------------------------- validation

/** Inline error for the NPU memory override; empty input is allowed (it means "use detected"). */
export function budgetProblem(raw: string, hw: HardwareProfile): string | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return "Enter a number of gigabytes, for example 7.5.";
  if (n <= 0) return "The shared memory is above zero.";
  if (hw.ramGB > 0 && n > hw.ramGB) return `This PC has ${hw.ramGB} GB of RAM: the NPU cannot share more than that.`;
  return null;
}

/** Inline error for a read-aloud speaker id against the selected model's voices. */
export function speakerProblem(sid: number, model: VoiceModel | null | undefined): string | null {
  if (!model) return null;
  if (model.voices && !model.voices.some((v) => v.sid === sid)) return `This model offers voices 0 to ${model.voices.length - 1}.`;
  if (typeof model.sidCount === "number" && (!Number.isInteger(sid) || sid < 0 || sid >= model.sidCount)) {
    return `This model offers speakers 0 to ${model.sidCount - 1}.`;
  }
  return null;
}

// ---------------------------------------------------------------- one retention authority

export interface RetentionChoice {
  loadingStrategy: "always" | "demand";
  idleReleaseSec: number;
  keepaliveSec: number;
}

/**
 * The single model-retention decision, derived from the user-facing idle-release knob:
 * "never release" keeps the model warm (a large keepalive), any other value releases
 * after that many seconds. `idleReleaseSec` is authoritative once it exists; a stored
 * file that only has the legacy `keepaliveSec` keeps working until the UI saves.
 */
export function retentionFromIdle(idleReleaseSec: number | undefined, legacyKeepaliveSec: number | undefined): RetentionChoice {
  const ok = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  // A settings file with neither key (a fresh profile) gets the schema default, 5 minutes.
  const idle = ok(idleReleaseSec) ? idleReleaseSec : ok(legacyKeepaliveSec) ? legacyKeepaliveSec : 300;
  return {
    loadingStrategy: idle === 0 ? "always" : "demand",
    idleReleaseSec: idle,
    keepaliveSec: idle === 0 ? 86_400 : idle,
  };
}

/** Patch saving one retention choice from the UI (keeps the two stored keys in step). */
export function retentionPatch(idleReleaseSec: number): Partial<Settings> {
  const r = retentionFromIdle(idleReleaseSec, idleReleaseSec);
  return { loadingStrategy: r.loadingStrategy, idleReleaseSec: r.idleReleaseSec, keepaliveSec: r.keepaliveSec };
}

// ---------------------------------------------------------------- benchmark targets

export type BenchTarget = "npu" | "hybrid";

export const BENCH_TARGET_LABEL: Record<BenchTarget, string> = {
  npu: "Hexagon NPU",
  hybrid: "CPU + NPU (hybrid)",
};

/**
 * The targets a model can be benchmarked on, from its engine alone: a GGUF model runs
 * on the NPU or on GenieX's hybrid path; a compiled QAIRT bundle is a baked NPU
 * artifact with no CPU path at all, so no hybrid target is offered for it.
 */
export function benchmarkTargets(engine: string | null | undefined): { id: BenchTarget; label: string }[] {
  const targets: { id: BenchTarget; label: string }[] = [{ id: "npu", label: BENCH_TARGET_LABEL.npu }];
  if (engine !== "qairt") targets.push({ id: "hybrid", label: BENCH_TARGET_LABEL.hybrid });
  return targets;
}

/**
 * The target a benchmark may actually run: derived from the model's engine, never
 * trusted from the UI state (which can hold a choice made for a different model).
 * A compiled bundle always normalizes to the NPU; an unknown value falls back to
 * the one target every model has.
 */
export function normalizeBenchTarget(target: string | null | undefined, engine: string | null | undefined): BenchTarget {
  return target === "hybrid" && engine !== "qairt" ? "hybrid" : "npu";
}

/**
 * The "Runs on" line under the compute select, only when it ADDS something the select
 * does not already say. The select shows the effective target, so restating it ("Runs
 * on: Hexagon NPU") says the same thing twice — the line exists for the one case the
 * picker cannot show: a compiled bundle's stale hybrid pick was overridden, and the
 * form owes the person the reason.
 */
export function runsOnNote(picked: string | null | undefined, engine: string | null | undefined): string | null {
  if (!picked || normalizeBenchTarget(picked, engine) === picked) return null;
  return engine === "qairt" ? "Runs on: Hexagon NPU — a compiled bundle has no CPU path" : `Runs on: ${picked === "hybrid" ? "CPU + NPU (hybrid)" : "the Hexagon NPU"}`;
}

// ---------------------------------------------------------------- calibration reset

/**
 * The calibration reset patch, taken from the ONE voice defaults (the schema):
 * the reset button must restore what a fresh install has, so the values are read
 * from the settings schema instead of a second hand-copied set of numbers that drifts.
 */
export function calibrationResetPatch(): Partial<VoiceSettings> {
  const d = voiceSettings({});
  return {
    minLevel: d.minLevel,
    interruptLevel: d.interruptLevel,
    interruptMs: d.interruptMs,
    minSpeechMs: d.minSpeechMs,
    endSilenceMs: d.endSilenceMs,
    waitMs: d.waitMs,
  };
}

// ---------------------------------------------------------------- save feedback

export interface SaveFailureView {
  /** The operation's id: stable across its own retries, unique per attempt. */
  id: number;
  what: string;
  text: string;
  /** Re-runs exactly this operation — and refuses when a newer save of the same setting superseded it. */
  retry: () => void;
}

export interface SaveFeedbackState {
  /** What is being saved right now, then the brief "Saved" confirmation. */
  transient: { tone: "busy" | "ok"; text: string } | null;
  /** Every unresolved failed save, each with its own Retry. Different settings' failures coexist. */
  failures: SaveFailureView[];
}

export interface SaveFeedbackStore {
  subscribe: (fn: () => void) => () => void;
  /** Stable between notifications, for React's useSyncExternalStore. */
  get: () => SaveFeedbackState;
  /** Runs one save: marks it busy, then "Saved" (auto-dismissed) or failed (sticky).
   *  `opKey` (optional) names the SETTING being saved: failures and successes of the
   *  same setting resolve each other; different settings' failures never interfere. */
  /** Resolves true when the save landed, false when it failed (the failure line
   *  shows why): a caller that reports an outcome waits for this. */
  attempt: (what: string, apply: () => Promise<unknown>, opKey?: string) => Promise<boolean>;
  /** Retries one failed save by id (the same operation, never a newer one's patch). */
  retryFailure: (id: number) => void;
  /** The user clears one failure by hand. */
  dismissFailure: (id: number) => void;
  /** The user clears every failure (and any confirmation) by hand. */
  dismiss: () => void;
  dispose: () => void;
}

/**
 * The one save-feedback contract for the settings page. Overlapping saves must never
 * lie about their state:
 *  - beginning a save cancels the previous dismissal timer, so an older "Saved" can
 *    never kill the new "Saving…";
 *  - a completion only updates the transient line while it is the newest attempt (a
 *    generation counter drops completions that arrive out of order);
 *  - a failure lives in a LIST keyed by setting: a later failure or success of a
 *    DIFFERENT setting cannot erase it, and each failure's Retry re-runs exactly the
 *    operation that failed, until it succeeds or the user dismisses it;
 *  - a newer save of the SAME setting supersedes that setting's older unresolved
 *    failure: retrying the older patch would silently overwrite the newer choice, so
 *    the superseded failure (and its Retry) go away the moment the newer value lands.
 */
export function createSaveFeedback(delayMs = 2500): SaveFeedbackStore {
  let state: SaveFeedbackState = { transient: null, failures: [] };
  let seq = 0; // the newest attempt (owns the transient line)
  let opSeq = 0; // operations: a retry re-runs the same one, so it can resolve its own failure
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  /** opKey → the one unresolved failure for that setting (a newer attempt replaces it). */
  const pending = new Map<string, { opId: number; what: string; message: string; apply: () => Promise<unknown> }>();
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  const set = (patch: Partial<SaveFeedbackState>) => { state = { ...state, ...patch }; emit(); };
  const clearDoneTimer = () => { if (doneTimer !== undefined) { clearTimeout(doneTimer); doneTimer = undefined; } };

  const publish = () => {
    set({
      failures: [...pending.entries()]
        .sort((a, b) => a[1].opId - b[1].opId)
        .map(([key, f]) => ({
          id: f.opId,
          what: f.what,
          text: `Saving ${f.what} failed: ${f.message}`,
          retry: () => {
            // superseded in the meantime (a newer same-setting save landed)? Then this
            // retry would overwrite that newer choice with the stale patch: refuse.
            if (pending.get(key)?.opId !== f.opId) return;
            void run(f.what, f.apply, key, f.opId);
          },
        })),
    });
  };

  const run = async (what: string, apply: () => Promise<unknown>, opKey: string, opId?: number): Promise<boolean> => {
    const id = opId ?? ++opSeq;
    clearDoneTimer();
    const gen = ++seq;
    set({ transient: { tone: "busy", text: `Saving ${what}…` } });
    try {
      await apply();
      // This success resolves any older unresolved failure of the SAME setting (its
      // patch is outdated now); a DIFFERENT setting's failure stays visible.
      if ((pending.get(opKey)?.opId ?? Number.POSITIVE_INFINITY) <= id) {
        pending.delete(opKey);
        publish();
      }
      if (gen === seq) {
        set({ transient: { tone: "ok", text: "Saved" } });
        doneTimer = setTimeout(() => {
          doneTimer = undefined;
          if (gen === seq) set({ transient: null });
        }, delayMs);
      }
      return true;
    } catch (e) {
      // A failure is recorded whatever its age: the operation did fail. A failure of
      // the SAME setting replaces that setting's older failure (retrying the older
      // patch would clobber the newer value); other settings' failures are untouched.
      // It never overwrites the transient line of a newer attempt — separate slots.
      pending.set(opKey, { opId: id, what, message: (e as Error)?.message ?? String(e), apply });
      publish();
      if (gen === seq) set({ transient: null });
      return false;
    }
  };

  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get() { return state; },
    attempt: (what, apply, opKey) => run(what, apply, opKey ?? what),
    retryFailure(id) {
      for (const [key, f] of pending) if (f.opId === id) { void run(f.what, f.apply, key, id); return; }
    },
    dismissFailure(id) {
      for (const [key, f] of pending) if (f.opId === id) { pending.delete(key); publish(); return; }
    },
    dismiss() { clearDoneTimer(); pending.clear(); publish(); set({ transient: null }); },
    dispose() { clearDoneTimer(); subs.clear(); },
  };
}

// ---------------------------------------------------------------- memory estimate gate

export type EstimatePhase =
  /** No numbers yet, and nothing to fall back on. */
  | "loading"
  /** The newest request is in flight for THIS configuration; the shown numbers are its own previous answer. */
  | "refreshing"
  /** Usable numbers for the current configuration. */
  | "ready"
  /** The request failed. */
  | "failed"
  /** The answer came back without usable numbers. */
  | "unavailable"
  /** The shown numbers belong to a PREVIOUS configuration; the current one is still loading. */
  | "stale";

export interface EstimateGateState {
  /** The configuration key the shown data belongs to. */
  key: string;
  /** The same configuration in words, so a stale result can say what it IS for. */
  label: string;
  phase: EstimatePhase;
  est: MemoryEstimate | null;
  /** Only on "failed": asking again makes sense. */
  canRetry: boolean;
}

/** The configuration an estimate answers for: model, context, cache precision and the
 *  memory budget — the budget changes the fit verdict, so it is part of the identity. */
export function estimateConfigKey(modelRef: string, nctx?: number, kvType?: string, budgetGB?: number | null): string {
  return JSON.stringify([modelRef, nctx ?? null, kvType ?? null, budgetGB ?? null]);
}

/** The configuration in words (for the stale note: the shown numbers must name what they are for). */
export function estimateConfigLabel(modelRef: string, nctx?: number, kvType?: string, budgetGB?: number | null): string {
  const parts = [modelRef];
  if (typeof nctx === "number" && nctx > 0) parts.push(`context ${nctx}`);
  parts.push(`cache ${kvType || "f16"}`);
  if (typeof budgetGB === "number" && Number.isFinite(budgetGB) && budgetGB > 0) parts.push(`budget ${budgetGB} GB`);
  return parts.join(" · ");
}

export interface EstimateGate {
  subscribe: (fn: () => void) => () => void;
  get: () => EstimateGateState;
  /** Asks for the given configuration; out-of-order and superseded answers are dropped. */
  request: (modelRef: string, nctx?: number, kvType?: string, budgetGB?: number | null) => void;
  retry: () => void;
  dispose: () => void;
}

/**
 * Gates the memory estimate so the interface never shows one model's numbers as
 * another model's answer:
 *  - every request carries the configuration key it was made for (model, context,
 *    cache, memory budget), and only a response to the NEWEST request is ever shown;
 *  - a previous configuration's numbers may stay visible while the new one loads, but
 *    only explicitly marked "stale" and labelled with the configuration they belong
 *    to — never as the new configuration's result;
 *  - failures and unusable answers have their own phases, and a failed request offers
 *    Retry instead of the endless "Measuring…" the old catch-to-null produced.
 */
export function createEstimateGate(
  fetchEstimate: (modelRef: string, nctx?: number, kvType?: string) => Promise<MemoryEstimate>,
): EstimateGate {
  let state: EstimateGateState = { key: "", label: "", phase: "loading", est: null, canRetry: false };
  let seq = 0;
  let last: { modelRef: string; nctx?: number; kvType?: string; budgetGB?: number | null } | null = null;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  const usable = (e: MemoryEstimate | null | undefined): boolean => !!e && e.weightsGB > 0 && Number.isFinite(e.totalRequiredGB) && e.totalRequiredGB > 0;

  const ask = (modelRef: string, nctx?: number, kvType?: string, budgetGB?: number | null) => {
    last = { modelRef, nctx, kvType, budgetGB };
    const key = estimateConfigKey(modelRef, nctx, kvType, budgetGB);
    const label = estimateConfigLabel(modelRef, nctx, kvType, budgetGB);
    const id = ++seq;
    if (state.est && state.key === key) state = { ...state, phase: "refreshing", canRetry: false };
    // old numbers stay visible but stale: their label keeps naming the configuration
    // they ACTUALLY belong to — never the new one
    else if (state.est) state = { ...state, phase: "stale", canRetry: false };
    else state = { key, label, phase: "loading", est: null, canRetry: false };
    emit();
    void fetchEstimate(modelRef, nctx, kvType).then(
      (est) => {
        if (id !== seq) return; // out-of-order: a newer request owns the display
        state = { key, label, est, phase: usable(est) ? "ready" : "unavailable", canRetry: false };
        emit();
      },
      () => {
        if (id !== seq) return;
        // the previous numbers for this same configuration may stay; none are shown
        // for a configuration that has never answered
        const keep = state.est && state.key === key ? state.est : null;
        state = { key, label, est: keep, phase: "failed", canRetry: true };
        emit();
      },
    );
  };

  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get() { return state; },
    request: (modelRef, nctx, kvType, budgetGB) => ask(modelRef, nctx, kvType, budgetGB),
    retry() { if (last && state.canRetry) ask(last.modelRef, last.nctx, last.kvType, last.budgetGB); },
    dispose() { subs.clear(); seq++; },
  };
}

// ---------------------------------------------------------------- radio groups

/**
 * The next position in a radio group for a key press: arrows step and wrap, Home/End
 * jump. Positions are indexes into the ENABLED options; the caller maps them back to
 * the buttons, so disabled choices are skipped.
 */
export function radioMove(count: number, current: number, key: string): number {
  if (count <= 0) return 0;
  const last = count - 1;
  const cur = Math.min(last, Math.max(0, current));
  switch (key) {
    case "ArrowRight": case "ArrowDown": return cur >= last ? 0 : cur + 1;
    case "ArrowLeft": case "ArrowUp": return cur <= 0 ? last : cur - 1;
    case "Home": return 0;
    case "End": return last;
    default: return cur;
  }
}

/** The keys that belong to the radio group itself; everything else (Tab, Shift+Tab,
 *  Space, Enter, shortcuts) keeps its normal browser behavior. */
export const RADIO_NAV_KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * The ONE option reachable by Tab (the roving tabindex), as a radio group requires:
 * the checked choice when it is enabled, otherwise the FIRST enabled choice — the
 * group must never become Tab-unreachable just because the saved selection is
 * unavailable. `null` when no option is enabled (nothing can be the tab stop).
 */
export function radioTabStop<T extends string>(options: { id: T; disabled?: boolean }[], value: T): T | null {
  const checked = options.find((o) => o.id === value);
  if (checked && !checked.disabled) return checked.id;
  return options.find((o) => !o.disabled)?.id ?? null;
}

// ---------------------------------------------------------------- advanced-group persistence

/**
 * The Advanced navigation group's saved expanded/collapsed value. The old writer saved
 * "0" for collapsed while the reader compared against "0" — but the writer wrote
 * "true"/"false", so a collapsed group reopened. Both spellings are read; the write is
 * always the boolean string, and anything unknown means open (the default).
 */
export function readAdvOpen(raw: string | null | undefined): boolean {
  return !(raw === "false" || raw === "0");
}
export function writeAdvOpen(open: boolean): string {
  return open ? "true" : "false";
}

// ---------------------------------------------------------------- slider commits

export interface SliderCommitOptions {
  /** The value the settings hold when the slider mounts (the first committed value). */
  initial: number;
  /** Performs the save. Read through a ref by the caller, so it stays current. */
  save: (v: number) => void;
  debounceMs?: number;
  /** Injectable timers so tests run without real clocks. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface SliderCommit {
  /** Dragging/typing: schedules the debounced commit (replacing a pending one). */
  change: (v: number) => void;
  /** A pointer/keyboard gesture finished: commit now if the value differs. */
  gestureEnd: (v: number) => void;
  /** Focus left the slider: never lose the pending value. */
  blur: () => void;
  /** The slider unmounts / the page navigates away: flush the pending value. */
  dispose: () => void;
  /** The prop value changed from outside (save round-trip, reset): re-latch — but a
   *  pending local edit is kept until it commits. */
  sync: (v: number) => void;
}

/**
 * The one commit discipline for a save-on-change slider. Every trigger (debounce,
 * pointer release, keyboard, blur, unmount) funnels into ONE latch: a save happens
 * only when the value differs from the last COMMITTED value, so the triggers can fire
 * together without duplicate saves — and unmount flushes the pending value instead of
 * dropping it.
 */
export function createSliderCommit(o: SliderCommitOptions): SliderCommit {
  const debounceMs = o.debounceMs ?? 600;
  const setT = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = undefined;
  let pending: number | null = null;
  let committed = o.initial;

  const cancel = () => { if (timer !== undefined) { clearT(timer); timer = undefined; } };
  const commit = (v: number) => {
    if (v === committed) return; // the triggers fire together: only a real change saves
    committed = v;
    o.save(v);
  };
  const commitNow = (v: number) => { cancel(); pending = null; commit(v); };

  return {
    change(v) {
      pending = v;
      cancel();
      if (v === committed) { pending = null; return; } // dragged back: nothing to save
      timer = setT(() => {
        timer = undefined;
        const val = pending;
        pending = null;
        if (val !== null) commit(val);
      }, debounceMs);
    },
    gestureEnd(v) { pending = v; commitNow(v); },
    blur() { if (pending !== null) commitNow(pending); },
    dispose() {
      // navigate-away with an unsaved value: flush it, never drop it
      if (pending !== null) commitNow(pending);
      else cancel();
    },
    sync(v) { if (pending === null) committed = v; },
  };
}

// ---------------------------------------------------------------- connection test

export interface SearchConnectionConfig {
  provider: string;
  braveKey?: string | null;
  searxngUrl?: string | null;
}

/** The exact identity of what a connection test answers for: provider + credential +
 *  address together. A result may only be shown while this is unchanged. */
export function connectionFingerprint(cfg: SearchConnectionConfig): string {
  return JSON.stringify([cfg.provider, cfg.braveKey ?? "", cfg.searxngUrl ?? ""]);
}

/** Error text and logs must never carry the credential or the private instance address. */
export function redactCredentials(text: string, cfg: SearchConnectionConfig): string {
  let out = text ?? "";
  for (const secret of [cfg.braveKey, cfg.searxngUrl]) {
    const s = typeof secret === "string" ? secret.trim() : "";
    if (s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}

export type ConnectionTestPhase = "idle" | "busy" | "ok" | "failed";

export interface ConnectionTestState {
  phase: ConnectionTestPhase;
  text: string;
  /** The fingerprint of the configuration this result (or in-flight test) belongs to. */
  fingerprint: string | null;
  /** Only on "ok": how many results the test query got back. */
  n: number | null;
}

export interface ConnectionTester {
  subscribe: (fn: () => void) => () => void;
  /** Stable between notifications, for React's useSyncExternalStore. */
  get: () => ConnectionTestState;
  /** Tests this exact configuration. An older in-flight test's answer is dropped. */
  test: (cfg: SearchConnectionConfig) => Promise<void>;
  /** The configuration changed: a result about the old one must not show any more. */
  invalidate: (cfg: SearchConnectionConfig) => void;
  dispose: () => void;
}

/**
 * The connection test's honesty contract: a result is bound to the exact provider +
 * credential + address it tested (its fingerprint), and only the newest test's answer
 * is ever shown — a superseded response is dropped, and changing the configuration
 * invalidates the shown result instead of letting it answer for settings it never
 * tested. Errors are redacted before they reach the interface.
 */
export function createConnectionTester(
  run: (cfg: SearchConnectionConfig) => Promise<{ ok: boolean; n: number; error?: string }>,
): ConnectionTester {
  let state: ConnectionTestState = { phase: "idle", text: "", fingerprint: null, n: null };
  let seq = 0;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  const set = (patch: Partial<ConnectionTestState>) => { state = { ...state, ...patch }; emit(); };
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get() { return state; },
    async test(cfg) {
      const fp = connectionFingerprint(cfg);
      const id = ++seq;
      state = { phase: "busy", text: "Testing…", fingerprint: fp, n: null };
      emit();
      try {
        const r = await run(cfg);
        if (id !== seq) return; // superseded: a newer test (or a config change) owns the display
        set(r.ok
          ? { phase: "ok", text: `Works: ${r.n} result${r.n === 1 ? "" : "s"} came back for a test query.`, n: r.n }
          : { phase: "failed", text: r.error ?? "The search did not answer. Check the credential or address, then try again." });
      } catch (e) {
        if (id !== seq) return;
        set({ phase: "failed", text: redactCredentials((e as Error)?.message || "The search test could not run.", cfg) });
      }
    },
    invalidate(cfg) {
      const fp = connectionFingerprint(cfg);
      if (state.fingerprint !== null && state.fingerprint !== fp) {
        seq++; // also drops an in-flight test of the old configuration
        state = { phase: "idle", text: "", fingerprint: null, n: null };
        emit();
      }
    },
    dispose() { subs.clear(); seq++; },
  };
}

// ---------------------------------------------------------------- runtime numbers

/** The integer fields of the llama.cpp runtime, with the ranges the interface enforces
 *  itself (the HTML min/max attributes are not validation — old drafts and hand-typed
 *  values must be checked in code). */
export const RUNTIME_FIELD_RANGES = {
  threads: { label: "CPU threads", min: 1, max: 1024 },
  threadsBatch: { label: "Prompt threads", min: 1, max: 1024 },
  ctx: { label: "Context window override", min: 512, max: 262144 },
  gpuLayers: { label: "Layers on the GPU", min: -1, max: 999 },
  batch: { label: "Batch size", min: 1, max: 8192 },
  ubatch: { label: "Micro-batch", min: 1, max: 8192 },
} as const;

export type RuntimeField = keyof typeof RUNTIME_FIELD_RANGES;

export type ParsedRuntimeInt = { ok: true; value: number | undefined } | { ok: false; error: string };

/**
 * One draft field of the runtime numbers: empty means "not set" (the runtime decides),
 * and everything else must be a finite whole number inside the field's range. Non-finite
 * values are rejected outright — `Number("Infinity")` would survive `Number.isNaN` and
 * become `null` in the settings JSON, silently corrupting them.
 */
export function parseRuntimeInt(raw: string, field: RuntimeField): ParsedRuntimeInt {
  const spec = RUNTIME_FIELD_RANGES[field];
  const t = raw.trim();
  if (t === "") return { ok: true, value: undefined };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: `${spec.label}: "${t}" is not a usable number.` };
  if (!Number.isInteger(n)) return { ok: false, error: `${spec.label}: enter a whole number (${spec.min}–${spec.max}).` };
  if (n < spec.min || n > spec.max) return { ok: false, error: `${spec.label}: must be between ${spec.min} and ${spec.max}.` };
  return { ok: true, value: n };
}

// ---------------------------------------------------------------- dictation languages

export interface LanguageOption { code: string; label: string; /** Saved but not offered by this model: kept so a preference never silently disappears. */ saved?: boolean }

/** The dictation languages the UI offers for a multilingual model, Auto-detect on top. */
export const DICTATION_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" }, { code: "ar", label: "Arabic" },
];

/** The European subset (the transducer model names 25 European languages; of the offered languages it has English). */
const EUROPEAN_CODES = new Set(["en"]);

/**
 * The language choices for the SELECTED dictation model, from what the model says it
 * understands: a multilingual model offers the full list, a European one the European
 * subset, an English-only one English. A saved language the new model does not offer
 * is kept in the list marked "(saved)" — never silently dropped, never offered as if
 * the model supported it.
 */
export function dictationLanguageOptions(model: VoiceModel | null | undefined, savedCode: string | undefined): LanguageOption[] {
  const said = model?.languages ?? "";
  let allowed = DICTATION_LANGUAGES; // no model selected (or an unknown wording): the multilingual list
  if (/^English\b/i.test(said.trim())) allowed = DICTATION_LANGUAGES.filter((l) => l.code === "en");
  else if (/European/i.test(said)) allowed = DICTATION_LANGUAGES.filter((l) => EUROPEAN_CODES.has(l.code));
  const options: LanguageOption[] = [{ code: "", label: "Auto-detect" }, ...allowed.map((l) => ({ ...l }))];
  const code = (savedCode ?? "").trim();
  if (code && !options.some((o) => o.code === code)) {
    const name = DICTATION_LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();
    options.push({ code, label: `${name} (saved — not in this model)`, saved: true });
  }
  return options;
}
