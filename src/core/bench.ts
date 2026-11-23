import type { CatalogEntry } from "../shared/types";
import { CATALOG } from "./catalog";
import { DynamicData, TaskCategory } from "./dynamic";
import type { Placement } from "./placement";
import { BENCH_SECTIONS, BENCH_TESTS, BenchMode, BenchSection, BenchTest, SECTION_INFO, TEST_COUNT, testsFor } from "./benchTests";
import { CANDIDATES, Candidate } from "./benchCandidates";
import { TestCost } from "./benchEstimate";
import { coverage } from "./benchStats";
import { normalizeName } from "./foundry";
import { mdCell } from "./escape";

/**
 * The model benchmark (Settings, Developer settings): installs each candidate in turn, runs a large set of tests on the NPU,
 * scores the answers with checks that need no judge (exact values, formats, code that is run, facts), records the speed
 * (time to first token, tokens per second), keeps every raw answer, writes one result file per model and uninstalls it to
 * make room. This file is the pure part: results, roster and reports. The tests are in benchTests.ts, the loop in benchRunner.ts.
 */

export { BENCH_SECTIONS, BENCH_TESTS, SECTION_INFO, TEST_COUNT, testsFor };
export { estimateRun } from "./benchEstimate";
export { CANDIDATES };
export type { Candidate };
export type { BenchMode, BenchSection, BenchTest };

export interface TestResult {
  id: string;
  section: BenchSection;
  title: string;
  /** 0 to 1. */
  score: number;
  note: string;
  /** What the model answered, whole (the thinking is apart). */
  answer: string;
  /** What it thought before answering, whole. */
  thinking: string;
  /** How the test was asked: the answer limit and the thinking level. */
  asked: { maxTokens: number; effort: string | null };
  ttftSec: number | null;
  tokPerSec: number | null;
  tokens: number;
  /** True when `tokens` is the number of stream chunks, not the server's verified token usage (B13). */
  tokensEstimated?: boolean;
  totalSec: number;
  finish: string | null;
  skipped?: string;
  error?: string;
}

export interface ModelSummary {
  /** Mean score of the tests that ran, 0 to 100. */
  quality: number | null;
  ttftSec: number | null;
  tokPerSec: number | null;
  /** True when the tok/s median rests on stream-chunk counts, not the server's verified token usage. */
  tokPerSecEstimated?: boolean;
  /** Score by section, 0 to 100. */
  bySection: Partial<Record<BenchSection, number>>;
  /** Tests that ran (answered, scored or errored). */
  ran: number;
  failed: number;
  /** Tests skipped (window too small, tool missing...): they ran no tokens and score nothing. */
  skipped: number;
  /** How many tests the mode planned for this model; null when the plan was not recorded (older results). */
  planned: number | null;
}

/** What the launch check measured. Prefill is the prompt read per second (the NPU is far better at it than at writing), from the long prompt. */
export interface LaunchStats {
  tokPerSec: number | null;
  ttftSec: number | null;
  window: number | null;
  prefillTokPerSec?: number | null;
  /** The prefill figure rests on an estimate of the prompt's length (the server did not say it). */
  prefillEstimated?: boolean;
  /** B13: the tok/s rests on stream-chunk counts (the server sent no token usage) — an estimate, never verified throughput. */
  tokensEstimated?: boolean;
  energy?: import("./battery").Energy | null;
}

