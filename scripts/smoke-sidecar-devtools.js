// Live smoke of the sidecar dev tools: the roster/state methods answer without the
// NPU, and a real one-model NPU load test runs end to end (the default setting only, native
// bundle: one server start through the host capability, one real prompt). The driver plays
// the Rust host: startChatServer spawns geniex serve, stopChatServer kills it.
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 18198; // not the app's 18181, not the chat smoke's 18199
const ENDPOINT = `http://127.0.0.1:${PORT}/v1`;

const findGeniex = () => {
  const candidates = [process.env.GENIEX_PATH, path.join(process.env.LOCALAPPDATA ?? "", "GenieX CLI", "geniex.exe")].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("geniex.exe not found");
};

const child = spawn(process.execPath, ["dist/sidecar/main.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; let nextId = 1; const waiters = new Map();
let serveChild = null; const npuTestEvents = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { console.log("UNPARSEABLE:", line.slice(0, 120)); continue; }
    if (m.t === "event") {
      if (m.name === "npuTest") { npuTestEvents.push(m.payload); }
      else console.log(`EVENT ${m.name}:`, JSON.stringify(m.payload).slice(0, 140));
    } else if (m.t === "res") { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); } }
    else if (m.t === "req") void handleHostRequest(m);
  }
});
child.stderr.on("data", (d) => { const t = d.toString().trim(); if (t && !/^\[chat\]|^- |^=|^The app expects|^NPU load test|^Machine:|^RAM:|^Server debug|^No server|^\* |^ {2}/.test(t)) console.error("STDERR:", t.slice(0, 160)); });

/** The host capabilities the same way sidecar.rs implements them. */
async function handleHostRequest(m) {
  const reply = (ok, result, error) => child.stdin.write(JSON.stringify({ t: "res", id: m.id, ok, ...(ok ? { result } : { error }) }) + "\n");
  try {
    if (m.method === "startChatServer") {
      const [model, compute] = m.args ?? [];
      console.log(`HOST startChatServer: ${model} (${compute})`);
      if (serveChild) { try { process.kill(serveChild.pid); } catch { /* already exited */ } }
      serveChild = spawn(findGeniex(), ["serve", "--host", `127.0.0.1:${PORT}`, "--compute", compute || "npu", "--power-mode", "burst", "--keepalive", "300", "--metrics", "--model", model], { stdio: "ignore" });
      const readyAt = Date.now() + 180_000;
      while (Date.now() < readyAt) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const j = await (await fetch(`${ENDPOINT}/models`)).json();
          if (Array.isArray(j.data) && j.data.length) { console.log(`HOST server ready (${j.data.length} models)`); return reply(true, { endpoint: ENDPOINT, state: "ready", model, lastError: null }); }
        } catch { /* not up yet: poll again */ }
      }
      return reply(false, null, "the model server did not become ready in time");
    }
    if (m.method === "stopChatServer") {
      if (serveChild) { try { process.kill(serveChild.pid); } catch { /* already exited */ } serveChild = null; }
      console.log("HOST stopChatServer");
      return reply(true, true, undefined);
    }
    return reply(false, null, `the smoke host does not offer "${m.method}"`);
  } catch (e) { reply(false, null, String(e.message ?? e)); }
}

const call = (method, ...args) => { const id = `t-${nextId++}`; return new Promise((res, rej) => { waiters.set(id, { res, rej }); child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n"); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  if (serveChild) { try { process.kill(serveChild.pid); } catch { /* already exited */ } }
  child.stdin.end(); child.kill(); process.exit(code);
}

(async () => {
  try {
    console.log("ping:", JSON.stringify(await call("ping")));

    console.log("batteryRead:", JSON.stringify(await call("batteryRead")));
    console.log("npuResetStatus:", JSON.stringify(await call("npuResetStatus")));
    console.log("labState:", JSON.stringify(await call("labState")));

    const roster = await call("benchRoster");
    console.log("benchRoster: targets", roster.targets.length, "tests", roster.tests.launch, "freeGB", roster.freeGB, "folder", roster.folder);

    const npuRoster = await call("npuTestRoster");
    console.log("npuTestRoster:", JSON.stringify(npuRoster.slice(0, 3)));
    if (!npuRoster.length) throw new Error("no installed models for the load test");
    // the smallest installed model: a smoke test checks the load test works, not whether the largest model fits
    const pick = [...npuRoster].sort((a, b) => (a.sizeGB ?? 99) - (b.sizeGB ?? 99))[0];

    // --all: every installed model through the app's OWN load path (its naming, start command and warm-up), the
    // check a raw geniex test cannot make (three faults of that path were missed by raw tests)
    const all = process.argv.includes("--all");
    const ids = all ? npuRoster.map((m) => m.id) : [pick.id];
    console.log("\n--- NPU load test on", all ? `all ${ids.length} installed models` : pick.name, "---");
    const started = await call("npuTestStart", ids, false, false);
    console.log("npuTestStart:", JSON.stringify(started));
    if (!started.ok) throw new Error(started.error);

    const end = Date.now() + (all ? 4 * 3600_000 : 420_000);
    while (Date.now() < end) {
      const last = npuTestEvents.at(-1);
      if (last && last.running === false) break;
      await sleep(1000);
    }
    const st = await call("npuTestState");
    const logTail = (st.lines ?? []).slice(-14).join("\n");
    console.log("log tail:\n" + logTail);
    // one result per ATTEMPT (a model may be tried under several settings): a model loads when one attempt did
    const byModel = new Map();
    for (const r of st.results ?? []) {
      const m = byModel.get(r.model) ?? { ok: false, how: "", error: "" };
      if (r.ok && !m.ok) { m.ok = true; m.how = `${r.label}, ${r.seconds} s`; } else if (!r.ok) m.error = String(r.error ?? "").slice(0, 160);
      byModel.set(r.model, m);
    }
    if (all) {
      for (const [model, m] of byModel) console.log(`${m.ok ? "LOADS" : "FAILS"}  ${model} — ${m.ok ? m.how : m.error}`);
      console.log(`${[...byModel.values()].filter((m) => m.ok).length}/${byModel.size} load`);
    }
    const ok = st.running === false && byModel.size === ids.length && (all || [...byModel.values()][0]?.ok === true);
    console.log("\nSMOKE " + (ok ? "PASS" : "FAIL"));
    cleanup(ok ? 0 : 1);
  } catch (e) {
    console.error("DRIVER FAIL:", e);
    cleanup(1);
  }
})();
