// Regression test for the sidecar's `appShutdown` during ACTIVE work: a long
// tool run is started, then the host's exit path calls `appShutdown` with a 3 s
// grace (as shutdown.rs does). Expected: the response acknowledges closing, the
// running tool process tree is killed (no orphan `ping.exe` left behind), any
// new request is REFUSED ("MKMN is shutting down; this request was not
// started."), and the sidecar exits on its own once nothing is outstanding.
//
// To observe the refusal, a second request is left pending on a host call
// (confirmRun is never answered for it): the sidecar then has outstanding work
// and cannot exit until it is released — exactly the "busy sidecar gets a
// graceful stop" situation the Rust host's shutdown handles.
//
// Run from the repo root with the bundled node:
//   node scripts/smoke-sidecar-shutdown.js
// (or with any native node >= 18; it only needs dist/sidecar/main.js built).
const { spawn, execSync } = require("child_process");

const child = spawn(process.execPath, ["dist/sidecar/main.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 1;
const waiters = new Map();
const runEvents = [];
let sidecarExited = false;
let exitCode = null;

const safeWrite = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch { /* the sidecar is gone */ } };

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
      if (m.name === "run") runEvents.push(m.payload);
      else console.log(`EVENT ${m.name}:`, JSON.stringify(m.payload).slice(0, 120));
    } else if (m.t === "res") {
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); }
    } else if (m.t === "req") {
      // the driver plays the host. The FIRST confirmRun (the long command we
      // want running) is approved; every later one is left UNANSWERED so the
      // request stays outstanding and the sidecar cannot exit yet.
      if (m.method === "confirmRun" && !confirmRunAnswered) {
        confirmRunAnswered = true;
        safeWrite({ t: "res", id: m.id, ok: true, result: true });
      } else if (m.method === "confirmRun") {
        pendingConfirmRunId = m.id; // held on purpose; released in step 6
      } else {
        safeWrite({ t: "res", id: m.id, ok: false, error: `the shutdown-smoke host does not offer "${m.method}"` });
      }
    }
  }
});
let confirmRunAnswered = false;
let pendingConfirmRunId = null;
child.stderr.on("data", (d) => console.error("STDERR:", d.toString().trim().slice(0, 200)));
child.on("exit", (code) => { sidecarExited = true; exitCode = code; console.log(`sidecar exited (code=${code})`); });

const call = (method, ...args) => {
  const id = `t-${nextId++}`;
  return new Promise((res, rej) => {
    waiters.set(id, { res, rej });
    safeWrite({ t: "req", id, method, args });
  });
};
const callWithTimeout = async (method, ...args) => Promise.race([
  call(method, ...args),
  sleep(5000).then(() => { throw new Error(`no response to ${method} within 5 s`); }),
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(150); }
  return false;
};

// The sidecar's tool runs go through cmd (`shell: true`); a long `ping` keeps a
// real child process alive long enough to observe the kill.
const pingCount = () => {
  try {
    const out = execSync('powershell -NoProfile -Command "@(Get-Process PING -ErrorAction SilentlyContinue).Count"', { encoding: "utf8" });
    return parseInt(out.trim(), 10);
  } catch { return -1; }
};

let failed = false;
const assert = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${what}`);
  if (!cond) failed = true;
};

(async () => {
  console.log("ping:", JSON.stringify(await callWithTimeout("ping")));

  // 1. start a long tool run (30 s of ping; it must never finish on its own)
  await callWithTimeout("runCommand", "r1", "ping -n 30 127.0.0.1");
  const runStarted = await waitFor(() => pingCount() > 0, 10000);
  assert(runStarted, "the tool run's child process (ping.exe) is active");
  if (!runStarted) throw new Error("precondition failed: no active run child");
  const before = pingCount();

  // 2. keep the sidecar BUSY across the shutdown: a second run whose approval
  //    is never answered (its request stays outstanding, so no timeout here).
  void call("runCommand", "r2", "ping -n 30 127.0.0.1").catch(() => { /* resolved late or never: fine */ });
  await sleep(500);
  assert(!sidecarExited, "precondition: the sidecar is still alive with pending work");

  // 3. the host's exit path: appShutdown with a short grace (shutdown.rs)
  const ack = await Promise.race([
    call("appShutdown"),
    sleep(3000).then(() => { throw new Error("appShutdown did not answer within the 3 s grace"); }),
  ]);
  assert(ack && ack.ok === true && ack.closing === true, `appShutdown acknowledged (ok=${ack && ack.ok}, closing=${ack && ack.closing})`);

  // 4. the running tool's process tree was killed, not orphaned
  const killed = await waitFor(() => pingCount() < before, 10000);
  assert(killed, `the active run's process tree was killed (ping.exe ${before} -> ${pingCount()})`);

  // 5. new work is refused while shutting down (the sidecar is alive: r2 pending)
  const refused = await call("ping").then(() => null, (e) => e);
  assert(refused && /shutting down/.test(refused.message), `new request refused: "${refused && refused.message}"`);

  // 6. release the pending work: the sidecar must exit on its own (closing + nothing outstanding)
  assert(!sidecarExited, "the sidecar waits for its outstanding request before exiting");
  // answer the hanging confirmRun (r2) with a DECLINE: no new run spins up
  if (pendingConfirmRunId) safeWrite({ t: "res", id: pendingConfirmRunId, ok: true, result: false });
  // the decline makes the sidecar emit a stopped exit for r2 and drain
  await waitFor(() => sidecarExited, 15000);
  assert(sidecarExited, "the sidecar exited by itself once nothing is outstanding");
  assert(exitCode === 0, `the sidecar exited cleanly (code=${exitCode})`);

  if (failed) process.exit(1);
  console.log("\nSMOKE OK: appShutdown during active work kills runs, refuses new work, exits cleanly");
  process.exit(0);
})().catch((e) => { console.error("DRIVER FAIL:", e); try { child.kill(); } catch { /* already exited */ } process.exit(1); });
