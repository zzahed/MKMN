import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import * as path from "node:path";
import { runExamples, smokeRun } from "../src/core/construct/sandbox";
import { runCases } from "../src/core/benchChecks";
import { codeChecks } from "../src/core/labCode";
import { IsolationUnsafeError, lockedNodeArgs, setIsolation } from "../src/core/isolate";
import { codeDirs, ISOLATION_PROBE, lockedEnv, lockedNodeRunner, probeVerdict, proveNetworkDenied, proveNetworkDeniedSync } from "../src/sidecar/isolation";

/**
 * Code a model wrote was run with node:vm INSIDE the sidecar: Node says vm is not a
 * security boundary, and a context made from a host object is escaped by
 * `this.constructor.constructor("return process")()`. The sidecar now runs these checks
 * in a one-shot Node process with the permission model on (read the app's own code,
 * nothing else). This test escapes ON PURPOSE and shows what the escape reaches:
 * everything in place (as before), nothing in the locked-down process.
 */

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const worker = path.join(dist, "sidecar", "isolateWorker.js");

beforeAll(() => {
  // the worker runs as compiled JavaScript, the way the app ships it
  execFileSync(process.execPath, [path.join(root, "node_modules", "typescript-compiler", "bin", "tsc"), "-p", path.join(root, "tsconfig.sidecar.json")], { cwd: root, windowsHide: true, stdio: "ignore" });
  if (!existsSync(worker)) throw new Error("the sidecar did not build");
}, 180_000);

afterEach(() => setIsolation(null));

const outside = path.join(root, "package.json").replace(/\\/g, "\\\\"); // outside dist: not the app's runtime code
const ESCAPE = `(function () { var p = this.constructor.constructor("return process")(); var m = function (n) { return p.getBuiltinModule(n); }; var r = []; ` +
  `try { m("fs").readFileSync("${outside}", "utf8"); r.push("read"); } catch (e) { r.push("fs:" + (e.code || "error")); } ` +
  `try { m("child_process").execFileSync(p.execPath, ["--version"]); r.push("spawned"); } catch (e) { r.push("child:" + (e.code || "error")); } ` +
  `return r.join(","); })()`;

/** What the escape reported (the failure echoes the call, then `gave "..."`). */
const gave = (failures: string[]) => /gave "([^"]*)"/.exec(failures.join(" "))?.[1] ?? "";

