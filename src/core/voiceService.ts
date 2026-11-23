import { ChildProcess, fork } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { FriendlyError, SpeakChunk, VoiceDownloadProgress, VoiceModel, VoiceModelView, VoiceSettings, VoiceStatus } from "../shared/types";
import { installVoiceArchive } from "./voiceInstall";
import type { Out as WorkerOut } from "../voice/worker";
import { VOICE_MODELS, sttConfig, ttsConfig, voiceModel, voiceModelUrl, FileList } from "../core/voiceModels";

export function listTree(dir: string, out: FileList = []): FileList {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(p + path.sep); listTree(p, out); } else out.push(p);
  }
  return out;
}

const fe = (id: string, title: string, fix: string, raw = ""): FriendlyError => ({ id, title, fix, raw });

/**
 * Owns the voice worker process, the downloaded speech models and the CPU / NPU choice per model.
 */
// Whether a 416 answer's Content-Range ("bytes", a star, a slash, then the total) says the file on disk is the whole file.
export function rangeComplete(contentRange: string, have: number): boolean {
  const m = /^bytes \*\/(\d+)$/i.exec(contentRange.trim());
  return !!m && have > 0 && Number(m[1]) === have;
}

export class VoiceService extends EventEmitter {
  private child: ChildProcess | null = null;
  private workerEpoch = 0;
  private applyLock: Promise<void> = Promise.resolve();
  /** Transcriptions (resolved with text) and speech (resolved when done) waiting on the worker. */
  private pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  /** Previews of speech in progress that are still running: a new one is not sent while one is, and the final decode is never held back by them. */
  private previewing = false;
  private loadWaiters = new Map<string, Array<{ resolve: () => void; reject: (e: Error) => void }>>();
  private st: VoiceStatus = { worker: "off", stt: null, tts: null, sttProvider: null, ttsProvider: null, sttLang: null, notice: null, ttsSampleRate: null, error: null };
  private downloads = new Map<string, { cancel(): void }>();
  private seq = 0;
  /** "kind:modelId" pairs whose NPU load killed the worker (the prebuilt sherpa-onnx has no QNN and exits the process). */
  private npuBroken = new Set<string>();

  constructor(private modelsRoot: string, private workerPath: string, private workerEnv: NodeJS.ProcessEnv = {}) {
    super();
  }

  status(): VoiceStatus { return { ...this.st }; }
  private patch(p: Partial<VoiceStatus>) { this.st = { ...this.st, ...p }; this.emit("status", this.status()); }

  dirFor(m: VoiceModel) { return path.join(this.modelsRoot, m.id); }
  isInstalled(m: VoiceModel) { return fs.existsSync(path.join(this.dirFor(m), ".complete")); }
  models(): VoiceModelView[] { return VOICE_MODELS.map((model) => ({ model, installed: this.isInstalled(model) })); }

