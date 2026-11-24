/**
 * Adaptive compute selection for MKMN.
 *
 * One decision per request, made BEFORE the request starts and kept stable for the
 * whole generation: which engine/device configuration serves this model now. The
 * decision uses this device's own measurements (validated quality, latency, energy,
 * memory) — never raw utilization alone — and every selection carries its reason and
 * whether it is provisional (no local measurements backed it).
 *
 * Hard boundaries (from the proposal):
 *  - GenieX `hybrid` is CPU + NPU. It is never labeled "GPU" and never promised to
 *    touch the GPU.
 *  - A QAIRT bundle is a precompiled Hexagon artifact: NPU only, no CPU/GPU/hybrid
 *    conversion of the same bundle.
 *  - Simultaneous CPU+NPU+GPU execution of one model is NOT offered anywhere: no
 *    installed runtime has been verified to do that here.
 *  - Energy values are never invented: without a credible whole-task battery
 *    measurement, the energy dimension is "unknown" and the selection says so.
 */

export type AutoGoal = "balanced" | "battery_saver" | "fastest";
/** The devices a user (or a policy) can pick. "hybrid" is GenieX CPU+NPU. */
export type ManualCompute = "npu" | "hybrid" | "gpu" | "cpu";
export type EngineId = "geniex" | "foundry" | "llama_cpp";

export const AUTO_GOALS: { id: AutoGoal; label: string; why: string }[] = [
  { id: "balanced", label: "Balanced", why: "A good mix of speed, memory and battery, as measured on this PC." },
  { id: "battery_saver", label: "Battery Saver", why: "The least battery use measured on this PC that still answers in reasonable time." },
  { id: "fastest", label: "Fastest", why: "The fastest answers measured on this PC, within safe memory limits." },
];

/** "hybrid" is CPU + NPU, everywhere the user can read it. */
export const COMPUTE_LABEL: Record<ManualCompute, string> = {
  npu: "NPU",
  hybrid: "CPU + NPU",
  gpu: "GPU",
  cpu: "CPU",
};

export const ENGINE_LABEL: Record<EngineId, string> = {
  geniex: "GenieX",
  foundry: "Foundry Local",
  llama_cpp: "llama.cpp",
};

/** One measured configuration of this machine, for one candidate. */
export interface Measurement {
  /** Warm decode rate, tokens/s (null = not measured). */
  decodeTokPerSec: number | null;
  /** Warm first-token latency, ms — prefill INCLUDED (never add a prefill term on top). */
  ttftMs: number | null;
  /**
   * Whole-task energy per OUTPUT token, mWh, from an integrated battery measurement.
   * null when never measured on battery: it must not be guessed.
   */
  mWhPerToken: number | null;
  /** Measured peak process/model memory, GB; null when unknown. */
  peakRamGB: number | null;
  /** Epoch ms of the measurement. */
  at: number | null;
  /** What produced it ("mkmn-bench", "npu-load-test", "shipped-score"). */
  source: string;
  /** Runtime/driver/artifact identity the measurement was taken under. */
  runtimeVersion?: string | null;
}

export interface FoundryVariantFact {
  alias: string;
  /** "NPU" | "GPU" | "CPU" as Foundry names the build's hardware. */
  device: string;
  /** The exact model id this build is asked for by (from the load response, not guessed). */
  modelId: string;
  /** The build sits in Foundry's cache right now. */
  cached: boolean;
}

/** What the host knows about the engines and artifacts that could serve this model. */
export interface EngineFacts {
  /** null when no engine can serve this model at all. */
  engine: EngineId | null;
  /** The artifact is a precompiled QAIRT (NPU-only) bundle. */
  isQairt: boolean;
  /**
   * GPU placement was VERIFIED for this exact model/runtime/device combination
   * (a placement measurement on this machine, or a llama.cpp engine with a real GPU).
   * A generic platform name never sets this.
   */
  gpuVerified: boolean;
  /** GenieX GGUF artifacts may use the CPU+NPU hybrid; QAIRT may not. */
  hybridAllowed: boolean;
  /** Foundry's variants for this model, when the entry is a Foundry alias. */
  foundryVariants?: FoundryVariantFact[];
}

