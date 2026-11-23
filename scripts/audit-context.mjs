// Context-window audit: what context each model has, from every source of truth, kept separate.
//
// Columns and their meaning (never mixed):
//   declared max    — the model file's own trained window: `*.context_length` from a GGUF header
//   compiled limit  — what a QAIRT graph was compiled with: `dialog.context.size` of its genie_config.json
//   recommendation  — what the app's catalog/pack data recommends (a choice, NOT a measurement)
//   requested       — what the user/estimator asked the server to serve (settings nctxMode, the spawn's --nctx)
//   launch plan     — what the supervisor DECLARED before spawning ("GenieX capabilities …; served context N
//                     tokens" is written into the log BEFORE the process exists — it is a plan, never an observation)
//   readiness       — whether the REQUESTED model was seen in a running server's model list ("Requested model X
//                     is served"). This verifies the model identity, NOT the token limit.
//   observed served — what a server was SEEN serving as its context window: a served-context statement that NAMES
//                     its model, logged AFTER that model's readiness line, attributable to exactly one non-failed
//                     launch. Statements that name no model — or that several overlapping same-model launches could
//                     equally own — are LEFT UNKNOWN: file proximity and timestamp ordering are never evidence enough.
//                     Today the supervisor never writes such a line, so this stays UNKNOWN for every model — a plan,
//                     a request or a readiness line is never copied here.
//
// Evidence pairing correlates by REQUEST/PROCESS IDENTITY (the spawn's --model against the readiness line's
// model), then by timestamp: a readiness line only pairs with a spawn of the same model at or before its own
// timestamp, and never with a spawn already marked failed. Failed launches ("exited prematurely", "rejected
// the serve command line") mark their spawn; a retry spawn is a new record; a later failure after an earlier
// successful observation is reported as `lastAttempt`, it does not erase the observation. Lines from every log
// file are merged in timestamp order, so rotation and overlapping files are handled.
//
// Identity and cache locations follow the app's own rules (src/core/geniex.ts + src/core/modelIdentity.ts):
//   - canonical identity: `ai-hub-models/X` counts as `qualcomm/X` (lowercased) — one row per artifact
//   - models cache: `GENIEX_DATADIR\models` when the override is set, else `~\.cache\geniex\models`
//   - settings: `%LOCALAPPDATA%\MKMN\Config\settings.json`; custom models: `%APPDATA%\MKMN\custom-models.json`
// The GGUF header parser is a small standalone copy of src/core/gguf.ts (this script must run
// without a build, so it cannot import the maintained TS module); it reads the same fields
// (`general.architecture`, `<arch>.context_length`) and nothing else. Every supported scalar
// type, arrays and truncated headers are covered by tests/audit-context.test.ts — including an
// i16 field placed BEFORE the architecture/context keys (an earlier version advanced the cursor
// wrongly for i16 and corrupted everything after it).
// Output: docs/evidence/context-audit-<date>/context-audit.md (+ .json). Relative paths only; no user name, no document text.
//
// The pure parts (identity, log parsing, pairing) are exported so fixture tests can exercise them
// (tests/audit-context.test.ts); the report itself only runs when the script is executed directly.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// ---- the app's canonical identity and cache-location rules (mirrors of src/core/modelIdentity.ts + geniex.ts)
export const canonicalName = (s) => String(s ?? "").trim().toLowerCase().replace(/^ai-hub-models\//, "qualcomm/");
// A precision suffix (`org/model:q4_0`) names one file of the same model: the row is the model, not the file.
export const stripPrecision = (s) => String(s ?? "").replace(/:[^/:]*$/, "");

const GENIEX_DATADIR = process.env.GENIEX_DATADIR ?? null;
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };

