import { EventEmitter } from "events";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GENIEX_INSTALLER_URL, SetupState, SetupStep, StepId, initialSteps, locateGeniex } from "./setup";
import { canTransition } from "../shared/stateMachines";
import { downloadFile } from "./download";
import { UnsignedInstallerError, judgeSignature, readSignature, sha256File, type Signature } from "./installerTrust";
import { geniexReleaseNewer, type GeniexInstaller } from "./geniexRelease";
import { GENIEX_MIN_VERSION, compareVersions, type GeniexGateStatus } from "./geniexGate";
import { geniexVersion, run } from "./geniex";

export interface GeniexInstallDeps {
  download(url: string, dest: string, onPercent: (p: number | null) => void): Promise<void>;
  /** Run the downloaded installer, resolve with its exit code and everything it printed. */
  run(exe: string): Promise<{ code: number; output: string }>;
  exists(p: string): boolean;
  env: NodeJS.ProcessEnv;
  tmpDir: string;
  url?: string;
  /** Windows' signature verdict on the downloaded file, and its SHA-256. */
  signature(exe: string): Promise<Signature>;
  sha256(exe: string): Promise<string>;
  probe(exe: string): Promise<string | null>;
  /** The digest of an unsigned installer the person chose to run anyway (that exact file only). */
  allowUnsigned?: string | null;
  /** The release Qualcomm's feed names (geniexRelease.ts): its versioned installer is downloaded and must hash to its sha256. */
  release?: GeniexInstaller | null;
}

/**
 * Download Qualcomm's installer and run it. Its flags are not documented anywhere reachable,
 * so it runs with none: any window it shows is Qualcomm's own. Afterwards geniex.exe is looked
 * for in the paths the installer printed, the documented folder and PATH.
 */
