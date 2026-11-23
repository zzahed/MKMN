// Live smoke test of the sidecar install methods (no destructive call: a small model is
// pulled and then removed again, both through the sidecar itself).
const { spawn } = require("child_process");

const child = spawn(process.execPath, ["dist/sidecar/main.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const events = [];
let nextId = 1;
const waiters = new Map();

child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { console.log("UNPARSEABLE:", line.slice(0, 120)); continue; }
    if (m.t === "event") { events.push(m); console.log(`EVENT ${m.name}:`, JSON.stringify(m.payload).slice(0, 160)); }
    else if (m.t === "res") {
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); }
    }
  }
});
child.stderr.on("data", (d) => console.error("STDERR:", d.toString().trim().slice(0, 200)));

function call(method, ...args) {
  const id = `t-${nextId++}`;
  return new Promise((res, rej) => {
    waiters.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n");
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("ping:", JSON.stringify(await call("ping")));
  console.log("cancelInstall(unknown):", JSON.stringify(await call("cancelInstall", "does-not-exist").catch((e) => `error: ${e.message}`)));
  console.log("installDynamic(bogus):", JSON.stringify(await call("installDynamic", "no-such-pack").catch((e) => `error: ${e.message}`)));
  console.log("uninstallDynamic(bogus):", JSON.stringify(await call("uninstallDynamic", "no-such-pack").catch((e) => `error: ${e.message}`)));

  // A real small install + uninstall roundtrip: gemma-3-1b-it GGUF (~1 GB), then removed again.
  console.log("\n--- installing gemma-3-1b-it via installDynamicModel (pack 2B) ---");
  try {
    await call("installDynamicModel", "2B", "gemma-3-1b-it");
  } catch (e) { console.log("installDynamicModel rejected:", e.message); }
  console.log(`\n${events.filter((e) => e.name === "install").length} install events, ${events.filter((e) => e.name === "dynamicInstall").length} dynamicInstall events so far`);

  console.log("\n--- uninstalling it again through the sidecar ---");
  const entry = { id: "gemma-3-1b-it", repo: "unsloth/gemma-3-1b-it-GGUF", quant: "Q4_0", engine: "llama_cpp" };
  const r = await call("uninstall", entry).catch((e) => ({ error: e.message }));
  console.log("uninstall:", JSON.stringify(r));

  child.stdin.end();
  await sleep(500);
  child.kill();
  process.exit(0);
})().catch((e) => { console.error("DRIVER FAIL:", e); child.kill(); process.exit(1); });