// ---- GGUF header parsing (standalone copy of src/core/gguf.ts, same fields only)
const TYPES = { 0: "u8", 1: "i8", 2: "u16", 3: "i16", 4: "u32", 5: "i32", 6: "f32", 7: "bool", 8: "str", 9: "arr", 10: "u64", 11: "i64", 12: "f64" };
export { TYPES };
export function parseGguf(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "GGUF") throw new Error("not a GGUF file");
  let off = 4;
  const u32 = () => { const v = buf.readUInt32LE(off); off += 4; return v; };
  const u64 = () => { const v = buf.readBigUInt64LE(off); off += 8; return Number(v); };
  const str = () => { const n = u64(); const v = buf.toString("utf8", off, off + n); off += n; return v; };
  off += 4; // version
  u64(); // tensor count
  const kvCount = u64();
  const kv = {};
  const value = (t) => {
    switch (TYPES[t]) {
      case "u8": return buf[off++];
      case "i8": return buf.readInt8(off++);
      case "u16": { const v = buf.readUInt16LE(off); off += 2; return v; }
      case "i16": { const v = buf.readInt16LE(off); off += 2; return v; }
      case "u32": return u32();
      case "i32": { const v = buf.readInt32LE(off); off += 4; return v; }
      case "f32": { const v = buf.readFloatLE(off); off += 4; return v; }
      case "bool": return !!buf[off++];
      case "str": return str();
      case "u64": return u64();
      case "i64": { const v = buf.readBigInt64LE(off); off += 8; return Number(v); }
      case "f64": { const v = buf.readDoubleLE(off); off += 8; return v; }
      case "arr": { const t = u32(), n = u64(); for (let i = 0; i < n; i++) value(t); return null; } // arrays are skipped, cursor still advances
      default: throw new Error(`bad gguf type ${t}`);
    }
  };
  for (let i = 0; i < kvCount; i++) {
    const key = str();
    const t = u32();
    const v = value(t); // every value is walked, so the cursor always advances
    if (/general\.architecture$/.test(key)) kv[key] = v;
    else if (/\.context_length$/.test(key)) kv[key] = v;
  }
  return kv;
}
function ggufContext(file) {
  const fd = fs.openSync(file, "r");
  try {
    let size = 512 * 1024;
    for (;;) {
      const buf = Buffer.alloc(Math.min(size, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      try { return parseGguf(buf); } catch (e) {
        if (buf.length >= fs.fstatSync(fd).size || size >= 64 * 1024 * 1024) throw e;
        size *= 4;
      }
    }
  } finally { fs.closeSync(fd); }
}

// ---- log evidence: pure parsing and pairing (exported for the fixture tests)
/**
 * Turns log lines into evidence events, each with its timestamp and file:
 *   capabilities    — "GenieX capabilities: context kind K; served context N tokens" (a PRE-SPAWN plan)
 *   spawn           — "Spawning GenieX: … --model M --nctx N" (argv as a plain string or a quoted array)
 *   readiness       — "Requested model M is served; warming up." (the model was SEEN in a running server's list)
 *   launchFailed    — "exited prematurely" / "rejected the serve command line"
 *   contextConfirmed— a served-context statement that is NOT the pre-spawn capabilities line (post-readiness).
 *                     It carries `model` ONLY when the line itself names the model (`--model M` or "model/for M");
 *                     a statement that names no identity stays uncorrelated and is never attributed.
 */
export function parseLogEvents(lines, file) {
  const ts = (line) => Number(/^\[(\d+(?:\.\d+)?)\]/.exec(line)?.[1] ?? 0);
  const ev = [];
  for (const line of lines) {
    const cap = /GenieX capabilities: context kind ([\w-]+); served context (\d+) tokens/.exec(line);
    if (cap) { ev.push({ type: "capabilities", ts: ts(line), kind: cap[1], served: parseInt(cap[2], 10), file }); continue; }
    if (/Spawning GenieX:/i.test(line)) {
      const m = /--model[",\s]+([^\s",]+)/.exec(line) ?? /--model\s+([^\s"]+)/.exec(line);
      if (m) {
        const n = /--nctx[",\s]+(\d+)/.exec(line);
        ev.push({ type: "spawn", ts: ts(line), model: m[1], nctx: n ? parseInt(n[1], 10) : null, file });
      }
      continue;
    }
    const ready = /Requested model (.+?) is served/.exec(line);
    if (ready) { ev.push({ type: "readiness", ts: ts(line), model: ready[1], file }); continue; }
    if (/exited prematurely|rejected the serve command line/i.test(line)) { ev.push({ type: "launchFailed", ts: ts(line), file }); continue; }
    // a served-context statement that is NOT the pre-spawn capabilities line: a runtime confirmation.
    // Its identity is taken from the line itself only; an org/name-shaped token after "--model",
    // "model" or "for" — anything else (file name, timestamp, host:port) is never an identity.
    if (/served context (?:of )?(\d+) tokens/.test(line) && !/GenieX capabilities/.test(line)) {
      const served = parseInt(/served context (?:of )?(\d+) tokens/.exec(line)[1], 10);
      const ident = /--model[",\s]+([^\s",]+)/.exec(line) ?? /\b(?:model|for)\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+)/.exec(line);
      // the capture may end on sentence punctuation: strip it before canonicalizing
      const model = ident ? canonicalName(ident[1].replace(/[.,;]+$/, "")) : null;
      ev.push({ type: "contextConfirmed", ts: ts(line), served, model, file });
      continue;
    }
  }
  return ev;
}

/**
 * Pairs events into one record per spawn, requiring EXPLICIT identity for every attribution:
 *   - the capabilities line belongs to the NEXT spawn in the SAME file within 5s (the supervisor
 *     logs it immediately before, into the same stream);
 *   - a readiness line pairs with the most recent unconsumed spawn OF THE SAME MODEL at or before
 *     its timestamp — a spawn already marked failed never receives it (a failed launch did not serve);
 *   - a failure marks the most recent unconsumed, not-yet-served spawn of its file;
 *   - a post-readiness served-context statement confirms a window ONLY when the statement itself
 *     names the model AND exactly one readiness-verified, non-failed launch of that model precedes
 *     it. Zero candidates (no such launch) or several (overlapping same-model launches — which
 *     process spoke is not decidable) leave the statement unattributed. File proximity and
 *     timestamp ordering are never enough.
 * Returns the records plus the statements that could not be attributed, so the report can count
 * them instead of silently dropping them.
 */
export function pairEvidenceDetailed(events) {
  const records = [];
  const uncorrelated = []; // served-context statements that name no model identity
  const ambiguous = [];    // statements with an identity that no unique launch can own
  let pendingCap = null;
  for (const ev of events) {
    if (ev.type === "capabilities") { pendingCap = ev; continue; }
    if (ev.type === "spawn") {
      const rec = { model: canonicalName(ev.model), requested: ev.nctx, plannedServed: null, plannedKind: null, readiness: null, failed: false, served: null, servedEvidence: null, ts: ev.ts, file: ev.file };
      if (pendingCap && pendingCap.file === ev.file && Math.abs(ev.ts - pendingCap.ts) <= 5) { rec.plannedServed = pendingCap.served; rec.plannedKind = pendingCap.kind; pendingCap = null; }
      records.push(rec);
      continue;
    }
    if (ev.type === "launchFailed") {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].file === ev.file && records[i].ts <= ev.ts && !records[i].readiness && !records[i].failed) { records[i].failed = true; break; }
      }
      continue;
    }
    if (ev.type === "readiness") {
      const model = canonicalName(ev.model);
      let best = null;
      for (const r of records) if (r.model === model && r.readiness === null && !r.failed && r.ts <= ev.ts && (best === null || r.ts >= best.ts)) best = r;
      if (best) best.readiness = { ts: ev.ts, file: ev.file };
      continue;
    }
    if (ev.type === "contextConfirmed") {
      if (!ev.model) { uncorrelated.push(ev); continue; }
      const cands = records.filter((r) => r.model === ev.model && r.readiness !== null && !r.failed && r.served === null && r.readiness.ts <= ev.ts);
      if (cands.length === 1) {
        const r = cands[0];
        r.served = ev.served;
        r.servedEvidence = `${ev.file}: "served context ${ev.served} tokens" names ${ev.model}, logged after that model's readiness (${r.readiness.file})`;
      } else {
        ambiguous.push({ ts: ev.ts, file: ev.file, served: ev.served, model: ev.model, why: cands.length === 0 ? "no readiness-verified launch of this model precedes the statement" : `${cands.length} readiness-verified launches of this model precede it: which one served is not decidable` });
      }
      continue;
    }
  }
  return { records, uncorrelated, ambiguous };
}