/** One selectable execution path. */
export interface Candidate {
  id: string;
  engine: EngineId;
  compute: ManualCompute;
  /** What the serve call receives: "npu", "hybrid", "cpu", "gpu", "HTP0,HTP1"… */
  serveCompute: string;
  /** A Foundry candidate names its exact build; it is never chosen by alias alone. */
  foundry?: { alias: string; modelId: string; device: string };
  measurement: Measurement | null;
}

/** Everything the policy weighs, all of it optional-or-null when it cannot be known. */
export interface SelectionInput {
  goal: AutoGoal;
  candidates: Candidate[];
  battery: { onMains: boolean | null; percent: number | null } | null;
  /** Free RAM + commit headroom, GB; null when unknown. */
  headroomGB: number | null;
  /** The candidate id currently loaded (resident), if any. */
  residentId: string | null;
  /** Measured cost of reloading this model (a switch), seconds; null when unknown. */
  reloadSec: number | null;
  /** Device contention from owned-process or physical-engine counters; `stale` flags samples too old to trust. */
  contention: { npuBusy: boolean | null; gpuBusy: boolean | null; samplesFresh: boolean };
  /** Expected output tokens for this request (conservative). */
  expectedOutputTokens: number;
  /** Now, epoch ms (injected for tests). */
  now: number;
  /** Minimum ms between switches; a switch inside the window keeps the resident config. Default 120000. */
  cooldownMs?: number;
  /** The last switch the policy made (for the cooldown). */
  lastSwitch?: { at: number; toId: string } | null;
  /** The predicted-latency ceiling for Battery Saver, ms; null = no limit. */
  latencyLimitMs?: number | null;
}

export interface GatedOut {
  id: string;
  compute: ManualCompute;
  why: string;
}

export interface Selection {
  config: Candidate | null;
  /** The explanation, in order: engine · device · evidence · why. */
  reason: string[];
  /** No local measurement supported this decision: a known-supported default was used. */
  provisional: boolean;
  /** Candidates refused, with the reason (shown in the UI instead of being silently dropped). */
  gatedOut: GatedOut[];
}

const DEFAULT_COOLDOWN_MS = 120_000;
/** A switch must promise a real, sustained improvement — not a rounding error. */
const SWITCH_GAIN_FRACTION = 0.25;
const ENERGY_GAIN_FRACTION = 0.2;
/** Battery Saver's default response-time ceiling: 1.75x the best measured latency. */
const BATTERY_LATENCY_TOLERANCE = 1.75;

/** Predicted end-to-end latency, ms: warm TTFT + remaining decode. Non-overlapping terms. */
export function predictedLatencyMs(c: Candidate, expectedOutputTokens: number): number | null {
  const m = c.measurement;
  if (!m || m.decodeTokPerSec === null || !m.decodeTokPerSec || m.ttftMs === null) return null;
  return m.ttftMs + (expectedOutputTokens / m.decodeTokPerSec) * 1000;
}

/**
 * The candidates this engine/artifact can honestly offer. Gating is from FACTS:
 * artifact kind, verified placements, cached variants. Anything unsupported comes
 * back with a reason instead of being offered and silently reinterpreted.
 */
