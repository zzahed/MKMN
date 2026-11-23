/**
 * Does a model really run on the NPU? GenieX is started with --compute npu, but that is a request, not proof: a model that
 * cannot be placed may fall back to the CPU. Proof comes from measuring while the model generates: the NPU's own counters
 * (utilization, memory taken since before the model was loaded) and how busy the CPU is. Several signals are combined because
 * any one can be missing (no NPU counters on this PC) or misleading.
 */
export type RunsOn = "npu" | "cpu" | "mixed" | "unknown";

export interface PlacementInput {
  /** What the server was asked: --compute npu or cpu. */
  asked: "npu" | "cpu";
  /** Peak NPU utilization seen during generation, null when Windows gives no counter. */
  npuUtilPeak: number | null;
  /** NPU memory in use during generation minus before the model was loaded, GB; null without counters. */
  npuMemDeltaGB: number | null;
  /** Share of all CPU cores busy during generation, 0 to 100. */
  cpuBusyPct: number | null;
  /** What the server's own log says about where the model was loaded. */
  logHint: "npu" | "cpu" | null;
  sizeGB: number;
  /** Whether generation succeeded and produced output tokens. */
  generationSuccess?: boolean | null;
  /** Number of output tokens generated. */
  generatedTokens?: number | null;
}

export interface Placement extends PlacementInput {
  runsOn: RunsOn;
  /** Why, in short sentences. */
  evidence: string[];
}

const CPU_BUSY = 55;
const NPU_UTIL = 8;

/**
 * Reads the server log for where the layers went. The wording is a guess at llama.cpp / GenieX output, matched loosely.
 * A log line that only MENTIONS a device proves nothing — a failed HTP initialization ("ggml-hex backend failed to
 * initialize") names the NPU but ran on nothing. Failure lines are excluded from the evidence before matching.
 */
export function logPlacement(lines: string[]): "npu" | "cpu" | null {
  // A line that says a backend failed (to initialize, to load) is evidence of a FAILED
  // attempt, never of where execution ran; "falling back to cpu" lines are kept as the
  // CPU evidence they are.
  const evidence = lines.filter((l) => !/fail(?:ed)?[^\n]{0,80}(initialize|init\b|load|create)|failed to initialize/i.test(l));
  const text = evidence.join("\n");
  const npu = /ggml-hex|hexagon|\bhtp\b|\bqnn\b|\bdsp\b|htp graph loaded|device:\s*htp|offload(?:ed|ing)[^\n]*(?:npu|hexagon)|backend[^\n]*npu/i.test(text);
  const cpu = /(?:compute|backend|device)[^\n]*\bcpu\b(?!.*npu)|falling back to cpu|fallback to cpu|using cpu\b/i.test(text);
  if (npu && !cpu) return "npu";
  if (cpu && !npu) return "cpu";
  return null;
}

export function judgePlacement(i: PlacementInput): Placement {
  const ev: string[] = [];
  if (i.generationSuccess === false || (i.generatedTokens !== undefined && i.generatedTokens !== null && i.generatedTokens <= 0)) {
    ev.push("Inference failed or generated 0 tokens: cannot certify NPU execution");
    return { ...i, runsOn: "unknown", evidence: ev };
  }
  const haveCounters = i.npuUtilPeak !== null || i.npuMemDeltaGB !== null;
  const memNeed = Math.min(0.3, Math.max(0.1, i.sizeGB * 0.15));
  const npuSignal = (i.npuUtilPeak ?? 0) >= NPU_UTIL || (i.npuMemDeltaGB ?? 0) >= memNeed;
  // Whole-system CPU busy is EVERY process's activity, not the model's: other
  // applications (a browser, an indexer) can hold it at 90% while the model sits
  // on the NPU. It can never downgrade affirmative NPU counter evidence, and on
  // its own it cannot certify CPU execution of the model.
  const cpuHeavy = (i.cpuBusyPct ?? 0) >= CPU_BUSY;
  if (i.npuUtilPeak !== null) ev.push(`NPU utilization peaked at ${Math.round(i.npuUtilPeak)}%`);
  if (i.npuMemDeltaGB !== null) ev.push(`NPU memory grew by ${i.npuMemDeltaGB.toFixed(1)} GB when the model loaded`);
  if (!haveCounters) ev.push("Windows gave no NPU counters, so the NPU could not be measured directly");
  if (i.cpuBusyPct !== null) ev.push(`system CPU was ${Math.round(i.cpuBusyPct)}% busy while it answered (all processes, not attributed to the model)`);
  if (i.logHint) ev.push(`the server log mentions the ${i.logHint === "npu" ? "NPU / Hexagon" : "CPU"}`);
  if (i.asked === "cpu") ev.push("the server was started with --compute cpu");
  let runsOn: RunsOn;
  if (i.asked === "cpu") {
    // the CPU was asked for explicitly: busy CPU corroborates it, NPU counters contradict it
    runsOn = cpuHeavy || (!npuSignal && haveCounters) ? "cpu" : npuSignal ? "mixed" : "cpu";
  } else if (npuSignal) {
    // affirmative NPU evidence: whole-system CPU activity does not change where the
    // model ran (at most, hybrid execution put some tensors on the CPU — without a
    // per-process split that stays an unverified possibility, not a "mixed" verdict)
    runsOn = "npu";
  } else if (haveCounters) {
    // counters were present and showed no NPU activity while the model generated.
    // A busy system CPU only means SOME processes were busy (cpu); a quiet machine
    // with no NPU activity is unexplained — a log line that merely MENTIONS the
    // device is not execution evidence (B06), so the honest answer is "unknown".
    runsOn = cpuHeavy ? "cpu" : "unknown";
    if (runsOn === "unknown") ev.push("no NPU activity was measured and a device mention in the log is not execution evidence: placement unknown");
  } else {
    // no NPU counters at all: a busy system CPU says nothing about THIS model's device,
    // and a log mention of the NPU does not certify execution either. A log line that
    // says the model FELL BACK to the CPU, on the other hand, is decisive CPU evidence.
    runsOn = i.logHint === "cpu" ? "cpu" : "unknown";
    if (runsOn === "unknown") ev.push(i.logHint === "npu"
      ? "the log mentions the NPU but a mention is not proof of execution, and there are no counters: placement unknown"
      : "without NPU counters or a device line in the log, placement cannot be told from whole-system CPU activity alone");
  }
  return { ...i, runsOn, evidence: ev };
}

/** CPU busy share between two samples of os.cpus(), 0 to 100, over all cores. */
export function cpuBusy(a: { times: Record<string, number> }[], b: { times: Record<string, number> }[]): number | null {
  let busy = 0, total = 0;
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    const dt = (x: Record<string, number>) => Object.values(x).reduce((s, v) => s + v, 0);
    const idle = b[k].times.idle - a[k].times.idle;
    const all = dt(b[k].times) - dt(a[k].times);
    busy += all - idle;
    total += all;
  }
  return total > 0 ? Math.round((busy / total) * 1000) / 10 : null;
}