/** The spawn records alone (the shape the fixture tests and applyEvidence use). */
export const pairEvidence = (events) => pairEvidenceDetailed(events).records;

/**
 * Writes each model's newest, best record into the audit rows (a readiness-verified record wins over
 * a plain one). A LATER failed launch never erases an earlier successful observation — but it is
 * reported separately (`lastAttempt`), so a model that used to serve and no longer starts reads
 * honestly. Pre-spawn configuration (the plan) and runtime confirmation (observed) stay separate.
 */
export function applyEvidence(models, records) {
  const byModel = new Map();
  const latestFailure = new Map();
  for (const rec of records) {
    const key = stripPrecision(rec.model);
    if (rec.failed && !rec.readiness) {
      const curF = latestFailure.get(key);
      if (!curF || rec.ts >= curF.ts) latestFailure.set(key, rec);
    }
    const cur = byModel.get(key);
    if (!cur) { byModel.set(key, rec); continue; }
    // a record with a readiness wins over one without; between equals, the newer one wins
    const recReady = rec.readiness !== null, curReady = cur.readiness !== null;
    if ((recReady && !curReady) || (recReady === curReady && rec.ts >= cur.ts)) byModel.set(key, rec);
  }
  for (const [key, rec] of byModel) {
    const r = models.get(key);
    if (!r) continue;
    if (rec.requested !== null) { r.requested = rec.requested; r.requestedSource = "the spawn's --nctx flag (app log)"; }
    if (rec.plannedServed !== null) { r.plannedServed = rec.plannedServed; r.planSource = `the supervisor's pre-spawn plan, context kind ${rec.plannedKind ?? "n/a"} (${rec.file})`; }
    r.readiness = rec.readiness ? `the requested model was seen served (${rec.readiness.file})` : (rec.failed ? "never seen served: the launch failed" : null);
    r.observed = rec.served; // stays null unless an identity-named, post-readiness statement exists
    r.evidence = rec.servedEvidence;
    r.launchFailed = rec.failed;
    const lf = latestFailure.get(key);
    if (lf && rec.readiness && lf.ts >= (rec.readiness?.ts ?? 0)) {
      r.lastAttempt = `a later launch attempt failed (${lf.file}); the observation above is from the earlier successful launch`;
    }
  }
}

