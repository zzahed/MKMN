// Reproducible model tournament. Drives the app's OWN sidecar chat
// orchestrator (so the numbers are end-to-end MKMN results — the engine-level
// probe in src-tauri/src/bench.rs is a separate measurement) against the cached
// candidates, on a scratch port with PID-file discipline.
//
// Per candidate it measures:
//   cold load        — startChatServer → the server answers /v1/models
//   first answer     — TTFT of the FIRST task (the request that pays the warmup)
//   total + tok/s    — the sidecar's own chat stats (ChatStats.done)
//   peak memory      — private bytes and working set of the geniex process, PID-sampled
//   CPU delta        — geniex process TotalProcessorTime across the candidate's run
//   NPU utilization  — best-effort, the same counters the app reads (src/core/perf.ts)
//
// Quality: one fixed task suite ("tournament-v1") with deterministic checks
// (numeric answer, JSON extraction, instruction constraints), the SAME suite
// for every candidate. The score is the fraction passed. This is a screening
// suite, not a leaderboard.
//
// NOT measured here, on purpose: energy (no reliable per-process method on this
// Windows build), per-process GPU attribution (no per-process GPU counter), and
// the Qwen3.5-2B / Qwen3.5-4B Q4_0 candidates (not cached — downloads deferred,
// reported as unvalidated in the handoff).
//
// Usage: node scripts/tournament.mjs [--only <name>,<name>]
// Scratch state: scripts/.tournament/ (PID file, samples, custom entries).
// Results: docs/evidence/model-tournament-<date>.{json,md} + evidence records
// written to the app's evidence store (%LOCALAPPDATA%\MKMN\Config\model-evidence.json).
const { spawn, spawnSync, execFileSync } = await import("node:child_process");
const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");
const { fileURLToPath, pathToFileURL } = await import("node:url");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SCRATCH = path.join(ROOT, "scripts", ".tournament");
const OUT_DIR = path.join(ROOT, "docs", "evidence");
const PORT = 18199; // scratch port; the app's own 18181 is NEVER touched
const ENDPOINT = `http://127.0.0.1:${PORT}/v1`;
const PID_FILE = path.join(SCRATCH, "geniex.pid");
// The sidecar reads ONE layout (src/shared/paths.ts, from LOCALAPPDATA); the old MKMN_DATA_DIR/MKMN_SETTINGS
// were ignored, so the run read the real settings and never saw its own models ("Pick a model first.").
// LOCALAPPDATA points into the scratch folder, so settings, hardware and custom models resolve there.
const CONFIG = path.join(SCRATCH, "MKMN", "Config");
const REAL_GENIEX = path.join(process.env.LOCALAPPDATA ?? "", "GenieX CLI", "geniex.exe");
const EVIDENCE_FILE = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "MKMN", "Config", "model-evidence.json");
const DATE = new Date().toISOString().slice(0, 10);

const { NPU_UTIL_SCRIPT, parseNpuCounters } = await import(pathToFileURL(path.join(DIST, "core", "perf.js")).href);
const { listInstalled } = await import(pathToFileURL(path.join(DIST, "core", "geniex.js")).href);

// ---------------------------------------------------------------------------
// Candidates: only artifacts ACTUALLY in the cache run. A candidate the cache
// does not hold is reported unavailable — never substituted with another model.
// ---------------------------------------------------------------------------
const CANDIDATES = [
  { name: "qwen3-1.7b-qairt", ref: "qualcomm/Qwen3-1.7B", engine: "qairt", paramsB: 1.7, tier: "efficiency", role: "warmup + efficiency reference" },
  { name: "qwen3-4b-qairt", ref: "qualcomm/Qwen3-4B", engine: "qairt", paramsB: 4, tier: "balanced", role: "the balanced candidate" },
  { name: "qwen3-8b-qairt", ref: "qualcomm/Qwen3-8B", engine: "qairt", paramsB: 8, tier: "quality", role: "quality candidate (QAIRT)" },
  { name: "qwen35-9b-gguf", ref: "unsloth/Qwen3.5-9B-GGUF:Q4_0", baseRef: "unsloth/Qwen3.5-9B-GGUF", engine: "llama_cpp", paramsB: 9, tier: "quality", role: "quality candidate (GGUF)" },
];
// Requested by the phase but NOT cached: reported as unvalidated, never substituted.
const UNAVAILABLE = [
  { name: "qwen35-2b-gguf", ref: "unsloth/Qwen3.5-2B-GGUF:Q4_0", tier: "efficiency", reason: "not in the GenieX cache; downloading was deferred (this run uses cached models only)" },
  { name: "qwen35-4b-gguf", ref: "unsloth/Qwen3.5-4B-GGUF:Q4_0", tier: "balanced", reason: "not in the GenieX cache; downloading was deferred (this run uses cached models only)" },
];