describe("generated code runs in a locked-down process", () => {
  it("in place (the old way), an escape reads the person's files and starts programs", async () => {
    const r = await runExamples([], "function f() { return 1; }", [{ call: ESCAPE, expect: '"x"' }]);
    expect(gave(r.failures)).toMatch(/^read,spawned/);
  });

  it("in the locked-down process the same escape reads nothing, starts nothing and opens no connection", async () => {
    setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
    const r = await runExamples([], "function f() { return 1; }", [{ call: ESCAPE, expect: '"x"' }]);
    expect(gave(r.failures)).toBe("fs:ERR_ACCESS_DENIED,child:ERR_ACCESS_DENIED");
  }, 60_000);

  it("a process with the same locked flags cannot open a connection (it fails later, so it is tried apart)", async () => {
    const server = createServer((s) => { reached = true; s.destroy(); });
    let reached = false;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const code = `const s = require("net").connect(${port}, "127.0.0.1"); s.on("connect", () => { console.log("CONNECTED"); s.destroy(); }); s.on("error", (e) => console.log(e.code));`;
      const out = await new Promise<string>((resolve) => {
        execFile(process.execPath, [...lockedNodeArgs(codeDirs(path.join(dist, "sidecar")), "-e"), code], { windowsHide: true, timeout: 20_000 }, (_e, stdout) => resolve(String(stdout).trim()));
      });
      expect(out).toBe("ERR_ACCESS_DENIED");
      expect(reached).toBe(false);
    } finally { server.close(); }
  }, 60_000);

  it("the checks still work there: examples, a smoke run, the benchmark's cases and the lab's code checks", async () => {
    setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
    expect(await runExamples([], "function add(a, b) { return a + b; }", [{ call: "add(2, 3)", expect: "5" }])).toEqual({ ok: true, failures: [] });
    expect(await smokeRun({ kind: "fn", name: "double", code: "function double(n) { return n * 2; }", state: JSON.stringify({ n: 2 }), others: [], params: ["n"] } as never)).toEqual([]);
    expect(runCases("function sq(x) { return x * x; }", [["sq(3)", 9], ["sq(-2)", 4]])).toEqual({ passed: 2, total: 2, error: undefined });
    const checks = [{ kind: "run", expr: "inc(1)", want: "2" }] as never[];
    const ran = await codeChecks("```js\nfunction inc(n) { return n + 1; }\n```", checks);
    expect([...ran.keys()][0]).toBe(checks[0]); // keyed by the caller's own check
  }, 60_000);

  // Security pre-review 2026-11-24, F1 and F2: node:sqlite opened, attached and wrote files outside
  // the permission model's file-system rules, and process.kill reached every process of the user.
  it("in the locked-down process an escape can neither write a file through SQLite nor signal or reprioritise another process", async () => {
    const target = path.join(tmpdir(), `mkmn-isolation-${process.pid}.db`);
    rmSync(target, { force: true });
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
    try {
      const sqlTarget = target.replace(/\\/g, "/").replace(/'/g, "''");
      const escape = `(function () { var p = this.constructor.constructor("return process")(); var r = []; ` +
        `try { var s = p.getBuiltinModule("node:sqlite"); if (!s) r.push("sqlite:none"); else { new s.DatabaseSync(":memory:").exec("vacuum into '${sqlTarget}'"); r.push("sqlite:wrote"); } } catch (e) { r.push("sqlite:" + (e.code || "error")); } ` +
        `try { p.kill(${victim.pid}, 0); r.push("kill:signalled"); } catch (e) { r.push("kill:" + (e.code || "error")); } ` +
        `try { p._kill(${victim.pid}, 0); r.push("rawkill:signalled"); } catch (e) { r.push("rawkill:" + (e.code || "error")); } ` +
        // found reviewing #52: the permission model does not cover another process's priority either
        `try { p.getBuiltinModule("os").setPriority(${victim.pid}, 19); r.push("priority:changed"); } catch (e) { r.push("priority:" + (e.code || "error")); } ` +
        `return r.join(","); })()`;
      const priorityBefore = getPriority(victim.pid!);
      setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
      const r = await runExamples([], "function f() { return 1; }", [{ call: escape, expect: '"x"' }]);
      expect(gave(r.failures)).toBe("sqlite:none,kill:ERR_ACCESS_DENIED,rawkill:ERR_ACCESS_DENIED,priority:ERR_ACCESS_DENIED");
      expect(existsSync(target)).toBe(false);
      expect(victim.exitCode).toBeNull();
      expect(getPriority(victim.pid!)).toBe(priorityBefore);
    } finally {
      victim.kill();
      rmSync(target, { force: true });
    }
  }, 60_000);

  // F3: Windows (libuv) copies its own list of variables into a child whose environment lacks
  // them (USERNAME, USERPROFILE, PATH, TEMP...), so an empty-looking environment still named the
  // person and their profile folder. They are now passed blank, which libuv leaves as they are.
  it("in the locked-down process an escape finds no user name, profile folder, temp folder or PATH", async () => {
    const escape = `(function () { var e = this.constructor.constructor("return process")().env; ` +
      `return ["USERNAME", "USERPROFILE", "HOMEPATH", "USERDOMAIN", "LOGONSERVER", "TEMP", "TMP", "PATH"].map(function (k) { return k + "=" + (e[k] || ""); }).join(","); })()`;
    setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
    const r = await runExamples([], "function f() { return 1; }", [{ call: escape, expect: '"x"' }]);
    expect(gave(r.failures)).toBe("USERNAME=,USERPROFILE=,HOMEPATH=,USERDOMAIN=,LOGONSERVER=,TEMP=,TMP=,PATH=");
  }, 60_000);

  it("a process with the same locked flags has no node:sqlite at all", () => {
    const out = execFileSync(process.execPath, [...lockedNodeArgs(codeDirs(path.join(dist, "sidecar")), "-e"), `console.log(typeof process.getBuiltinModule("node:sqlite"))`], { windowsHide: true, encoding: "utf8" });
    expect(out.trim()).toBe("undefined");
  }, 60_000);

  it("a loop that never ends is stopped and reported, not left running", async () => {
    setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
    const r = await runExamples([], "function spin() { while (true) {} }", [{ call: "spin()", expect: "1" }]);
    expect(r.ok).toBe(false);
  }, 60_000);
});