export interface ModelResult {
  key: string;
  name: string;
  ref: string;
  sizeGB: number;
  paramsB: number | null;
  /** Where the model comes from ("Dynamic 4B", "Catalog"). */
  source: string;
  thinking: "toggle" | "always" | "none";
  mode: BenchMode;
  startedAt: string;
  finishedAt: string | null;
  /** The model was already installed before the run (also set when the install call found the cache already holding it). */
  wasInstalled: boolean;
  /** False when the installed-models inventory could not be read: installed state was unknown, not negative. */
  inventoryKnown?: boolean;
  /** This run demonstrably downloaded the artifact: only then may cleanup remove it. */
  ownedInstall?: boolean;
  installSec: number | null;
  /** The first request, which includes loading the model onto the NPU. */
  coldStartSec: number | null;
  npuMemGB: number | null;
  /** The repo the model was finally tested from, and every repo tried before it. */
  repo?: string;
  triedRepos?: string[];
  /** Why the model could not be tested (or not to the end), in a few words. */
  skipReason?: string;
  /** The setting (window, NPU sessions, buffer size) under which the model loaded when it did not load as the app starts it. */
  loadSetting?: string;
  /** Request fields this model's engine refused (and that were then left out): what the engine does not accept. */
  refused?: string[];
  /** Launch check: the model loaded and answered a real prompt. */
  launched?: boolean;
  /** What the launch check measured: the answer to a prompt of about 1500 tokens, and the window the server was started with. */
  launch?: LaunchStats;
  /** On the mains or on the battery when it was measured: the energy figure only exists on the battery. */
  power?: "battery" | "mains" | "unknown";
  /** Minutes into the run when this model started its tests: the NPU may be warmer, or slower, later in a long run. */
  runOffsetMin?: number;
  /** Whether it ran on the NPU or the CPU, measured while it answered. */
  placement?: Placement;
  /**
   * B03: the model reference the SERVED server reported (its own spelling of the artifact),
   * the context window it actually served, and how that window is determined. Requests are
   * named with the served model, and every window-dependent figure quotes servedContext —
   * never the catalog's recommendation.
   */
  servedModel?: string;
  servedContext?: number | null;
  contextKind?: "compiled" | "configurable" | null;
  /** The engine that served the model ("GenieX", "Foundry Local"). */
  backend?: string;
  /**
   * B04: what identifies the WORK this result holds — suite version, mode, artifact and
   * engine. Resume skips a model only when a finished result with THIS fingerprint exists.
   */
  fingerprint?: string;
  /** How many tests this mode planned for the model (B09: coverage is judged against the plan). */
  planned?: number | null;
  /**
   * B10: the fixed-workload repeated speed measurement (one warm-up write, then measured
   * repetitions of the same prompt with fixed sampling), separate from the quality tests.
   */
  speedTrack?: SpeedTrack;
  tests: TestResult[];
  summary: ModelSummary;
  error?: string;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 100) / 100;
};
const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 10;

export function summarize(tests: TestResult[], planned?: number | null): ModelSummary {
  const ran = tests.filter((t) => !t.skipped);
  const scored = ran.filter((t) => !t.error);
  const by: Partial<Record<BenchSection, number[]>> = {};
  for (const t of ran) (by[t.section] ??= []).push(t.score);
  // speed is taken from the short tests: the long texts measure reading, not answering
  const speedy = scored.filter((t) => t.section !== "long_context");
  // B13: only the server's verified token usage is a measurement of writing speed; a
  // chunk-derived rate is an estimate and is labeled as one (never silently the same figure).
  const verified = speedy.filter((t) => !t.tokensEstimated);
  const verifiedTok = verified.map((t) => t.tokPerSec).filter((x): x is number => x !== null);
  const estimatedTok = speedy.map((t) => t.tokPerSec).filter((x): x is number => x !== null);
  const tokPerSec = verifiedTok.length ? median(verifiedTok) : median(estimatedTok);
  return {
    // the sections count equally, whatever their number of tests (code has many, a quick reply has one)
    quality: ran.length ? mean(Object.values(by).map((v) => mean(v!) / 100)) : null,
    ttftSec: median(speedy.map((t) => t.ttftSec).filter((x): x is number => x !== null)),
    tokPerSec,
    tokPerSecEstimated: !verifiedTok.length && estimatedTok.length > 0,
    bySection: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, mean(v!)])) as Partial<Record<BenchSection, number>>,
    ran: ran.length,
    failed: ran.filter((t) => t.error).length,
    skipped: tests.filter((t) => t.skipped).length,
    // the plan recorded for the run; without one (older results, direct calls) the tests given ARE the plan
    planned: planned ?? tests.length
  };
}

/**
 * B09: coverage of one model's result, from the recorded plan — defined in
 * benchStats.ts (so the renderer's graphs can read it without pulling in the
 * Node-side test definitions) and re-exported here for the runner and the reports.
 */
export { coverage } from "./benchStats";

// ------------------------------------------------------------------ the roster

/**
 * B04: the version of the suite itself. Bump it when the tests, the scoring or the
 * mode definitions change: results of an older suite keep their place in history but
 * no longer satisfy Resume — their coverage is not the coverage this version plans.
 */
export const SUITE_VERSION = "suite-2026-11-06";

/** The engine a target runs on, as the fingerprint records it. */
const engineOfTarget = (t: { engine?: string }): string => (t.engine === "foundry" ? "foundry-local" : "geniex");