// The task suite: representative user tasks with deterministic checks.
const strip = (a) => String(a ?? "")
  .replace(new RegExp("<think>[\\s\\S]*?</think>", "g"), "")
  .replace(/```[a-z]*\n?|```/g, "")
  .trim();
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const TASKS = [
  { id: "summarize", prompt: "Summarize this note in one short sentence (under 40 words).\n\nNote: The design review is moved to Friday at 3pm in room 204. Bring the revised budget spreadsheet; the revised budget is 12,000 euros. Lunch is not provided.",
    check: (a) => { const t = strip(a); return { pass: /friday/i.test(t) && /budget/i.test(t) && words(t) <= 60, want: "mentions Friday and the budget, under 60 words" }; } },
  { id: "math", prompt: "A shop has 24 apples. It sells 9, then buys two dozen more. How many apples does the shop have now? Answer with the number only.",
    check: (a) => ({ pass: /\b39\b/.test(strip(a)), want: "39" }) },
  { id: "extract-json", prompt: 'From this email, output ONLY a JSON object with keys "item" and "quantity", no other text.\n\nEmail: Hello, please send us 4 USB-C cables and 2 HDMI adapters. Thanks, Priya',
    check: (a) => { const m = strip(a).match(/\{[\s\S]*?\}/); if (!m) return { pass: false, want: "a JSON object" };
      try { const j = JSON.parse(m[0]); const q = Number(j.quantity); return { pass: /usb/i.test(String(j.item ?? "")) && q === 4, want: 'item "USB-C", quantity 4' }; } catch { return { pass: false, want: "valid JSON" }; } } },
  { id: "one-sentence", prompt: "Describe what a triangle is in exactly one sentence. Do not use more than one sentence.",
    check: (a) => { const t = strip(a).replace(/[.!?]+$/, ""); const n = t.split(/[.!?]+/).filter((s) => s.trim().length > 0).length; return { pass: n === 1, want: "exactly one sentence" }; } },
  { id: "code", prompt: "Write a Python function named add_tax(price) that returns the price with 20 percent tax added. Reply with the code only.",
    check: (a) => { const t = strip(a); return { pass: /def\s+add_tax\s*\(/.test(t) && /1\.2/.test(t), want: "def add_tax( and 1.2" }; } },
  { id: "knowledge", prompt: "What is the capital city of Australia? Answer with the city name only.",
    check: (a) => ({ pass: /canberra/i.test(strip(a)), want: "Canberra" }) },
];

// ---------------------------------------------------------------------------
// Host shim: plays the Rust host for the sidecar process.
// ---------------------------------------------------------------------------
const findGeniex = () => {
  const candidates = [process.env.GENIEX_PATH, path.join(process.env.LOCALAPPDATA ?? "", "GenieX CLI", "geniex.exe")].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("geniex.exe not found");
};
const EXE = findGeniex();

let serveChild = null;
let coldLoadMs = null;
let serveCompute = null;
let serveModel = null;
/** The context the served model was started with (null: server default / QAIRT
 * compiled graph) — part of the served identity, reported in the evidence. */
let serveNctx = null;
/** The cache inventory (geniex model list), read once; candidates serve the EXACT
 * ref the cache reports — never a re-spelled one. */
let INSTALLED = [];
const canonRef = (s) => String(s ?? "").toLowerCase().replace(/^ai-hub-models\//, "qualcomm/").replace(/:[^:]*$/, "").replace(/-gguf$/, "").replace(/[^a-z0-9]/g, "");
const installedRefOf = (c) => INSTALLED.find((m) => canonRef(m.ref || m.name) === canonRef(c.ref) || canonRef(m.ref || m.name) === canonRef(c.baseRef ?? c.ref))?.ref ?? c.ref;
const cacheHas = (c) => INSTALLED.some((m) => canonRef(m.ref || m.name) === canonRef(c.ref) || canonRef(m.ref || m.name) === canonRef(c.baseRef ?? c.ref));

/** A one-token completion: the "the model really generates" readiness check the
 * cold-load timing waits for (an inventory listing alone is not loading done). */
async function modelAnswers(model) {
  try {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    return r.ok;
  } catch { return false; }
}

/** PID-file discipline: the PID file names ONLY servers this script spawned. A
 * leftover from a previous crashed run of THIS script is killed (it is ours);
 * anything else on the port aborts the run instead of being killed blind. */
function scratchServerCleanup() {
  if (fs.existsSync(PID_FILE)) {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (pid && isAlive(pid)) {
      console.log(`[tournament] killing leftover scratch geniex pid ${pid} (recorded in ${PID_FILE})`);
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
    fs.rmSync(PID_FILE, { force: true });
  }
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let killedPid = null; // the server killMine is waiting on: Windows NPU teardown lags taskkill
const killMine = () => {
  if (serveChild?.pid) { spawnSync("taskkill", ["/PID", String(serveChild.pid), "/T", "/F"], { stdio: "ignore" }); killedPid = serveChild.pid; }
  serveChild = null;
  serveModel = null;
  serveNctx = null;
  fs.rmSync(PID_FILE, { force: true });
};
/** A killed geniex takes seconds to tear its NPU graph down and release the
 * port; a new server spawned too early dies with a bind error. Wait until the
 * killed process is REALLY gone and the port refuses TWO consecutive fetches —
 * a single timeout can catch the dying server mid-teardown, still bound. */
async function waitServerDown(timeoutMs = 45_000) {
  const t0 = Date.now();
  while (killedPid && isAlive(killedPid) && Date.now() - t0 < timeoutMs) await sleep(300);
  let misses = 0;
  while (Date.now() - t0 < timeoutMs) {
    try { await fetch(`${ENDPOINT}/models`, { signal: AbortSignal.timeout(800) }); misses = 0; await sleep(400); continue; }
    catch { if (++misses >= 2) { killedPid = null; return true; } await sleep(400); }
  }
  return false;
}

/** Spawn geniex serve, retrying the BIND-FAILURE signature: a fresh server that
 * exits with code 0 within ~2 s died on "Only one usage of each socket address"
 * — the previous server's port was not released yet despite waitServerDown. */
async function spawnServe(model, compute, nctx) {
  const args = ["serve", "--host", `127.0.0.1:${PORT}`, "--compute", compute, "--power-mode", "burst", "--keepalive", "300", "--metrics", "--model", model];
  if (nctx) args.push("--nctx", String(nctx)); // GGUF only: the QAIRT graph has its context compiled in
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    const log = fs.openSync(path.join(SCRATCH, "serve.log"), "a");
    fs.writeSync(log, `\n==== spawn ${new Date().toISOString()} (attempt ${attempt}) :: ${args.join(" ")}\n`);
    serveChild = spawn(EXE, args, { stdio: ["ignore", log, log] });
    serveModel = model;
    serveNctx = nctx ?? null;
    fs.writeFileSync(PID_FILE, String(serveChild.pid));
    serveChild.on("exit", (code) => { fs.writeSync(log, `==== exit code ${code} at ${new Date().toISOString()} (after ${Date.now() - t0}ms)\n`); console.log(`[tournament] geniex serve exited (code ${code}) after ${((Date.now() - t0) / 1000).toFixed(1)}s`); });
    const deadline = Date.now() + 240_000;
    const bindFailed = new Promise((resolve) => {
      const check = setInterval(() => {
        if (serveChild && serveChild.exitCode !== null && serveChild.exitCode !== undefined) { clearInterval(check); resolve(serveChild.exitCode === 0 && Date.now() - t0 < 2000); }
      }, 150);
      serveChild.once("exit", () => { clearInterval(check); });
    });
    const won = await Promise.race([
      (async () => {
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          if (serveChild?.exitCode !== null && serveChild?.exitCode !== undefined) return false;
          try {
            const r = await fetch(`${ENDPOINT}/models`);
            const j = await r.json();
            // Completed loading, not inventory availability: /v1/models can list
            // while the graph is still being loaded (the supervisor's readiness
            // probe has the same narrowing). The model is cold-load READY when a
            // one-token completion actually answers.
            if (Array.isArray(j.data) && j.data.length && (await modelAnswers(model))) { coldLoadMs = Date.now() - t0; return true; }
          } catch { /* not listening yet */ }
        }
        return false;
      })(),
      bindFailed,
    ]);
    if (won) return true;
    if (serveChild?.exitCode === 0 && Date.now() - t0 < 2000 && attempt < 3) {
      console.log(`[tournament] spawn died on the port bind (attempt ${attempt}); waiting for the release and retrying`);
      await sleep(2500);
      continue;
    }
    if (serveChild?.exitCode !== null && serveChild?.exitCode !== undefined) throw new Error(`geniex serve exited (code ${serveChild.exitCode})`);
    throw new Error("the model server did not become ready in time");
  }
}

/** Evidence records go to the SAME file the Rust store keeps (same record shape,
 * upsert by id, atomic write). A failed evidence write never fails the run. */
function writeEvidence(records) {
  try {
    fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
    let all = [];
    try { all = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")); if (!Array.isArray(all)) all = []; } catch { all = []; }
    for (const r of records) {
      const i = all.findIndex((x) => x.id === r.id);
      if (i >= 0) all[i] = r; else all.push(r);
    }
    const tmp = `${EVIDENCE_FILE}.tournament.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, EVIDENCE_FILE);
    return all.length;
  } catch (e) { console.log(`[tournament] evidence write failed (non-fatal): ${e.message}`); return -1; }
}

// The sidecar process and its protocol channel.
let child = null, buf = "", nextId = 1;
const waiters = new Map();
const chatEvents = []; // every chat event, filtered by turn id at read time

function handleHostRequest(m) {
  const reply = (ok, result, error) => child.stdin.write(JSON.stringify({ t: "res", id: m.id, ok, ...(ok ? { result } : { error }) }) + "\n");
  const args = m.args ?? [];
  (async () => {
    switch (m.method) {
      case "startChatServer": {
        const [model, compute, opts] = args;
        serveCompute = compute || "npu";
        const wantNctx = opts?.nctx ?? null;
        // The supervisor's reuse rule: a start request for a model already served
        // by a LIVE server reuses it instead of spawning a duplicate (every chat
        // turn re-ensures its server; only a changed key restarts the model).
        // The context is part of that key: a request for a different nctx is a
        // different served configuration, not the same server.
        if (serveChild && isAlive(serveChild.pid) && serveModel === model && serveNctx === wantNctx) {
          try {
            const r = await fetch(`${ENDPOINT}/models`);
            const j = await r.json();
            if (Array.isArray(j.data) && j.data.length) { reply(true, { endpoint: ENDPOINT, state: "ready", model, lastError: null, servedNctx: serveNctx }); break; }
          } catch { /* fell through: restart below */ }
        }
        killMine();
        if (!(await waitServerDown())) { reply(false, null, "the previous model server is still releasing the port"); break; }
        try { await spawnServe(model, serveCompute, wantNctx); reply(true, { endpoint: ENDPOINT, state: "ready", model, lastError: null, servedNctx: serveNctx }); }
        catch (e) { reply(false, null, String(e.message ?? e)); }
        break;
      }
      case "stopChatServer": killMine(); reply(true, true); break;
      case "saveSettings": reply(true, args[0] ?? {}); break;
      case "setServerBusy": reply(true, true); break;
      case "pickFolder": reply(true, null); break;
      case "notify": reply(true, true); break;
      case "recordModelEvidence": reply(true, writeEvidence(args[0] ?? [])); break;
      case "getModelEvidence":
        try { reply(true, JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"))); } catch { reply(true, []); }
        break;
      case "revealPath": case "openPath": reply(true, true); break;
      default: console.log(`[tournament] host method "${m.method}" not offered`); reply(false, null, `the tournament host does not offer "${m.method}"`);
    }
  })().catch((e) => reply(false, null, String(e.message ?? e)));
}

function call(method, ...args) {
  const id = `t-${nextId++}`;
  return new Promise((res, rej) => {
    waiters.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n");
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSidecar() {
  child = spawn(process.execPath, [path.join(DIST, "sidecar", "main.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LOCALAPPDATA: SCRATCH,
      GENIEX_PATH: process.env.GENIEX_PATH ?? REAL_GENIEX,
      MKMN_APP_VERSION: "0.0.1-tournament",
    },
  });
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.t === "event") {
        if (m.name === "chat") {
          const ev = { ...m.payload, _at: Date.now() }; // _at: when the event ARRIVED (wall clock, for honest first-answer timing)
          chatEvents.push(ev);
          try { fs.appendFileSync(path.join(SCRATCH, "events.log"), JSON.stringify(ev) + "\n"); } catch { /* diagnostics only */ }
        }
      } else if (m.t === "res") {
        const w = waiters.get(m.id);
        if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); }
      } else if (m.t === "req") void handleHostRequest(m);
    }
  });
  child.stderr.on("data", (d) => { const t = d.toString().trim(); if (t) console.log(`[sidecar] ${t.slice(0, 160)}`); });
}

/** The real reason of a failed turn: the app's title plus its raw cause (a title alone, "Something went wrong", says nothing). */
const reasonOf = (e) => [e?.message ?? e?.title, e?.raw && e.raw !== e?.title ? String(e.raw) : null].filter(Boolean).join(": ") || "no answer";

/** Waits for the done/error event of one turn. */
async function waitTurn(turnId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const last = chatEvents.filter((e) => e.id === turnId && (e.type === "done" || e.type === "error")).at(-1);
    if (last) return last;
    await sleep(300);
  }
  return { id: turnId, type: "error", error: { message: "timeout waiting for the answer" } };
}
const answerOf = (turnId) => chatEvents.filter((e) => e.id === turnId && e.type === "answer").map((e) => e.text ?? "").join("");

// Memory + CPU sampler: one PowerShell loop per candidate, ~1 sample/s.
function startSampler(pid, file) {
  const script = `
while ($true) {
  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if ($p) { Add-Content -Path '${file.replace(/'/g, "''")}' -Value "$($p.PrivateMemorySize64),$($p.WorkingSet64),$($p.TotalProcessorTime.TotalMilliseconds)" }
  Start-Sleep -Milliseconds 1000
}`;
  const s = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  return () => { try { s.kill(); } catch { /* gone */ } };
}

/** NPU utilization, the same counters the app reads. One reading takes ~2s. */
function npuSample() {
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", NPU_UTIL_SCRIPT], { encoding: "utf8", timeout: 15000 });
    return parseNpuCounters(r.stdout ?? "");
  } catch { return null; }
}

/** Persistent NPU sampler: the counter discovery runs ONCE, then each round
 * re-enumerates the instance paths (GPU Engine instances are PID-scoped — a
 * candidate's geniex process does not exist at discovery time, so fixed paths
 * would sample only stale PIDs and always read 0), does the app's own
 * two-sample read (-SampleInterval 1 -MaxSamples 2, last sample wins —
 * utilization is a RATE counter, a single read always cooks to 0), and appends
 * one JSON line. ~2.5 s per reading. */
function startNpuSampler(file) {
  const loop = NPU_UTIL_SCRIPT.replace(/\$out = @\(\)[\s\S]*$/, `$out = @()
while ($true) {
  if ($found.Count -gt 0) {
    $paths = @()
    foreach ($set in 'GPU Engine','GPU Adapter Memory','GPU Process Memory') {
      try { $paths += @((Get-Counter -ListSet $set).PathsWithInstances | Where-Object { $x = $_.ToLower(); @($found.Keys | Where-Object { $x.Contains($_) }).Count -gt 0 }) } catch {}
    }
    if ($paths) {
      $c = @(Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 2 -ErrorAction SilentlyContinue)
      if ($c.Count -gt 0) {
        $out = @($c[$c.Count - 1].CounterSamples | ForEach-Object { [pscustomobject]@{ p = $_.Path; v = [double]$_.CookedValue } })
        [pscustomobject]@{ sets = $names; adapter = (@($found.Values) -join ', '); adapters = @(); samples = $out } | ConvertTo-Json -Compress -Depth 4 | Add-Content -Path '${file.replace(/'/g, "''")}'
      }
    }
  }
  Start-Sleep -Milliseconds 300
}`);
  const s = spawn("powershell", ["-NoProfile", "-Command", loop], { stdio: "ignore" });
  return () => { try { s.kill(); } catch { /* gone */ } };
}

async function runCandidate(c, npu, run = "") {
  const suffix = run ? `#${run}` : "";
  console.log(`\n=== ${c.name}${suffix} (${c.ref}) ===`);
  const serveRef = installedRefOf(c);
  const result = { name: c.name, ref: serveRef, engine: c.engine, tier: c.tier, paramsB: c.paramsB, available: true, tasks: [], npu: npu ? { utilMax: null, memBytesMax: null } : null };

  const sampleFile = path.join(SCRATCH, `samples-${c.name}${run ? "-" + run : ""}.csv`);
  fs.rmSync(sampleFile, { force: true });
  let stopSampler = () => {};

  // NPU utilization: a persistent sampler (a two-sample read every ~2.5 s, the
  // max taken at the end) — the same counters the app's meters read.
  const npuFile = path.join(SCRATCH, `npu-${c.name}${run ? "-" + run : ""}.log`);
  let npuStop = null;
  if (npu) {
    result.npu = { utilMax: null, memBytesMax: null, samples: 0 };
    fs.rmSync(npuFile, { force: true });
    npuStop = startNpuSampler(npuFile);
  }

  // The FIRST task pays the cold load: the sidecar's ensureServer asks the host
  // to start the model, and the shim measures geniex spawn → ready inside its
  // own spawnServe. The memory sampler attaches afterwards, once the PID exists.
  let first = true;
  try {
    for (const task of TASKS) {
      const turnId = `${c.name}${suffix}:${task.id}`; // suffix keeps a CPU retry's events apart
      const chatT0 = Date.now();
      call("chat", turnId, `tournament-${c.name}`, [{ role: "user", content: task.prompt }], { effort: "off", subagents: false }).catch(() => {});
      const done = await waitTurn(turnId, 300_000);
      if (done.type === "error" && done.error?.message === "timeout waiting for the answer") {
        // the turn is still running and holds the runtime lease: abort it the way
        // the app's own stop button does, so later turns are not poisoned by it
        await call("abortChat", turnId).catch(() => {});
        await sleep(1500);
      }
      if (done.type !== "done" || !done.stats) {
        result.tasks.push({ id: task.id, pass: false, error: reasonOf(done.error), wallMs: Date.now() - chatT0 });
        console.log(`  ${task.id}: ERROR (${reasonOf(done.error).slice(0, 160)}) raw: ${JSON.stringify(done).slice(0, 300)}`);
        continue;
      }
      const answer = answerOf(turnId);
      const check = task.check(answer);
      // first visible answer, wall clock: from the send to the first answer event's
      // arrival — includes the model start, the NPU warm-up and the orchestrator's
      // own preparation, which the stream stats (measured from the fetch) exclude
      const firstAnswerAt = chatEvents.find((e) => e.id === turnId && e.type === "answer" && (e.text ?? "").trim())?._at ?? null;
      result.tasks.push({
        id: task.id,
        pass: !!check.pass,
        want: check.want,
        answerChars: answer.length,
        ttftSec: done.stats.ttftSec ?? null,
        wallFirstAnswerSec: firstAnswerAt != null ? Math.round((firstAnswerAt - chatT0) / 100) / 10 : null,
        totalSec: done.stats.totalSec ?? null,
        tokPerSec: done.stats.tokPerSec ?? null,
        tokens: done.stats.tokens ?? null,
        promptTokens: done.stats.promptTokens ?? null,
        wallMs: Date.now() - chatT0,
        firstTask: first,
        answer: answer.length <= 400 ? answer : answer.slice(0, 400) + "…",
      });
      if (first) {
        // the server is up now: adopt the shim's own cold-load measurement and
        // the compute/context it actually served with, then start the memory sampler
        result.coldLoadMs = coldLoadMs;
        result.compute = serveCompute;
        result.servedNctx = serveNctx;
        if (result.compute && result.compute !== "npu") result.computeFallback = "the NPU start failed; this candidate was measured on the CPU — the numbers are NOT NPU numbers";
        console.log(`cold load: ${result.coldLoadMs != null ? (result.coldLoadMs / 1000).toFixed(1) + "s" : "not measured"} (compute ${result.compute ?? "?"}${result.servedNctx ? `, nctx ${result.servedNctx}` : ""})`);
        const pid = serveChild?.pid;
        if (pid) stopSampler = startSampler(pid, sampleFile);
        first = false;
      }
      console.log(`  ${task.id}: ${check.pass ? "PASS" : "FAIL"} (ttft ${done.stats.ttftSec ?? "?"}s, total ${done.stats.totalSec ?? "?"}s, ${done.stats.tokPerSec ?? "?"} tok/s)`);
    }
  } finally {
    await sleep(1200); // let the last sample land
    stopSampler(); npuStop?.();
  }

  // every task errored = the model never came up (e.g. GGUF cannot start on the
  // NPU). The caller decides on an EXPLICIT CPU retry; nothing is recorded yet.
  if (result.tasks.length && result.tasks.every((t) => t.error)) {
    result.startFailed = result.tasks[0].error ?? "the model never produced an answer";
    return result;
  }

  // aggregate: first visible answer = the first task's TTFT (it pays the warmup);
  // steady-state = the later tasks' medians.
  const oks = result.tasks.filter((t) => t.ttftSec != null);
  const firstTask = result.tasks.find((t) => t.firstTask && t.ttftSec != null);
  const later = oks.filter((t) => !t.firstTask);
  const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  result.firstAnswerSec = firstTask?.wallFirstAnswerSec ?? firstTask?.ttftSec ?? null;
  result.steadyTtftSec = med(later.map((t) => t.ttftSec));
  result.steadyTokPerSec = med(later.map((t) => t.tokPerSec).filter((x) => x != null));
  result.totalSec = med(oks.map((t) => t.totalSec).filter((x) => x != null));
  result.passed = result.tasks.filter((t) => t.pass).length;
  result.taskCount = TASKS.length;

  // memory / cpu from the samples
  try {
    const rows = fs.readFileSync(sampleFile, "utf8").trim().split(/\r?\n/).filter(Boolean)
      .map((l) => l.split(",").map(Number)).filter((r) => r.length >= 3 && r.every((x) => Number.isFinite(x)));
    if (rows.length) {
      result.peakPrivateMB = Math.round(Math.max(...rows.map((r) => r[0])) / 1024 / 1024);
      result.peakWorkingSetMB = Math.round(Math.max(...rows.map((r) => r[1])) / 1024 / 1024);
      result.cpuDeltaSec = Math.round((rows.at(-1)[2] - rows[0][2]) / 100) / 10;
      result.samples = rows.length;
    }
  } catch { /* sampler file missing: reported as not measured */ }
  if (result.npu) {
    try {
      const lines = fs.readFileSync(npuFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        const r = parseNpuCounters(l);
        if (r?.util != null) result.npu.utilMax = Math.max(result.npu.utilMax ?? 0, r.util);
        if (r?.memBytes != null) result.npu.memBytesMax = Math.max(result.npu.memBytesMax ?? 0, r.memBytes);
      }
      result.npu.samples = lines.length;
    } catch { /* sampler file missing: reported as not measured */ }
    result.npu.memBytesMaxGB = result.npu.memBytesMax != null ? Math.round(result.npu.memBytesMax / 1024 ** 3 * 100) / 100 : null;
  }

  // evidence: this candidate was loaded, timed and scored HERE.
  writeEvidence([
    { id: `loaded-on-device:${serveRef}`, kind: "loaded-on-device", ref: serveRef, asOf: new Date().toISOString(), machine: MACHINE, runtimeVersion: RUNTIME, config: { compute: result.compute, nctx: result.servedNctx ?? null, powerMode: "burst", suite: "tournament-v1" }, result: { coldLoadMs: result.coldLoadMs } },
    { id: `performance-measured:${serveRef}`, kind: "performance-measured", ref: serveRef, asOf: new Date().toISOString(), machine: MACHINE, runtimeVersion: RUNTIME, config: { compute: result.compute, nctx: result.servedNctx ?? null, powerMode: "burst", suite: "tournament-v1" }, result: { firstAnswerSec: result.firstAnswerSec, steadyTtftSec: result.steadyTtftSec, steadyTokPerSec: result.steadyTokPerSec, totalSec: result.totalSec, peakPrivateMB: result.peakPrivateMB ?? null, peakWorkingSetMB: result.peakWorkingSetMB ?? null, cpuDeltaSec: result.cpuDeltaSec ?? null, npuUtilMax: result.npu?.utilMax ?? null } },
    { id: `quality-evaluated:${serveRef}`, kind: "quality-evaluated", ref: serveRef, asOf: new Date().toISOString(), machine: MACHINE, runtimeVersion: RUNTIME, config: { suite: "tournament-v1", taskCount: TASKS.length, effort: "off" }, result: { passed: result.passed, total: result.taskCount, tasks: result.tasks.map((t) => ({ id: t.id, pass: t.pass })) } },
  ]);
  console.log(`  passed ${result.passed}/${result.taskCount}; peak private ${result.peakPrivateMB ?? "?"} MB; cpu +${result.cpuDeltaSec ?? "?"}s`);
  return result;
}

// machine + runtime identity for the evidence records
function machineLabel() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name; [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)"], { encoding: "utf8", timeout: 20000 });
    const [cpu, ram] = out.trim().split(/\r?\n/);
    return `${cpu?.trim() ?? "unknown"}, ${ram?.trim() ?? "?"} GB`;
  } catch { return "unknown"; }
}
function geniexLabel() {
  try { return execFileSync(EXE, ["--version"], { encoding: "utf8", timeout: 20000 }).trim().split(/\r?\n/)[0] ?? "unknown"; } catch { return "unknown"; }
}