export function candidatesFor(entry: { engine?: string | null; quant?: string | null; foundryDevice?: string | null; foundryAlias?: string | null; foundryModelId?: string | null; ref?: string; repo?: string }, facts: EngineFacts, measurements: Record<string, Measurement | undefined>): { candidates: Candidate[]; gatedOut: GatedOut[] } {
  const candidates: Candidate[] = [];
  const gatedOut: GatedOut[] = [];
  const gate = (compute: ManualCompute, ok: boolean, why: string, make: () => Candidate) => {
    if (ok) candidates.push(make());
    else gatedOut.push({ id: `${facts.engine ?? "none"}:${compute}`, compute, why });
  };

  if (facts.engine === "geniex") {
    const base = { engine: "geniex" as EngineId, measurement: null };
    gate("npu", true, "", () => ({ ...base, id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measurements["geniex:npu"] ?? null }));
    gate(
      "hybrid",
      facts.hybridAllowed && !facts.isQairt,
      facts.isQairt ? "A QAIRT bundle is a compiled NPU artifact: it has no CPU+NPU hybrid path." : "Hybrid (CPU+NPU) loads are not allowed by the current settings.",
      () => ({ ...base, id: "geniex:hybrid", compute: "hybrid", serveCompute: "hybrid", measurement: measurements["geniex:hybrid"] ?? null })
    );
    gate(
      "gpu",
      facts.gpuVerified,
      "GPU placement was never verified for this exact model/runtime/device combination on this machine.",
      () => ({ ...base, id: "geniex:gpu", compute: "gpu", serveCompute: "gpu", measurement: measurements["geniex:gpu"] ?? null })
    );
    // A QAIRT bundle is a precompiled Hexagon artifact: the CPU cannot execute it
    // either — the only honest paths are the NPU one and (for other artifacts) none.
    gate("cpu", !facts.isQairt, "A QAIRT bundle is a compiled NPU artifact: it has no CPU execution path.", () => ({ ...base, id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measurements["geniex:cpu"] ?? null }));
  } else if (facts.engine === "foundry") {
    for (const v of facts.foundryVariants ?? []) {
      const compute = (v.device.toLowerCase() === "npu" ? "npu" : v.device.toLowerCase() === "gpu" ? "gpu" : "cpu") as ManualCompute;
      const id = `foundry:${v.alias}:${compute}`;
      const ok = v.cached;
      gate(
        compute,
        ok,
        `No cached Foundry Local build for ${v.device} of this model (install it in Models first).`,
        () => ({ id, engine: "foundry", compute, serveCompute: v.device.toLowerCase(), foundry: { alias: v.alias, modelId: v.modelId, device: v.device }, measurement: measurements[id] ?? null })
      );
    }
  } else if (facts.engine === "llama_cpp") {
    const base = { engine: "llama_cpp" as EngineId, measurement: null };
    gate("gpu", facts.gpuVerified, "No usable GPU was verified for the llama.cpp engine on this machine.", () => ({ ...base, id: "llama_cpp:gpu", compute: "gpu", serveCompute: "gpu", measurement: measurements["llama_cpp:gpu"] ?? null }));
    gate("cpu", true, "", () => ({ ...base, id: "llama_cpp:cpu", compute: "cpu", serveCompute: "cpu", measurement: measurements["llama_cpp:cpu"] ?? null }));
  }
  return { candidates, gatedOut };
}

/**
 * THE policy. Filters, scores, applies residency + cooldown, and explains itself.
 * Returns null config only when nothing passes (the caller then refuses or falls
 * back explicitly — never silently).
 */