/**
 * B04: what a result must match for Resume to skip the model: the suite version, the
 * requested mode, the exact artifact (repo + precision — another quant is another
 * artifact) and the engine. The load setting and the served window are discovered
 * during loading, so they are recorded on the result but not required to match: a
 * resumed run re-loads the model and records what it actually gets.
 */
export function runFingerprint(t: { repo?: string; bundleRef?: string; quant?: string | null; engine?: string }, mode: BenchMode): string {
  const engine = t.engine === "foundry" ? "foundry-local" : "geniex";
  return [SUITE_VERSION, mode, engine, (t.bundleRef ?? t.repo ?? "").toLowerCase(), t.quant ?? ""].join("|");
}

// ------------------------------------------------------------------ the fixed-workload speed track

/** One repetition of the fixed-workload speed measurement. */
export interface SpeedRep {
  /** 0 = the warm-up write (not measured as a result), 1..n = measured repetitions. */
  i: number;
  /** "cold" for the first measured repetition (prompt cache empty), "warm" after it. */
  cacheState: "cold" | "warm";
  tokens: number;
  /** True when `tokens` is a stream-chunk count, not the server's verified usage. */
  tokensEstimated: boolean;
  ttftSec: number | null;
  tokPerSec: number | null;
  totalSec: number;
}

/** B10: a controlled, repeated measurement of raw writing speed — one fixed prompt, fixed sampling, fixed output budget, recorded context and cache state. */
export interface SpeedTrack {
  /** The fixed prompt every repetition is asked. */
  prompt: string;
  /** The fixed output-token budget. */
  maxTokens: number;
  /** The fixed sampling: greedy, seeded, so repetitions measure the runtime, not the sampling. */
  sampling: { temperature: number; top_p: number; seed: number };
  /** The context window the server actually served during the measurement. */
  context: number | null;
  /** The measured repetitions, in order (the warm-up write is i = 0). */
  reps: SpeedRep[];
  /** Median tokens/s of the warm, VERIFIED repetitions (null when none could be measured). */
  medianTokPerSec: number | null;
  /** Spread of the warm verified repetitions: (max − min) / median, in percent. */
  spreadPct: number | null;
  /** Why the measurement is missing or partial. */
  note?: string;
}

export interface BenchTarget {
  key: string;
  name: string;
  repo: string;
  quant: string | null;
  sizeGB: number;
  paramsB: number | null;
  source: string;
  /** Other repos that hold the same model in the same quant, tried in order when `repo` will not install or load. */
  altRepos?: string[];
  /** The Dynamic bundle model, when it comes from a pack. */
  bundleRef?: string;
  /** The catalog / custom entry, when it already exists. */
  entryId?: string;
  job?: string;
  /** What a specialist is known for, from its model card. */
  specialty?: string;
  /** "foundry": the model is run by Microsoft Foundry Local instead of GenieX, to compare the two engines on the same model. */
  engine?: "foundry";
  foundryAlias?: string;
  foundryModelId?: string;
  /** The hardware of the Foundry Local build (NPU, GPU, CPU). */
  foundryDevice?: string;
  /** For a Foundry Local target: the key of the same model in the GenieX roster. */
  twinOf?: string;
}

/**
 * The STANDARD entries only, as the benchmark roster is meant to hold: the built-in
 * catalog (the GenieX / AI Hub store models), the models an installed Dynamic pack saved
 * (`dynamicRef`), and the Foundry Local models. A model the user resolved from Hugging
 * Face, Docker or ModelScope never enters a benchmark run.
 */
export function standardBenchEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return entries.filter((e) => CATALOG.some((c) => c.id === e.id) || !!e.dynamicRef || e.id.startsWith("foundry:"));
}

/**
 * Every model worth testing on this PC, each once, none heavier than `maxSizeGB`. Nothing
 * is hidden or filtered by the badge: the benchmark is how to find out. The roster holds
 * ONLY standard models — the Dynamic packs, the built-in catalog and Foundry Local, as the
 * caller filters `entries`; no Hugging Face, custom or specialist list is added unless the
 * caller passes one in `extra` (the app no longer does).
 */