export async function installGeniex(d: GeniexInstallDeps, progress: (percent: number | null, message: string) => void): Promise<string> {
  // a feed that names a release older than the minimum is refused before anything is downloaded
  if (d.release && compareVersions(d.release.tag.replace(/^v/i, "").replace(/[-+].*$/, ""), GENIEX_MIN_VERSION) < 0) {
    throw new Error(`Qualcomm's current NPU engine is too old for MKMN, so nothing was downloaded. Try again later; until then, models can't run on the NPU. Details for support: latest ${d.release.tag}, needs v${GENIEX_MIN_VERSION} or newer.`);
  }
  fs.mkdirSync(d.tmpDir, { recursive: true });
  // The downloader resumes partial files, so keep each published artifact's bytes separate.
  const dest = path.join(d.tmpDir, d.release ? `geniex-cli-${d.release.sha256}.exe` : "geniex-cli.exe");
  progress(0, "Downloading GenieX from Qualcomm…");
  await d.download(d.release?.url ?? d.url ?? GENIEX_INSTALLER_URL, dest, (p) => progress(p, "Downloading GenieX from Qualcomm…"));
  if (d.release) {
    // the feed's checksum is checked before anything else: a file that is not the published one is never run, signed or not
    progress(null, `Checking the installer against GenieX ${d.release.tag}…`);
    const got = (await d.sha256(dest)).toLowerCase();
    if (got !== d.release.sha256) throw new Error(`The download from Qualcomm was damaged or incomplete, so it was not run. Try again. Details for support: its SHA-256 ${got} does not match the SHA-256 Qualcomm published for GenieX ${d.release.tag} (${d.release.sha256}).`);
  }
  progress(null, "Checking the installer's signature…");
  const trust = judgeSignature(await d.signature(dest));
  if (trust.verdict === "refused") throw new Error(`The NPU engine's installer did not pass MKMN's safety check, so it was not run. Try again later, or install GenieX from Qualcomm yourself and use Settings › Developer › Locate geniex.exe. Details for support: ${trust.reason}.`);
  if (trust.verdict === "unsigned") {
    const digest = await d.sha256(dest);
    if (!d.allowUnsigned || d.allowUnsigned !== digest) throw new UnsignedInstallerError(digest);
  }
  progress(null, "Running the GenieX installer… (a Qualcomm window may appear; follow it if so)");
  const r = await d.run(dest);
  const tail = r.output.trim().split(/\r?\n/).slice(-6).join(" | ").slice(0, 400);
  if (r.code !== 0) throw new Error(`The NPU engine's installer stopped before it finished. Try again. If it fails again, restart the PC and try once more. Details for support: code ${r.code}, installer said: ${tail || "(nothing)"}`);
  const found = locateGeniex(r.output, d.env, d.exists);
  if (!found) throw new Error(`The installer finished, but MKMN can't find the engine. Restart MKMN. If it is still missing, use Settings › Developer › Locate geniex.exe. Details for support: installer said: ${tail || "(nothing)"}`);
  const reported = await d.probe(found);
  const version = reported?.match(/\bv?(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)?.[1];
  if (!version) throw new Error("The engine was installed but doesn't respond. Try again, or restart the PC. Details for support: GenieX reported no version or working serve command.");
  if (d.release && version !== d.release.tag.replace(/^v/, "")) {
    throw new Error(`A different version of the engine was found than the one just installed. Try again. Details for support: found ${version}, expected ${d.release.tag}.`);
  }
  // the installed executable is checked against the minimum again: inference stays off until it passes
  if (compareVersions(version.replace(/[-+].*$/, ""), GENIEX_MIN_VERSION) < 0) {
    throw new Error(`The NPU engine on this PC is too old for MKMN; until it is updated, models can't run on the NPU. Try again to install the current one. Details for support: found v${version}, needs v${GENIEX_MIN_VERSION} or newer.`);
  }
  return found;
}

export const realGeniexDeps = (): GeniexInstallDeps => ({
  download: (url, dest, cb) => downloadFile(url, dest, cb),
  run: (exe) => new Promise((resolve) => {
    // Deliberate: the Qualcomm installer window is visible so the person can see the install happen.
    execFile(exe, [], { windowsHide: false, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, output: `${stdout}${stderr}` });
    });
  }),
  exists: fs.existsSync,
  signature: readSignature,
  sha256: sha256File,
  probe: async (exe) => {
    const version = await geniexVersion(exe);
    if (!version) return null;
    const help = await run(exe, ["serve", "--help"], 10000);
    return help.code === 0 && help.out.includes("--compute") ? version : null;
  },
  env: process.env,
  tmpDir: path.join(os.tmpdir(), "open-npu-setup")
});

/**
 * Whether the launch check needs Qualcomm's release feed. Only a GenieX that already works can be offered an optional
 * update; a missing, older or unreadable one is offered the install at once, from the local check alone (the install
 * reads the feed itself), so an offline PC is not kept waiting for the feed's timeout.
 */
export function geniexNeedsFeed(status: GeniexGateStatus | null): boolean {
  return status?.state === "ok";
}

/**
 * The optional update the setup screen offers a working GenieX: the feed's latest stable tag when it is newer than what
 * is installed and is not the release the person already skipped (`skipped`, kept in settings), else null.
 */
export function geniexUpgradeOffer(status: GeniexGateStatus | null, latestStable: string | null, skipped: string | null): string | null {
  if (!geniexNeedsFeed(status) || !latestStable) return null;
  if (geniexReleaseNewer(latestStable, status!.detected) !== true) return null;
  const bare = (t: string) => t.trim().replace(/^v/i, "");
  if (skipped && bare(skipped) === bare(latestStable)) return null;
  return latestStable;
}