export function selectAuto(input: SelectionInput): Selection {
  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const gatedOut: GatedOut[] = [];
  const reason: string[] = [];
  const goal = input.goal;

  // ---- filter: memory headroom, contention, battery constraint
  const passing: Candidate[] = [];
  for (const c of input.candidates) {
    const why = rejectReason(c, input);
    if (why) gatedOut.push({ id: c.id, compute: c.compute, why });
    else passing.push(c);
  }
  if (!passing.length) {
    return {
      config: null,
      reason: ["No supported configuration passes the current constraints (memory, contention, availability)."],
      provisional: true,
      gatedOut,
    };
  }

  // ---- the resident configuration (kept unless a real, sustained gain says otherwise)
  const resident = passing.find((c) => c.id === input.residentId) ?? null;
  // Any switch (to the resident or away from it) opens the cooldown window: the point
  // is to stop flip-flopping between configurations, not to bless the newest one.
  const coolingDown = !!input.lastSwitch && input.now - input.lastSwitch.at < cooldownMs;

  const withLatency = passing
    .map((c) => ({ c, lat: predictedLatencyMs(c, input.expectedOutputTokens) }))
    .sort((a, b) => (a.lat ?? Number.MAX_SAFE_INTEGER) - (b.lat ?? Number.MAX_SAFE_INTEGER));
  const measured = withLatency.filter((x) => x.lat !== null);
  const best = measured[0];

  // ---- no measurements at all: a known-supported default, marked provisional
  if (!measured.length) {
    // default preference by goal, all provisional: NPU first (this is an NPU PC app),
    // then CPU+NPU, then GPU, then CPU.
    const order: ManualCompute[] = goal === "battery_saver" ? ["npu", "hybrid", "gpu", "cpu"] : ["npu", "hybrid", "gpu", "cpu"];
    const pick = order.map((p) => passing.find((c) => c.compute === p)).find(Boolean) ?? passing[0];
    const why =
      goal === "battery_saver"
        ? "no credible whole-task energy measurement exists on this device, so no energy ranking was made"
        : "no latency or throughput measurement exists on this device for this model";
    reason.push(`${ENGINE_LABEL[pick!.engine]} · ${COMPUTE_LABEL[pick!.compute]}`, `provisional: ${why}; kept the known-supported default`, deviceNotes(input));
    return { config: pick!, reason, provisional: true, gatedOut };
  }

  // ---- scored selection per goal
  let pick: { c: Candidate; lat: number | null } | null;
  const goalLine: string[] = [];
  if (goal === "fastest") {
    pick = best;
    goalLine.push(`fastest of ${measured.length} measured configurations (${Math.round(best.lat! / 100) / 10} s predicted for ~${input.expectedOutputTokens} output tokens)`);
  } else if (goal === "battery_saver") {
    const limit = input.latencyLimitMs ?? (best.lat !== null ? best.lat * BATTERY_LATENCY_TOLERANCE : null);
    const inTime = limit === null ? measured : measured.filter((x) => x.lat !== null && x.lat <= limit);
    const withEnergy = (inTime.length ? inTime : measured).filter((x) => x.c.measurement!.mWhPerToken !== null && x.c.measurement!.mWhPerToken! > 0);
    if (withEnergy.length) {
      pick = withEnergy.reduce((a, b) => (b.c.measurement!.mWhPerToken! < a.c.measurement!.mWhPerToken! ? b : a));
      goalLine.push(`lowest measured energy (${pick.c.measurement!.mWhPerToken} mWh/token) within the ${limit ? `${Math.round(limit / 100) / 10} s` : "any"} latency target`);
    } else {
      // NEVER invent energy: fall back to the lowest-latency passing config and say so.
      pick = best;
      goalLine.push("no credible whole-task energy measurement on this device (battery runs only): the energy ranking was not made", `provisional fallback: the fastest measured configuration instead`);
    }
  } else {
    // balanced: explicit limits first (memory is already filtered), then a latency/energy compromise:
    // among configurations within 1.5x of the fastest predicted latency, take the lowest energy; else the fastest.
    const within = measured.filter((x) => x.lat !== null && x.lat! <= best.lat! * 1.5);
    const withEnergy = within.filter((x) => x.c.measurement!.mWhPerToken !== null && x.c.measurement!.mWhPerToken! > 0);
    if (withEnergy.length) {
      pick = withEnergy.reduce((a, b) => (b.c.measurement!.mWhPerToken! < a.c.measurement!.mWhPerToken! ? b : a));
      goalLine.push(`lowest measured energy among configurations within 1.5x of the fastest predicted latency (${Math.round(pick.lat! / 100) / 10} s)`);
    } else {
      pick = best;
      goalLine.push("fastest measured configuration (no energy measurement exists to balance against)");
    }
  }

  // ---- residency + cooldown: keep what is loaded unless the gain is real and allowed
  if (resident && resident.id !== pick!.c.id) {
    const residentLat = predictedLatencyMs(resident, input.expectedOutputTokens);
    const better = best.lat !== null && residentLat !== null && residentLat > 0 && residentLat / best.lat >= 1 + SWITCH_GAIN_FRACTION;
    const residentEnergy = resident.measurement?.mWhPerToken ?? null;
    const pickEnergy = pick!.c.measurement?.mWhPerToken ?? null;
    const energyBetter = goal === "battery_saver" && residentEnergy !== null && pickEnergy !== null && residentEnergy / pickEnergy >= 1 + ENERGY_GAIN_FRACTION;
    const blocked = coolingDown || !(better || energyBetter);
    if (blocked) {
      const why: string[] = [];
      if (coolingDown) why.push(`a switch happened ${Math.round((input.now - input.lastSwitch!.at) / 1000)} s ago (cooldown ${Math.round(cooldownMs / 1000)} s)`);
      else why.push(`switching would save less than ${Math.round(SWITCH_GAIN_FRACTION * 100)}% of the predicted time`);
      if (input.reloadSec !== null) why.push(`reloading costs about ${Math.round(input.reloadSec)} s`);
      reason.push(`staying resident: ${ENGINE_LABEL[resident.engine]} · ${COMPUTE_LABEL[resident.compute]} (${why.join("; ")})`);
      pick = { c: resident, lat: predictedLatencyMs(resident, input.expectedOutputTokens) };
    }
  } else if (resident && resident.id === pick!.c.id) {
    reason.push("already resident: no switch, no reload");
  }

  const m = pick!.c.measurement;
  const measuredLine = m
    ? `measured on this device (${m.source}${m.at ? `, ${new Date(m.at).toISOString().slice(0, 10)}` : ""}): ${m.decodeTokPerSec === null ? "tok/s not measured" : `${m.decodeTokPerSec} tok/s`}, first token ${m.ttftMs === null ? "not measured" : `${Math.round(m.ttftMs)} ms`}${m.mWhPerToken !== null ? `, ${m.mWhPerToken} mWh/token` : ""}`
    : "no local measurement for the configuration kept resident";
  reason.unshift(
    `${ENGINE_LABEL[pick!.c.engine]} · ${COMPUTE_LABEL[pick!.c.compute]}`,
    measuredLine,
    ...goalLine,
    deviceNotes(input)
  );
  const provisional = m === null;
  return { config: pick!.c, reason, provisional, gatedOut };
}