  // ---------------------------------------------------------------- worker process
  private ensureWorker(): ChildProcess {
    if (this.child && this.child.connected) return this.child;
    this.patch({ worker: "starting", error: null });
    const c = fork(this.workerPath, [], {
      env: { ...process.env, ...this.workerEnv },
      serialization: "advanced",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let tail = "";
    c.stderr?.on("data", (b) => { tail = (tail + b.toString()).slice(-1500); });
    // fenced by the child's identity: a worker that stop() already replaced must not patch the status of the
    // replacement or resolve its waiters with a message that arrives late
    c.on("message", (m) => { if (this.child !== c) return; this.onMessage(m as WorkerOut); });
    c.on("exit", (code, signal) => {
      if (this.child !== c) return;
      this.child = null;
      const detail = [`exit code ${code ?? "none"}`, signal ? `signal ${signal}` : "", tail.trim()].filter(Boolean).join("; ");
      const err = fe("voice-crash", "The voice engine stopped", "It will restart the next time you use dictation or read-aloud. If it keeps happening, switch that model to the CPU or pick a smaller one.", detail);
      console.error(`[voice] worker exited: ${detail}`);
      const reason = new Error(`${err.title} (${detail.slice(0, 300)})`);
      for (const p of this.pending.values()) p.reject(reason);
      for (const list of this.loadWaiters.values()) for (const w of list) w.reject(reason);
      this.pending.clear(); this.loadWaiters.clear();
      this.patch({ worker: code === 0 ? "off" : "failed", stt: null, tts: null, sttProvider: null, ttsProvider: null, sttLang: null, error: code === 0 ? null : err });
    });
    this.child = c;
    return c;
  }

  private onMessage(m: WorkerOut) {
    switch (m.t) {
      case "ready": this.patch({ worker: "ready" }); break;
      case "fatal": this.patch({ worker: "failed", error: fe("voice-runtime", "The speech runtime could not start", "Reinstall MKMN (the speech library is part of the ARM64 build).", m.message) }); break;
      case "loaded": {
        const key = m.kind === "stt" ? "stt" : "tts";
        this.patch({
          ...(key === "stt" ? { sttProvider: m.provider } : { ttsProvider: m.provider }),
          ...(key === "tts" ? { ttsSampleRate: m.sampleRate } : {}),
          notice: m.notice ?? this.st.notice
        });
        const waiters = this.loadWaiters.get(key) ?? [];
        this.loadWaiters.delete(key);
        for (const w of waiters) w.resolve();
        break;
      }
      case "text": this.pending.get(m.id)?.resolve(m.text); this.pending.delete(m.id); break;
      case "audio": {
        const chunk: SpeakChunk = { id: m.id, samples: m.samples, sampleRate: m.sampleRate, done: m.done };
        this.emit("audio", chunk);
        if (m.done) { this.pending.get(m.id)?.resolve(undefined); this.pending.delete(m.id); }
        break;
      }
      case "error": {
        const err = new Error(m.message);
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)!.reject(err); this.pending.delete(m.id); }
        else if (m.kind && this.loadWaiters.has(m.kind)) {
          const waiters = this.loadWaiters.get(m.kind) ?? [];
          this.loadWaiters.delete(m.kind);
          for (const w of waiters) w.reject(err);
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------- model loading
  /** Load (or reload) the configured models. Called when settings change and on first use. */
  apply(v: VoiceSettings): Promise<void> {
    return (this.applyLock = this.applyLock.catch(() => {}).then(() => this.doApply(v)));
  }

  private async doApply(v: VoiceSettings): Promise<void> {
    // the epoch of this apply: stop() bumps it, and every await below is followed by a check, so a stop while a
    // model loads cannot make this apply start a replacement worker or patch a status that was already reset
    const epoch = this.workerEpoch;
    const stopped = () => this.workerEpoch !== epoch;
    // the note about the NPU only lasts while the NPU is what was asked for: put back on the CPU, it goes
    if (this.st.notice && !this.npuUnavailable(v).length) this.patch({ notice: null });
    const want = { stt: voiceModel(v.sttModelId), tts: voiceModel(v.ttsModelId) };
    let reloadLost = false;
    for (const kind of ["stt", "tts"] as const) {
      if (stopped()) return;
      const m = want[kind];
      const requested = kind === "stt" ? v.sttCompute : v.ttsCompute;
      const compute = requested === "npu" && m && this.npuBroken.has(`${kind}:${m.id}`) ? "cpu" : requested;
      const loadedId = this.st[kind];
      const loadedProv = kind === "stt" ? this.st.sttProvider : this.st.ttsProvider;
      if (!m || !this.isInstalled(m)) {
        if (loadedId) { this.ensureWorker().send({ t: "unload", kind }); this.patch(kind === "stt" ? { stt: null, sttProvider: null, sttLang: null } : { tts: null, ttsProvider: null }); }
        continue;
      }
      if (loadedId === m.id && (loadedProv === compute || (loadedProv === "cpu" && compute === "npu" && this.st.notice))) {
        // A multilingual recognizer carries the language IN its loaded config: the model
        // id and provider matching is not enough — a changed sttLanguage must reload it,
        // or dictation keeps transcribing with the old language setting (B: language).
        if (kind !== "stt" || (this.st.sttLang ?? "") === (v.sttLanguage || "")) continue;
      }
      const files = listTree(this.dirFor(m));
      const mk = (c: "cpu" | "npu") => (kind === "stt" ? sttConfig(m, files, v.sttLanguage, c) : ttsConfig(m, files, c));
      const load = async (c: "cpu" | "npu") => {
        if (stopped()) throw new Error("The voice engine stopped");
        const worker = this.ensureWorker();
        const done = new Promise<void>((resolve, reject) => {
          const list = this.loadWaiters.get(kind) ?? [];
          list.push({ resolve, reject });
          this.loadWaiters.set(kind, list);
        });
        worker.send({ t: "load", kind, config: mk(c), cpuConfig: mk("cpu"), wantNpu: c === "npu" });
        await done;
        if (stopped()) throw new Error("The voice engine stopped");
      };
      this.patch({ notice: null });
      try {
        try {
          await load(compute);
        } catch (e) {
          // sherpa-onnx exits the whole process when the QNN provider is missing, so no in-worker fallback runs.
          // A stop() rejects the load waiter too: that is a cancellation, not a QNN crash — and it must not be
          // treated as one, because with the child cleared the fallback would fork a replacement worker.
          if (stopped() || compute !== "npu" || this.child) throw e;
          this.npuBroken.add(`${kind}:${m.id}`);
          await load("cpu");
          if (stopped()) return;
          this.patch({ error: null });
          reloadLost = true;
        }
        if (stopped()) return;
        this.patch(kind === "stt" ? { stt: m.id, sttLang: v.sttLanguage || "" } : { tts: m.id });
      } catch (e) {
        if (stopped()) throw e; // the status was already reset by stop(): no error of a cancelled apply may be patched
        this.patch({ error: fe("voice-load", `Could not load ${m.name}`, "Delete the model and download it again, or choose another one in Settings.", (e as Error).message) });
        throw e;
      }
    }
    if (stopped()) return;
    // The crash dropped whatever else the worker held: load it again (the NPU is skipped for the broken ones).
    if (reloadLost) await this.doApply(v);
    const broken = ["stt", "tts"].filter((k) => [...this.npuBroken].some((b) => b.startsWith(`${k}:`)) && (k === "stt" ? v.sttCompute : v.ttsCompute) === "npu");
    if (broken.length) this.patch({ notice: `${broken.map((k) => (k === "stt" ? "Dictation" : "Read-aloud")).join(" and ")} could not start on the NPU: the speech runtime used for these models has no NPU support, so it runs on the CPU for this session (your NPU setting is kept). Speech models from Foundry Local do run on the NPU.` });
  }

  /** The kinds the person asked to run on the NPU that this runtime could not: they fall back to the CPU for this session, reported in the notice — the saved setting stays what the user chose. */
  npuUnavailable(v: VoiceSettings): ("stt" | "tts")[] {
    return (["stt", "tts"] as const).filter((k) => [...this.npuBroken].some((b) => b.startsWith(`${k}:`)) && (k === "stt" ? v.sttCompute : v.ttsCompute) === "npu");
  }

  /** `partial`: a preview while the person is still talking; null when the recognizer was busy and skipped it. */
  async transcribe(samples: Float32Array, sampleRate: number, partial = false): Promise<string | null> {
    if (!this.st.stt) throw new Error("Choose and download a dictation model in Settings first.");
    if (partial && this.previewing) return null;
    const id = `t${++this.seq}`;
    const w = this.ensureWorker();
    if (partial) this.previewing = true;
    return new Promise<string | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.send({ t: "transcribe", id, samples, sampleRate, partial });
    }).finally(() => { if (partial) this.previewing = false; });
  }

  speak(id: string, text: string, sid: number, speed: number): Promise<void> {
    if (!this.st.tts) return Promise.reject(new Error("Choose and download a read-aloud model in Settings first."));
    const w = this.ensureWorker();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.send({ t: "speak", id, text, sid, speed });
    });
  }