/** What the GenieX step says before it runs: what was found, what is required, what the install does. */
export function geniexStepDetail(status: GeniexGateStatus | null, upgrade: string | null): string {
  const need = `MKMN needs GenieX v${status?.required ?? GENIEX_MIN_VERSION} or newer`;
  const what = `Installs Qualcomm's latest stable Windows ARM64 release${upgrade ? ` (${upgrade})` : ""}, checked against its published SHA-256 and signature`;
  if (!status || status.state === "missing") return `Not installed. ${need}. ${what}.`;
  if (status.state === "outdated") return `Found v${status.detected}. ${need}. ${what}.`;
  if (status.state === "invalid") return `Found ${status.path ?? "geniex.exe"}, which reported no valid version. ${need}. ${what}.`;
  return `Found v${status.detected}, which works. Optional update to Qualcomm's latest stable release${upgrade ? `, ${upgrade}` : ""}, checked against its published SHA-256 and signature.`;
}

export interface SetupOps {
  /** Path of geniex.exe if it is installed. */
  geniexPath(): string | null;
  /** Install GenieX, return the path found. */
  installGeniex(progress: (percent: number | null, message: string) => void, allowUnsigned?: string | null): Promise<string>;
  onGeniexInstalled(path: string): void;
  /** The person skipped the optional update to this release: it is not offered again at launch. */
  onGeniexUpdateSkipped?(tag: string): void;
  /** GenieX only exists for Windows on ARM: elsewhere it is never offered. Default true. */
  geniexSupported?(): boolean;
  /** llama.cpp is wanted (the chat model runs on the GPU or the CPU) and not there yet. */
  llamaNeeded?(): boolean;
  installLlama?(progress: (percent: number | null, message: string) => void): Promise<void>;
  voiceNeeds(): { stt: boolean; tts: boolean; sttName: string; ttsName: string; sttMB?: number; ttsMB?: number };
  /** Download + select the default model of that kind. */
  installVoice(kind: "stt" | "tts", progress: (percent: number | null, message: string) => void): Promise<void>;
}

/**
 * First-launch setup: whatever is missing (GenieX, default dictation and read-aloud models) is
 * installed straight away, in order, with progress; failures are shown with a Retry, never block the app.
 */
export class SetupService extends EventEmitter {
  private state: SetupState = { active: false, awaitingConfirm: false, steps: [] };
  private running = false;
  private confirmed = false;
  private skipped = new Set<StepId>();
  /** The optional update offered to a GenieX that already works (null when the GenieX step is a required install). */
  private offeredUpgrade: string | null = null;
  /** The SHA-256 of an unsigned installer the person chose to run anyway. */
  private allowUnsigned: string | null = null;

  constructor(private ops: SetupOps) { super(); }

  status(): SetupState { return { active: this.state.active, awaitingConfirm: this.state.awaitingConfirm, steps: this.state.steps.map((s) => ({ ...s })) }; }

  private emitState() { this.emit("state", this.status()); }
  private step(id: StepId) { return this.state.steps.find((s) => s.id === id)!; }
  /**
   * Set one step's fields. A change of state must be one the `setup` registry machine
   * allows; the service and the screen read the same list, so an impossible move is a
   * programming fault and is reported rather than silently stored.
   */
  private set(id: StepId, p: Partial<SetupStep>) {
    const step = this.step(id);
    if (p.state !== undefined && p.state !== step.state && !canTransition("setup", step.state, p.state)) {
      throw new Error(`setup step ${id} cannot move from ${step.state} to ${p.state}`);
    }
    Object.assign(step, p);
    this.emitState();
  }