export function buildRoster(data: DynamicData, entries: CatalogEntry[], maxSizeGB: number, maxParamsB = 9.5, extra: Candidate[] = []): BenchTarget[] {
  const seen = new Set<string>();
  const out: BenchTarget[] = [];
  const id = (repo: string, quant: string | null) => `${repo}:${quant ?? ""}`.toLowerCase();
  for (const pack of Object.values(data.packs).filter((p) => p.maxParamsB <= maxParamsB).sort((a, b) => a.maxParamsB - b.maxParamsB)) {
    for (const m of pack.models) {
      const k = id(m.repo, m.quant);
      if (m.foundryOnly || seen.has(k) || m.sizeGB > maxSizeGB) continue;
      seen.add(k);
      out.push({ key: m.ref, name: m.name, repo: m.repo, quant: m.quant, sizeGB: m.sizeGB, paramsB: m.paramsB, source: `Dynamic ${pack.label}`, altRepos: m.altRepos, bundleRef: m.ref, job: m.job });
    }
  }
  for (const e of entries) {
    const k = id(e.repo, e.quant);
    if (seen.has(k) || e.excluded || e.sizeGB > maxSizeGB || (e.paramsB ?? 0) > maxParamsB) continue;
    seen.add(k);
    // a Foundry entry keeps its engine identity on the target: the fingerprint records
    // WHICH engine ran the model, and the window's engine-comparison button selects it
    const foundry = e.id.startsWith("foundry:") ? { engine: "foundry" as const, foundryDevice: e.foundryDevice } : {};
    out.push({ key: e.id, name: e.name, repo: e.repo, quant: e.quant, sizeGB: e.sizeGB, paramsB: e.paramsB ?? null, source: CATALOG.some((c) => c.id === e.id) ? "Catalog" : "Custom", entryId: e.id, job: e.role, ...foundry });
  }
  // the specialists: models acclaimed for one kind of work (translation, tool calling, maths, code, extraction, medicine...)
  for (const c of extra) {
    const k = id(c.repo, c.quant);
    if (seen.has(k) || c.sizeGB > maxSizeGB || (c.paramsB ?? 0) > maxParamsB) continue;
    seen.add(k);
    out.push({ key: `spec:${slug(c.name)}`, name: c.name, repo: c.repo, quant: c.quant, sizeGB: c.sizeGB, paramsB: c.paramsB, source: "Specialists", altRepos: c.altRepos, specialty: c.specialty });
  }
  // a Foundry target names the GenieX target of the SAME model, when the roster holds one:
  // the two together are the engine-comparison pair (twinOf is the pairing key)
  const geniex = new Map<string, BenchTarget>();
  for (const t of out) if (t.engine !== "foundry") { const k = normalizeName(t.name); if (!geniex.has(k)) geniex.set(k, t); }
  for (const t of out) {
    if (t.engine !== "foundry") continue;
    t.foundryAlias = t.repo;
    t.twinOf = geniex.get(normalizeName(t.name))?.key;
  }
  return out;
}

/** What the window needs to estimate a run, for each test set. */
export const testCosts = (mode: BenchMode): TestCost[] => testsFor(mode).map((t) => ({ maxTokens: t.maxTokens, think: t.think, minContext: t.minContext }));

/** The few kinds of failure a model can have, from the message of the error: what the report and the window say instead of a stack of words. */
export function classifyFailure(msg: string): string {
  if (/does not fit|fit in NPU memory|over this machine|too big/i.test(msg)) return "too big for the NPU memory";
  if (/disk space/i.test(msg)) return "not enough disk space";
  if (/install failed|download|not found|404|network/i.test(msg)) return "download failed";
  if (/too slow/i.test(msg)) return "too slow to test";
  if (/time budget/i.test(msg)) return "took too long";
  if (/did not start|not ready|ECONNREFUSED|fetch failed|server|no answer after|did not answer|warm-up failed|could not load/i.test(msg)) return "did not load";
  if (/three tests in a row/i.test(msg)) return "kept failing";
  if (/no test could run/i.test(msg)) return "no test could run";
  return "failed";
}

/** A file-name-safe version of a model name. */
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "model";

// ------------------------------------------------------------------ the reports

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n.toFixed(0));
const num = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "–" : n.toFixed(d));
const cell = (s: string) => mdCell(s).replace(/\n/g, " ");
const SECTION_IDS = BENCH_SECTIONS.map((s) => s.id);
const sectionsOf = (rs: ModelResult[]) => SECTION_IDS.filter((s) => rs.some((r) => r.summary.bySection[s] !== undefined));