/**
 * Security pre-review 2026-11-24, F6 and F7. An escape reaches the worker's own `process`, so it
 * could print a reply of its own (and exit before the real one), rewrite the real one on its way
 * out, or bend the builtins the reply is made with: every check it was judged by then "passed".
 * And it could print without end into the sidecar's memory.
 */
describe("the locked-down process's reply is the worker's, and its output is bounded", () => {
  const locked = () => setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
  const failing = (call: string) => runExamples([], "function f() { return 1; }", [{ call, expect: '"never"' }]).then((r) => r, (e: Error) => e);
  const PASSED = '{"ok":true,"value":{"ok":true,"failures":[]}}';
  const esc = (body: string) => `(function () { var p = this.constructor.constructor("return process")(); ${body} return "x"; })()`;

  it("a reply the code printed itself, before exiting, is not taken for the worker's", async () => {
    locked();
    const r = await failing(esc(`p.stdout.write('${PASSED}\\n'); p.exit(0);`));
    expect(r).not.toEqual({ ok: true, failures: [] });
    expect(r).toBeInstanceOf(Error);
  }, 60_000);

  it("a reply the code printed itself, with the real one still to come, is not taken either", async () => {
    locked();
    const r = await failing(esc(`p.on("exit", function () { p.stdout.write('${PASSED}\\n'); });`));
    expect(r).toMatchObject({ ok: false });
  }, 60_000);

  it("the code cannot rewrite the real reply on its way out", async () => {
    locked();
    const r = await failing(esc(`var w = p.stdout.write.bind(p.stdout); p.stdout.write = function (s, cb) { return w('${PASSED}\\n', cb); }; ` +
      `var fs = p.getBuiltinModule("fs"), ws = fs.writeSync; fs.writeSync = function (fd) { return ws(fd, '${PASSED}\\n'); };`));
    expect(r).toMatchObject({ ok: false });
  }, 60_000);

  it("the code cannot bend the builtins the reply and the verdict are made with", async () => {
    locked();
    const r = await failing(esc(`var O = p.constructor.constructor("return Object")(), J = p.constructor.constructor("return JSON")(); ` +
      `try { O.defineProperty(O.prototype, "toJSON", { value: function () { return this && this.failures ? { ok: true, failures: [] } : this; }, configurable: true }); } catch (e) {} ` +
      `try { J.stringify = function () { return '${PASSED}'; }; } catch (e) {} ` +
      `try { p.constructor.constructor("return Array")().prototype.push = function () { return 0; }; } catch (e) {}`));
    expect(r).toMatchObject({ ok: false });
  }, 60_000);

  // CI on Linux: there stdout to a pipe is asynchronous, so the code's last unterminated output
  // could still be on the line the reply was written to
  it("output that does not end its line does not hide the real reply", async () => {
    locked();
    const r = await failing(esc(`p.getBuiltinModule("fs").writeSync(1, "no newline"); p.stdout.write("nor this");`));
    expect(r).toMatchObject({ ok: false });
  }, 60_000);

  it("output past the limit stops the check and is reported, on the async and the sync path", async () => {
    locked();
    // written synchronously (an asynchronous write may be dropped when the worker exits, as on Linux)
    const flood = esc(`var fs = p.getBuiltinModule("fs"), b = p.getBuiltinModule("buffer").Buffer.alloc(1 << 20, 120); ` +
      `for (var i = 0; i < 40; i++) for (var at = 0; at < b.length;) { try { at += fs.writeSync(1, b, at, b.length - at); } catch (e) { if (e.code !== "EAGAIN") throw e; } }`);
    const r = await failing(flood);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/printed more than 16 MiB and was stopped/);
    expect(() => runCases(`function f() { return ${flood}; }`, [["f()", 1]])).toThrow(/printed more than 16 MiB and was stopped/);
  }, 60_000);
});

/**
 * QE-1.4: the locked flags only protect when THIS Node binary enforces them. Node 24's
 * permission model let a locked process open a connection, so the sidecar now proves the
 * runtime denies the network before it runs any generated code, and refuses when it cannot.
 */
