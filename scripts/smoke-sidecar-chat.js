// Live smoke test of the sidecar chat: the orchestrator runs in the sidecar, the
// driver plays the Rust host (`startChatServer` spawns geniex serve and polls /v1/models
// until the data array is non-empty — the same readiness rule the supervisor applies).
// Prints the answer, then stops the server and the sidecar.
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 18199; // not the app's 18181: a stray smoke server must never collide with the app
const ENDPOINT = `http://127.0.0.1:${PORT}/v1`;

const findGeniex = () => {
  const candidates = [
    process.env.GENIEX_PATH,
    path.join(process.env.LOCALAPPDATA ?? "", "GenieX CLI", "geniex.exe")
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("geniex.exe not found");
};

const child = spawn(process.execPath, ["dist/sidecar/main.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 1;
const waiters = new Map();
const chatEvents = []; // every `chat` event of the smoke turn
let serveChild = null;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { console.log("UNPARSEABLE:", line.slice(0, 120)); continue; }
    if (m.t === "event") {
      if (m.name === "chat") {
        chatEvents.push(m.payload);
        const p = m.payload;
        if (p.type === "answer") process.stdout.write(p.text ?? "");
        else if (p.type === "done") console.log(`\n[done] ${JSON.stringify(p.stats)}`);
        else if (p.type === "error") console.log(`\n[error] ${JSON.stringify(p.error)}`);
        else if (p.type === "agent") console.log(`[agent ${p.status ?? "run"}] ${p.name}: ${String(p.output ?? p.error ?? "").slice(0, 120)}`);
        else console.log(`[${p.type}]`, JSON.stringify(p).slice(0, 140));
      } else console.log(`EVENT ${m.name}:`, JSON.stringify(m.payload).slice(0, 120));
    } else if (m.t === "res") {
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); }
    } else if (m.t === "req") {
      void handleHostRequest(m);
    }
  }
});
child.stderr.on("data", (d) => console.error("STDERR:", d.toString().trim().slice(0, 200)));

/** The host capabilities: the same contract sidecar.rs implements. */
async function handleHostRequest(m) {
  const reply = (ok, result, error) => child.stdin.write(JSON.stringify({ t: "res", id: m.id, ok, ...(ok ? { result } : { error }) }) + "\n");
  try {
    if (m.method === "startChatServer") {
      const [model, compute] = m.args ?? [];
      console.log(`HOST startChatServer: ${model} (${compute})`);
      const exe = findGeniex();
      const args = ["serve", "--host", `127.0.0.1:${PORT}`, "--compute", compute || "npu", "--power-mode", "burst", "--keepalive", "300", "--metrics", "--model", model];
      serveChild = spawn(exe, args, { stdio: "ignore" });
      const readyAt = Date.now() + 180_000;
      while (Date.now() < readyAt) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const r = await fetch(`${ENDPOINT}/models`);
          const j = await r.json();
          if (Array.isArray(j.data) && j.data.length) {
            console.log(`HOST server ready: ${j.data.length} model(s) at ${ENDPOINT}`);
            return reply(true, { endpoint: ENDPOINT, state: "ready", model, lastError: null });
          }
        } catch { /* not listening yet */ }
      }
      return reply(false, null, "the model server did not become ready in time");
    }
    if (m.method === "pickFolder") return reply(true, null);
    return reply(false, null, `the smoke host does not offer "${m.method}"`);
  } catch (e) {
    reply(false, null, String(e.message ?? e));
  }
}

function call(method, ...args) {
  const id = `t-${nextId++}`;
  return new Promise((res, rej) => {
    waiters.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n");
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  if (serveChild) { try { process.kill(serveChild.pid); } catch { /* gone */ } }
  child.stdin.end();
  child.kill();
  process.exit(code);
}

(async () => {
  try {
    console.log("ping:", JSON.stringify(await call("ping")));
    const { CATALOG, ref } = require(path.join(__dirname, "..", "dist", "core", "catalog.js"));
    const { parseModelList } = require(path.join(__dirname, "..", "dist", "core", "native.js"));
    // an installed catalog entry: `geniex model list` through the app's own parser
    const exe = findGeniex();
    const rows = parseModelList(execFileSync(exe, ["model", "list"], { encoding: "utf8", timeout: 30000 }));
    const canon = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const entry = CATALOG.find((e) => rows.some((m) => {
      const n = canon(m.name);
      return n === canon(ref(e)) || n === canon(e.repo) || n === canon(m.name.split("/").pop()) && canon(m.name.split("/").pop()) === canon(e.repo.split("/").pop());
    }));
    if (!entry) throw new Error("no installed catalog entry found among:\n" + rows.map((r) => r.name).join(", "));
    console.log("model:", entry.id, "->", ref(entry));

    console.log("\n--- chat: Hello. ---");
    await call("chat", "smoke-1", entry.id, [{ role: "user", content: "Hello. Answer with one short sentence." }], { effort: "off", subagents: false });

    const end = Date.now() + 300_000;
    // the end of a turn is found by its TYPE: a trailing "run" event follows "done"
    const ending = () => chatEvents.find((e) => e.type === "done" || e.type === "error");
    while (Date.now() < end && !ending()) await sleep(500);
    const last = ending();
    const ok = last && last.type === "done" && chatEvents.some((e) => e.type === "answer" && e.text && e.text.trim());
    console.log("\nSMOKE " + (ok ? "PASS" : "FAIL"));
    cleanup(ok ? 0 : 1);
  } catch (e) {
    console.error("DRIVER FAIL:", e);
    cleanup(1);
  }
})();