/** A manual pick is honored or refused with a reason — never silently reinterpreted. */
export function selectManual(candidates: Candidate[], gatedOut: GatedOut[], compute: ManualCompute, ctx: Omit<SelectionInput, "goal" | "candidates">): Selection {
  const c = candidates.find((x) => x.compute === compute);
  if (!c) {
    const why = gatedOut.find((g) => g.compute === compute)?.why ?? `no available configuration serves this model on ${COMPUTE_LABEL[compute]}`;
    return { config: null, reason: [`${COMPUTE_LABEL[compute]} is not available for this model: ${why}`], provisional: true, gatedOut };
  }
  const rejected = rejectReason(c, ctx);
  if (rejected) return { config: null, reason: [`${COMPUTE_LABEL[compute]} is gated out right now: ${rejected}`], provisional: true, gatedOut };
  const m = c.measurement;
  return {
    config: c,
    provisional: !m,
    reason: [
      `${ENGINE_LABEL[c.engine]} · ${COMPUTE_LABEL[c.compute]} (chosen manually)`,
      m
        ? `measured on this device (${m.source}): ${m.decodeTokPerSec === null ? "tok/s not measured" : `${m.decodeTokPerSec} tok/s`}, first token ${m.ttftMs === null ? "not measured" : `${Math.round(m.ttftMs)} ms`}`
        : "no local measurement for this configuration yet — your choice is applied as-is",
    ],
    gatedOut,
  };
}

/** Constraint checks shared by auto and manual. Memory, contention, samples. */
function rejectReason(c: Candidate, input: Pick<SelectionInput, "headroomGB" | "contention">): string | null {
  const m = c.measurement;
  if (m?.peakRamGB != null && input.headroomGB != null && m.peakRamGB > input.headroomGB) {
    return `needs about ${m.peakRamGB.toFixed(1)} GB but only ${input.headroomGB.toFixed(1)} GB of memory headroom exists`;
  }
  if (c.compute === "npu" || c.compute === "hybrid") {
    // A stale/absent sample reads as null (unknown): unknown does NOT reject —
    // it just cannot promise a free device, and deviceNotes says so.
    if (input.contention.npuBusy === true) return "the NPU is busy with another owned task";
  }
  if (c.compute === "gpu" && input.contention.gpuBusy === true) return "the GPU is busy with another workload";
  return null;
}

/** One line on what the monitoring could and could not see. */
function deviceNotes(input: Pick<SelectionInput, "contention" | "battery">): string {
  const parts: string[] = [];
  if (input.contention.npuBusy === null) parts.push("NPU activity unknown (no fresh counter)");
  if (input.contention.gpuBusy === null) parts.push("GPU activity unknown (no fresh counter)");
  if (!input.contention.samplesFresh) parts.push("monitoring samples are stale");
  const b = input.battery;
  if (!b || b.onMains === null) parts.push("power state unknown");
  else parts.push(b.onMains ? "on AC power" : `on battery${b.percent !== null ? ` (${b.percent}%)` : ""}`);
  return parts.join("; ");
}

/** The user-facing one-liner: "GenieX · CPU + NPU · selected from this device's measurements". */
export function describeSelection(sel: Selection): string {
  if (!sel.config) return sel.reason.join(" — ");
  const head = `${ENGINE_LABEL[sel.config.engine]} · ${COMPUTE_LABEL[sel.config.compute]}`;
  return sel.provisional ? `${head} · provisional` : `${head} · selected from this device's measurements`;
}