let MACHINE = "unknown";
let RUNTIME = "unknown";

function cleanup(code) {
  try { killMine(); } catch { /* gone */ }
  try { child?.stdin.end(); child?.kill(); } catch { /* gone */ }
  process.exit(code);
}

(async () => {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
  MACHINE = machineLabel();
  RUNTIME = geniexLabel();
  console.log(`machine: ${MACHINE}\nruntime: ${RUNTIME}\nport: ${PORT} (scratch; the app's 18181 is untouched)`);

  fs.mkdirSync(CONFIG, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  scratchServerCleanup();

  // which candidates the cache actually holds — the app's OWN inventory
  // (geniex list, via the same listInstalled the sidecar uses)
  try { INSTALLED = await listInstalled(EXE); }
  catch (e) { console.error(`geniex list failed: ${e.message}`); }

  // scratch settings: the app's OWN defaults (the sidecar reads the file raw — the
  // host normally writes every default — so a file with only overrides would turn
  // "tools on command" off and send plain chat down the page-tool paths), plus
  // search off; custom entries make the cached candidates addressable by the
  // sidecar's own catalog machinery
  fs.writeFileSync(path.join(CONFIG, "settings.json"), JSON.stringify({
    appearance: "system", geniexPath: null, npuBudgetOverrideGB: null, showKQuants: false,
    compute: "npu", keepaliveSec: 300, selectedModelId: null, pinnedGeniexVersion: null,
    customInstructions: "", effort: "off", subagents: false, autoCheck: true, reviewerModelId: null,
    reviewRounds: 2, writers: {}, developer: false, webSearch: false, wikimediaImages: false,
    searchAlways: false, toolsOnCommand: true, searchProvider: "duckduckgo", braveKey: "",
    searxngUrl: "", searchModelId: null, agentLoop: false, agentRounds: 6, agentMinutes: 30, agentGoal: "",
  }, null, 2));
  const custom = CANDIDATES.filter(cacheHas).map((c) => ({
    id: `tournament-${c.name}`, name: c.name, repo: c.baseRef ?? c.ref.replace(/:[^:]*$/, ""), quant: c.engine === "llama_cpp" ? "Q4_0" : null,
    engine: c.engine, role: c.role, sizeGB: Math.round(c.paramsB * 0.6 * 10) / 10, paramsB: c.paramsB,
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, max_tokens: 512 },
  }));
  fs.writeFileSync(path.join(CONFIG, "custom-models.json"), JSON.stringify(custom, null, 2));
  fs.writeFileSync(path.join(CONFIG, "hardware.json"), JSON.stringify({}));

  child = null;
  startSidecar();
  await sleep(1500);
  console.log("ping:", JSON.stringify(await call("ping").catch(() => null)));

  const results = { asOf: new Date().toISOString(), machine: MACHINE, runtime: RUNTIME, suite: "tournament-v1", port: PORT, candidates: [], unavailable: UNAVAILABLE, notes: [] };
  for (const c of CANDIDATES.filter((x) => !only || only.includes(x.name))) {
    if (!cacheHas(c)) {
      console.log(`\n=== ${c.name}: NOT in the cache — skipped (unavailable, never substituted) ===`);
      results.candidates.push({ name: c.name, ref: c.ref, tier: c.tier, available: false });
      continue;
    }
    let r = null;
    try { r = await runCandidate(c, true); }
    catch (e) {
      console.error(`candidate ${c.name} failed: ${e.message}`);
      results.candidates.push({ name: c.name, ref: c.ref, tier: c.tier, available: true, error: String(e.message ?? e) });
    }
    // An EXPLICIT, documented CPU retry for GGUF candidates that cannot start on
    // the NPU — never a silent substitution of compute (the same rule the
    // supervisor enforces in the app).
    if (r?.startFailed && c.engine === "llama_cpp") {
      console.log(`  NPU start failed (${String(r.startFailed).slice(0, 120)}); retrying EXPLICITLY on CPU`);
      killMine();
      await waitServerDown();
      const retry = custom.find((x) => x.id === `tournament-${c.name}`);
      if (retry) retry.preferredCompute = "cpu"; // customModels() re-reads the file each call
      fs.writeFileSync(path.join(CONFIG, "custom-models.json"), JSON.stringify(custom, null, 2));
      try {
        const r2 = await runCandidate(c, false, "cpu-retry");
        if (r2.startFailed) results.candidates.push({ ...r2, available: true, error: `did not start on NPU or CPU: ${r2.startFailed}` });
        else { r2.computeFallback = "the NPU start failed; this candidate was measured on the CPU — the numbers are NOT NPU numbers"; results.candidates.push(r2); }
      } catch (e) {
        console.error(`candidate ${c.name} cpu-retry failed: ${e.message}`);
        results.candidates.push({ name: c.name, ref: c.ref, tier: c.tier, available: true, error: `npu: ${r.startFailed}; cpu: ${e.message}` });
      }
    } else if (r?.startFailed) {
      // never started and no retry applies (a QAIRT bundle is NPU-only): a failure with its reason, not a scored row
      results.candidates.push({ ...r, error: `did not start: ${r.startFailed}` });
    } else if (r) {
      results.candidates.push(r);
    }
    killMine(); // a fresh server per candidate: every cold load is a real one
    await waitServerDown();
    await sleep(500);
  }

  fs.writeFileSync(path.join(OUT_DIR, `model-tournament-${DATE}.json`), JSON.stringify(results, null, 2));

  // human summary
  const done = results.candidates.filter((c) => c.available && !c.error && c.tasks);
  const lines = [
    `# Model tournament — ${DATE}`,
    "",
    `Machine: ${MACHINE}. Runtime: ${RUNTIME}. Suite: ${results.suite} (${TASKS.length} tasks, one run each).`,
    `Method: the app's own sidecar chat orchestrator, end-to-end; a fresh server per candidate (cold load is real); effort off; scratch port ${PORT}.`,
    "First answer = wall clock from sending the message to the first word on screen (includes the model start, the NPU warm-up and the orchestrator's preparation). Steady TTFT and tok/s are stream medians of the later tasks on the warm server.",
    "",
    "| Candidate | Tier | Passed | First answer | Steady TTFT | tok/s | Peak private | NPU util max | NPU mem | CPU |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...done.map((c) => `| ${c.name} | ${c.tier} | ${c.passed}/${c.taskCount} | ${c.firstAnswerSec ?? "?"}s | ${c.steadyTtftSec ?? "?"}s | ${c.steadyTokPerSec ?? "?"} | ${c.peakPrivateMB ?? "?"} MB | ${c.npu?.utilMax ?? "?"}% | ${c.npu?.memBytesMaxGB ?? "?"} GB | ${c.cpuDeltaSec ?? "?"}s |`),
    "",
    ...results.candidates.filter((c) => c.error).map((c) => `Failed: ${c.name}: ${String(c.error).slice(0, 200)}`),
    "Unvalidated (not cached, not substituted): " + UNAVAILABLE.map((u) => u.name).join(", ") + ".",
    "Not measured: energy (no reliable method), per-process GPU attribution.",
    ...(done.length && done.every((c) => c.npu?.utilMax == null) ? ["NPU utilization and memory: not measured, this PC exposes no NPU performance counters to Windows (no NPU adapter and no NPU engine instances)."] : []),
  ];
  fs.writeFileSync(path.join(OUT_DIR, `model-tournament-${DATE}.md`), lines.join("\n") + "\n");
  console.log(`\nresults written to docs/evidence/model-tournament-${DATE}.{json,md}`);
  cleanup(0);
})().catch((e) => { console.error("TOURNAMENT FAIL:", e); cleanup(1); });
