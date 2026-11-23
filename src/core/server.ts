import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { ComputeTarget, FriendlyError, ServerStatus } from "../shared/types";
import { friendly, isNoise } from "./errors";

export interface ServerOptions {
  exe: string;
  host?: string; // 127.0.0.1:18181
  compute?: ComputeTarget;
  keepaliveSec?: number;
  maxRestarts?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  /** What `--compute` is given instead of the target above (hybrid, or a list of NPU sessions), read at each launch. */
  computeFn?: () => string | undefined;
  /** Extra arguments for `serve`, read at each launch (a debug log level during a benchmark). */
  extraArgs?: () => string[];
  /** Extra environment for `serve`, read at each launch (GGML_HEXAGON_* in the NPU load test). */
  extraEnv?: () => NodeJS.ProcessEnv;
  /** Where to ask whether the server is up, instead of `<endpoint>/models` (llama-server: /health, which answers only once the model is loaded). */
  readyUrl?: string;
  /** The whole command line, for another server than GenieX (llama-server): given the host and the context of this launch. */
  argsFn?: (host: string, nctx: number | null) => string[];
  /** Extra env (GENIEX_* equivalents). */
  env?: NodeJS.ProcessEnv;
  /** How long a stop waits for the old process to confirm its exit (a wedged runtime can take more than the previous fixed 3 s to die after taskkill). */
  stopConfirmMs?: number;
  /** The system whose kill policy applies (taskkill re-issued on "win32"); `process.platform` unless a test sets it. */
  platform?: NodeJS.Platform;
  /**
   * Adopt a server already listening on the host instead of spawning a duplicate (the router of a second
   * app instance). The real runs on a machine with the installed app open: the second instance's own
   * router could not bind the fixed port, but the readiness probe succeeded against the FIRST instance's
   * router, the instance declared itself ready while its child died through its restart attempts, and
   * every router question went unanswered. The router is a shared, stateless helper on the processor;
   * adoption is the honest answer. Never set for a chat server: it carries the conversation's own model.
   */
  adoptExisting?: boolean;
  /**
   * What an answering endpoint must say for it to be adopted, read from its models list.
   * Without it any HTTP answer on the port was adopted, so an unrelated program that
   * happened to listen there would have been sent the person's questions. The router
   * passes `servesRouterModel`: a GenieX models list that holds the router's model.
   */
  adoptIf?: (models: unknown) => boolean;
}

/**
 * Keeps `geniex serve` alive as a hidden child process: start, poll /v1/models until ready,
 * restart on crash with a smaller context when the NPU overflowed, stop on app close.
 * One server, one model: GenieX loads on first request and swaps on request.
 */
/** What a `--compute` value runs on: a list of NPU sessions ("HTP0,HTP1") is the NPU. */
const asComputeTarget = (c: string): ComputeTarget =>
  c === "cpu" || c === "gpu" || c === "hybrid" || c === "npu" ? c : "npu";