// ---- one row per canonical model; every column filled only by its own kind of evidence
const rowShape = () => ({ identity: "", engine: null, quant: null, declared: null, compiled: null, recommendation: null, recSource: null, requested: null, requestedSource: null, plannedServed: null, planSource: null, readiness: null, observed: null, evidence: null, launchFailed: false, lastAttempt: null });

export function main() {
  const repo = path.resolve(import.meta.dirname, "..");
  const outDir = path.join(repo, "docs", "evidence", `context-audit-${new Date().toISOString().slice(0, 10)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const cacheRoot = GENIEX_DATADIR ? path.join(GENIEX_DATADIR, "models") : path.join(os.homedir(), ".cache", "geniex", "models");
  const settingsPath = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "MKMN", "Config", "settings.json") : null;
  const customPath = process.env.APPDATA ? path.join(process.env.APPDATA, "MKMN", "custom-models.json") : null;
  const logsDir = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "MKMN", "Logs") : null;
  // a relative display path with the home directory taken out (no user name in the report)
  const home = os.homedir();
  const display = (p) => p.startsWith(home) ? p.slice(home.length).replace(/^[\\/]/, "~/") : p;

  const models = new Map(); // key → row
  const rowOf = (key) => {
    key = stripPrecision(key);
    if (!models.has(key)) models.set(key, { ...rowShape(), identity: key });
    return models.get(key);
  };

  // ---- shipped catalog: recommendations (+ a compiled limit when the entry carries one)
  const catalog = readJson(path.join(repo, "src", "core", "catalog.json"), []);
  for (const e of Array.isArray(catalog) ? catalog : catalog.entries ?? []) {
    const r = rowOf(canonicalName(e.repo ?? e.id));
    r.engine = e.engine ?? r.engine;
    r.quant = e.quant ?? r.quant;
    r.recommendation = e.recommendedContext ?? r.recommendation;
    r.recSource = `catalog.json (${e.id}: recommendedContext)`;
    if (e.compiledContext) r.compiled = e.compiledContext; // the catalog's own claim; the bundle's config is checked below
  }

  // ---- dynamic packs: per-artifact, no pack-wide number
  const dyn = readJson(path.join(repo, "src", "core", "dynamic-data.json"), { packs: {} });
  for (const [id, p] of Object.entries(dyn.packs ?? {})) {
    for (const m of p.models ?? []) {
      const r = rowOf(canonicalName(m.repo ?? m.ref));
      r.engine = r.engine ?? (/^ai-hub-models\//i.test(m.repo) ? "qairt" : "llama_cpp");
      r.recommendation = m.contextTokens ?? r.recommendation;
      r.recSource = `dynamic-data.json (pack ${id})`;
    }
  }

  // ---- custom models the user saved: their recommended context is the app's request, not a measurement
  if (customPath && fs.existsSync(customPath)) {
    const customs = readJson(customPath, []);
    for (const c of Array.isArray(customs) ? customs : []) {
      const r = rowOf(canonicalName(c.repo ?? c.id ?? c.name));
      r.recommendation = c.recommendedContext ?? r.recommendation;
      r.recSource = "custom-models.json (the user's own entry)";
    }
  }

  // ---- installed QAIRT bundles: the compiled window from each bundle's genie_config.json
  const qairtConfigs = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "genie_config.json") qairtConfigs.push(p);
    }
  };
  if (fs.existsSync(cacheRoot)) walk(cacheRoot);
  for (const p of qairtConfigs) {
    const cfg = readJson(p, null);
    if (!cfg) continue;
    const compiled = cfg?.dialog?.context?.size ?? null;
    const rel = path.relative(cacheRoot, p).split(path.sep).slice(0, 2).join("/");
    const r = rowOf(canonicalName(rel));
    if (compiled !== null) r.compiled = compiled; // dialog.context.size IS the graph's window
  }

  // ---- GGUF files in the cache: the declared (trained) window from each file's header
  const ggufs = [];
  const walkGguf = (dir, depth = 0) => {
    if (depth > 4) return;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkGguf(p, depth + 1);
      else if (/\.gguf$/i.test(e.name)) ggufs.push(p);
    }
  };
  if (fs.existsSync(cacheRoot)) walkGguf(cacheRoot);
  const ggufFiles = [];
  for (const p of ggufs) {
    const rel = path.relative(cacheRoot, p).replace(/\\/g, "/");
    const gb = fs.statSync(p).size / 1e9;
    // the file's repo folder (org/name) gives the canonical identity; a shard keeps its own row when nothing matches
    const r = rowOf(canonicalName(rel.split("/").slice(0, 2).join("/")));
    try {
      const kv = ggufContext(p);
      const arch = String(kv["general.architecture"] ?? "");
      const trained = kv[`${arch}.context_length`] ?? null;
      if (trained !== null) r.declared = Math.max(r.declared ?? 0, trained);
      ggufFiles.push({ identity: r.identity, file: rel, arch, gb: +gb.toFixed(2), declared: trained });
    } catch (e) {
      ggufFiles.push({ identity: r.identity, file: rel, arch: null, gb: +gb.toFixed(2), declared: null, error: String(e.message ?? e).replace(/\d{4,}/g, "N") });
    }
  }

  // ---- settings: what the user asked for (requested, not served)
  const settings = settingsPath ? readJson(settingsPath, {}) : {};
  const nctxMode = settings.nctxMode ?? null;
  const requestedGlobal = nctxMode && nctxMode !== "auto" && !Number.isNaN(parseInt(nctxMode, 10)) ? parseInt(nctxMode, 10) : null;

  // ---- runtime evidence from the app's own logs. The pre-spawn capabilities line is a PLAN; only a
  // served-context statement that NAMES its model, logged AFTER that model's readiness line, paired
  // to one unique non-failed launch, is an observation. Everything else stays unknown.
  const observedRecords = [];
  const events = [];
  if (logsDir && fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir).filter((n) => /\.log$/i.test(n))) {
      let lines; try { lines = fs.readFileSync(path.join(logsDir, f), "utf8").split(/\r?\n/); } catch { continue; }
      events.push(...parseLogEvents(lines, f));
    }
  }
  // log rotation and overlapping files: everything is paired in timestamp order
  events.sort((a, b) => a.ts - b.ts);
  const paired = pairEvidenceDetailed(events);
  observedRecords.push(...paired.records);
  applyEvidence(models, observedRecords);
  if (requestedGlobal !== null) for (const r of models.values()) if (r.requested === null) { r.requested = requestedGlobal; r.requestedSource = "settings.json nctxMode"; }

  // ---- report
  const rows = [...models.values()].sort((a, b) => a.identity.localeCompare(b.identity));
  const json = {
    at: new Date().toISOString(),
    locations: {
      modelsCache: display(cacheRoot),
      modelsCacheOverride: GENIEX_DATADIR ? `GENIEX_DATADIR=${GENIEX_DATADIR}` : null,
      settings: settingsPath ? display(settingsPath) : null,
      logs: logsDir ? display(logsDir) : null,
    },
    definitions: {
      declared: "the GGUF file's own trained window (<arch>.context_length from its header)",
      compiled: "what a QAIRT graph was compiled with (dialog.context.size of genie_config.json)",
      recommendation: "what the app's catalog/pack data recommends — a choice, not a measurement",
      requested: "what the user/estimator asked the server to serve",
      launchPlan: "what the supervisor declared BEFORE spawning (the capabilities line) — a plan, never an observation",
      readiness: "the requested model was SEEN in a running server's model list — verifies identity, NOT the token limit",
      observedServed: "a served-context statement that NAMES its model, logged after that model's readiness line, attributable to exactly one non-failed launch; unattributable statements stay unknown",
    },
    ggufFiles,
    observed: observedRecords,
    uncorrelatedServedContext: paired.uncorrelated.length,
    ambiguousServedContext: paired.ambiguous.map((a) => ({ ts: a.ts, file: a.file, served: a.served, model: a.model, why: a.why })),
    rows,
  };
  fs.writeFileSync(path.join(outDir, "context-audit.json"), JSON.stringify(json, null, 2));

  const fmt = (v) => (v === null || v === undefined ? "unknown" : String(v));
  const lines = [
    `# Context-window audit (${json.at.slice(0, 10)})`,
    "",
    "One row per model, in the app's canonical identity (`ai-hub-models/X` counts as `qualcomm/X`).",
    "Every limit is kept in its own column; none is copied into another.",
    "",
    "- **Declared max** -- the model file's own trained window, from its GGUF header.",
    "- **Compiled** -- what a QAIRT graph was compiled with, from the installed bundle's `genie_config.json`.",
    "- **Recommendation** -- what the app's catalog/pack data recommends. A choice, not a measurement.",
    "- **Requested** -- what the user or estimator asked the server to serve (settings `nctxMode`, the spawn's `--nctx`).",
    "- **Launch plan** — what the supervisor declared BEFORE spawning (the \"GenieX capabilities … served context\" line).",
    "  It is written before the process exists: a plan, never an observation. A failed launch leaves it a plan still.",
    "- **Readiness** — whether the requested model was seen in a running server's model list. This verifies the",
    "  model's identity, not the token limit; on its own it does not make any context number observed.",
    "- **Observed served** — a served-context statement that NAMES its model, logged AFTER that model's",
    "  readiness line, attributable to exactly one non-failed launch of it. Statements that name no model",
    "  (or that several overlapping launches could own) are left unknown, never attributed by proximity.",
    "  The supervisor writes no such line today, so this is **unknown for every model**; the runtime value",
    "  the app actually uses lives in the server status (`servedNctx`), not in the logs.",
    "",
    `Models cache: \`${display(cacheRoot)}\`${GENIEX_DATADIR ? ` (via \`GENIEX_DATADIR\` override)` : ""} · settings: \`${settingsPath ? display(settingsPath) : "not found"}\` · logs: \`${logsDir ? display(logsDir) : "not found"}\``,
    "",
    "| Model | Engine / quant | Declared max | Compiled | Recommendation | Requested | Launch plan | Readiness | Observed served | Evidence for served |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const eq = `${r.engine ?? "—"}${r.quant ? ` / ${r.quant}` : ""}`;
      const ev = r.observed === null ? "none — unknown" : r.evidence ?? "";
      return `| ${r.identity} | ${eq} | ${fmt(r.declared)} | ${fmt(r.compiled)} | ${fmt(r.recommendation)} | ${fmt(r.requested)} | ${fmt(r.plannedServed)} | ${fmt(r.readiness)} | ${fmt(r.observed)} | ${ev} |`;
    }),
    "",
    `GGUF files read: ${ggufFiles.length}, of which ${ggufFiles.filter((g) => g.declared !== null).length} yielded a declared window.`,
    `Spawn records paired from the logs: ${observedRecords.length}, of which ${observedRecords.filter((o) => o.readiness).length} saw their requested model served and ${observedRecords.filter((o) => o.served !== null).length} carry an identity-named, post-readiness served-context statement.`,
    `Served-context statements NOT attributed (name no model, or no unique launch owns them): ${paired.uncorrelated.length + paired.ambiguous.length}, left unknown.`,
    "",
    "## Discrepancies worth watching",
    "",
  ];
  for (const r of rows) {
    const vals = [["declared", r.declared], ["compiled", r.compiled], ["recommendation", r.recommendation]].filter(([, v]) => v !== null);
    if (r.plannedServed !== null) vals.push(["launch plan", r.plannedServed]);
    if (r.observed !== null) vals.push(["observed served", r.observed]);
    const uniq = [...new Set(vals.map(([, v]) => v))];
    if (uniq.length > 1) lines.push(`- ${r.identity}: ${vals.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  {
    const failed = rows.filter((r) => r.launchFailed);
    if (failed.length) lines.push("", `Launches that failed (never seen served): ${failed.map((r) => r.identity).join(", ")}. Their pre-spawn plans remain plans.`);
    const afterSuccess = rows.filter((r) => r.lastAttempt);
    if (afterSuccess.length) {
      lines.push("", `Models whose LATEST launch attempt failed after an earlier successful observation (the observation is historical; the model is not serving now): ${afterSuccess.map((r) => r.identity).join(", ")}.`);
    }
    const unserved = rows.filter((r) => r.readiness === null && !r.launchFailed);
    if (unserved.length) {
      lines.push("", `No runtime evidence of serving at all for: ${unserved.map((r) => r.identity).join(", ")}.`);
      lines.push("These were never claimed as served; start the model once and re-run this script to fill them in.");
    }
  }
  fs.writeFileSync(path.join(outDir, "context-audit.md"), lines.join("\n") + "\n");
  console.log(`wrote ${outDir}\\context-audit.md (${rows.length} models, ${observedRecords.filter((o) => o.readiness).length} with readiness evidence, ${observedRecords.filter((o) => o.served !== null).length} with observed served context)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