  cancelSpeak(id: string) {
    this.child?.send({ t: "cancel", id });
  }

  async stop() {
    this.workerEpoch++;
    const reason = new Error("The voice engine stopped");
    for (const p of this.pending.values()) p.reject(reason);
    for (const list of this.loadWaiters.values()) for (const w of list) w.reject(reason);
    this.pending.clear();
    this.loadWaiters.clear();
    const c = this.child;
    this.child = null;
    if (c) { try { c.send({ t: "exit" }); } catch { /* already gone */ } setTimeout(() => c.kill(), 1500).unref(); }
    this.patch({ worker: "off", stt: null, tts: null, sttProvider: null, ttsProvider: null, sttLang: null });
  }

  // ---------------------------------------------------------------- downloads
  download(id: string): Promise<void> {
    const m = voiceModel(id);
    const emit = (p: Omit<VoiceDownloadProgress, "id">) => this.emit("download", { id, ...p } as VoiceDownloadProgress);
    if (!m) return Promise.reject(new Error("Unknown voice model"));
    if (!m.sha256) return Promise.reject(new Error(`${m.name} has no pinned SHA-256, so it cannot be downloaded`));
    const dir = this.dirFor(m);
    fs.mkdirSync(this.modelsRoot, { recursive: true });
    const archive = path.join(this.modelsRoot, `${m.id}.tar.bz2.part`);
    let cancelled = false;
    let req: ReturnType<typeof https.get> | null = null;
    this.downloads.set(id, { cancel: () => { cancelled = true; req?.destroy(); } });

    const get = (url: string, redirects = 0): Promise<void> => new Promise((resolve, reject) => {
      if (redirects > 6) return reject(new Error("Too many redirects"));
      // resume a partial download
      const have = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
      req = https.get(url, { headers: { "User-Agent": "MKMN", ...(have ? { Range: `bytes=${have}-` } : {}) } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode === 416) {
          res.resume();
          // complete only when the server's size is the size on disk; otherwise the partial file is bad: start over
          if (rangeComplete(String(res.headers["content-range"] ?? ""), have)) return resolve();
          fs.rmSync(archive, { force: true });
          return resolve(get(url, redirects + 1));
        }
        if (!res.statusCode || res.statusCode >= 400) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode})`)); }
        const resumed = res.statusCode === 206;
        const total = (parseInt(String(res.headers["content-length"] ?? "0"), 10) || 0) + (resumed ? have : 0);
        let got = resumed ? have : 0;
        const out = fs.createWriteStream(archive, { flags: resumed ? "a" : "w" });
        res.on("data", (b: Buffer) => { got += b.length; if (total) emit({ phase: "downloading", percent: Math.round((got / total) * 100) }); });
        res.pipe(out);
        out.on("finish", () => (cancelled || !total || got === total ? resolve() : reject(new Error(`the download ended at ${got} of ${total} bytes`))));
        out.on("error", reject);
        res.on("error", reject);
      });
      req.on("error", reject);
    });

    return (async () => {
      try {
        emit({ phase: "downloading", percent: 0 });
        await get(voiceModelUrl(m));
        if (cancelled) { emit({ phase: "cancelled", percent: null }); return; }
        emit({ phase: "extracting", percent: null });
        // checked against the catalog's SHA-256 and size, extracted to a staging folder, then promoted
        await installVoiceArchive(archive, m, dir);
        emit({ phase: "done", percent: 100 });
      } catch (e) {
        if (cancelled) { emit({ phase: "cancelled", percent: null }); return; }
        emit({ phase: "error", percent: null, error: fe("voice-download", `Could not download ${m.name}`, "Check your connection and disk space, then try again. A download that failed its check starts over.", (e as Error).message) });
      } finally {
        this.downloads.delete(id);
      }
    })();
  }

  cancelDownload(id: string) { this.downloads.get(id)?.cancel(); }

  /** Cancels every in-flight model download (the shutdown path). */
  cancelAllDownloads() { for (const d of this.downloads.values()) d.cancel(); }

  async remove(id: string) {
    const m = voiceModel(id);
    if (!m) return;
    if (this.st.stt === id || this.st.tts === id) await this.stop();
    fs.rmSync(this.dirFor(m), { recursive: true, force: true });
  }
}