  /**
   * Work out what needs installation or an upgrade; true when there is something to do.
   * `geniex` is the minimum-version verdict (geniexGate.ts): missing, outdated and invalid all offer the install of
   * Qualcomm's latest stable release, with the detected and required versions in the step. `upgrade` is a newer stable
   * release offered to a GenieX that already passes the minimum (optional: skipping it leaves inference on).
   */
  check(o: { geniex?: GeniexGateStatus | null; upgrade?: string | null } = {}): boolean {
    const v = this.ops.voiceNeeds();
    const supported = this.ops.geniexSupported?.() ?? true;
    const status = o.geniex ?? null;
    const blocked = status ? status.state !== "ok" : !this.ops.geniexPath();
    const geniexNeeded = supported && (blocked || !!o.upgrade);
    const steps = initialSteps({ geniex: geniexNeeded, llama: this.ops.llamaNeeded?.() ?? false, stt: v.stt, tts: v.tts }, { stt: v.sttName, tts: v.ttsName, sttMB: v.sttMB, ttsMB: v.ttsMB });
    if (geniexNeeded) steps[0].detail = geniexStepDetail(status, o.upgrade ?? null);
    this.offeredUpgrade = geniexNeeded && !blocked ? o.upgrade ?? null : null;
    for (const s of steps) if (this.skipped.has(s.id) && s.state === "pending") s.state = "skipped";
    const active = steps.some((s) => s.state === "pending");
    this.state = { active, awaitingConfirm: active && !this.confirmed, steps };
    this.emitState();
    return this.state.active;
  }

  async run(): Promise<void> {
    if (this.running || !this.confirmed) return;
    this.running = true;
    try {
      for (const s of this.state.steps) {
        if (s.state !== "pending" && s.state !== "error") continue;
        this.set(s.id, { state: "running", percent: null, message: "Starting…", error: null });
        try {
          const progress = (percent: number | null, message: string) => this.set(s.id, { percent, message });
          if (s.id === "geniex") this.ops.onGeniexInstalled(await this.ops.installGeniex(progress, this.allowUnsigned));
          else if (s.id === "llama") await this.ops.installLlama!(progress);
          else await this.ops.installVoice(s.id === "voice-stt" ? "stt" : "tts", progress);
          this.set(s.id, { state: "done", percent: 100, message: "Installed" });
        } catch (e) {
          this.set(s.id, { state: "error", percent: null, message: null, error: (e as Error).message, unsigned: e instanceof UnsignedInstallerError ? e.sha256 : null });
        }
      }
    } finally {
      this.running = false;
      this.state.active = this.state.steps.some((x) => x.state === "pending" || x.state === "running" || x.state === "error");
      this.emitState();
    }
  }

  /** The person agreed to the downloads: start them. */
  confirm(): Promise<void> {
    this.confirmed = true;
    this.state.awaitingConfirm = false;
    this.emitState();
    return this.run();
  }

  /** The person refused: nothing is downloaded now, the app opens as it is. */
  decline() {
    for (const s of this.state.steps) if (s.state === "pending") { this.skipped.add(s.id); s.state = "skipped"; s.message = "Skipped"; if (s.id === "geniex") this.upgradeSkipped(); }
    this.dismiss();
  }

  /** A skipped optional update is remembered, so the next launch does not offer the same release again. */
  private upgradeSkipped() {
    if (this.offeredUpgrade) this.ops.onGeniexUpdateSkipped?.(this.offeredUpgrade);
  }

  skip(id: StepId) {
    this.skipped.add(id);
    if (id === "geniex" && this.step(id).state !== "running") this.upgradeSkipped();
    if (this.step(id).state !== "running") this.set(id, { state: "skipped", error: null, message: "Skipped" });
    this.state.active = this.state.steps.some((x) => x.state === "pending" || x.state === "running" || x.state === "error");
    this.emitState();
  }

  retry(id: StepId) {
    this.skipped.delete(id);
    this.confirmed = true; // pressing Retry or Install is itself the consent
    this.state.awaitingConfirm = false;
    this.set(id, { state: "pending", error: null, message: null, unsigned: null });
    this.state.active = true;
    this.emitState();
    void this.run();
  }

  /** The person read that the installer is unsigned and chose to run it: that exact file (by digest), once. */
  runUnsigned(id: StepId) {
    const digest = this.step(id).unsigned;
    if (!digest) return;
    this.allowUnsigned = digest;
    this.retry(id);
  }

  dismiss() { this.state.active = false; this.state.awaitingConfirm = false; this.emitState(); }
}