function ranked(rs: ModelResult[], s: BenchSection) {
  return rs.filter((r) => r.summary.bySection[s] !== undefined)
    .sort((a, b) => (b.summary.bySection[s]! - a.summary.bySection[s]!) || ((b.summary.tokPerSec ?? 0) - (a.summary.tokPerSec ?? 0)));
}

/** Pearson correlation of two score lists, null when it cannot be told. */
export function correlation(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 4) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Pairs of sections that rank the models alike: testing both says little more than testing one. */
export function redundantSections(rs: ModelResult[], threshold = 0.9): { a: BenchSection; b: BenchSection; r: number }[] {
  const secs = sectionsOf(rs);
  const out: { a: BenchSection; b: BenchSection; r: number }[] = [];
  for (let i = 0; i < secs.length; i++) for (let j = i + 1; j < secs.length; j++) {
    const both = rs.filter((m) => m.summary.bySection[secs[i]] !== undefined && m.summary.bySection[secs[j]] !== undefined);
    const r = correlation(both.map((m) => m.summary.bySection[secs[i]]!), both.map((m) => m.summary.bySection[secs[j]]!));
    if (r !== null && r >= threshold) out.push({ a: secs[i], b: secs[j], r: Math.round(r * 100) / 100 });
  }
  return out.sort((x, y) => y.r - x.r);
}

/** For each Dynamic kind of work, the models that did best in the sections that inform it. */
export function suggestTable(rs: ModelResult[]): Partial<Record<TaskCategory, { name: string; score: number }[]>> {
  const byCat = new Map<TaskCategory, BenchSection[]>();
  for (const s of BENCH_SECTIONS) byCat.set(s.dynamic, [...(byCat.get(s.dynamic) ?? []), s.id]);
  const out: Partial<Record<TaskCategory, { name: string; score: number }[]>> = {};
  for (const [cat, secs] of byCat) {
    const rows = rs.map((r) => {
      const v = secs.map((s) => r.summary.bySection[s]).filter((x): x is number => x !== undefined);
      return { name: r.name, score: v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : -1, tok: r.summary.tokPerSec ?? 0 };
    }).filter((x) => x.score >= 0).sort((a, b) => b.score - a.score || b.tok - a.tok);
    if (rows.length) out[cat] = rows.slice(0, 3).map(({ name, score }) => ({ name, score }));
  }
  return out;
}

