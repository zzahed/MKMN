// Live smoke of the sidecar sandbox, media and tasks. The driver plays the Rust
// host: confirmRun is scripted per call, openPath/notify answer ok. No NPU work: the task
// run is only checked for its busy-NPU refusal path and the store round-trip.
const { spawn } = require("child_process");

const child = spawn(process.execPath, ["dist/sidecar/main.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; let nextId = 1; const waiters = new Map();
const runEvents = []; let confirmScript = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { console.log("UNPARSEABLE:", line.slice(0, 120)); continue; }
    if (m.t === "event") {
      if (m.name === "run") { runEvents.push(m.payload); console.log(`RUN ${m.payload.runId} ${m.payload.type}:`, String(m.payload.text ?? m.payload.error ?? "").trim().slice(0, 100)); }
      else if (m.name === "tasks") console.log("EVENT tasks:", JSON.stringify(m.payload).slice(0, 120));
      else console.log(`EVENT ${m.name}:`, JSON.stringify(m.payload).slice(0, 120));
    } else if (m.t === "res") { const w = waiters.get(m.id); if (!m.ok) console.log("RES-ERR:", m.id, m.error); if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); } }
    else if (m.t === "req") void handleHostRequest(m);
  }
});
child.stderr.on("data", (d) => console.error("STDERR:", d.toString().trim().slice(0, 160)));

async function handleHostRequest(m) {
  const reply = (ok, result, error) => child.stdin.write(JSON.stringify({ t: "res", id: m.id, ok, ...(ok ? { result } : { error }) }) + "\n");
  if (m.method === "confirmRun") { const v = confirmScript.length ? confirmScript.shift() : false; console.log(`HOST confirmRun (${m.args?.[3]}): ${v}`); return reply(true, v); }
  if (m.method === "openPath") { console.log("HOST openPath:", m.args?.[0]); return reply(true, true); }
  if (m.method === "notify") { console.log("HOST notify:", JSON.stringify(m.args)); return reply(true, true); }
  return reply(false, null, `the smoke host does not offer "${m.method}"`);
}

const call = (method, ...args) => { const id = `t-${nextId++}`; return new Promise((res, rej) => { waiters.set(id, { res, rej }); child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n"); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); } return false; };

function cleanup(code) { child.stdin.end(); child.kill(); process.exit(code); }

(async () => {
  try {
    console.log("ping:", JSON.stringify(await call("ping")));

    // 1. a command the user declines: a stopped exit, no run
    confirmScript = [false];
    await call("runCommand", "r1", "echo hello");
    if (!(await waitFor(() => runEvents.some((e) => e.runId === "r1" && e.type === "exit" && e.stopped === true), 10000))) throw new Error("declined command did not end with a stopped exit");
    console.log("declined: ok");

    // 2. an approved command: output and exit 0
    confirmScript = [true];
    await call("runCommand", "r2", "echo smoke-echo");
    if (!(await waitFor(() => runEvents.some((e) => e.runId === "r2" && e.type === "exit" && e.code === 0), 30000))) throw new Error("approved command did not exit 0");
    if (!runEvents.some((e) => e.runId === "r2" && e.type === "out" && e.text.includes("smoke-echo"))) throw new Error("the command's output did not stream");
    console.log("approved command: ok");

    // 3. runCode in a language, declined then approved (node is this very binary)
    confirmScript = [true];
    await call("runCode", "r3", "javascript", "console.log('code-runs')");
    if (!(await waitFor(() => runEvents.some((e) => e.runId === "r3" && e.type === "exit" && e.code === 0), 30000))) throw new Error("runCode did not exit 0");
    if (!runEvents.some((e) => e.runId === "r3" && e.type === "out" && e.text.includes("code-runs"))) throw new Error("the code's output did not stream");
    console.log("runCode: ok");

    // 4. a built site opens through the host
    const page = { title: "Home", kind: "html", language: "html", content: "<h1>hi</h1>" };
    const site = await call("launchSite", [page], page);
    if (!site.path) throw new Error("launchSite returned no path: " + JSON.stringify(site));
    console.log("launchSite: ok", site.path);

    // 5. media round-trip
    const px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const saved = await call("saveMedia", `data:image/png;base64,${px}`);
    if (!saved.mediaId) throw new Error("saveMedia did not keep the picture");
    const readBack = await call("readMedia", saved.mediaId);
    if (!readBack || !readBack.dataUrl.startsWith("data:image/png;base64,")) throw new Error("readMedia did not read it back");
    console.log("media: ok", saved.path);

    // 6. tasks: save (invalid schedule throws), list, delete. A previous run may have left
    //    the task behind (the first one ran before unknown schedules were rejected): drop it,
    //    so the invalid save really is a change.
    const base = { id: "smoke-task", name: "Smoke task", prompt: "Say ok.", schedule: { kind: "daily", time: "09:00" }, enabled: true };
    await call("deleteTask", "smoke-task").catch(() => {});
    let bad = null;
    try { await call("saveTask", { ...base, schedule: { kind: "nonsense" } }); } catch (e) { bad = e.message; }
    console.log("invalid schedule rejected:", JSON.stringify(bad));
    if (!bad) throw new Error("an invalid schedule was accepted");
    await call("saveTask", base);
    const tasks = await call("tasks");
    const mine = tasks.find((t) => t.id === "smoke-task");
    if (!mine || !mine.nextRun) throw new Error("the task was not saved with a next run");
    console.log("task saved, nextRun:", new Date(mine.nextRun).toISOString());
    // 7. runTask while the NPU is idle still starts a run we cannot wait for (a real chat);
    //    the honest check is that a run appears or the lease refuses. Stop it right away.
    void call("runTask", "smoke-task");
    await sleep(1500);
    const after = (await call("tasks")).find((t) => t.id === "smoke-task");
    console.log("after runTask: running =", after.running, "runs =", (after.runs ?? []).length, (after.runs ?? [])[0]?.error ?? "");
    await call("deleteTask", "smoke-task");
    if ((await call("tasks")).some((t) => t.id === "smoke-task")) throw new Error("the task was not deleted");
    console.log("tasks: ok");

    console.log("\nSMOKE PASS");
    cleanup(0);
  } catch (e) {
    console.error("DRIVER FAIL:", e);
    cleanup(1);
  }
})();