describe("generated code runs only on a runtime that is proven to block the network", () => {
  const dirs = () => codeDirs(path.join(dist, "sidecar"));
  const NO_NODE = path.join(root, "no-such-node.exe"); // spawning it would fail with ENOENT, not the refusal

  it("refuses with IsolationUnsafeError, and never starts the check, when the probe says the network is open", async () => {
    let probes = 0;
    const runner = lockedNodeRunner(NO_NODE, worker, dirs(), { probe: async () => { probes++; return false; }, probeSync: () => { probes++; return false; } });
    const first = await runner.run("runExamples", []).catch((e: Error) => e);
    expect(first).toBeInstanceOf(IsolationUnsafeError);
    expect((first as Error).name).toBe("IsolationUnsafeError");
    expect((first as Error).message).toBe("Generated code is turned off: this Node.js runtime cannot keep it away from the network and your files.");
    expect(() => runner.runSync("runExamples", [])).toThrow(IsolationUnsafeError);
    await expect(runner.run("runExamples", [])).rejects.toThrow(IsolationUnsafeError);
    expect(probes).toBe(1); // asked once, then remembered
  });

  it("runs the check when the probe proves the network is denied", async () => {
    let probes = 0;
    setIsolation(lockedNodeRunner(process.execPath, worker, dirs(), { probe: async () => { probes++; return true; }, probeSync: () => { probes++; return true; } }));
    expect(await runExamples([], "function add(a, b) { return a + b; }", [{ call: "add(2, 3)", expect: "5" }])).toEqual({ ok: true, failures: [] });
    expect(await runExamples([], "function add(a, b) { return a + b; }", [{ call: "add(1, 1)", expect: "2" }])).toEqual({ ok: true, failures: [] });
    expect(probes).toBe(1);
  }, 60_000);

  it("on this runtime the probe gives the same answer as the connection test above", async () => {
    expect(await proveNetworkDenied(process.execPath, dirs())).toBe(true);
    expect(proveNetworkDeniedSync(process.execPath, dirs())).toBe(true);
  }, 60_000);

  it("the shared isolation module imports nothing that only Node has: the window bundles it", () => {
    // src/core/construct/sandbox.ts reaches the window's bundle, and it imports src/core/isolate.ts;
    // a Node built-in there breaks `vite build` ("execFile" is not exported by "__vite-browser-external")
    const src = readFileSync(path.join(root, "src", "core", "isolate.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"(node:)?(child_process|fs|net|dgram|dns|os|path|http|https)"/);
  });

  it("fails closed: no answer from the probe is never taken as a denied network (it is 'could not tell')", async () => {
    expect(await proveNetworkDenied(NO_NODE, dirs())).toBeNull();
    expect(proveNetworkDeniedSync(NO_NODE, dirs())).toBeNull();
  }, 60_000);

  // The final review: one slow first start (an antivirus scan, a loaded PC) used to be kept as
  // "unsafe" for the whole session, and the message blamed the runtime. Only a definite answer
  // is remembered now; "could not tell" refuses that run and is asked again.
  it("reads the probe's output: only ERR_ACCESS_DENIED proves the ban, a socket error code proves it open, anything else is 'could not tell'", () => {
    expect(probeVerdict("ERR_ACCESS_DENIED\n")).toBe(true);
    expect(probeVerdict("ECONNREFUSED")).toBe(false);
    expect(probeVerdict("CONNECTED")).toBe(false);
    expect(probeVerdict("EACCES")).toBe(false);
    expect(probeVerdict("SQLITE_AVAILABLE")).toBe(false); // the file-system bypass of F1 is open
    expect(probeVerdict("SQLITE_AVAILABLE\nERR_ACCESS_DENIED")).toBeNull();
    expect(probeVerdict("")).toBeNull();
    expect(probeVerdict(undefined)).toBeNull();
    expect(probeVerdict("node:internal/modules/cjs/loader:1\nError: boom")).toBeNull();
  });

  it("'could not tell' refuses this run with its own message, is not remembered, and a later proof lets the check run", async () => {
    const answers: (boolean | null)[] = [null, true];
    let probes = 0;
    const next = (): boolean | null => (probes < answers.length ? answers[probes++] : (probes++, true));
    const runner = lockedNodeRunner(process.execPath, worker, dirs(), { probe: async () => next(), probeSync: () => next() });
    const first = await runner.run("runExamples", []).catch((e: Error) => e);
    expect(first).toBeInstanceOf(IsolationUnsafeError);
    expect((first as Error).message).toBe("Generated code is paused: MKMN could not confirm that this Node.js runtime blocks network access. It checks again on the next run.");
    setIsolation(runner);
    expect(await runExamples([], "function add(a, b) { return a + b; }", [{ call: "add(2, 3)", expect: "5" }])).toEqual({ ok: true, failures: [] });
    expect(await runExamples([], "function add(a, b) { return a + b; }", [{ call: "add(1, 1)", expect: "2" }])).toEqual({ ok: true, failures: [] });
    expect(probes).toBe(2); // asked again after "could not tell", then the proof is remembered
  }, 60_000);

  it("a probe that throws is 'could not tell' too, on the synchronous path as well", () => {
    let probes = 0;
    const runner = lockedNodeRunner(NO_NODE, worker, dirs(), { probe: async () => { throw new Error("spawn failed"); }, probeSync: () => { probes++; throw new Error("spawn failed"); } });
    expect(() => runner.runSync("runExamples", [])).toThrow(/could not confirm/);
    expect(() => runner.runSync("runExamples", [])).toThrow(/could not confirm/);
    expect(probes).toBe(2);
  });

  // F4: the probe used to try only one TCP connection, so a runtime that blocked the network but
  // let generated code write files, start programs or start workers passed as safe.
  it("the probe proves every restriction the runner relies on, and names the first one a runtime lacks", () => {
    const run = (flags: string[]) => {
      const r = spawnSync(process.execPath, [...flags, "-e", ISOLATION_PROBE], { windowsHide: true, encoding: "utf8", timeout: 30_000, env: lockedEnv() });
      return String(r.stdout).trim();
    };
    const locked = lockedNodeArgs(dirs(), "-e").slice(0, -1);
    expect(run(locked)).toBe("ERR_ACCESS_DENIED");
    expect(run([])).toBe("SQLITE_AVAILABLE");
    expect(run(["--no-experimental-sqlite"])).toBe("FS_WRITE_OPEN");
    expect(run([...locked, "--allow-fs-write=*"])).toBe("FS_WRITE_OPEN");
    expect(run([...locked, "--allow-child-process"])).toBe("CHILD_PROCESS_OPEN");
    expect(run([...locked, "--allow-worker"])).toBe("WORKER_OPEN");
    // the reply-integrity fix (#55) relies on the worker's builtins being frozen: a runtime that
    // ignores --frozen-intrinsics, or a runner started without it, is not proven safe
    expect(run(locked.filter((f) => f !== "--frozen-intrinsics"))).toBe("INTRINSICS_OPEN");
    expect(run([...locked, "--allow-net"])).toMatch(/^E(?!RR_)[A-Z0-9]+$/); // the network is open: a socket error, ECONNREFUSED
    for (const out of ["FS_WRITE_OPEN", "CHILD_PROCESS_OPEN", "WORKER_OPEN", "INTRINSICS_OPEN"]) expect(probeVerdict(out)).toBe(false);
    for (const out of ["FS_WRITE_UNKNOWN", "CHILD_PROCESS_UNKNOWN", "WORKER_UNKNOWN"]) expect(probeVerdict(out)).toBeNull();
  }, 120_000);

  it("a locked process cannot resolve a name, send UDP or fetch either", async () => {
    const run = (code: string) => new Promise<string>((resolve) => {
      execFile(process.execPath, [...lockedNodeArgs(dirs(), "-e"), code], { windowsHide: true, timeout: 20_000 }, (_e, stdout) => resolve(String(stdout).trim()));
    });
    expect(await run(`require("dns").lookup("localhost", (e) => console.log(e ? e.code : "RESOLVED"));`)).toBe("ERR_ACCESS_DENIED");
    expect(await run(`const u = require("dgram").createSocket("udp4"); u.on("error", (e) => { console.log(e.code); u.close(); }); u.send("x", 9, "127.0.0.1", (e) => { if (!e) { console.log("SENT"); u.close(); } });`)).toBe("ERR_ACCESS_DENIED");
    expect(await run(`fetch("http://127.0.0.1:59999/").then(() => console.log("FETCHED"), (e) => { let c = e; while (c.cause) c = c.cause; console.log(c.code || c.message); });`)).toBe("ERR_ACCESS_DENIED");
  }, 60_000);
});