/** The summary of a run as Markdown: the table of models, the best for each section, and what it suggests for Dynamic. */
export function buildReport(results: ModelResult[], meta: { startedAt: string; machine?: string; mode: string }): string {
  const done = results.filter((r) => r.summary.ran > 0).sort((a, b) => (b.summary.quality ?? 0) - (a.summary.quality ?? 0));
  // B09: only COMPLETE runs (every planned test ran or was skipped for a recorded reason,
  // no early error) are ranked against each other — a model cut short by a budget or an
  // error must not top a table as if it had passed the same suite.
  const complete = done.filter((r) => coverage(r).complete);
  const partial = done.filter((r) => !coverage(r).complete);
  const rankedPool = complete.length >= 2 ? complete : done;
  const poolNote = complete.length >= 2
    ? ""
    : `Less than two complete results: the ranking below mixes ${done.length} partial result${done.length === 1 ? "" : "s"} and compares only the tests that actually ran.`;
  const secs = sectionsOf(rankedPool);
  const cov = (r: ModelResult) => {
    const c = coverage(r);
    return `${c.attempted + c.skipped}/${c.planned}${c.complete ? "" : " partial"}`;
  };
  const L: string[] = [`# MKMN benchmark`, "", `Run started ${meta.startedAt} · ${meta.mode} test set · ${done.length} model${done.length === 1 ? "" : "s"}${meta.machine ? ` · ${meta.machine}` : ""}`, ""];
  L.push("Scores are 0 to 100: the share of each test's checks that held (exact values, formats, code that was run, facts). Quality is the mean of the sections, so a section with many tests does not outweigh the others. Speeds are medians over the short tests, measured on the NPU. Cold start is the first request, which loads the model. Every raw answer is in the model's own file and in `sections/`.", "");
  L.push("## Models", "", "| Model | Runs on | Size | Coverage | Quality | First token (s) | Tokens/s | Cold start (s) | Install (s) | Failed tests |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const r of done) L.push(`| ${cell(r.name)} | ${(r.placement?.runsOn ?? "unknown").toUpperCase()} | ${num(r.sizeGB)} GB | ${cov(r)} | ${pct(r.summary.quality)} | ${num(r.summary.ttftSec, 2)} | ${num(r.summary.tokPerSec)} | ${num(r.coldStartSec)} | ${r.installSec === null ? "already there" : num(r.installSec, 0)} | ${r.summary.failed} |`);
  if (poolNote) L.push("", poolNote);
  L.push("", "## Best model for each section", "", "| Section | 1st | 2nd | 3rd |", "|---|---|---|---|");
  for (const s of secs) {
    const rk = ranked(rankedPool, s);
    const c = (r?: ModelResult) => (r ? `${cell(r.name)} (${pct(r.summary.bySection[s])}, ${num(r.summary.tokPerSec)} tok/s)` : "");
    L.push(`| ${SECTION_INFO[s].group}: ${SECTION_INFO[s].label} | ${c(rk[0])} | ${c(rk[1])} | ${c(rk[2])} |`);
  }
  L.push("", "## Scores by section", "", `| Model | ${secs.map((s) => SECTION_INFO[s].label).join(" | ")} |`, `|---|${secs.map(() => "---").join("|")}|`);
  for (const r of done) L.push(`| ${cell(r.name)} | ${secs.map((s) => pct(r.summary.bySection[s])).join(" | ")} |`);
  const sug = suggestTable(rankedPool);
  if (Object.keys(sug).length) {
    L.push("", "## What this suggests for Dynamic", "", "For each kind of work Dynamic sorts requests into: the best models over the sections that inform it. Compare with the packs' tables in Developer settings (a pack only uses models of its own size).", "", "| Kind of work | 1st | 2nd | 3rd |", "|---|---|---|---|");
    for (const [cat, rows] of Object.entries(sug)) L.push(`| ${cat} | ${[0, 1, 2].map((i) => (rows![i] ? `${cell(rows![i].name)} (${rows![i].score})` : "")).join(" | ")} |`);
  }
  if (done.length >= 5) {
    const red = redundantSections(rankedPool);
    L.push("", "## Sections that tell the same story", "");
    L.push(red.length ? "These pairs ranked the models almost identically (correlation ≥ 0.9 over the models tested), so a later run could test only one of each:" : "No two sections ranked the models alike: each section told something the others did not.", "");
    for (const p of red.slice(0, 20)) L.push(`- ${SECTION_INFO[p.a].label} ↔ ${SECTION_INFO[p.b].label}: r = ${p.r}`);
  }
  if (partial.length) {
    L.push("", "## Partial results (not ranked)", "", "These models were cut short (a budget, an error or fewer tests than planned): their scores cover only the tests that ran and are kept out of the rankings above.", "");
    for (const r of partial) L.push(`- ${r.name}: ${cov(r)}${r.skipReason ? ` — ${r.skipReason}` : ""}${r.error ? ` — ${r.error}` : ""}`);
  }
  const failed = results.filter((r) => r.error || r.summary.ran === 0);
  if (failed.length) { L.push("", "## Not fully tested", ""); for (const r of failed) L.push(`- ${r.name}: ${r.skipReason ? `${r.skipReason}. ` : ""}${r.error ?? "no test ran"}`); }
  L.push("");
  return L.join("\n");
}

const fenceOf = (s: string) => { let f = "```"; while (s.includes(f)) f += "`"; return f; };

/** The detail of one model: each test, its score, its speed, and the raw answer (and thinking). */
export function buildModelReport(r: ModelResult): string {
  const s = r.summary;
  const c = coverage(r);
  const out = [
    `# ${r.name}`, "",
    `${r.source} · ${num(r.sizeGB)} GB · ${r.ref} · thinking: ${r.thinking}`,
    r.servedModel ? `Served as \`${r.servedModel}\`${r.backend ? ` on ${r.backend}` : ""}, window ${r.servedContext ?? "unknown"} tokens${r.contextKind ? ` (${r.contextKind} context)` : ""}.` : "",
    `Coverage ${c.attempted + c.skipped}/${c.planned} (${c.scored} scored, ${c.failed} failed, ${c.skipped} skipped)${c.complete ? " · complete" : " · PARTIAL: not comparable with complete runs"}.`,
    `Quality ${pct(s.quality)}/100 · first token ${num(s.ttftSec, 2)} s · ${num(s.tokPerSec)} tokens/s${s.tokPerSecEstimated ? " (estimated: the server sent no token usage, the figure counts stream chunks)" : ""} · cold start ${num(r.coldStartSec)} s${r.npuMemGB !== null ? ` · NPU memory ${num(r.npuMemGB)} GB` : ""}${r.installSec !== null ? ` · installed in ${num(r.installSec, 0)} s` : ""}`,
    r.placement ? `**Runs on: ${r.placement.runsOn.toUpperCase()}** (asked for ${r.placement.asked.toUpperCase()}): ${r.placement.evidence.join("; ")}.` : "",
    r.error ? `\n**Stopped early:** ${r.error}` : "", "",
    "| Section | Test | Score | First token | Tokens/s | Tokens | Finish | Note |", "|---|---|---|---|---|---|---|---|"
  ];
  for (const t of r.tests) out.push(`| ${SECTION_INFO[t.section].label} | ${cell(t.title)} | ${t.skipped ? "skipped" : pct(t.score * 100)} | ${num(t.ttftSec, 2)} | ${num(t.tokPerSec)}${t.tokensEstimated ? " (est.)" : ""} | ${t.tokens}${t.tokensEstimated ? " (chunks)" : ""} | ${t.finish ?? "–"} | ${cell(t.skipped ?? t.error ?? t.note)} |`);
  if (r.speedTrack) {
    const st = r.speedTrack;
    out.push("", "## Fixed-workload speed (repeated measurement)", "", `The same prompt asked ${st.reps.filter((x) => x.i > 0).length} times (after one warm-up write), greedy and seeded, output budget ${st.maxTokens} tokens, window ${st.context ?? "unknown"} tokens. This is the controlled speed figure; the per-test speeds above measure the real tasks.`, "", "| Rep | Cache | Tokens | First token (s) | Tokens/s | Time (s) |", "|---|---|---|---|---|---|");
    for (const rep of st.reps) out.push(`| ${rep.i === 0 ? "warm-up" : rep.i} | ${rep.cacheState} | ${rep.tokens}${rep.tokensEstimated ? " (chunks)" : ""} | ${num(rep.ttftSec, 2)} | ${rep.i === 0 ? "–" : num(rep.tokPerSec)} | ${num(rep.totalSec, 2)} |`);
    out.push("", `Median of the warm measured repetitions: ${st.medianTokPerSec === null ? "not measured" : `${st.medianTokPerSec} tokens/s (spread ${st.spreadPct === null ? "–" : `${st.spreadPct}%`})`}.`, "");
  }
  out.push("", "## Raw answers", "");
  for (const t of r.tests.filter((x) => !x.skipped)) {
    const f = fenceOf(t.answer + t.thinking);
    out.push(`### ${SECTION_INFO[t.section].label}: ${t.title} (${t.error ? "error" : pct(t.score * 100)})`, "", t.error ? `Error: ${t.error}` : `${t.note}`, "");
    if (!t.error) out.push(f + "text", t.answer || "(empty)", f, "");
    if (t.thinking) out.push("<details><summary>Thinking</summary>", "", f + "text", t.thinking, f, "", "</details>", "");
  }
  return out.join("\n");
}

/** One section across all the models: for each test, every model's score and raw answer, so they can be compared side by side. */
export function buildSectionReport(section: BenchSection, rs: ModelResult[]): string {
  const info = SECTION_INFO[section];
  const tests = BENCH_TESTS.filter((t) => t.section === section);
  const rk = ranked(rs, section);
  const out = [`# ${info.group}: ${info.label}`, "", `Informs the Dynamic kind of work "${info.dynamic}". Tests: ${tests.map((t) => t.title).join("; ")}.`, "", "| Rank | Model | Section score | Tokens/s |", "|---|---|---|---|"];
  rk.forEach((r, i) => out.push(`| ${i + 1} | ${cell(r.name)} | ${pct(r.summary.bySection[section])} | ${num(r.summary.tokPerSec)} |`));
  for (const t of tests) {
    const prompt = t.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n---\n\n");
    const f = fenceOf(prompt);
    out.push("", `## ${t.title}`, "", f + "text", prompt.length > 3000 ? prompt.slice(0, 3000) + "\n… (cut)" : prompt, f, "");
    for (const r of rs) {
      const x = r.tests.find((y) => y.id === t.id);
      if (!x || x.skipped) continue;
      const g = fenceOf(x.answer);
      out.push(`### ${r.name}: ${x.error ? "error" : pct(x.score * 100)}`, "", x.error ?? x.note, "", g + "text", x.answer || "(empty)", g, "");
    }
  }
  return out.join("\n");
}
