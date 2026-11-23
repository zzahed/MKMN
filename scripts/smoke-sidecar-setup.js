// Live smoke of the sidecar setup/update methods. One-shot driver.
const { spawn } = require("child_process");
const child = spawn(process.execPath, ["dist/sidecar/main.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; let nextId = 1; const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { console.log("UNPARSEABLE:", line.slice(0, 100)); continue; }
    if (m.t === "event") console.log(`EVENT ${m.name}:`, JSON.stringify(m.payload).slice(0, 220));
    else if (m.t === "res") { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); } }
    else if (m.t === "req") { child.stdin.write(JSON.stringify({ t: "res", id: m.id, ok: true, result: null }) + "\n"); }
  }
});
child.stderr.on("data", (d) => console.error("STDERR:", d.toString().trim().slice(0, 160)));
const call = (method, ...args) => { const id = `t-${nextId++}`; return new Promise((res, rej) => { waiters.set(id, { res, rej }); child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n"); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  console.log("ping:", JSON.stringify(await call("ping")));
  console.log("updateState:", JSON.stringify(await call("updateState")));
  console.log("updateForce:", JSON.stringify(await call("updateForce")));
  console.log("waiting for the setup check...");
  await sleep(3500);
  console.log("setupState:", JSON.stringify(await call("setupState"), null, 1).slice(0, 700));
  console.log("setupSkip(unknown):", JSON.stringify(await call("setupSkip", "no-such-step")));
  child.stdin.end(); await sleep(300); child.kill(); process.exit(0);
})().catch((e) => { console.error("DRIVER FAIL:", e); child.kill(); process.exit(1); });