export class ServerManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private wantRunning = false;
  private nctx: number | null = null;
  /** The compute the current server was started with (null before the first start). */
  private startedCompute: string | null = null;
  private restarts = 0;
  private lastError: FriendlyError | null = null;
  private log: string[] = [];
  private state: ServerStatus["state"] = "stopped";
  /** True when the endpoint is served by another instance's process and no child of our own was spawned. */
  private adopted = false;
  /** Whether the current child ever answered its readiness probe (a spawn that died first cannot bind — see onExit). */
  private childEverReady = false;
  private startToken = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private stopEpoch = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: ServerOptions) {
    super();
  }

  get host() { return this.o.host ?? "127.0.0.1:18181"; }
  get endpoint() { return `http://${this.host}/v1`; }

  status(): ServerStatus {
    return {
      state: this.state,
      endpoint: this.endpoint,
      nctx: this.nctx,
      // what the server runs on: a manager started from a compute function (the router: CPU, else GPU) says that
      compute: asComputeTarget(this.startedCompute ?? this.o.computeFn?.() ?? this.o.compute ?? "npu"),
      restarts: this.restarts,
      lastError: this.lastError,
      pid: this.child?.pid ?? null,
      adopted: this.adopted || undefined
    };
  }

  recentLog(n = 60): string[] { return this.log.slice(-n); }

  /** True when this manager adopted an already-served endpoint (no child of its own). */
  isAdopted(): boolean { return this.adopted; }

  /** Whether what answers the endpoint may be adopted: it answers, and (when the owner
   *  says what it must serve) its models list says so. A body that is not JSON is not. */
  async adoptable(): Promise<boolean> {
    if (!this.o.adoptIf) return this.probe();
    const f = this.o.fetchFn ?? fetch;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1000);
      try {
        const r = await f(this.o.readyUrl ?? `${this.endpoint}/models`, { signal: ac.signal });
        if (!r.ok) return false;
        return this.o.adoptIf(await r.json());
      } finally { clearTimeout(timer); }
    } catch { return false; }
  }

  /** One readiness probe of the endpoint: does anything answer the models URL right now? */
  async probe(): Promise<boolean> {
    const f = this.o.fetchFn ?? fetch;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1000);
      try { return !!(await f(this.o.readyUrl ?? `${this.endpoint}/models`, { signal: ac.signal })).ok; }
      finally { clearTimeout(timer); }
    } catch { return false; }
  }

  private set(state: ServerStatus["state"]) {
    this.state = state;
    this.emit("status", this.status());
  }

  /** Start (or restart with a different context). Resolves when ready or rejects with the friendly error. */
  start(nctx: number): Promise<void> {
    const epoch = this.stopEpoch;
    return this.enqueue(async () => {
      if (epoch !== this.stopEpoch) throw new Error("Server start cancelled");
      if (this.child && this.nctx === nctx && this.state === "ready") return;
      // an adopted endpoint is kept only while it still answers; a dead one falls through to our own launch
      if (this.adopted) {
        if (await this.adoptable()) { this.nctx = nctx; this.set("ready"); return; }
        this.adopted = false;
      }
      await this.stopCurrent();
      if (epoch !== this.stopEpoch) throw new Error("Server start cancelled");
      this.nctx = nctx;
      this.wantRunning = true;
      this.restarts = 0;
      this.lastError = null;
      await this.launch();
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation);
    // A failed launch must not prevent a later retry or shutdown.
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  private cancelRestart() {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async launch(): Promise<void> {
    const token = ++this.startToken;
    // another instance's server already answers here: adopt it, spawn nothing (a second
    // child on the fixed port cannot bind, dies through its restart attempts, and every
    // question in between goes unanswered — the collision the real runs recorded)
    if (this.o.adoptExisting && (await this.adoptable())) {
      this.adopted = true;
      this.child = null;
      this.wantRunning = true;
      this.set("ready");
      return;
    }
    this.set(this.restarts > 0 ? "restarting" : "starting");
    let args: string[];
    if (this.o.argsFn) args = this.o.argsFn(this.host, this.nctx);
    else {
      const compute = this.o.computeFn?.() ?? this.o.compute ?? "npu";
      this.startedCompute = compute;
      args = ["serve", "--host", this.host, "--compute", compute, "--keepalive", String(this.o.keepaliveSec ?? 300)];
      if (this.nctx) args.push("--nctx", String(this.nctx));
      args.push(...(this.o.extraArgs?.() ?? []));
    }
    const child = (this.o.spawnFn ?? spawn)(this.o.exe, args, { windowsHide: true, env: { ...process.env, ...this.o.env, ...this.o.extraEnv?.() } });
    this.child = child;
    this.childEverReady = false;
    const onData = (b: Buffer) => this.onOutput(b.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const exited = new Promise<number | null>((res) => {
      child.on("error", (e) => { this.onOutput(`${e.message}\n`); res(-1); });
      child.on("close", (code) => res(code));
    });
    exited.then((code) => {
      if (this.child === child) this.child = null;
      if (token !== this.startToken) return;
      this.onExit(code);
    });

    const ready = await this.waitReady(child, token);
    if (token !== this.startToken) throw new Error("Server start cancelled");
    if (!ready) {
      if (this.state !== "failed" && this.state !== "stopped" && this.state !== "restarting") {
        this.fail(this.lastError ?? { id: "timeout", title: "The model server did not start", fix: "Check the last server error in Settings, then retry.", raw: this.log.slice(-10).join("\n") });
      }
      throw new Error(this.lastError?.title ?? "server did not become ready");
    }
    this.set("ready");
  }

  private async waitReady(child: ChildProcess, token: number): Promise<boolean> {
    const f = this.o.fetchFn ?? fetch;
    const deadline = Date.now() + (this.o.readyTimeoutMs ?? 60000);
    while (Date.now() < deadline) {
      if (token !== this.startToken || this.child !== child) return false;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Readiness probe timed out"));
          }, Math.min(1000, Math.max(1, deadline - Date.now())));
        });
        const r = await Promise.race([
          f(this.o.readyUrl ?? `${this.endpoint}/models`, { signal: controller.signal }),
          timeout
        ]);
        // with an adoption rule, our own server is ready only when it passes it too: a stranger
        // answering the port must never make our dying child look ready
        if (r.ok && (!this.o.adoptIf || this.o.adoptIf(await r.json().catch(() => null)))) { this.childEverReady = true; return true; }
      } catch { /* not up yet */ }
      finally { if (timer !== undefined) clearTimeout(timer); }
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 300));
    }
    return false;
  }

  private onOutput(text: string) {
    for (const part of text.split(/\r?\n/)) {
      const line = part.trim();
      if (!line || isNoise(line)) continue;
      this.log.push(line);
      if (this.log.length > 500) this.log.splice(0, 100);
      const fe = friendly(line);
      if (fe && fe.id !== "unknown" && /error|fail|abort|exception|err\b/i.test(line)) this.lastError = fe;
    }
  }

  private fail(e: FriendlyError) {
    this.lastError = e;
    this.set("failed");
    this.emit("error", e);
  }

  private async onExit(code: number | null) {
    this.log.push(`[MKMN AI] server exited with code ${code}`);
    if (!this.wantRunning) { this.set("stopped"); return; }
    const max = this.o.maxRestarts ?? 3;
    const tail = this.log.slice(-20).join("\n");
    const known = this.lastError ?? friendly(tail);
    // a refused mapping does not depend on the context, and every new launch on a NPU that a failed load left in a bad state fails the same way (or worse): stop, the app resets the NPU
    if (/buffer mapping failed|fastrpc_mmap/i.test(tail)) {
      this.fail(known ?? { id: "npu-overflow", title: "The NPU refused to map the model", fix: "Reset the NPU, then try again.", raw: tail });
      return;
    }
    // An adoptable server (the router) whose own spawn died before it ever served: when
    // nothing answers the port either, the endpoint is held by a process that can be
    // neither probed nor bound (a wedged holder seen in on-device test runs — the 8b model's router
    // spent its whole session in restarts that never served once). Restarting cannot
    // serve the endpoint and only burns the attempts: fail at once. The next request's
    // start re-probes from scratch — it adopts the moment the holder ever answers, and
    // spawns when the port is genuinely free. A server that HAD been serving keeps its
    // restarts: after a mid-session crash the port is free, and its own spawn is the way
    // back.
    if (this.o.adoptExisting && !this.childEverReady && !(await this.adoptable())) {
      // something answers but is not a server this one may adopt: another program holds the port
      const stranger = await this.probe();
      if (this.state !== "failed") this.fail(this.lastError ?? (stranger
        ? { id: "endpoint-foreign", title: `Another program is using the port ${this.host.split(":").pop()}`, fix: "It answers there but is not MKMN's model server, so nothing is sent to it. Close that program; MKMN tries again with the next request.", raw: tail }
        : { id: "endpoint-held", title: "The model server's port is held by a process that does not answer", fix: "It is tried again with the next request; the endpoint is adopted when that process answers.", raw: tail }));
      return;
    }
    if (this.restarts >= max) {
      this.fail(known ?? { id: "crash", title: "The model server keeps crashing", fix: "Look at the last server error in Settings; try a smaller model or context.", raw: tail });
      return;
    }
    this.restarts++;
    // NPU memory overflow: come back with half the context, never below 2K.
    if (known?.id === "npu-overflow" || known?.id === "npu-sdk-error") {
      this.nctx = Math.max(2048, Math.floor((this.nctx ?? 8192) / 2 / 1024) * 1024);
    }
    this.emit("restart", { code, nctx: this.nctx, attempt: this.restarts });
    const token = this.startToken;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.enqueue(async () => {
        if (this.wantRunning && token === this.startToken && !this.child) await this.launch();
      }).catch(() => undefined);
    }, Math.min(500 * 2 ** this.restarts, 8000));
  }

  private platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform;
  }

  /** On Windows kill() ends the process only: a child it started would keep the NPU. */
  private killTree(c: ChildProcess) {
    if (this.platform() === "win32" && c.pid) {
      try { spawn("taskkill", ["/F", "/T", "/PID", String(c.pid)], { windowsHide: true, stdio: "ignore" }); return; } catch { /* falls back below */ }
    }
    c.kill("SIGKILL");
  }

  stop(): Promise<void> {
    // Invalidate a pending launch immediately, before waiting for the lifecycle queue.
    this.stopEpoch++;
    this.wantRunning = false;
    this.startToken++;
    this.cancelRestart();
    this.adopted = false; // an adoption ends with the instance's interest in the endpoint
    return this.enqueue(() => this.stopCurrent());
  }

  private async stopCurrent(): Promise<void> {
    this.wantRunning = false;
    this.startToken++;
    this.cancelRestart();
    const c = this.child;
    if (c && c.exitCode === null) {
      try {
        await new Promise<void>((res, reject) => {
          const limit = this.o.stopConfirmMs ?? 15000;
          let reissue: NodeJS.Timeout | null = null;
          const t = setTimeout(() => {
            if (reissue) clearInterval(reissue);
            reject(new Error("Could not confirm that the previous model server stopped"));
          }, limit);
          c.once("close", () => { clearTimeout(t); if (reissue) clearInterval(reissue); res(); });
          if (this.platform() === "win32") {
            this.killTree(c);
            // a wedged runtime may not act on the first taskkill: re-issue while we wait
            reissue = setInterval(() => { if (c.exitCode === null) this.killTree(c); }, 5000);
          } else {
            c.kill();
          }
        });
      } catch (error) {
        this.lastError = { id: "unknown", title: "The previous model server has not stopped", fix: "Close the previous runtime before retrying. MKMN will not start a replacement without confirmed shutdown.", raw: String(error) };
        this.set("failed");
        throw error;
      }
    }
    if (this.child === c) this.child = null;
    this.set("stopped");
  }
}
