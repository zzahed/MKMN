/**
 * The MKMN sidecar: a plain Node.js process supervised by the Tauri host, carrying the
 * main-process logic that has no reason to be rewritten in Rust (catalog, Hugging Face,
 * Docker Hub, LibreOffice conversion, wikimedia). It speaks the line-delimited JSON
 * protocol of ./protocol.ts over stdin/stdout, the same transport the voice worker uses
 * as plain Node. Nothing here may import window-shell code — that is the rule
 * that keeps this process a plain Node program.
 */
import { journalDir } from "../core/harness/journal";
import { pruneForSettings } from "../core/retention";
import { taskProjectView } from "../core/taskKnowledge";
import { raceAbort } from "../core/abortable";
import { readCapped } from "../core/folderRun";
import { HostSettingsWriter } from "../core/settingsWriter";
import { approvalBody } from "../core/approval";
import { npuResetLaunchCommand, npuResetOutcome } from "../core/npuReset";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DockerClient } from "../core/docker";
import { convertLegacy, findOfficeSuite } from "../core/officeConvert";
import { checkRequirements, checkUpdates, geniexInstallerNewer, installRequirement, installedChatModels, updateRequirement } from "../core/requirements";
import { HARDWARE_SCRIPT, buildProfile, parseRawHardware, type RawHardware } from "../core/hardware";
import { effectiveHardware } from "../core/budget";
import { readBool, readSetting, voiceSettings as readVoiceSettings } from "../shared/settingsSchema";
import { HfClient } from "../core/hf";
import { run, updateProbeArgs, installedRefsOf, findGeniex, pullModel, removeModel, diskCheck, freeDiskGB, modelsDir, listInstalled, canonicalName, installedState, type Pull, type PullOptions } from "../core/geniex";
import { compiledContextOf } from "../core/qairt";
import { parseModelList, type NativeBundle } from "../core/native";
import { resolveModel } from "../core/resolve";
import { CATALOG, ref as entryRef } from "../core/catalog";
import { candidateRepos, entryMatches, installedOf, packParts, isDynamicId, sortRequest, type BundleModel, type TaskCategory } from "../core/dynamic";
import { DYNAMIC_DATA } from "../core/dynamic-data";
import { VoiceService } from "../core/voiceService";
import { defaultVoiceModel, voiceModel } from "../core/voiceModels";
import { runChatOrchestrator, abortChat, skipStep, chatCount, registerChat, unregisterChat, collect, foldOldMessages, dynamicTeam, type ChatHost, type Served } from "../core/chatOrchestrator";
import { runAgentLoop, type AgentDriver, type AgentModel } from "./computerUse";
import { reviewWait, runDocEdit, type DocEditFs } from "./docEditRun";
import type { AgentRunEvent } from "../shared/agent";
import { headlessAsk } from "./headless";
import { startUnknownModelCheck } from "./unknownModelCheck";
import { checkArtifact } from "../core/construct/checkArtifact";
import { knowledgeDirOf, openKnowledgeIndex } from "../core/knowledge/store";
import { resolveModelIdentity } from "../core/modelIdentity";
import { scoreEntry } from "../core/fit";
import { describers } from "../core/vision";
import { quickErrors } from "../core/codecheck";
import { CHART_FIX_INSTRUCTIONS } from "../core/chart";
import { diagramFixInstructions } from "../core/diagram";
import { runtimeLease } from "../core/lease";
import { friendly, ModelStartError } from "../core/errors";
import { SetupService, geniexNeedsFeed, geniexUpgradeOffer, installGeniex, realGeniexDeps } from "../core/setupService";
import { GENIEX_INSTALLER_URL } from "../core/setup";
import { GENIEX_INDEX_URL, geniexReleaseNewer, parseGeniexIndex, resolveGeniexRelease } from "../core/geniexRelease";
import { Updater } from "../core/updater";
import { BenchRunner, type BenchConfig, type BenchLive, type BenchState } from "../core/benchRunner";
import { buildRoster, standardBenchEntries } from "../core/bench";
import { parseLabFile } from "../core/promptLab";
import { LabRunner, type LabModel } from "../core/labRunner";
import { runLoadTest, type LoadAttempt } from "../core/npuTest";
import { LOAD_SETTINGS, badgeOf, badgeOfPlacement, effectiveLoad, ladder, looksGarbled, prefillPrompt, profileOf, type LoadSetting } from "../core/npuLoad";
import { Gateway } from "../core/harness/gateway";
import { createLiveRun, type LiveRun } from "../core/harness/run";
import { sString } from "../core/harness/schema";
import { applyEffort, effectiveEffort, thinkingSupport } from "../core/effort";
import { DEFAULT_ENDPOINT, geniexVersion } from "../core/geniex";
import { GeniexGate, parseGeniexCliVersion } from "../core/geniexGate";
import { NPU_UTIL_SCRIPT, WINDOWS_BUILD_SCRIPT, npuReadingFromHost, parseNpuCounters, type NpuReading } from "../core/perf";
import { BATTERY_SCRIPT, batteryFromHost, batteryPercent, createCachedPowerReader, createHostFirstBatteryReader, parseBattery, type BatteryReading } from "../core/battery";
import { ROUTER_CTX, ROUTER_HOST, ROUTER_MODEL, ROUTER_PREFERRED, RouterPlacement, ROUTER_TIMEOUT_MS, PRODUCE_VOTES, Q, TREE, FileKindMemo, RouterBreaker, RouterWarmGate, SortMemory, parseYesNo, servesRouterModel, readSearchQuery, routerSampling, searchQueryPrompt, settled, sortByQuestions, yesNoPrompt, type Asked } from "../core/router";
import { ServerManager } from "../core/server";
import type { TemplateKind } from "../core/templates/kit";
import { runnerFor, withPip } from "../core/runcode";
import { launchSite } from "./siteLaunch";
import { JsonStore } from "../core/library";
import { Scheduler } from "../core/scheduler";
import { composeInstructions } from "../core/instructions";
import { artifactsIn, stripArtifacts } from "../core/artifacts";
import { buildSystemPrompt, knowledgeBudget } from "../core/projects";
import { mergedPack, pickModel, tierOf } from "../core/dynamic";
import { spawn, spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import type { Artifact, ChatEvent, RunEvent, ScheduledTask } from "../shared/types";
import type { CatalogEntry, ChatMessage, ChatOptions, FriendlyError, HardwareProfile, InstallProgress, InstalledModel, SpeakChunk, VoiceDownloadProgress, VoiceSettings, VoiceStatus } from "../shared/types";
import { registerHumain, fuseConnection, fuseSearchContext, sourcesBlock } from "./humain";
import { registerVoice } from "./register/voice";
import { registerKnowledge } from "./register/knowledge";
import { registerTasks } from "./register/tasks";
import { registerAgent } from "./register/agent";
import { registerFoundry } from "./register/foundry";
import { registerBench } from "./register/bench";
import { registerModels } from "./register/models";
import { CLOUD_CHAT_ID, fuseEntry, fuseServed } from "../core/cloudChat";
import { installedOnlyEntries, parseInstalledJson } from "../core/installedEntries";
import { checkOutcome, clearLoadFailure, failuresOfThisGeniex, verdictOf, withLoadFailure } from "../core/loadFailures";
import { suiteRunRecord } from "../core/benchStore";
import { npuInUse } from "../core/npuInUse";
import { NpuOwner } from "../core/npuOwner";
import { nextState } from "../shared/stateMachines";
import { cloudProviderOf, featureEnabled } from "../shared/humain";
import { decodeLine, encodeMessage, SidecarDispatcher, type SidecarMessage } from "./protocol";
import { mkmnPaths } from "../shared/paths";


// stdout is the protocol channel: everything a core module prints (the chat orchestrator's
// timing notes, library warnings) must leave on stderr, or it tears the JSON framing
import { format } from "util";
import { setIsolation } from "../core/isolate";
import { lockedNodeRunner } from "./isolation";

// Code a model wrote is never run in this process: every check that runs it goes to a
// one-shot Node process with the permission model on (src/core/isolate.ts).
setIsolation(lockedNodeRunner());
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  console[m] = (...a: unknown[]) => { try { process.stderr.write(format(...a) + "\n"); } catch { /* stderr gone */ } };
}

// ---- paths and settings (one layout with the Rust host: src/shared/paths.ts)

const PATHS = mkmnPaths();
const dataDir = () => process.env.MKMN_DATA_DIR ?? PATHS.dataDir;
const dataFile = (n: string) => path.join(dataDir(), n);
/** Settings live in %LOCALAPPDATA%\MKMN\Config\settings.json, the same file `save_settings_cmd`
 * reads and writes. The host owns this layout (mkmnPaths); MKMN_SETTINGS remains a test override. */
const settingsFile = () => process.env.MKMN_SETTINGS ?? PATHS.settingsFile;

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
const writeJson = (file: string, v: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic replacement: readers (settings.json is read by the Rust host too) must never
  // see a truncated file if this process dies mid-write. The temp name carries this
  // process's id and the time: two writers must never stage onto the SAME temp path,
  // where one could rename or remove the other's in-flight file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  // A rename over a file another program holds open (an antivirus scan) can fail for a
  // moment on Windows: it is tried again, never replaced by a direct write that a crash
  // would leave half-written.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (attempt >= 4) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to clean */ }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
};

/** The file's mtime, or -1 when it does not exist (yet). */
const settingsMtime = (): number => {
  try { return fs.statSync(settingsFile()).mtimeMs; } catch { return -1; }
};

// The cache is validated against the file's mtime on EVERY read, not trusted for a
// fixed window: the Rust host (and the webview's save path) write this same file, and
// a two-second blind cache made this process answer from a stale copy after they did.
let settingsCache: { mtime: number; value: any } | null = null;
function settings(): any {
  const mtime = settingsMtime();
  if (!settingsCache || settingsCache.mtime !== mtime) {
    settingsCache = { mtime, value: readJson(settingsFile(), {}) };
  }
  return settingsCache.value;
}

/** Top-level merge into the settings (the same semantics as the Rust `save_settings_cmd`).
 * The Rust host is the ONE writer of settings.json — its locked read-merge-write is
 * serialized against the webview's own save path — so this sidecar hands its patch to the
 * host and never writes the file itself. The patch lands in the local cache at once
 * (readers see it); a patch the host could not take stays pending and is retried
 * (`HostSettingsWriter`, tests/settings-writer.test.ts). A headless `--ask` run has no
 * host: its changes live for that run only, and the log says so. */
const settingsWriter = new HostSettingsWriter({
  save: (patch) => dispatcher.callHost((m) => { void write(m); }, "saveSettings", [patch], 30_000),
  onSaved: (result) => {
    // the host returns the full merged settings: adopt them, so nothing this
    // process reads drifts from what the one writer actually stored
    // (with what was submitted while this call was in flight on top: it is not saved yet, but it is the newest value)
    if (result && typeof result === "object") settingsCache = { mtime: settingsMtime(), value: { ...result, ...settingsWriter.unsaved() } };
  },
  log: (line) => console.error(line),
});
let headlessSettingsNoted = false;
function saveSettings(patch: Record<string, unknown>): any {
  const merged = { ...settings(), ...patch };
  settingsCache = { mtime: settingsMtime(), value: merged };
  if (headlessMode) {
    if (!headlessSettingsNoted) console.error("[settings] headless run: setting changes are kept for this run only (the app's host is the one writer of settings.json)");
    headlessSettingsNoted = true;
    return merged;
  }
  settingsWriter.submit(patch);
  return merged;
}

// ---- hardware (the PowerShell probe, cached in hardware.json like the desktop build)

function ps(script: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") return reject(new Error("PowerShell probes only run on Windows"));
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out)
    );
  });
}

// ---- readings the HOST already has natively (the Rust monitor's PDH NPU sample, the
// battery class driver's IOCTLs). Spawning PowerShell for them cost seconds of CPU per
// call: the host capabilities answer in milliseconds. The PowerShell scripts below stay
// as a fallback for when the host refuses or errors. Which source answered is logged
// once per session, so a silent fallback cannot go unnoticed.

const loggedReadSources = new Set<string>();
function noteReadSource(kind: string, source: "host" | "fallback" | "powershell"): void {
  const key = `${kind}:${source}`;
  if (loggedReadSources.has(key)) return;
  loggedReadSources.add(key);
  console.log(`[readings] ${kind}: reading from the ${source === "host" ? "host's native reading" : "PowerShell fallback"} (logged once per session)`);
}

async function callHostReading<T>(method: string, timeoutMs = 5_000): Promise<T | null> {
  try {
    const r = await dispatcher.callHost((m) => { void write(m); }, method, [], timeoutMs);
    return (r && typeof r === "object") ? (r as T) : null;
  } catch { return null; }
}

/** One NPU reading: the host's PDH sample, or the PowerShell counters as a fallback. `util: null` stays "unknown", never idle. */
async function readNpuOnce(): Promise<NpuReading> {
  const fromHost = npuReadingFromHost(await callHostReading("npuReading"));
  if (fromHost) {
    noteReadSource("npu", "host");
    return fromHost;
  }
  noteReadSource("npu", "powershell");
  return ps(NPU_UTIL_SCRIPT, 8000).then(parseNpuCounters);
}

/**
 * The NPU counters read with PowerShell. This is the ONLY source that measures NPU memory
 * (the host's own sample carries none), so the benchmark's memory-record points use this
 * rather than the cheap host probe; the frequent live samples keep the host reading. It
 * also carries the utilization, so a memory point gets both from one spawn.
 */
async function readNpuMemoryOnce(): Promise<NpuReading> {
  noteReadSource("npu memory", "powershell");
  return ps(NPU_UTIL_SCRIPT, 8000).then(parseNpuCounters);
}

/** One battery reading: the host's native IOCTLs first; the WMI script when the host
 * errors, refuses, or answers "no battery" the script contradicts. The choice is held
 * for the whole session (see createHostFirstBatteryReader): a host that wrongly says
 * "no battery" on a PC that has one must not empty the battery panel, the benchmark's
 * power line and the on-battery compute choice. */
const readBatteryOnce = createHostFirstBatteryReader({
  host: async () => {
    const r = await callHostReading<Record<string, unknown>>("powerReading");
    if (!r || typeof r.present !== "boolean") return null;
    return batteryFromHost(r);
  },
  fallback: async () => parseBattery(await ps(BATTERY_SCRIPT, 10_000).catch(() => "")),
  log: (line) => console.log(line),
  noteSource: (s) => noteReadSource("power", s),
});

/** The battery reader the request selection uses: at most one read per 30 s. */
const batteryReader = createCachedPowerReader(readBatteryOnce);

let rawHardwareCache: RawHardware | null = null;
let hardwareCache: HardwareProfile | null = null;
async function hardware(refresh = false): Promise<HardwareProfile> {
  if (hardwareCache && !refresh) return hardwareCache;
  if (!refresh) {
    const saved = readJson<{ raw: RawHardware } | null>(PATHS.hardwareFile, null);
    if (saved) rawHardwareCache = saved.raw;
  }
  if (!rawHardwareCache || refresh) {
    try {
      rawHardwareCache = parseRawHardware(await ps(HARDWARE_SCRIPT));
      try { writeJson(PATHS.hardwareFile, { raw: rawHardwareCache }); } catch { /* the cache file is a convenience; the reading stands */ }
    } catch {
      rawHardwareCache = rawHardwareCache ?? {
        cpuName: os.cpus()[0]?.model ?? "Unknown CPU",
        totalRamBytes: os.totalmem(),
        npuDevices: [],
        osArch: process.arch === "arm64" ? "ARM64" : process.arch.toUpperCase()
      };
    }
  }
  const ramGB = (rawHardwareCache!.totalRamBytes ?? os.totalmem()) / 1024 ** 3;
  // The desktop build refines GPUs here (detectGpus, in the llama module); the sidecar keeps
  // the parsed probe as is — the NPU budget and the RAM it guards against are already exact.
  rawHardwareCache = { ...rawHardwareCache!, gpus: rawHardwareCache!.gpus ?? [], cpuThreads: rawHardwareCache!.cpuThreads ?? os.cpus().length };
  hardwareCache = buildProfile(rawHardwareCache, process.arch, settings().npuBudgetOverrideGB ?? null);
  void ramGB;
  return hardwareCache;
}

async function chatHardware(): Promise<HardwareProfile> {
  const s = settings();
    return effectiveHardware(await hardware(), voiceSettings(), readSetting(s, "compute"));
}

// ---- the clients (the same construction as the desktop main process)

const hf = new HfClient((u, i) => fetch(u, i as any) as any);
const docker = new DockerClient((u, i) => fetch(u, i as any) as any);

let nativeCache: { at: number; list: NativeBundle[] } | null = null;
async function nativeBundles(): Promise<NativeBundle[]> {
  if (nativeCache && Date.now() - nativeCache.at < 600_000) return nativeCache.list;
  const exe = findGeniex(settings().geniexPath ?? null);
  if (!exe) throw new Error("GenieX is not installed");
  const r = await run(exe, ["model", "list"], 30000);
  if (r.code !== 0) throw new Error("`geniex model list` failed");
  nativeCache = { at: Date.now(), list: parseModelList(r.out) };
  return nativeCache.list;
}

// customModelsFile: the host's Config\custom-models.json, from the same mkmnPaths layout.
const customModelsFile = PATHS.customModelsFile;
const customModels = (): any[] => readJson(customModelsFile, []);
const saveCustom = (e: any) => {
  const all = customModels().filter((x: any) => x.id !== e.id);
  writeJson(customModelsFile, [...all, e]);
};

// ---- network helpers (mirrors of the desktop main process)

/** Bytes as they arrive over JSON: an array of numbers, or an object with numeric keys. */
function asBytes(v: unknown): Uint8Array | null {
  if (Array.isArray(v)) return new Uint8Array(v.map((n) => Number(n) & 0xff));
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).filter((k) => /^\d+$/.test(k));
    if (!keys.length) return null;
    const out = new Uint8Array(keys.length);
    for (const k of keys) out[Number(k)] = Number((v as Record<string, unknown>)[k]) & 0xff;
    return out;
  }
  return null;
}

// ---- the dispatcher and its methods

// ---- the stdio loop

/**
 * CLI mode (src/sidecar/headless.ts): set when this process was
 * started as `--ask`, before any turn runs. The protocol writer then drops every
 * line (the CLI's stdout is the one result, nothing may ride beside it), and a
 * host roundtrip — markGeneration, an NPU reading, a stray recovery call — is
 * failed at once instead of waiting out the protocol's default timeout for a
 * host that is not there. The turn's host in CLI mode already answers every
 * host-owned piece itself; this is the guard for anything that slips past it.
 */
let headlessMode = false;

const write = (m: SidecarMessage) => {
  if (headlessMode) {
    if (m.t === "req") dispatcher.resolveHostResponse({ t: "res", id: m.id, ok: false, error: "headless exec has no app host for this" });
    return Promise.resolve();
  }
  return new Promise<void>((res) => { process.stdout.write(encodeMessage(m) + "\n", () => res()); });
};
const dispatcher = new SidecarDispatcher();

dispatcher.register("ping", () => ({ ok: true, node: process.version, sidecar: true }));

dispatcher.register("convertLegacyDoc", async (name: string, bytes: unknown) => {
  const raw = asBytes(bytes);
  return typeof name === "string" && raw && raw.length < 40 * 1024 ** 2 ? await convertLegacy(name, raw) : null;
});

dispatcher.register("pickFolder", () => dispatcher.callHost((m) => { void write(m); }, "pickFolder"));

// ---- model installs (`geniex pull`, progress as `install` / `dynamicInstall` events)
// The same logic as the desktop main process (installEntry / installPackModel): the disk is
// checked first, the pull is resumable and cancellable, a precompiled NPU bundle is tried
// under every name GenieX has used for it, and a pack model falls back provider by provider.

const pulls = new Map<string, Pull>();

const emitEvent = (name: string, payload: unknown) => { void write({ t: "event", name, payload }); };

function geniexExe(): string {
  const exe = findGeniex(settings().geniexPath ?? null);
  if (!exe) throw new Error("GenieX is not installed");
  return exe;
}

/**
 * GenieX v0.11.0 or newer is mandatory for inference (geniexGate.ts): the router's server, the NPU load test and the
 * setup screen read this verdict; the chat's server is gated again by the Rust host before it starts or adopts one.
 * Only the local `--version` runs, so an offline PC with a compatible GenieX keeps working. A saved custom path is
 * checked like the default folder. Model management (list, download, remove) keeps the plain path.
 */
const geniexGate = new GeniexGate({
  find: () => findGeniex(settings().geniexPath ?? null),
  readVersion: async (exe) => {
    const first = await run(exe, ["--skip-update", "--version"], 10_000).catch(() => null);
    if (first && parseGeniexCliVersion(first.out)) return first.out;
    const plain = await run(exe, ["--version"], 10_000).catch(() => null);
    return plain?.out ?? null;
  },
  identity: (exe) => { try { const st = fs.statSync(exe); return `${st.size}:${st.mtimeMs}`; } catch { return null; } }
});

const isFoundryEntry = (e: CatalogEntry) => e.id.startsWith("foundry:");

const allEntries = (): CatalogEntry[] => [...CATALOG, ...customModels() as CatalogEntry[], ...installedOnlyCache, ...foundryEntriesCache];

/** The Foundry Local catalog entries of this machine, discovered in the background
 * (a CLI call) and refreshed whenever anything asks about Foundry: chat resolves
 * these ids through entryById, so they must be in the synchronous list. */
let foundryEntriesCache: CatalogEntry[] = [];

/** The user's own resolved/downloaded models, so the renderer's catalog can list them (they are
 * selectable, installed or not) — the same list `allEntries()` serves from here. */
/** The installed GenieX's version ("v0.11.0"), the key of the load-failure record. */
async function geniexVersionTag(): Promise<string | null> {
  const v = await geniexVersion(geniexExe()).catch(() => null);
  return v?.match(/v\d+\.\d+\.\d+/)?.[0] ?? null;
}
// a load failure seen with another GenieX is forgotten at start: a newer runtime may load the model
void geniexVersionTag().then((v) => {
  const kept = failuresOfThisGeniex(settings().loadFailures, v);
  if (Object.keys(kept).length !== Object.keys(settings().loadFailures ?? {}).length) saveSettings({ loadFailures: kept });
}).catch(() => undefined);

// Retention (privacy.retentionDays, docs/design/data-at-rest.md): once at start, before any chat
// runs, the run journals and offloaded payloads older than the setting are removed. Unset (the
// default) removes nothing. Only the count is logged, never a file name or its contents.
try {
  const pruned = pruneForSettings(settings(), [journalDir(), path.join(journalDir(), "offload")], Date.now());
  if (pruned.length) console.error(`[retention] removed ${pruned.length} run records and offloaded replies older than ${settings().privacy?.retentionDays} days`);
} catch (e) {
  console.error(`[retention] old run records could not be removed: ${(e as Error).message}`);
}

/** Models installed in GenieX that no catalog, pack or custom entry names: listed too (they were invisible). */
let installedOnlyCache: CatalogEntry[] = [];
async function refreshInstalledOnly(): Promise<CatalogEntry[]> {
  // never throws: a GenieX not found keeps the list as known (it once made the whole custom list fail with it)
  const exe = findGeniex(settings().geniexPath ?? null);
  const r = exe ? await run(exe, ["--skip-update", "list", "--format", "json"], 30_000).catch(() => null) : null;
  if (!r || r.code !== 0) return installedOnlyCache; // a failed list keeps what was known, never empties the list
  const packKnown = Object.values(DYNAMIC_DATA.packs).flatMap((p) => packParts(p)).map((m) => ({ repo: m.repo, quant: m.quant } as CatalogEntry));
  installedOnlyCache = installedOnlyEntries(parseInstalledJson(r.out), [...CATALOG, ...customModels() as CatalogEntry[], ...packKnown]);
  return installedOnlyCache;
}
// the startup check of unknown models reads allEntries(): the installed ones must be known before it runs
void refreshInstalledOnly();

/** The catalog entries whose model (by its canonical ref) sits in the GenieX cache right now. */
async function installedEntries(): Promise<CatalogEntry[]> {
  const installed = await listInstalled(geniexExe()).catch(() => []);
  const canon = new Set(installed.map((m) => canonicalName(m.ref || m.name)));
  return allEntries().filter((e) => canon.has(canonicalName(entryRef(e))) || canon.has(canonicalName(e.repo)));
}

async function installEntry(entry: CatalogEntry, pullAs?: string): Promise<{ ok: boolean; error?: string; cancelled?: boolean; alreadyInstalled?: boolean }> {
  const exe = geniexExe();
  const ref = entryRef(entry);
  // Duplicate-import protection: the artifact already in the cache is never
  // re-downloaded — the same model pulled twice is wasted bandwidth and two
  // cache records for one identity.
  const installed = await listInstalled(exe).catch(() => [] as { ref?: string; name?: string }[]);
  const canon = (s: string) => canonicalName(String(s ?? ""));
  if (installed.some((m) => canon(String(m.ref ?? m.name ?? "")) === canon(ref) || canon(String(m.ref ?? m.name ?? "")) === canon(entry.repo))) {
    void recordEvidence([{ kind: "download-verified", ref }]);
    return { ok: true, alreadyInstalled: true };
  }
  let last: InstallProgress | null = null;
  const emit = (p: InstallProgress) => { last = p; emitEvent("install", p); };
  let pull: Pull | null = null;
  try {
    emit({ ref, phase: "checking", percent: null, line: "Checking disk space" });
    const disk = diskCheck(freeDiskGB(modelsDir()), entry.sizeGB);
    if (disk) { emit({ ref, phase: "error", percent: null, error: disk }); return { ok: false, error: disk.title }; }
    // `--model-hub` is passed when the entry names its source: geniex's own auto-detection
    // can misread a short docker name as an HF repo. A local-path pull never comes through here.
    const hub = (entry as { source?: CatalogEntry["source"] }).source;
    const pullOptions: PullOptions | undefined = hub ? { modelHub: hub } : undefined;
    pull = pullModel(exe, pullAs ?? ref, (x) => emit({ ...x, ref }), undefined, pullOptions); // the screen follows the model by its own ref, whatever name it is pulled under
    pulls.set(ref, pull);
    await pull.done;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    emit({ ref, phase: "error", percent: null, error: { id: "install", title: "Install could not start", fix: "See the raw message below.", raw } });
  } finally {
    pulls.delete(ref);
  }
  if (pull?.cancelled) return { ok: false, cancelled: true, error: "cancelled" };
  const end = last as InstallProgress | null;
  const ok = end?.phase === "done";
  if (ok) void recordEvidence([{ kind: "download-verified", ref }]);
  return ok ? { ok: true } : { ok: false, error: end?.error?.title ?? end?.phase ?? "not finished" };
}

/**
 * Installs a model of a Dynamic pack. It may be missing from a provider, or lack the pack's quant, or be a
 * precompiled bundle this chip has no build of: each provider of the same model is tried in turn, and the
 * first that really installs wins. (The Foundry Local branch of the desktop build stays there: it is an
 * earlier comparison feature, the sidecar installs the GenieX files.)
 */
async function installPackModel(m: BundleModel): Promise<{ done: boolean; failures: string[]; cancelled?: boolean }> {
  const failures: string[] = [];
  let done = false;
  // A cancel must stop the WHOLE operation, not merely kill one provider's download and
  // let the loop start the next one behind the user's back.
  let cancelled = false;
  for (const repo of candidateRepos(m)) {
    // a precompiled bundle has no quant; the other providers of its model are GGUF files, asked for in `altQuant`
    const wantQuant = repo === m.repo ? m.quant : (m.altQuant ?? m.quant);
    const rightQuant = (e: CatalogEntry) => !wantQuant || !e.quant || e.quant.toLowerCase() === wantQuant.toLowerCase();
    try {
      let entry = allEntries().find((e) => rightQuant(e) && ((e as any).dynamicRef === m.ref || entryMatches(e, m.ref) || entryMatches(e, repo)));
      if (!entry) {
        const r = await resolveModel({ hf, docker, native: nativeBundles }, wantQuant ? `${repo}:${wantQuant}` : repo, await hardware(), { showKQuants: !!settings().showKQuants });
        if (r.type !== "model" || !r.inspection.entry) throw new Error("not found");
        entry = r.inspection.entry;
        if (!rightQuant(entry)) throw new Error(`no ${wantQuant} file (only ${entry.quant})`);
      }
      if (customModels().some((c: any) => c.id === entry!.id) || !CATALOG.some((e) => e.id === entry!.id)) saveCustom({ ...entry, dynamicRef: m.ref });
      const r = await installEntry(entry);
      if (r.cancelled) {
        cancelled = true;
        break;
      }
      if (!r.ok) throw new Error(r.error ?? "the download failed");
      done = true;
      break;
    } catch (e) {
      if ((e as Error)?.message === "cancelled") { cancelled = true; break; }
      failures.push(`${repo}: ${(e as Error).message}`);
    }
  }
  return cancelled ? { done: false, failures, cancelled: true } : { done, failures };
}

/**
 * Every removal of a GenieX model goes through here and is logged (the host log keeps the sidecar's lines): on
 * two model folders vanished during a load and no line said what removed them.
 */
async function removeGeniexModel(ref: string, why: string): Promise<{ ok: boolean; out: string }> {
  console.warn(`[models] removing ${ref} (${why})`);
  const r = await removeModel(geniexExe(), ref);
  console.warn(`[models] ${r.ok ? "removed" : "could not remove"} ${ref}${r.ok ? "" : `: ${r.out.trim().slice(0, 200)}`}`);
  return r;
}

// ---- voice (the speech worker, forked from this process — pure Node)
// The same VoiceService the desktop build runs (src/core/voiceService.ts): it owns the
// worker process, the downloaded speech models and the CPU / NPU choice per model. Its
// status, download and audio events travel out as sidecar events.

const voice = new VoiceService(
  path.join(dataDir(), "Workspace", "voice-models"),
  process.env.MKMN_VOICE_WORKER ?? path.join(__dirname, "..", "voice", "worker.js")
);
voice.on("status", (st: VoiceStatus) => emitEvent("voiceStatus", st));
voice.on("download", (p: VoiceDownloadProgress) => emitEvent("voiceDownload", p));
// the samples go out as a plain array: JSON has no typed arrays, and the bridge rebuilds
// the Float32Array the audio player needs
voice.on("audio", (c: SpeakChunk) => emitEvent("voiceAudio", { ...c, samples: Array.from(c.samples) }));

const voiceSettings = (): VoiceSettings => readVoiceSettings(settings());

/** One load at a time: sentences arriving while the voice is still loading all wait for the same load. */
let voiceLoad: Promise<void> | null = null;
let voiceLoadKey = "";
const voiceKey = () => JSON.stringify([voiceSettings().sttModelId, voiceSettings().ttsModelId, voiceSettings().sttCompute, voiceSettings().ttsCompute, voiceSettings().sttLanguage]);

async function ensureVoice(): Promise<void> {
  const v = voiceSettings();
  if (voiceLoad && voiceLoadKey !== voiceKey()) return voiceLoad.catch(() => undefined).then(() => ensureVoice()); // other models were chosen meanwhile: load them after
  return (voiceLoad ??= (async () => {
    voiceLoadKey = voiceKey();
    await voice.apply(v);
    // F19: an NPU component this runtime cannot serve is a SESSION fallback, not
    // a silently persisted preference change. The saved setting stays what the
    // user chose (a driver update restores the NPU without re-selecting it), and
    // the VoiceService patches the reason into its status notice — the banner in
    // the UI — saying what actually runs and why.
    voice.npuUnavailable(v);
  })().finally(() => { voiceLoad = null; }));
}

registerVoice(dispatcher, { voice, voiceSettings, saveSettings, ensureVoice });

// ---- chat (the orchestrator runs here; the model server belongs to the Rust host)
// The shared runChatOrchestrator. Everything it needs from the
// machine is in the ChatHost below: the server comes from the host capability
// `startChatServer` (Rust owns geniex.exe), the web and Wikimedia answers come from
// plain fetch, and what is missing here (figures, slide screenshots, the in-page
// artifact check) degrades gracefully.

/** The model server as the orchestrator sees it. The Rust host reports the context
 * window the server was actually started with (`servedNctx`): prompts are trimmed to
 * the real window, never to a catalog recommendation. Null only when the host could
 * not report one (QAIRT compiles its context statically). */
const servedOf = (endpoint: string, nctx: number | null = null, model?: string, contextKind: "compiled" | "configurable" | null = null): Served => ({ endpoint, model, status: () => ({ nctx, contextKind }) });

let lastLoadedEntry: CatalogEntry | null = null;
let serverLastError: FriendlyError | null = null;

/** The chosen Fuse model, as the entry a chat on Fuse runs with: read from the settings at every lookup. */
function fuseChatEntry(): CatalogEntry | undefined {
  const s = settings();
  if (cloudProviderOf(s.humainMode) !== "fuse") return undefined;
  return fuseEntry(typeof s.humainFuseModel === "string" && s.humainFuseModel ? s.humainFuseModel : "no model chosen", null);
}
const entryById = (id: string): CatalogEntry | undefined => (id === CLOUD_CHAT_ID ? fuseChatEntry() : allEntries().find((e) => e.id === id));

/** The installed cache refs, briefly cached: resolution must be cheap enough to run
 * beside every server start, and `listInstalled` shells out to the CLI. */
let installedRefsCache: { at: number; refs: string[] } | null = null;
async function installedRefsTTL(): Promise<string[]> {
  if (installedRefsCache && Date.now() - installedRefsCache.at < 5_000) return installedRefsCache.refs;
  const list = await listInstalled(geniexExe()).catch(() => []);
  // every build by its own name (name:precision too): a GGUF build named without it was refused as "not in the cache"
  const refs = installedRefsOf(list);
  installedRefsCache = { at: Date.now(), refs };
  return refs;
}

/** The ONE model-identity resolution (src/core/modelIdentity.ts), shared with the
 * renderer's select/preload path: an application alias resolves to the exact same
 * cache reference whichever entry point asks — chat, compact, tasks, tests,
 * benchmarks and the preload all serve THIS ref, and an internal `custom:` or
 * `dynamic:` id never reaches GenieX. */
function resolveServeRefFor(entry: CatalogEntry, installedRefs: string[]): string {
  const r = resolveModelIdentity(entry.id, { customEntries: customModels() as CatalogEntry[], installedRefs });
  if (r.ok) return r.ref;
  // An entry the resolver refuses is not servable (it is not installed and names no
  // cache artifact): fail fast with the resolver's truthful reason.
  throw new Error(r.reason);
}

/** The generation speeds measured here, by catalog id (the same file the desktop build keeps). */
const speedFile = () => dataFile("speeds.json");
function recordSpeed(entry: CatalogEntry, tokPerSec: number | null, tokens: number) {
  if (!tokPerSec || tokens < 40 || isDynamicId(entry.id)) return;
  const all = readJson<Record<string, number>>(speedFile(), {});
  const old = all[entry.id];
  all[entry.id] = Math.round((old ? old * 0.7 + tokPerSec * 0.3 : tokPerSec) * 10) / 10;
  try { writeJson(speedFile(), all); } catch { /* not kept */ }
  // A timed generation on this PC is "Performance measured" evidence too.
  void recordEvidence([{ kind: "performance-measured", ref: entryRef(entry), result: { tokPerSec, tokens } }]);
}

/** Asks the Rust host to bring the model's server up (it owns geniex.exe) and answers where it listens.
 * A load setting rides along (the benchmark and the NPU test start models under a specific one):
 * its `compute` (e.g. "HTP0,HTP1", how the layers are split over the NPU sessions) goes into the
 * same flag the webview's own start path uses, its window cap into the `nctx` override. Settings
 * that are only environment variables cannot cross: the host does not set env on geniex.exe. */

// ---- adaptive compute (one selection per request, stable for the whole generation)

import {
  AUTO_GOALS,
  COMPUTE_LABEL,
  ENGINE_LABEL,
  candidatesFor,
  describeSelection,
  selectAuto,
  selectManual,
  type AutoGoal,
  type Candidate,
  type Measurement,
  type Selection,
} from "../core/adaptiveCompute";
import { FoundryHost, cliRunner, findFoundry, type FoundryCachedVariant } from "../core/foundryHost";

/** hardware.json lives in the host's Config dir (mkmnPaths), the file the Rust host writes after each benchmark. */
const hardwareFile = () => PATHS.hardwareFile;
function calibratedProfiles(): Record<string, any> {
  const hw = readJson<any>(hardwareFile(), {});
  return (hw && typeof hw === "object" ? hw.calibratedProfiles : undefined) ?? {};
}

/** The measurements one model has on this device, per candidate id ("geniex:npu"…). Only
 * what was actually measured here is returned — absent figures stay absent. */
function measurementsFor(serveRef: string, entryRefStr: string): Record<string, Measurement | undefined> {
  const out: Record<string, Measurement> = {};
  for (const key of [...new Set([serveRef, entryRefStr])]) {
    const prof = calibratedProfiles()[key];
    const runs = prof?.runs ?? {};
    for (const run of Object.values<any>(runs)) {
      const c = String(run?.compute ?? "").toLowerCase();
      if (!["npu", "hybrid", "gpu", "cpu"].includes(c)) continue;
      const id = `geniex:${c}`;
      const m: Measurement = {
        decodeTokPerSec: typeof run.decodeTokPerSec === "number" ? run.decodeTokPerSec : null,
        // A 0 (or negative) ttft is the runtime's "did not measure" figure, never a
        // real one — a first token cannot arrive in 0 s. Null feeds the honest
        // "first token: not measured" wording downstream.
        ttftMs: typeof run.ttftMs === "number" && run.ttftMs > 0 ? run.ttftMs : null,
        // Whole-task energy is NOT recorded by the quick benchmark (it needs the battery
        // probe): unknown here, never invented.
        mWhPerToken: null,
        peakRamGB: null,
        at: run.measuredAt ? (Date.parse(run.measuredAt) || null) : null,
        source: "mkmn-bench",
        runtimeVersion: null,
      };
      // keep the freshest measurement per configuration
      if (!out[id] || ((out[id]!.at ?? 0) < (m.at ?? 0))) out[id] = m;
    }
  }
  return out;
}

/** The candidate list + gating for a model, from facts (artifact kind, verified placements, cached variants). */
function engineFactsFor(entry: CatalogEntry, serveRef: string): Parameters<typeof candidatesFor>[1] {
  const s = settings();
  const isQairt = entry.engine === "qairt" || (entry as any).engine === "qairt";
  // GPU is offered only when a placement measurement verified it on this machine, or
  // (for GenieX GGUF) when the user's own hardware evidence says a GPU exists AND a
  // previous run of this model verified GPU execution. Nothing is inferred from the
  // platform name alone.
  const placements = s.placements ?? {};
  const gpuVerified = placements[serveRef] === "gpu" || placements[entryRef(entry)] === "gpu";
  return {
    engine: isFoundryEntry(entry) ? "foundry" : "geniex",
    isQairt,
    // hybrid (CPU+NPU) is a GenieX GGUF capability; the user's consent gates it in chat
    hybridAllowed: true,
    gpuVerified,
  };
}

async function foundryVariantsFor(alias: string): Promise<{ cached: boolean; device: string; modelId: string }[]> {
  const f = await foundryHost();
  if (!f) return [];
  const list = await f.cached();
  if (!list) return [];
  return list
    .filter((v) => v.alias.toLowerCase() === alias.toLowerCase())
    .map((v) => ({ cached: true, device: v.device || "CPU", modelId: v.alias }));
}

/** The selection state of the last request, for the UI (engine · device · reason · provisional). */
let lastAdaptive: { at: number; entryId: string; goal: string; selection: Selection } | null = null;

/**
 * The compute decision for ONE request, made before it starts. Selects with the
 * validated measurements this device has (and only those), applies the switch
 * cooldown and the residency preference, and records the reason for display.
 * `null` when the model/setting makes the decision (an explicit load setting from
 * the benchmark or the NPU test always wins).
 */
async function selectForRequest(entry: CatalogEntry, serveRef: string, o?: { setting?: LoadSetting; force?: boolean }): Promise<Selection | null> {
  const s = settings();
  if (o?.setting || s.computeMode !== "auto") return null;
  const goal = (AUTO_GOALS.some((g) => g.id === s.autoGoal) ? s.autoGoal : "balanced") as AutoGoal;
  try {
    const facts = engineFactsFor(entry, serveRef);
    const foundry = isFoundryEntry(entry) ? await foundryVariantsFor(String((entry as any).foundryAlias ?? entry.repo)) : [];
    if (isFoundryEntry(entry)) (facts as any).foundryVariants = foundry.map((v) => ({ alias: String((entry as any).foundryAlias ?? entry.repo), device: v.device, modelId: v.modelId, cached: v.cached }));
    const { candidates, gatedOut } = candidatesFor(entry, facts, measurementsFor(serveRef, entryRef(entry)));
    // The two readings run in PARALLEL (they used to be awaited one after the other,
    // seconds of added latency per request), and the battery is cached for 30 s: a
    // battery does not change between two requests. The NPU reading is never cached
    // here — the contention input needs the freshest sample.
    const [bat, npu] = await Promise.all([
      batteryReader(),
      readNpu().catch(() => null as NpuReading | null),
    ]);
    const ramFreeGB = os.freemem() / 1024 ** 3;
    const fresh = !!npu && npu.util !== null;
    const input = {
      goal,
      candidates,
      battery: bat?.present ? { onMains: bat.onMains, percent: batteryPercent(bat) } : null,
      headroomGB: ramFreeGB > 0 ? ramFreeGB : null,
      residentId: lastAdaptive && lastAdaptive.entryId === entry.id ? lastAdaptive.selection.config?.id ?? null : null,
      reloadSec: null,
      contention: {
        npuBusy: fresh && npu && npu.util !== null ? npu.util > 45 : null,
        gpuBusy: null as boolean | null,
        samplesFresh: fresh,
      },
      expectedOutputTokens: 256,
      now: Date.now(),
      cooldownMs: 120_000,
      lastSwitch: s.adaptiveState?.lastSwitchAt && s.adaptiveState?.lastSwitchTo ? { at: s.adaptiveState.lastSwitchAt, toId: s.adaptiveState.lastSwitchTo } : null,
    };
    const sel = selectAuto(input);
    lastAdaptive = { at: Date.now(), entryId: entry.id, goal, selection: sel };
    // keep the decision (and the cooldown marker) where the next request can see it
    if (sel.config) {
      const prev = s.adaptiveState ?? {};
      const switched = prev.lastSwitchTo !== sel.config.id;
      void saveSettings({ adaptiveState: { at: Date.now(), goal, configId: sel.config.id, engine: sel.config.engine, compute: sel.config.compute, reason: sel.reason, provisional: sel.provisional, lastSwitchAt: switched ? Date.now() : prev.lastSwitchAt, lastSwitchTo: switched ? sel.config.id : prev.lastSwitchTo } });
    }
    return sel;
  } catch (e) {
    // a monitoring failure degrades to the default, loudly
    return { config: null, reason: [`adaptive selection could not run (${(e as Error).message.slice(0, 120)}); the configured default is used`], provisional: true, gatedOut: [] };
  }
}

// ---- Foundry Local engine (sidecar-owned: its daemon, its CLI, its lifecycle)

let foundryHostCache: { host: FoundryHost; available: boolean; checkedAt: number } | null = null;
/** Version-aware discovery, briefly cached: `foundry --version` runs at most once a minute. */
async function foundryHost(): Promise<FoundryHost | null> {
  if (foundryHostCache && Date.now() - foundryHostCache.checkedAt < 60_000) return foundryHostCache.available ? foundryHostCache.host : null;
  const exe = findFoundry(process.env, (p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) { foundryHostCache = { host: null as unknown as FoundryHost, available: false, checkedAt: Date.now() }; return null; }
  const host = new FoundryHost(cliRunner(exe), (l) => console.warn(`[foundry] ${l}`));
  let available: boolean;
  try { available = await host.discover(); } catch { available = false; }
  foundryHostCache = { host, available, checkedAt: Date.now() };
  return available ? host : null;
}

let foundryEntriesInFlight: Promise<CatalogEntry[]> | null = null;

/**
 * Every Foundry model this version offers, with the cached ones marked installed. The
 * catalog is what makes Foundry installable from the Models page; one CLI call serves it
 * (and is cached in the host), so chat can still resolve a `foundry:<alias>` id at once.
 */
async function foundryEntries(): Promise<CatalogEntry[]> {
  if (foundryEntriesInFlight) return foundryEntriesInFlight;
  foundryEntriesInFlight = (async () => {
    const f = await foundryHost();
    if (!f) { foundryEntriesCache = []; return []; }
    const [list, catalog] = await Promise.all([
      f.cached().catch(() => null),
      f.catalog().catch(() => null)
    ]);
    const cached = list ?? [];
    const offered = catalog ?? [];
    const variants = [
      ...offered,
      ...cached
        .filter((v) => !offered.some((o) => o.alias.toLowerCase() === v.alias.toLowerCase()))
        .map((v) => ({ alias: v.alias, device: v.device, task: "chat", sizeGB: v.sizeGB, modelId: v.alias }))
    ];
    if (!variants.length) { foundryEntriesCache = []; return []; }
    const installedAliases = new Set([
      ...cached.map((v) => v.alias.toLowerCase()),
      ...offered.filter((v) => v.cached).map((v) => v.alias.toLowerCase())
    ]);
    const { foundryCatalogEntries } = await import("../core/foundry");
    const entries = foundryCatalogEntries(
      variants.map((v) => ({ alias: v.alias, device: v.device, task: v.task, sizeGB: v.sizeGB, modelId: v.modelId })),
      16
    ).map((e) => {
      const onDisk = cached.find((v) => v.alias.toLowerCase() === e.repo.toLowerCase());
      const device = (onDisk?.device || (e as any).foundryDevice) as CatalogEntry["foundryDevice"];
      return {
        ...e,
        foundryDevice: device,
        foundryInstalled: installedAliases.has(e.repo.toLowerCase()),
        ...(onDisk?.sizeGB != null ? { sizeGB: onDisk.sizeGB } : {})
      };
    });
    foundryEntriesCache = entries;
    return entries;
  })().finally(() => { foundryEntriesInFlight = null; });
  return foundryEntriesInFlight;
}

const foundryDownloads = new Map<string, AbortController>();

const foundryAliasOf = (entry: CatalogEntry): string =>
  String((entry as { foundryAlias?: string }).foundryAlias ?? entry.repo ?? "").replace(/^foundry:/, "").trim();

/** A Foundry model is installed by Foundry itself, into its own cache (progress as `install` events). */
async function installFoundryEntry(entry: CatalogEntry): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  const f = await foundryHost();
  if (!f) return { ok: false, error: "Microsoft Foundry Local is not installed (or its version could not be read)." };
  const alias = foundryAliasOf(entry);
  if (!alias) return { ok: false, error: "this Foundry entry names no model alias" };
  const ref = entryRef(entry);
  if (foundryDownloads.has(ref)) return { ok: false, error: `${alias} is already being downloaded` };
  const ctl = new AbortController();
  foundryDownloads.set(ref, ctl);
  const emit = (p: InstallProgress) => emitEvent("install", p);
  emit({ ref, phase: "checking", percent: null, line: `Asking Foundry Local for ${alias}` });
  try {
    emit({ ref, phase: "downloading", percent: null, line: `Downloading ${alias} with Foundry Local` });
    const r = await f.download(alias, {
      signal: ctl.signal,
      onLine: (line) => {
        const m = /(\d{1,3})(?:\.\d+)?\s*%/.exec(line);
        if (!m) return;
        const percent = Math.max(0, Math.min(100, Number(m[1])));
        emit({ ref, phase: "downloading", percent, line: `Downloading ${alias} with Foundry Local` });
      }
    });
    if (ctl.signal.aborted) {
      emit({ ref, phase: "cancelled", percent: null });
      return { ok: false, cancelled: true, error: "cancelled" };
    }
    if (!r.ok) {
      const raw = r.error ?? "the download failed";
      emit({ ref, phase: "error", percent: null, error: {
        id: "install",
        title: `Foundry Local could not download ${alias}`,
        fix: `Check this PC's connection, then try again. The same command in a terminal (\`foundry model download ${alias}\`) shows the full message.`,
        raw
      } });
      return { ok: false, error: raw };
    }
    emit({ ref, phase: "done", percent: 100 });
    void foundryEntries().catch(() => undefined);
    return { ok: true };
  } finally {
    foundryDownloads.delete(ref);
  }
}

/** A Foundry model is removed from Foundry's own cache, not through GenieX. */
async function uninstallFoundryEntry(entry: CatalogEntry): Promise<{ ok: boolean; message: string }> {
  const f = await foundryHost();
  if (!f) return { ok: false, message: "Microsoft Foundry Local is not installed (or its version could not be read)." };
  const alias = foundryAliasOf(entry);
  if (!alias) return { ok: false, message: "this Foundry entry names no model alias" };
  const r = await f.remove(alias);
  void foundryEntries().catch(() => undefined);
  return r;
}

registerModels(dispatcher, {
  hf, docker, nativeBundles, chatHardware, hardware, settings, saveCustom, customModels, refreshInstalledOnly,
  pulls, foundryDownloads, installEntry, installPackModel, installFoundryEntry, uninstallFoundryEntry, checkNewModel,
  removeGeniexModel, geniexExe, emitEvent, recordEvidence, installedEntries, isFoundryEntry, allEntries, speedFile, readJson, write,
});

/**
 * The Foundry branch of ensureServer: exact variant selection from the CACHE, load
 * through the sidecar-owned FoundryHost (cancellable by the chat's signal), the real
 * served model id recorded, and the effective device reported.
 */
async function ensureFoundryServer(entry: CatalogEntry, o?: { setting?: LoadSetting; force?: boolean; signal?: AbortSignal }): Promise<Served> {
  const f = await foundryHost();
  if (!f) throw new Error("Microsoft Foundry Local is not installed (or its version could not be read): this model cannot start.");
  // one engine on the NPU (the registered machine npuOwner): the GenieX server comes down first
  const alias = foundryAliasOf(entry);
  if (!alias) throw new Error("this Foundry entry names no model alias");
  const wanted = (entry as any).foundryDevice ?? null;
  const loaded = await npuOwner.run("foundry", () => f.load(alias, wanted, o?.signal));
  // the effective engine/device is what Foundry REPORTED, not what was asked
  emitEvent("adaptiveSelection", { entryId: entry.id, engine: "foundry", compute: loaded.device.toLowerCase(), modelId: loaded.modelId, device: loaded.device, variant: loaded.variant, at: Date.now(), provisional: true, reason: [`Foundry Local · ${loaded.device}${loaded.variant ? ` (${loaded.variant})` : ""} · device reported by the runtime at load`, "foundry builds are validated when first loaded on this machine; until then the device is what the runtime says"] });
  return servedOf(loaded.endpoint, null, loaded.modelId);
}

/** Puts down anything Foundry holds in memory (sidecar-owned or not) before the GenieX host takes the NPU. */
const unloadFoundry = async (): Promise<void> => {
  const f = await foundryHost();
  if (f) await f.unloadIfLoaded().catch((e) => console.warn(`[foundry] unload failed: ${(e as Error).message}`));
};

// the window's own model starts (choosing a model, preloading it) reach the host directly: they ask this first
/** Who holds the NPU (the registered machine npuOwner): every start of either engine claims it here first. */
const npuOwner = new NpuOwner({
  geniex: async () => { await engineHostCall("releaseGeniexForHandoff", []); },
  foundry: async () => {
    const f = await foundryHost();
    if (f) await f.releaseForHandoff();
    else if (foundryHostCache?.host && !foundryHostCache.host.missing) {
      throw new Error("Foundry Local could not be queried. Repair its installation or close it and retry.");
    }
  },
});

function engineHostCall(method: string, args: unknown[]): Promise<unknown> {
  return dispatcher.callHost((m) => { void write(m); }, method, args, 1_200_000);
}

function admittedGeniexMethod(method: string) {
  return (...args: unknown[]) => {
    if (runtimeLease.isBusy()) throw new Error("A generation or another model task is running. Wait for it to finish, then retry.");
    return npuOwner.run("geniex", () => engineHostCall(method, args));
  };
}
dispatcher.register("startGeniexModel", admittedGeniexMethod("startGeniexModel"));
dispatcher.register("preloadGeniexModel", admittedGeniexMethod("preloadGeniexModel"));
dispatcher.register("restartGeniexModel", admittedGeniexMethod("restartGeniexModel"));
dispatcher.register("benchmarkGeniexModel", admittedGeniexMethod("benchmarkGeniexModel"));

const startingServers = new Map<string, Promise<Served>>();
async function ensureServer(entry: CatalogEntry, o?: { setting?: LoadSetting; force?: boolean; signal?: AbortSignal; retryModelLoad?: boolean }): Promise<Served> {
  serverLastError = null;
  // The Foundry engine is the sidecar's own server lifecycle: not geniex.exe, not the host.
  if (isFoundryEntry(entry)) return ensureFoundryServer(entry, o);
  // A HUMAIN Fuse model: an endpoint with its key, no process, never the NPU.
  if (entry.cloud === "fuse") {
    const c = await fuseConnection(path.dirname(settingsFile()), settings(), o?.signal);
    return fuseServed({ ...c, effort: settings().humainFuseEffort });
  }
  // Resolve the identity FIRST, through the one shared resolver: the ref served here
  // is the same one the renderer's preload and select resolved for this alias, and a
  // ref that matches nothing fails fast with its reason instead of starting a server
  // GenieX cannot load a model into.
  const serveRef = resolveServeRefFor(entry, await installedRefsTTL().catch(() => [] as string[]));
  const s = settings();
  // F16: the ONE effective-load resolver (shared with the renderer's preload
  // path) decides compute/context here — explicit request > kept profile >
  // the entry's preference > global compute. A profile from an older schema
  // version is ignored.
  const eff = effectiveLoad({
    setting: o?.setting,
    serveRef,
    entryRef: entryRef(entry),
    profiles: s.loadProfiles,
    globalCompute: s.compute,
    preferredCompute: (entry as { preferredCompute?: string }).preferredCompute,
  });
  // Adaptive selection: one decision per request, made BEFORE it starts, kept stable
  // for the whole generation (the server it starts is not touched until the request
  // ends; a switch needs the runtime lease, which the chat holds for the whole turn).
  // An explicit load setting (benchmark, NPU test) always wins.
  const selection = await selectForRequest(entry, serveRef, o);
  const compute = selection?.config ? selection.config.serveCompute : eff.compute;
  const nctx = eff.nctx;
  if (selection?.reason?.length) emitEvent("adaptiveSelection", { entryId: entry.id, engine: selection.config?.engine ?? "geniex", compute: selection.config?.compute ?? eff.compute, serveCompute: compute, at: Date.now(), provisional: selection.provisional, reason: selection.reason, gatedOut: selection.gatedOut });
  const key = JSON.stringify([serveRef, compute, nctx, !!o?.retryModelLoad]);
  const inFlight = o?.force ? null : startingServers.get(key);
  if (inFlight) return inFlight;
  const p = npuOwner.run("geniex", async () => {
    // switching engines: a loaded Foundry model holds RAM (and NPU memory for its NPU builds) the GenieX server needs
    const r = await dispatcher.callHost((m) => { void write(m); }, "startChatServer", [serveRef, compute, { nctx, retryModelLoad: o?.retryModelLoad }], 600_000) as { endpoint?: string; state?: string; model?: string | null; lastError?: FriendlyError | string | null; servedNctx?: number | null; contextKind?: string | null } | null;
    if (r?.lastError) serverLastError = typeof r.lastError === "object"
      ? r.lastError
      : { id: "server", title: "The model server reported an error", fix: "Look in Developer settings for the server logs.", raw: String(r.lastError) };
    if (!r?.endpoint) {
      if (r?.lastError && serverLastError) throw new ModelStartError(serverLastError);
      throw new Error("the model server did not start");
    }
    // The routed artifact's own compiled window, read from its bundle, is the fallback when the
    // host could not report a served window — a QAIRT graph's real limit, not the catalog's claim.
    const served = typeof r.servedNctx === "number" ? r.servedNctx : compiledContextOf(serveRef);
    return servedOf(String(r.endpoint), served, typeof r.model === "string" ? r.model : serveRef,
      r.contextKind === "compiled" || r.contextKind === "configurable" ? r.contextKind : null);
  }).finally(() => startingServers.delete(key));
  if (!o?.force) startingServers.set(key, p);
  return p;
}

/** A screenshot shown to an installed model that can see, with the question; null when there is none or it did not answer. The one already loaded comes first. */
async function lookAtShot(id: string, shot: string, question: string, signal: AbortSignal): Promise<string | null> {
  const installed = await installedEntries();
  for (const d of describers(installed, lastLoadedEntry)) {
    try {
      const srv = await ensureServer(d);
      lastLoadedEntry = d;
      const [system, ...rest] = question.split("\n\n");
      const text = (await collect(sidecarHost, d, srv, [{ role: "system", content: system }, { role: "user", content: [{ type: "image_url", image_url: { url: shot } }, { type: "text", text: rest.join("\n\n") }] }], `${id}:look`, signal, "off")).trim();
      if (text) return text;
    } catch (e) { if (signal.aborted) throw e; }
  }
  return null;
}

/** The sidecar's artifact check. The desktop build loads the page in a hidden window and
 * measures the screen; here the page's program is PLAYED in an isolated context instead
 * (construct/pagecheck.ts → sandbox.ts: the files it links are put in, the script is
 * parsed, then the page is loaded, drawn, its buttons and keys are pressed and its clock
 * ticks — with the page replaced by stand-ins, no window needed). The ONE check a build's
 * Test run consumes lives in core (src/core/construct/checkArtifact.ts), importable so
 * the tests drive exactly what a real build runs. */

/** What each model is asked to find out whether it can be the router: a few questions with a plain answer. */
const ROUTER_PROBES: [string, string, boolean][] = [
  ["make a snake game in html", "q_code", true], ["hello, how are you?", "q_code", false], ["what is 12 times 7?", "q_math", true], ["write a poem about the sea", "q_creative", true]
];

// ------------------------------------------------------------------ the router: a tiny model that sorts requests, on the processor
//
// A small
// model in a server of its own, on the PROCESSOR and its own port (never on the NPU,
// which holds the chat's model), asked closed yes/no questions per request. This process
// owns it the way it owns the Foundry server — a child of the sidecar inside the host's
// job object, so it dies with the app and no repeated launch accumulates copies (the
// single-instance owner is the only MKMN, and each MKMN has one sidecar).
//
// Everything stays bounded like the desktop build: a router that is not up yet is started
// for the NEXT request (this one is never made to wait), and every question is under
// ROUTER_TIMEOUT_MS — the words' guess stands whenever the router is missing, slow or
// unclear. The CPU exception here is the established one (the router model only).

let routerSrv: ServerManager | null = null;
let routerExe: string | null = null;
const routerSortMemory = new SortMemory();
let routerWarming = false;
const routerStats = { asked: 0, lastMs: null as number | null, lastError: null as string | null };
/**
 * One timeout per request (the rule on-device test runs broke): after a question to the
 * router failed or timed out, the request's remaining closed questions are answered null
 * at once while the background warm re-probes; the router's next success closes it. The
 * sort shares one signal, but every other closed question carried its own fresh timeout —
 * a wedged router cost one request ten timeouts and more.
 */
const routerBreaker = new RouterBreaker();
/** No ask reaches the server until its model has answered once: a fresh geniex says "ready" about 0.6 s after it is spawned, with no model loaded, and the load takes about 3.5 s — the asks of that window burned the whole router timeout (the b-runs' cold-server silence). */
const routerWarmGate = new RouterWarmGate();

/** The router's model: the one chosen in the settings when it is installed, else the best installed candidate, else the shipped default. */
const routerEntryOf = (installed: CatalogEntry[]) =>
  (settings().dynamic?.routerModel ? installed.find((e) => e.id === settings().dynamic!.routerModel && !isFoundryEntry(e)) : undefined)
  ?? installed.find((e) => !isFoundryEntry(e) && e.engine === "llama_cpp" && !!e.quant && ROUTER_PREFERRED.test(`${e.id} ${e.name}`))
  ?? installedOf(ROUTER_MODEL, installed);

/** The installed models that can be the router: small files that GenieX runs on the processor. Foundry Local's are left out: its daemon is the NPU's, and using it would put the chat's model out every time. */
const routerCandidates = (installed: CatalogEntry[]) =>
  installed.filter((e) => !isFoundryEntry(e) && e.engine === "llama_cpp" && !!e.quant && (e.sizeGB ?? 99) <= 1.6);

/** The router models installed here, as "repo:quant": what an endpoint must list for the router to adopt it. */
let routerAdoptRefs: string[] = [];

/** Where the router runs: the CPU, until a warmed router misses its answers there (a busy processor), then the GPU. */
const routerPlacement = new RouterPlacement();

/**
 * A warmed router did not answer in time: after `ROUTER_GPU_AFTER` such misses in a row it moves to the GPU (its own
 * server is restarted there; another instance's adopted router is left alone).
 */
function routerMissed(): void {
  if (!routerSrv || routerSrv.isAdopted() || !routerPlacement.missed()) return;
  console.warn(`[router] ${routerPlacement.reason}`);
  routerStats.lastError = routerPlacement.reason;
  const srv = routerSrv;
  void srv.stop().catch(() => undefined).then(() => { routerWarmGate.reset(); void warmRouter(true); });
}

/** The router's own server: the processor, its own port, a small window. The NPU is never asked, so the chat's model stays where it is. A second app instance adopts the router the first one already serves instead of spawning a duplicate that cannot bind the fixed port (the real runs: the probe answered against the first instance, the child died through its restarts, every question went unanswered). */
async function ensureRouterServer(exe: string): Promise<ServerManager> {
  await geniexGate.require(); // the router is inference too: an older GenieX is never started for it
  // the models this app may ask as its router: an endpoint is adopted only when it lists one
  routerAdoptRefs = routerCandidates(await installedEntries()).map(entryRef);
  if (!routerSrv || routerExe !== exe) {
    await routerSrv?.stop().catch(() => undefined);
    const help = (await run(exe, ["serve", "--help"], 10000).catch(() => ({ out: "" }))).out;
    // CPU first, the GPU when the CPU proved too busy (RouterPlacement): read at every start of the server
    routerSrv = new ServerManager({ exe, host: ROUTER_HOST, computeFn: () => routerPlacement.compute, keepaliveSec: 86_400, extraArgs: () => updateProbeArgs(settings().geniexUpdateCheck, help), adoptExisting: true, adoptIf: (models) => servesRouterModel(models, routerAdoptRefs) });
    routerSrv.on("error", () => undefined);
    routerExe = exe;
  }
  if (routerSrv.status().state !== "ready") {
    await routerSrv.start(ROUTER_CTX);
    routerWarmGate.reset(); // a fresh server (spawned, or adopted cold) has no model loaded yet
  }
  else if (routerSrv.isAdopted() && !(await routerSrv.probe())) {
    await routerSrv.start(ROUTER_CTX); // the adopted server died: serve our own
    routerWarmGate.reset();
  }
  return routerSrv;
}

/** One short question to the router: its reply, or null when it is not there, not ready (it is started for the next one) or did not answer in time. */
async function routerAsk(system: string, user: string, maxTokens: number, timeoutMs = ROUTER_TIMEOUT_MS): Promise<string | null> {
  const exe = await geniexGate.usable();
  if (!exe || !readBool(settings(), "dynamic.router")) return null;
  // one timeout per request: a question of this request already went unanswered, the rest cost nothing — the words' guess stands while the warm below re-probes
  if (routerBreaker.isOpen()) { void warmRouter(); return null; }
  // no ask reaches a server whose model has not answered once: the "ready" answer of a fresh geniex says nothing about the load (about 3.5 s), and asking into it only burns the timeout
  if (!routerWarmGate.open) { void warmRouter(); return null; }
  const entry = routerEntryOf(await installedEntries());
  if (!entry) return null;
  try {
    // the router answers the closed questions of every request, whatever model is chosen: one that is not up yet is started now, and this question goes to the chat model (never made to wait)
    if (!routerSrv || routerSrv.status().state !== "ready") { warmRouter(true); return null; }
    const tuned = { ...entry, sampling: routerSampling(maxTokens) } as CatalogEntry;
    const reply = await collect(sidecarHost, tuned, routerSrv, [{ role: "system", content: system }, { role: "user", content: user }], `router:${Date.now()}`, AbortSignal.timeout(timeoutMs), "off");
    routerBreaker.close(); // it answers: the next request meets it fresh
    routerWarmGate.markWarmed(); // a reply — any reply — proves the model is loaded on this server
    routerPlacement.answered();
    return reply;
  } catch {
    routerMissed(); // only a warmed router reaches here: the gate above refused the cold one
    // a wedged or dead router must cost this request at most its one short timeout: the questions after this are refused at once, and the warm below re-probes (it closes the breaker when the router answers again)
    routerBreaker.trip();
    routerStats.lastError = "the router did not answer in time: the words decided for the rest of this request";
    void warmRouter(true);
    return null;
  }
}

/** One yes/no question about a request put to the router, or null when it is not there, not ready or has no clear answer. */
async function routerYesNo(text: string, ask: string): Promise<boolean | null> {
  const p = yesNoPrompt(text, ask);
  const reply = await routerAsk(p.system, p.user, 3);
  return reply === null ? null : parseYesNo(reply);
}

/** A heavy decision: the same question in several wordings, the router asked one after the other and stopped as soon as the majority is there; a tie goes to "no" (a conversation costs a sentence, a file made by mistake costs minutes). null when it never answered. */
async function routerVote(text: string, questions: readonly string[]): Promise<boolean | null> {
  const answers: boolean[] = [];
  for (const q of questions) {
    const r = await routerYesNo(text, q);
    if (r === null) continue;
    answers.push(r);
    const done = settled(answers, questions.length);
    if (done !== undefined) return done;
  }
  return answers.length ? answers.filter(Boolean).length > answers.length / 2 : null;
}

const routerFileKindMemo = new FileKindMemo();
/**
 * The kind of file a request asks for, by closed yes/no questions of the router, the most specific first (a small model answers a yes/no far better than a pick among five, which turned "a doc exel" into a Word document):
 * a spreadsheet, a calculator page, a website, then a written document. undefined when the router did not answer (the words then decide). A real outcome is remembered for the same message; a non-answer never is (a cold, gated or wedged router must not stand in for "no file is wanted" on every later ask of the same text).
 */
async function routerFileKind(text: string): Promise<TemplateKind | null | undefined> {
  const memo = routerFileKindMemo.get(text);
  if (memo !== undefined) return memo;
  // first, is a file to be PRODUCED at all? ("I need help revising this", "here is a document" are conversations): a wrong yes here costs minutes, a wrong no costs a sentence
  const produce = await routerVote(text, PRODUCE_VOTES);
  if (produce === false) { routerFileKindMemo.set(text, null); return null; }
  if (produce === null) return undefined; // the router did not answer: the words decide, and nothing is remembered
  let kind: TemplateKind | null = null, answered = false;
  for (const [k, q] of [["xlsx", Q.sheet], ["tool", Q.calculator], ["site", Q.site], ["docx", Q.word]] as const) {
    const r = await routerYesNo(text, q);
    if (r === null) { if (!answered) return undefined; continue; } // the router answered nothing at all: not an outcome, ask again later (never memoized)
    answered = true;
    if (r) { kind = k; break; }
  }
  routerFileKindMemo.set(text, kind);
  return kind;
}

/** The web search for a request, written by the router; null when it did not write a usable one (the keywords then stand in). */
async function routerQuery(text: string): Promise<string | null> {
  const p = searchQueryPrompt(text);
  const reply = await routerAsk(p.system, p.user, 24, 6000);
  return reply === null ? null : readSearchQuery(reply);
}

/** Starts the router in the background, so that the first request already finds it ready. */
function warmRouter(force = false) {
  if (!readBool(settings(), "dynamic.router")) return;
  if (routerWarming) return;
  if (!findGeniex(settings().geniexPath ?? null)) return;
  routerWarming = true;
  void (async () => {
    const exe = await geniexGate.usable();
    if (!exe) return;
    const installed = await installedEntries();
    if (!routerEntryOf(installed)) return;
    try {
      const srv = await ensureRouterServer(String(exe));
      // the model is loaded by its first request: ask one question now, so the first real request finds it ready
      const entry = routerEntryOf(installed)!;
      const p = yesNoPrompt("hello", "Is it a greeting?");
      await collect(sidecarHost, { ...entry, sampling: routerSampling(2) } as CatalogEntry, srv, [{ role: "system", content: p.system }, { role: "user", content: p.user }], `router:warm`, AbortSignal.timeout(60_000), "off");
      routerBreaker.close(); // the router answers again: the next request meets it fresh (a wedged one stays open)
      routerWarmGate.markWarmed();
    } catch (e) { routerStats.lastError = (e as Error).message; }
  })().finally(() => { routerWarming = false; });
}

/** What the router answered to the last request: the questions it was asked, and what it said to each. */
type SidecarRouterResult = { kind: TaskCategory | null; asked: Asked[]; ms: number };

/**
 * The kind of a request according to the router, or null (not installed, switched off, too slow, or no clear answer): the rules' guess then
 * stands. It is asked a series of yes/no questions, each answered in one word, so each costs little more than the time to the first token.
 */
async function routerSort(text: string, installed: CatalogEntry[], lean?: TaskCategory, fresh = false): Promise<SidecarRouterResult | null> {
  const known = fresh ? undefined : routerSortMemory.get(text);
  if (known) return { kind: known, asked: [], ms: 0 };
  const entry = routerEntryOf(installed);
  const exe = await geniexGate.usable();
  if (!entry || !exe || settings().dynamic?.router === false) return null;
  const t0 = Date.now();
  // one timeout per request: a question of this request already went unanswered, the sort is refused at once (the words' guess stands)
  if (routerBreaker.isOpen()) { void warmRouter(); routerStats.lastError = "the router did not answer its last question: the words decided"; return null; }
  // the same warm gate as the single questions: a "ready" server with no model loaded only burns the timeout
  if (!routerWarmGate.open) { void warmRouter(); routerStats.lastError = "the router's model was still loading: the words decided"; return null; }
  try {
    // a router that is not up yet is started for the next request: this one is not made to wait for it
    if (!routerSrv || routerSrv.status().state !== "ready") { warmRouter(true); routerStats.lastError = "the router was still starting: the words decided"; return null; }
    const srv = routerSrv;
    const signal = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
    const tuned = { ...entry, sampling: routerSampling(3) } as CatalogEntry;
    const r = await sortByQuestions(async (ask) => {
      const p = yesNoPrompt(text, ask);
      return parseYesNo(await collect(sidecarHost, tuned, srv, [{ role: "system", content: p.system }, { role: "user", content: p.user }], `router:${Date.now()}`, signal, "off"));
    }, lean);
    routerStats.asked++;
    routerPlacement.answered();
    routerStats.lastMs = Date.now() - t0;
    routerStats.lastError = r.kind ? null : "the answers did not lead to a kind";
    if (r.kind) routerSortMemory.set(text, r.kind);
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    // the sort shares one signal, so a wedged router cost it one timeout — but the request's remaining closed questions must not pay it again
    routerBreaker.trip();
    routerMissed();
    void warmRouter();
    routerStats.lastError = (e as Error).message;
    return null;
  }
}

const sidecarHost: ChatHost = {
  settings: () => settings() as any,
  patchSettings: (patch) => { saveSettings(patch as Record<string, unknown>); },
  allEntries,
  entryById,
  installedEntries,
  chatHardware,
  lastLoaded: () => lastLoadedEntry,
  setLastLoaded: (e) => { lastLoadedEntry = e; },
  benchRunning: () => bench?.running ?? false, // a benchmark holds the NPU: the orchestrator refuses to start a model over it
  ensureServer,
  recoverServer: async (e) => {
    // A stalled ROUTER call must never walk this chat path: collect hands every call the
    // fail-fast recovery, and a router:warm that stalled (seen in an on-device test run) stopped the
    // CHAT's model server and asked the host to start the router model in its place —
    // the user's chat model put out mid-turn by the router's own failure. The router's
    // server is this process's own: recycle it here, and only a non-router entry falls
    // through to the chat host below.
    if (routerSrv && (await routerEntryOf(await installedEntries()))?.id === e.id) {
      await routerSrv.stop().catch(() => undefined);
      const exe = await geniexGate.usable();
      if (exe) return await ensureRouterServer(String(exe));
    }
    // The fail-fast client's one recovery for a server that stopped serving mid-call: the
    // server is put down through the owner that has it (the Rust host's supervisor for
    // geniex.exe, this process for Foundry Local — never both at once) and started again.
    await stopServerHost();
    const started = await ensureServer(e, { force: true });
    lastLoadedEntry = e;
    return started;
  },
  servedName: (e) => (e.cloud ? e.repo : entryRef(e)),
  send: (ev) => {
    emitEvent("chat", ev);
    // A stuck NPU announces itself through the orchestrator's own failure lines
    // (the driver's dspqueue/fastrpc/mapping errors). The host's recovery is
    // bounded and rate-limited there (one per cooldown, never mid-generation,
    // never a foreign process); firing it here costs nothing when the failure is
    // something else.
    if (ev && typeof ev === "object" && (ev as { type?: string }).type === "error") {
      const raw = JSON.stringify((ev as { error?: unknown }).error ?? ev);
      if (/dspqueue_read failed|fastrpc_mmap|buffer mapping failed/i.test(raw)) {
        void dispatcher.callHost((m) => { void write(m); }, "npuRecoverStuck", [], 30_000).catch(() => undefined);
      }
    }
  },
  recordSpeed,
  folderOf: (opts) => (typeof opts.projectFolder === "string" && opts.projectFolder.trim() ? opts.projectFolder : null),
  // figures are drawn in the webview; until the bridge offers them, a diagram is reported as
  // "could not be drawn" and the slide keeps its text. There is no slide renderer either:
  // renderSlide is left out on purpose (the host cannot draw slides), so the deck build says
  // its slides were checked by the layout measure only instead of pretending a screenshot ran.
  figure: async () => null,
  lookAtShot,
  checkArtifact,
  // The NPU recovery: the HOST does the bounded process-level recovery (stop OUR
  // stuck server and OUR job-scoped strays, once per cooldown, never mid-
  // generation); the driver-level reset needs administrator permission and stays
  // the user's explicit UAC-prompted decision in Developer settings — so canReset
  // stays false here, exactly like the desktop build's own canAutoReset.
  npuRecovery: async () => {
    const info = await dispatcher
      .callHost((m) => { void write(m); }, "npuRecoveryInfo", [], 5_000)
      .catch(() => null) as { external?: string[]; canReset?: boolean } | null;
    return {
      external: Array.isArray(info?.external) ? info.external : [],
      canReset: info?.canReset === true,
      reset: async () => ({
        ok: false,
        message: "The NPU's driver was not reset: that needs administrator permission. Use the NPU reset in Developer settings; the stuck model server was stopped automatically instead."
      })
    };
  },
  // the owned server is BUSY while a generation runs, idle again after it (the
  // supervisor reports the "busy" state between "ready" and the idle unload)
  markGeneration: (active: boolean) => {
    void dispatcher.callHost((m) => { void write(m); }, "setServerBusy", [active], 15_000).catch(() => undefined);
  },
  // the router: a small model on the processor in a server of this process's own (the
  // established CPU exception). Absent or slow, the words alone sort the request —
  // every router call is bounded and every failure falls back.
  router: {
    sort: (text, installed, lean) => routerSort(text, installed, lean),
    yesNo: (text, ask) => routerYesNo(text, ask),
    query: (text) => routerQuery(text),
    fileKind: (text) => routerFileKind(text)
  }
};

const humainChat = registerHumain(dispatcher, path.dirname(settingsFile()), settings);

dispatcher.register("chat", (id: string, modelId: string, messages: ChatMessage[], opts: ChatOptions) => {
  // fire and forget: the events stream out as `chat` events; the answer ends with a `done` or an `error`
  const config = settings();
  if (modelId === CLOUD_CHAT_ID) {
    const provider = cloudProviderOf(config.humainMode);
    if (!provider) throw new Error("Select a HUMAIN chat provider in Settings.");
    // Fuse is an OpenAI-compatible endpoint: its chats run through the app's own pipeline.
    if (provider === "fuse") {
      const list = Array.isArray(messages) ? messages : [];
      void (async () => {
        let turn = list;
        let links: [string, string][] = [];
        // Fuse's web search lives on its Responses API: asked first, its findings ride the turn as context
        const mode = featureEnabled(config.humainDisabledFeatures, "search") ? config.humainChatSearch : "off";
        const lastUser = [...list].reverse().find((m) => m.role === "user");
        const query = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content as any[] | undefined)?.map((p) => p?.text ?? "").join(" ") ?? "";
        if (mode && mode !== "off" && query.trim()) {
          try {
            sidecarHost.send({ id: String(id), type: "notice", text: "Searching the web with HUMAIN Fuse" } as ChatEvent);
            const c = await fuseConnection(path.dirname(settingsFile()), config);
            const found = await fuseSearchContext({ key: c.key, model: c.model, query, mode });
            if (found) {
              const at = list.lastIndexOf(lastUser!);
              turn = [...list.slice(0, at), { role: "system", content: found.context }, ...list.slice(at)];
              links = found.links;
            }
          } catch (e) {
            sidecarHost.send({ id: String(id), type: "notice", text: `The web search did not answer, so this answer uses no web results (${(e as Error).message})` } as ChatEvent);
          }
        }
        // the links the search found are listed by the app under the answer, just before the turn ends
        const host: ChatHost = links.length ? { ...sidecarHost, send: (ev) => {
          if (ev.id === String(id) && ev.type === "done") sidecarHost.send({ id: String(id), type: "answer", text: sourcesBlock(links) } as ChatEvent);
          sidecarHost.send(ev);
        } } : sidecarHost;
        await runChatOrchestrator(host, String(id), CLOUD_CHAT_ID, turn, (opts ?? {}) as ChatOptions);
      })();
      return;
    }
    const ac = new AbortController();
    registerChat(id, ac);
    void humainChat(id, config, Array.isArray(messages) ? messages : [], ac.signal, sidecarHost.send)
      .finally(() => unregisterChat(id));
    return;
  }
  void runChatOrchestrator(sidecarHost, String(id), String(modelId), Array.isArray(messages) ? messages : [], (opts ?? {}) as ChatOptions);
});

dispatcher.register("abortChat", (id: string) => { abortChat(String(id)); });

// the closed file question the renderer asks before building its prompt (the router's answer is memoized above)
dispatcher.register("routerFileKind", async (text: unknown) => routerFileKind(String(text ?? "")));

dispatcher.register("skipStep", (id: string, back?: boolean) => { skipStep(String(id), !!back); });

// ---- the router's own panel (Settings → Dynamic): the same answers the desktop build gives

dispatcher.register("routerStatus", async () => {
  const installed = (await installedEntries()).filter((e) => !isDynamicId(e.id));
  const rs = routerSrv?.status();
  return {
    model: ROUTER_MODEL.name,
    sizeGB: ROUTER_MODEL.sizeGB,
    installed: !!routerEntryOf(installed),
    enabled: settings().dynamic?.router !== false,
    running: routerSrv?.status().state === "ready",
    warmed: routerWarmGate.open, // the model has answered once on the current server: asks reach it (the "ready" state alone says nothing about the load)
    // which server is answering the router's asks: the sidecar's own child, or another
    // instance's process this manager adopted (the measurements record this per ask)
    server: rs ? { adopted: !!rs.adopted, compute: rs.compute, nctx: rs.nctx, state: rs.state, pid: rs.pid } : null,
    // where it runs and why: the CPU, or the GPU after the CPU proved too busy
    placement: { compute: routerPlacement.compute, reason: routerPlacement.reason },
    ...routerStats
  };
});

dispatcher.register("routerCandidates", async () => {
  const installed = (await installedEntries()).filter((e) => !isDynamicId(e.id));
  return { chosen: routerEntryOf(installed)?.id ?? null, candidates: routerCandidates(installed).map((e) => ({ id: e.id, name: e.name, sizeGB: e.sizeGB })) };
});

// the model for the router is found the way a person would: each candidate is asked the same few questions, and the quickest that answers them all right is kept
dispatcher.register("routerBench", async () => {
  const exe = await geniexGate.require();
  const installed = (await installedEntries()).filter((e) => !isDynamicId(e.id));
  const rows: { id: string; name: string; sizeGB: number; ms: number | null; right: number; total: number; error: string | null }[] = [];
  for (const e of routerCandidates(installed)) {
    const row = { id: e.id, name: e.name, sizeGB: e.sizeGB, ms: null as number | null, right: 0, total: ROUTER_PROBES.length, error: null as string | null };
    try {
      const srv = await ensureRouterServer(String(exe));
      const tuned = { ...e, sampling: routerSampling(3) } as CatalogEntry;
      const ask = async (text: string, id: string) => { const p = yesNoPrompt(text, TREE[id].ask); return parseYesNo(await collect(sidecarHost, tuned, srv, [{ role: "system", content: p.system }, { role: "user", content: p.user }], `router:bench`, AbortSignal.timeout(60_000), "off")); };
      await ask("hello", "q_code"); // the first request loads the model: not counted
      const t0 = Date.now();
      for (const [text, id, want] of ROUTER_PROBES) if ((await ask(text, id)) === want) row.right++;
      row.ms = Math.round((Date.now() - t0) / ROUTER_PROBES.length);
    } catch (err) { row.error = (err as Error).message.slice(0, 120); }
    rows.push(row);
  }
  const best = rows.filter((r) => r.ms !== null && r.right === r.total).sort((a, b) => a.ms! - b.ms!)[0];
  if (best) { saveSettings({ dynamic: { ...(settings().dynamic ?? {}), routerModel: best.id } }); routerSortMemory.clear(); }
  return { rows, chosen: best?.id ?? null };
});

dispatcher.register("routerInstall", async () => {
  const r = await installPackModel(ROUTER_MODEL);
  warmRouter();
  return r;
});

dispatcher.register("routerTest", async (text: string) => {
  const installed = (await installedEntries()).filter((e) => !isDynamicId(e.id));
  const t0 = Date.now();
  const rules = sortRequest(String(text ?? ""));
  const r = await routerSort(String(text ?? "").slice(0, 600), installed, rules.category, true);
  return { kind: r?.kind ?? null, ms: Date.now() - t0, rules, asked: (r?.asked ?? []).map((a) => ({ id: a.id, yes: a.yes })) };
});

/** The chat's side calls (a summary, a repaired diagram) share the open turn's lease, or take it briefly. */
async function withChatSideLease<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  const owner = runtimeLease.currentOwner();
  if (owner?.owner === "chat") return fn();
  const lease = runtimeLease.acquire("chat", label);
  if (!lease) return null;
  try { return await fn(); } finally { lease.release(); }
}

dispatcher.register("compactChat", async (id: string, modelId: string, messages: ChatMessage[], memoTurns: number, convId?: string) => {
  const r = await withChatSideLease(`Summary ${id}`, async () => {
    const ac = new AbortController();
    registerChat(String(id), ac); // so the window's abort reaches a summary being built
    try {
      const entry = (isDynamicId(modelId) ? lastLoadedEntry ?? (await dynamicTeam(sidecarHost, modelId, Array.isArray(messages) ? messages : []))?.pick.entry : entryById(modelId)) ?? lastLoadedEntry;
      if (!entry) return { error: "Pick a model first." };
      const srv = await ensureServer(entry);
      lastLoadedEntry = entry;
      const r = await foldOldMessages(sidecarHost, String(id), entry, srv, Array.isArray(messages) ? messages : [], Number(memoTurns) || 0, ac.signal, false, { convId: convId ? String(convId) : undefined });
      if (!r) return { error: "There is not enough earlier conversation to summarize yet." };
      return "text" in r ? { text: r.text, turns: r.turns } : { error: r.error };
    } catch (e) {
      return { error: ac.signal.aborted ? "Stopped." : friendly((e as Error).message)?.title ?? (e as Error).message };
    } finally { unregisterChat(String(id)); }
  });
  return r ?? { error: "The NPU is busy with another task. Wait for it to finish." };
});

// a diagram is only drawn in the webview (Mermaid needs one), so the window asks for a correction when its own repairs were not enough
dispatcher.register("fixBlock", async (kind: string, raw: string, reason: string) => {
  const entry = lastLoadedEntry;
  if (!entry || (kind !== "mermaid" && kind !== "chart") || typeof raw !== "string" || raw.length > 6000) return null;
  try {
    // under the open turn's own lease when a turn is answering; never against a task, a test or a benchmark
    return await withChatSideLease(`A repaired ${kind}`, async () => {
      const srv = await ensureServer(entry!);
      const [system, user] = kind === "chart"
        ? [CHART_FIX_INSTRUCTIONS, `The chart:\n${raw.trim().slice(0, 2500)}\n\nWhat is wrong with it: ${String(reason).slice(0, 300)}\n\nSend the corrected JSON.`]
        : [diagramFixInstructions, `The diagram:\n${raw.trim().slice(0, 4000)}\n\nWhat is wrong with it: ${String(reason).slice(0, 300)}\n\nSend the corrected Mermaid text.`];
      const reply = await collect(sidecarHost, entry!, srv, [{ role: "system", content: system }, { role: "user", content: user }], `fix:${Date.now()}`, AbortSignal.timeout(90_000), "off");
      const stripped = reply.replace(new RegExp("<" + "think[\\s\\S]*?<" + "/think>", "g"), "").trim();
      return stripped || null;
    });
  } catch { return null; }
});

// ---- setup (first launch) and updates (deliberately without a transport)
// The same SetupService the desktop build runs (src/core/setupService.ts): whatever is
// missing on first launch (GenieX, the default speech models) is installed in order, with
// progress as `setup` events. The updater is the same honest "disabled" class: no update
// transport exists until a signed MKMN release channel does.

const setupGeniexPath = () => findGeniex(settings().geniexPath ?? null);
const setupGeniexSupported = () => process.platform === "win32" && process.arch === "arm64";
const fetchGeniexIndex = () => fetch(GENIEX_INDEX_URL, { signal: AbortSignal.timeout(15_000) })
  .then((r) => (r.ok ? r.json() : null)).then(parseGeniexIndex).catch(() => null);

/** The setup screen's GenieX question: the minimum-version verdict (local, works offline) and, for a GenieX that already
 * works, Qualcomm's latest stable tag when it is newer than what is installed and was not skipped before. A missing or
 * older GenieX never waits for the feed: the install reads it itself. */
async function setupGeniexCheck(): Promise<{ geniex: Awaited<ReturnType<typeof geniexGate.check>> | null; upgrade: string | null }> {
  if (!setupGeniexSupported()) return { geniex: null, upgrade: null };
  geniexGate.reset();
  const status = await geniexGate.check();
  if (!geniexNeedsFeed(status)) return { geniex: status, upgrade: null };
  const latest = (await fetchGeniexIndex())?.latestStable ?? null;
  return { geniex: status, upgrade: geniexUpgradeOffer(status, latest, settings().geniexSkippedUpdate ?? null) };
}

const setup = new SetupService({
  geniexPath: setupGeniexPath,
  installGeniex: async (progress, allowUnsigned) => {
    progress(null, "Checking Qualcomm's latest stable GenieX release…");
    const release = await resolveGeniexRelease();
    if (!release) throw new Error("Qualcomm's latest stable GenieX release could not be verified. Check your internet connection and retry.");
    return installGeniex({ ...realGeniexDeps(), allowUnsigned, release }, progress);
  },
  onGeniexInstalled: (p) => { saveSettings({ geniexPath: p }); geniexGate.reset(); },
  onGeniexUpdateSkipped: (tag) => { saveSettings({ geniexSkippedUpdate: tag }); },
  geniexSupported: setupGeniexSupported,
  // llama.cpp is the desktop build's GPU/CPU engine; the Tauri build targets the NPU,
  // where GenieX serves everything, so no llama step is ever offered here
  llamaNeeded: () => false,
  voiceNeeds: () => {
    const v = voiceSettings();
    const stt = voiceModel(v.sttModelId) ?? defaultVoiceModel("stt");
    const tts = voiceModel(v.ttsModelId) ?? defaultVoiceModel("tts");
    return { stt: !voice.isInstalled(stt), tts: !voice.isInstalled(tts), sttName: stt.name, ttsName: tts.name, sttMB: stt.sizeMB, ttsMB: tts.sizeMB };
  },
  installVoice: (kind, progress) => new Promise<void>((resolve, reject) => {
    const v = voiceSettings();
    const m = voiceModel(kind === "stt" ? v.sttModelId : v.ttsModelId) ?? defaultVoiceModel(kind);
    const on = (p: VoiceDownloadProgress) => {
      if (p.id !== m.id) return;
      progress(p.percent, p.phase === "extracting" ? "Unpacking…" : `Downloading ${m.name}…`);
      if (p.phase === "done") {
        voice.off("download", on);
        const cur = voiceSettings();
        saveSettings({ voice: { ...cur, ...(kind === "stt" ? { sttModelId: m.id } : { ttsModelId: m.id }) } });
        void ensureVoice().catch(() => undefined);
        resolve();
      } else if (p.phase === "error" || p.phase === "cancelled") {
        voice.off("download", on);
        reject(new Error(p.error ? `${p.error.title}. ${p.error.fix} (${p.error.raw})` : "Download cancelled"));
      }
    };
    voice.on("download", on);
    void voice.download(m.id);
  })
});
setup.on("state", (st: unknown) => emitEvent("setup", st));

const updater = new Updater((st) => emitEvent("update", st));
updater.start();

// the desktop build checks after the window's first paint: the same beat, a moment after launch
setTimeout(() => {
  void setupGeniexCheck().then((o) => setup.check(o)).catch((e) => console.error(`[sidecar] setup check failed: ${e}`));
}, 2500);

dispatcher.register("setupState", () => setup.status());
dispatcher.register("setupConfirm", () => setup.confirm());
dispatcher.register("setupDecline", () => setup.decline());
dispatcher.register("setupDismiss", () => setup.dismiss());
dispatcher.register("setupSkip", (id: string) => {
  if (setup.status().steps.some((s) => s.id === id)) setup.skip(id as never);
});
dispatcher.register("setupRetry", (id: string) => {
  if (setup.status().steps.some((s) => s.id === id)) setup.retry(id as never);
});
dispatcher.register("setupRunUnsigned", (id: string) => {
  if (setup.status().steps.some((s) => s.id === id)) setup.runUnsigned(id as never);
});

dispatcher.register("updateState", () => updater.current);
dispatcher.register("updateCheck", () => updater.check());
dispatcher.register("updateInstall", () => { updater.install(); });
dispatcher.register("updateForce", () => updater.force());

// ---- dev tools: the benchmark, the NPU load test and the prompt lab
// The same BenchRunner / LabRunner / runLoadTest the desktop build runs (src/core), fed with
// this process's deps. The model server still belongs to the Rust host: `start` and
// `stopServer` go through the host capabilities (startChatServer / stopChatServer), so
// geniex.exe keeps exactly one owner. What cannot cross degrades honestly:
//  - no Foundry Local engine in the roster (the comparison feature);
//  - serverLog answers [] (the server's log lives in the Rust host);
//  - the NPU counters are the whole NPU's, not the server process's (the pid is the host's);
//  - load-test settings that are only environment variables (host-side buffers) are skipped
//    with a note: the host does not set env on geniex.exe;
//  - the automatic NPU reset says no (canAutoReset is false in the desktop build too).

const benchRoot = () => path.join(dataDir(), "benchmarks");

let npuRead: Promise<NpuReading> | null = null;
const readNpu = (): Promise<NpuReading> => {
  npuRead ??= readNpuOnce().finally(() => { npuRead = null; });
  return npuRead;
};
let npuMemRead: Promise<NpuReading> | null = null;
const readNpuMemory = (): Promise<NpuReading> => {
  npuMemRead ??= readNpuMemoryOnce().finally(() => { npuMemRead = null; });
  return npuMemRead;
};
const npuMemGB = (r: NpuReading) => (r.memBytes === null ? null : Math.round((r.memBytes / 1024 ** 3) * 100) / 100);

let serveHelp: string[] = [];
async function probeLogArgs(): Promise<void> {
  try {
    const help = await run(geniexExe(), ["serve", "--help"], 10000);
    serveHelp = ["geniex serve --help:", ...help.out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(0, 60).map((l) => `  ${l}`)];
  } catch { serveHelp = []; }
}

/** Keeps the setting a model loaded under, so the app starts it that way (the same write the desktop build does). */
function rememberLoadSetting(entry: CatalogEntry, setting: LoadSetting): void {
  const r = entryRef(entry);
  const s = settings();
  const patch: Record<string, unknown> = { placements: { ...(s.placements ?? {}), [r]: badgeOf(setting) }, loadFailures: clearLoadFailure(s.loadFailures, r) };
  if (setting.id !== "default") patch.loadProfiles = { ...(s.loadProfiles ?? {}), [r]: profileOf(setting) };
  saveSettings(patch);
  // A load setting is only remembered once the model actually LOADED under it:
  // that is the "Loaded on this device" evidence, recorded where the fact was seen.
  void recordEvidence([{ kind: "loaded-on-device", ref: r, config: { setting: setting.id } }]);
}

/**
 * A benchmark-suite model's measured speed and device, written through the host's ONE profile writer (the
 * single-model benchmark's), keyed by the exact build it tested; the window then refreshes the Models list.
 */
async function recordSuiteRun(r: import("../core/bench").ModelResult): Promise<void> {
  const rec = suiteRunRecord(r);
  if (!rec) return;
  try {
    await dispatcher.callHost((m) => { void write(m); }, "recordBenchRun", [rec.modelRef, rec.run], 30_000);
    emitEvent("benchMeasured", { ref: rec.modelRef });
  } catch (e) { console.error(`[bench] the measurement of ${rec.modelRef} was not saved: ${(e as Error).message}`); }
}

/** The badge of a model: where the benchmark saw it run. */
function rememberPlacement(entry: CatalogEntry, runsOn: string): void {
  const b = badgeOfPlacement(runsOn);
  if (!b) return;
  const s = settings();
  saveSettings({ placements: { ...(s.placements ?? {}), [entryRef(entry)]: b }, loadFailures: clearLoadFailure(s.loadFailures, entryRef(entry)) });
  // The benchmark loaded AND ran the model: both facts are evidence now.
  void recordEvidence([
    { kind: "loaded-on-device", ref: entryRef(entry) },
    { kind: "performance-measured", ref: entryRef(entry), result: { runsOn: b } },
  ]);
}

/**
 * Records per-device evidence through the host's kind-validated store. Evidence
 * is never load-bearing: a failed record must not break the operation that
 * produced it, so every failure is swallowed after the attempt.
 */
async function recordEvidence(records: Array<{ kind: import("../core/manifest").EvidenceKind; ref: string; config?: unknown; result?: unknown; id?: string }>): Promise<void> {
  try {
    const hw = await hardware();
    const gv = await geniexVersion(geniexExe()).catch(() => null);
    const machine = `${hw.chipName}, ${hw.ramGB} GB`;
    const full = records.map((r) => ({
      id: r.id ?? `${r.kind}:${r.ref}`,
      kind: r.kind,
      ref: r.ref,
      asOf: new Date().toISOString(),
      machine,
      runtimeVersion: gv ?? "unknown",
      config: r.config,
      result: r.result,
    }));
    await dispatcher.callHost((m) => { void write(m); }, "recordModelEvidence", [full], 30_000);
  } catch { /* evidence recording is best-effort by contract */ }
}

/** The catalog entry of a Dynamic pack model: the one the app already knows, or the one worked out from Hugging Face. */
async function entryForBundle(m: { ref: string; name: string; repo: string; quant: string | null }): Promise<CatalogEntry> {
  const known = allEntries().find((e) => (e as any).dynamicRef === m.ref || entryMatches(e, m.ref) || entryMatches(e, m.repo));
  if (known) return known;
  const r = await resolveModel({ hf, docker, native: nativeBundles }, m.quant ? `${m.repo}:${m.quant}` : m.repo, await hardware(), { showKQuants: !!settings().showKQuants });
  if (r.type !== "model" || !r.inspection.entry) throw new Error(`${m.repo} was not found. Search for ${m.name} in Models and install it from there.`);
  return r.inspection.entry;
}

/** Puts the model server down through the host (it owns geniex.exe); the sidecar-owned
 * Foundry Local model (if one is loaded) is put down too, so no engine keeps the NPU. */
const stopServerHost = async (): Promise<void> => {
  try { await dispatcher.callHost((m) => { void write(m); }, "stopChatServer", [], 120_000); } catch { /* nothing to stop */ }
  await unloadFoundry();
};

const describeEntry = async (e: CatalogEntry): Promise<string> => {
  const hw = await chatHardware();
  const v = scoreEntry(e, hw);
  return `needs about ${v.estNpuGB} GB of the ${hw.npuBudgetGB.toFixed(1)} GB NPU budget (${hw.npuBudgetSource}), window ${v.contextTokens || "none"}, ${e.quant ?? "native"} ${e.architecture}, ${e.sizeGB.toFixed(1)} GB file${v.level !== "green" ? `, the app rates it ${v.level}: ${v.reasons.join(" ")}` : ""}`;
};

let bench: BenchRunner | null = null;

/** Whether the host was last told a benchmark is running: only transitions are sent. */
let benchFlagOn = false;

/** Tells the Rust host whether a benchmark is running, so the monitor keeps sampling over it.
 * The flag is a lease on the host side (two hours, renewed here): while it is on, this
 * timer re-sends it every minute, so a flag whose sidecar died mid-run is not renewed and
 * the host lets it lapse instead of resting the monitor never again. */
let benchLeaseTimer: ReturnType<typeof setInterval> | null = null;

function setHostBenchmarking(on: boolean): void {
  void dispatcher.callHost((m) => { void write(m); }, "setBenchmarking", [on], 5_000).catch(() => undefined);
  if (on && !benchLeaseTimer) benchLeaseTimer = setInterval(() => setHostBenchmarking(true), 60_000);
  if (!on && benchLeaseTimer) {
    clearInterval(benchLeaseTimer);
    benchLeaseTimer = null;
  }
}

function benchRunner(): BenchRunner {
  if (bench) return bench;
  bench = new BenchRunner({
    root: benchRoot(),
    resolve: async (t) =>
      (t.entryId ? entryById(t.entryId) : undefined) ??
      (t.bundleRef || t.repo
        ? await entryForBundle({ ref: t.bundleRef ?? t.key, name: t.name, repo: t.repo, quant: t.quant ?? null })
        : (() => { throw new Error(`${t.name} is not a model this app knows.`); })()),
    isInstalled: async (e) => {
      // A Foundry model lives in Foundry's own cache, never in the GenieX cache:
      // asking geniex about it always reads "not installed" and made the runner
      // re-download it through the wrong tool (`geniex pull` fails on the alias).
      if (isFoundryEntry(e)) {
        const f = await foundryHost();
        if (!f) return null;
        const list = await f.cached().catch(() => null);
        if (list === null) return null;
        const alias = foundryAliasOf(e).toLowerCase();
        return list.some((v) => v.alias.toLowerCase() === alias);
      }
      // Tri-state: a failed `geniex list` is an UNREADABLE inventory (null), never an
      // empty one — reading it as empty made the runner re-install cached models and
      // mis-own cleanup (it could uninstall a pre-existing model).
      let listed: InstalledModel[] | null;
      try { listed = await listInstalled(geniexExe()); } catch { listed = null; }
      return installedState(e, listed, entryRef(e));
    },
    install: (e) => isFoundryEntry(e) ? installFoundryEntry(e) : installEntry(e),
    cancelInstall: (e) => { pulls.get(entryRef(e))?.cancel(); foundryDownloads.get(entryRef(e))?.abort(); },
    uninstall: async (e) => {
      if (isFoundryEntry(e)) {
        const r = await uninstallFoundryEntry(e);
        return { ok: r.ok, message: r.message };
      }
      const r = await removeGeniexModel(entryRef(e), "the benchmark removes a model it installed");
      return { ok: r.ok, message: r.out.trim() };
    },
    keep: (e, t) => { if (!allEntries().some((x) => x.id === e.id)) saveCustom(t.bundleRef ? { ...e, dynamicRef: t.bundleRef } : e); },
    remember: rememberLoadSetting,
    placed: rememberPlacement,
    measured: (r) => { void recordSuiteRun(r); },
    allowHybrid: () => readBool(settings(), "allowHybridLoad"),
    // closeStray is not offered: geniex.exe belongs to the Rust host, and there is no other engine
    canResetNpu: async () => false, // the same answer the desktop build's own canAutoReset gives
    start: async (e, setting) => {
      // A fresh start for every model: no server of the model before is left running (a leftover
      // holds NPU memory and RAM, and only one model fits on the NPU).
      await stopServerHost();
      const srv = await ensureServer(e, { setting });
      // The SERVED window, not the catalog's recommendation: a model loaded through a
      // fallback with a smaller profile must be tested and reported under the window it
      // actually has (long-context eligibility and output limits depend on it). When the
      // host could not tell, the artifact's OWN compiled window (its bundle's config) is
      // resolved before the catalog value, which is only a PROVISIONAL stand-in.
      const nctx = srv.status().nctx ?? compiledContextOf(entryRef(e)) ?? (e as { recommendedContext?: number }).recommendedContext ?? 4096;
      // The served identity and the kind of context window travel with the run: the
      // report states WHICH model answered and whether its window is real or compiled.
      return { endpoint: srv.endpoint || DEFAULT_ENDPOINT, nctx, model: srv.model, backend: isFoundryEntry(e) ? "Foundry Local" : "GenieX", contextKind: srv.status().contextKind ?? null };
    },
    stopServer: stopServerHost,
    onRunEnd: () => { benchLease?.release(); benchLease = null; },
    freeDiskGB: () => freeDiskGB(modelsDir()),
    probe: async () => {
      const r = await readNpu();
      return { util: r.util, memGB: npuMemGB(r) };
    },
    // The memory-record points need the counter source that measures NPU memory: the host
    // probe above answers utilization without memory (there is no native NPU memory read).
    probeMemory: async () => {
      const r = await readNpuMemory();
      return { util: r.util, memGB: npuMemGB(r) };
    },
    serverLog: () => [],
    describe: describeEntry,
    compute: () => (settings().compute === "cpu" ? "cpu" : "npu"),
    battery: async () => (await readBatteryOnce()) ?? parseBattery(""),
    emitLive: (l: BenchLive) => emitEvent("benchLive", l),
    machineInfo: async () => {
      const hw = await hardware();
      let win = "";
      try { win = (await ps(WINDOWS_BUILD_SCRIPT, 8000)).trim(); } catch { /* unknown */ }
      const gv = await geniexVersion(geniexExe()).catch(() => null);
      const bat = (await readBatteryOnce()) ?? parseBattery("");
      const power: [string, string][] = bat.present ? [["Power", bat.onMains ? "plugged in (energy not measured)" : "on battery"], ["Battery", `${batteryPercent(bat)} %, ${bat.fullMWh} mWh when full`]] : [["Power", "no battery reported"]];
      return [["Chip", hw.chipName], ["Memory", `${hw.ramGB} GB`], ["NPU", hw.npuDetected ? `Hexagon NPU${hw.npuDriverVersion ? `, driver ${hw.npuDriverVersion}` : ""}` : "not found"], ["NPU memory limit", `${hw.npuBudgetGB} GB (${hw.npuBudgetSource})`], ["Windows", win || os.release()], ["GenieX", gv ?? "unknown"], ["MKMN", process.env.MKMN_APP_VERSION ?? "unknown"], ...power];
    },
    emit: (s: BenchState) => {
      emitEvent("bench", s);
      // A benchmark is work the app is doing on the NPU: the Rust monitor must keep
      // sampling over it (a hidden window must not send it to sleep). Only transitions
      // are sent, and the clear is reached on every end — done, stopped or an error.
      if (s.running !== benchFlagOn) { benchFlagOn = s.running; setHostBenchmarking(s.running); }
    }
  });
  return bench;
}

/** The runtime lease of the running benchmark (held from before its preparations until the run has ended). */
let benchLease: { release(): void } | null = null;

/**
 * Only the STANDARD models are benchmarked: the GenieX models of the built-in catalog
 * (the AI Hub store), the Dynamic packs' models, and the models of Microsoft Foundry
 * Local. What a user resolved from Hugging Face, Docker or ModelScope, and the old
 * "Specialists" list of hand-picked HF repos, never enter the run: the benchmark
 * compares the store offerings, not everything the app can load.
 */
async function benchRosterAll() {
  return buildRoster(DYNAMIC_DATA, standardBenchEntries(allEntries()), 7, 9.5, []);
}

async function startBench(cfg: BenchConfig): Promise<{ ok: boolean; error?: string }> {
  const run = benchRunner();
  if (run.running) return { ok: false, error: "A benchmark is already running." };
  if (chatCount() > 0) return { ok: false, error: "A chat is answering. Wait for it to finish: the NPU holds one model." };
  if (!cfg.keys.length) return { ok: false, error: "Tick at least one model." };
  if (!benchLease) {
    benchLease = runtimeLease.acquire("bench", "Benchmark run");
    if (!benchLease) return { ok: false, error: "The NPU is busy with another task. Wait for it to finish, or stop it first." };
  }
  try {
    await probeLogArgs();
    run.start(cfg, await benchRosterAll());
    for (const l of serveHelp) run.note(l);
  } finally {
    // nothing was started (an error in the preparation, or no model resolved): the lease must not stick
    if (!run.running) { benchLease.release(); benchLease = null; }
  }
  return { ok: true };
}

registerBench(dispatcher, { benchRunner, currentBench: () => bench, startBench, benchRoot, benchRosterAll, foundryHost, allEntries, isFoundryEntry, geniexExe, write });

// Open the edited copy of an Edit-a-copy run with its default app (the
// "Open edited copy" button). The person just saw the path in the interface;
// the sidecar has no shell, so the host starts the app.
dispatcher.register("openEditedCopy", async (target: string) => {
  if (typeof target !== "string" || !target) return false;
  try { await dispatcher.callHost((m) => { void write(m); }, "openEditedCopy", [target], 15_000); return true; } catch { return false; }
});

// ---- adaptive compute status (what the last request selected, and why)

dispatcher.register("adaptiveStatus", () => {
  const s = settings();
  return {
    mode: s.computeMode === "auto" ? "auto" : "manual",
    goal: AUTO_GOALS.some((g) => g.id === s.autoGoal) ? s.autoGoal : "balanced",
    goals: AUTO_GOALS,
    last: lastAdaptive
      ? { ...lastAdaptive.selection, at: lastAdaptive.at, entryId: lastAdaptive.entryId, goal: lastAdaptive.goal, label: describeSelection(lastAdaptive.selection) }
      : null,
    state: s.adaptiveState ?? null,
  };
});

registerFoundry(dispatcher, { foundryHost, foundryEntries, npuOwner });

// ---- What MKMN needs on the PC, and installing a missing one from the internet (src/core/requirements.ts)

dispatcher.register("requirements", async () => checkRequirements({
  run: (exe, args, t) => run(exe === "foundry" ? (findFoundry(process.env, (p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? "foundry") : exe, args, t),
  geniex: () => findGeniex(settings().geniexPath ?? null),
  geniexGate: () => { geniexGate.reset(); return geniexGate.check(); },
  chatModels: async () => {
    const exe = findGeniex(settings().geniexPath ?? null);
    const geniexCount = exe ? await listInstalled(exe).then((l) => l.length).catch(() => null) : null;
    // Foundry Local's chat builds only: the Models list's entries leave out its speech and embedding models
    const foundry = await foundryHost().then((f) => (f ? foundryEntries() : null)).catch(() => null);
    return installedChatModels(geniexCount, foundry);
  },
  voiceRuntime: () => { try { require.resolve("sherpa-onnx-node"); return true; } catch { return false; } },
  python: () => { const p = findPython(); return p ? [p.cmd, ...p.args.filter((a) => a !== "-u")].join(" ") : null; },
  office: findOfficeSuite,
  platform: process.platform
}));

dispatcher.register("installRequirement", async (a: { id?: unknown }) => {
  const r = await installRequirement(String(a?.id ?? ""), { run });
  // what was found missing before is looked for again next time
  if (r.ok) { pythonFound = undefined; foundryHostCache = null; }
  return r;
});

// Updates of what is already installed: winget's own list for its packages, and for GenieX the installer's
// publish date against the installed file (its update goes through the signed setup install, never `geniex update`).
dispatcher.register("requirementUpdates", async () => {
  const winget = await checkUpdates({ run });
  let geniex: { installed: string | null; newer: boolean | null } = { installed: null, newer: null };
  const exe = findGeniex(settings().geniexPath ?? null);
  if (exe) {
    let installedAt: Date | null = null;
    try { installedAt = fs.statSync(exe).mtime; } catch { /* unreadable: unknown */ }
    const installed = await geniexVersion(exe).catch(() => null);
    // Qualcomm's release index names the latest stable version: compared with the installed one, it decides;
    // the installer's publish date is only the fallback when the index cannot be read
    const index = await fetchGeniexIndex();
    const byVersion = geniexReleaseNewer(index?.latestStable ?? null, installed);
    if (byVersion !== null) geniex = { installed, newer: byVersion };
    else {
      const head = await fetch(GENIEX_INSTALLER_URL, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).catch(() => null);
      geniex = { installed, newer: geniexInstallerNewer(head?.ok ? head.headers.get("last-modified") : null, installedAt) };
    }
  }
  return { ...winget, geniex };
});

dispatcher.register("updateRequirement", async (a: { id?: unknown; pkg?: unknown }) => {
  const r = await updateRequirement(String(a?.id ?? ""), String(a?.pkg ?? ""), { run });
  if (r.ok) { pythonFound = undefined; foundryHostCache = null; }
  return r;
});

// ---- the NPU load test (Developer settings): the settings that make a model load, tried in order

interface NpuTestState { running: boolean; lines: string[]; results: LoadAttempt[] }
let npuTest: NpuTestState = { running: false, lines: [], results: [] };
let npuTestAc: AbortController | null = null;

dispatcher.register("npuTestState", () => npuTest);

dispatcher.register("npuTestRoster", async () => {
  const failed = new Set((benchRunner().state().rows ?? []).filter((r) => r.skipReason === "did not load").map((r) => r.name.toLowerCase()));
  const installed = await installedEntries().catch(() => [] as CatalogEntry[]);
  return installed
    .filter((e) => !isDynamicId(e.id))
    .map((e) => ({ id: e.id, name: e.name, sizeGB: e.sizeGB, failedBefore: failed.has(e.name.toLowerCase()) }))
    .sort((a, b) => Number(b.failedBefore) - Number(a.failedBefore) || b.sizeGB - a.sizeGB);
});

async function startNpuTest(entries: CatalogEntry[], o: { all: boolean; hybrid: boolean; onSetting?: (e: CatalogEntry, s: LoadSetting) => void }): Promise<{ ok: boolean; error?: string; done?: Promise<LoadAttempt[]> }> {
  if (npuTest.running) return { ok: false, error: "The test is already running." };
  if (bench?.running) return { ok: false, error: "A benchmark is using the NPU. Stop it first." };
  if (chatCount() > 0) return { ok: false, error: "A chat is answering. Wait for it to finish: the NPU holds one model." };
  // GenieX missing, older than the minimum, or with no valid version: the test is refused with what was found and what is needed
  const gate = await geniexGate.check();
  if (gate.state !== "ok") return { ok: false, error: gate.message };
  const lease = runtimeLease.acquire("test", "NPU load test");
  if (!lease) return { ok: false, error: "The NPU is busy with another task. Wait for it to finish, or stop it first." };
  await probeLogArgs().catch(() => undefined);
  const ac = new AbortController();
  npuTestAc = ac;
  const lines: string[] = [];
  const pushState = (p: Partial<NpuTestState>) => { npuTest = { ...npuTest, ...p }; emitEvent("npuTest", npuTest); };
  const log = (l: string) => { lines.push(l); if (lines.length > 3000) lines.splice(0, 500); pushState({ lines: [...lines] }); };
  pushState({ running: true, lines: [], results: [] });
  const hw = await chatHardware();
  log(`NPU load test, ${new Date().toLocaleString()}`);
  log(`Machine: ${hw.chipName} · ${hw.ramGB} GB RAM · NPU driver ${hw.npuDriverVersion ?? "unknown"} · NPU memory limit ${hw.npuBudgetGB.toFixed(1)} GB (${hw.npuBudgetSource}) · GenieX ${(await geniexVersion(geniexExe()).catch(() => null)) ?? "unknown"} · MKMN ${process.env.MKMN_APP_VERSION ?? "unknown"}`);
  log(`Server debug log: not available in this build (the server belongs to the Rust host)`);
  for (const l of serveHelp) log(l);
  log(`RAM: ${(os.freemem() / 1024 ** 3).toFixed(1)} GB free of ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB${os.freemem() / os.totalmem() < 0.1 ? ". WARNING: the RAM is almost full, and the NPU works in the RAM: models will fail to load whatever the setting. Close apps or restart the PC first." : ""}`);
  // a native NPU bundle has no window or sessions to choose: it is tried as it is.
  // Settings that are only environment variables cannot be started from here (the host does
  // not set env on geniex.exe): they are named, and skipped.
  const runnable = (s: LoadSetting) => s.id === "default" || !!s.compute;
  const settingsFor = (e: CatalogEntry) => {
    const all = e.engine === "llama_cpp" ? [LOAD_SETTINGS[0], ...ladder(o.hybrid)] : [LOAD_SETTINGS[0]];
    for (const s of all) if (!runnable(s)) log(`- ${s.label}: skipped, it is set with environment variables this build cannot pass to the server.`);
    return all.filter(runnable);
  };
  const done = runLoadTest({
    attempt: async (e, s) => {
      o.onSetting?.(e, s);
      // Stop interrupts the start too (it can take minutes): the wait ends at once and the
      // test's own cleanup stops the server.
      const srv = await raceAbort(ensureServer(e, { setting: s, force: true }), ac.signal);
      const nctx = e.recommendedContext;
      const limit = () => AbortSignal.any([ac.signal, AbortSignal.timeout(180_000)]);
      await collect(sidecarHost, e, srv, [{ role: "user", content: "Say OK." }], `npu-test:${Date.now()}`, limit(), "off");
      // a real prompt: a model can load, say one word, and still stop the NPU on the first long prompt
      const real = await collect(sidecarHost, e, srv, [{ role: "user", content: prefillPrompt(nctx) }], `npu-test:${Date.now()}`, limit(), "off");
      if (looksGarbled(real)) throw new Error("the model loaded but answered with garbage on a real prompt");
      return { nctx };
    },
    stopServer: stopServerHost,
    probe: async () => { const r = await readNpu(); return { util: r.util, memGB: npuMemGB(r) }; },
    serverLog: () => [],
    describe: describeEntry,
    remember: rememberLoadSetting,
    log
  }, entries, { all: o.all, settings: entries.length === 1 ? settingsFor(entries[0]) : [LOAD_SETTINGS[0], ...ladder(o.hybrid)].filter(runnable), signal: ac.signal })
    .then((results) => { pushState({ results }); return results; })
    .catch((e) => { log(`Stopped by an error: ${(e as Error).message}`); return [] as LoadAttempt[]; })
    .finally(() => { lease.release(); npuTestAc = null; void stopServerHost(); pushState({ running: false }); });
  return { ok: true, done };
}

dispatcher.register("npuTestStart", async (ids: string[], all: boolean, hybrid: boolean) => {
  if (Array.isArray(ids) && ids.length > 3) return { ok: false, error: "Pick at most 3 models: the log stays readable, and each model takes a few minutes." };
  const entries = (Array.isArray(ids) ? ids : []).flatMap((id) => entryById(String(id)) ?? []);
  if (!entries.length) return { ok: false, error: "Tick at least one model." };
  const r = await startNpuTest(entries, { all: !!all, hybrid: !!hybrid });
  return { ok: r.ok, error: r.error };
});

dispatcher.register("npuTestStop", () => { npuTestAc?.abort(); });

// ---- the NPU reset (Developer settings): the UAC-prompted device restart, as the desktop build
// runs it. The model server is put down first, through the host. The *automatic* reset stays
// out (the desktop build's own canAutoReset answers false as well).

async function resetNpuHost(o: { interactive?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "win32") return { ok: false, message: "Only on Windows." };
  await stopServerHost();
  if (!o.interactive) return { ok: true, message: "Inference server stopped." };
  // The command is built in core (tests/npu-reset-command.test.ts parses it): the
  // elevated script travels encoded and reports no-device and failed restarts honestly.
  const code = (await ps(npuResetLaunchCommand(), 60000).catch((e) => `error ${(e as Error).message}`)).trim();
  return npuResetOutcome(code);
}

dispatcher.register("npuReset", () => resetNpuHost({ interactive: true }));

dispatcher.register("npuResetStatus", () => ({ ready: process.platform === "win32", auto: false }));

// ---- battery (Developer settings, and the benchmark's energy rows elsewhere)

// The battery panel's readings: the host's native IOCTLs (fast), the WMI script only as a fallback.
dispatcher.register("batteryRead", () => readBatteryOnce());

// ---- the prompt lab: a Markdown file of prompts with their ideal answers, asked of the models picked, scored

let labRunner: LabRunner | null = null;
let labLease: { release(): void } | null = null;
const labServed = new Map<string, { entry: CatalogEntry; srv: Served }>();

function lab(): LabRunner {
  if (labRunner) return labRunner;
  labRunner = new LabRunner({
    prepare: async (m, signal) => {
      const entry = entryById(m.id);
      if (!entry) throw new Error("the app does not know this model");
      if (signal.aborted) throw new Error("stopped");
      const srv = await ensureServer(entry);
      lastLoadedEntry = entry;
      labServed.set(m.id, { entry, srv });
    },
    ask: async (m, system, prompt, o, signal) => {
      const got = labServed.get(m.id);
      if (!got) throw new Error("the model is not loaded");
      const { entry, srv } = got;
      const support = thinkingSupport(entry);
      const effort = o.thinking === "default" ? null : effectiveEffort(o.thinking === "on" ? "high" : "off", support);
      const msgs: ChatMessage[] = [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user" as const, content: prompt }];
      const e = applyEffort(effort, msgs, entry);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => ac.abort(), 10 * 60_000);
      const t0 = performance.now();
      let text: string, tokens: number | null;
      try {
        // the gateway: identity on the system prompt, the 45 s stall window, usage charged per call
        const a = await new Gateway().ask({
          endpoint: srv.endpoint || DEFAULT_ENDPOINT, model: srv.model ?? entryRef(entry), messages: e.messages,
          sampling: o.greedy ? routerSampling(o.maxTokens) : { ...entry.sampling, max_tokens: o.maxTokens, ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) },
          signal: ac.signal, body: e.body, thinkOpen: support === "always", nctx: srv.status().nctx ?? 4096, maxContinues: 0
        });
        text = a.text;
        tokens = a.stats?.tokens ?? null;
      } catch (err) {
        if (signal.aborted) throw new Error("stopped", { cause: err });
        if (ac.signal.aborted) throw new Error("no answer after 10 minutes", { cause: err });
        throw err;
      } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
      return { answer: text.replace(new RegExp("<" + "think[\\s\\S]*?(?:<[/]think>|$)", "g"), "").trim(), seconds: Math.round(((performance.now() - t0) / 1000) * 10) / 10, tokens };
    },
    emit: (s) => {
      if (!s.running) {
        labLease?.release();
        labLease = null;
      }
      emitEvent("lab", s);
    }
  });
  return labRunner;
}

dispatcher.register("labStart", (o: { md: string; modelIds: string[] }) => {
  if (bench?.running) return { ok: false, error: "A benchmark is running. Stop it first." };
  if (chatCount() > 0) return { ok: false, error: "A chat is answering. Wait for it to finish: the NPU holds one model." };
  if (typeof o?.md !== "string" || o.md.length > 2_000_000) return { ok: false, error: "The file could not be read." };
  const models: LabModel[] = ((o.modelIds ?? []) as string[]).flatMap((id) => { const e = entryById(String(id)); return e ? [{ id: e.id, name: e.name }] : []; });
  const file = parseLabFile(o.md);
  const lease = runtimeLease.acquire("test", "Prompt Lab");
  if (!lease) return { ok: false, error: "A model task is running. Wait for it to finish, then retry." };
  labLease = lease;
  const result = lab().start(file, models);
  if (!result.ok) {
    lease.release();
    labLease = null;
  }
  return result;
});

dispatcher.register("labStop", () => { labRunner?.stop(); return true; });

dispatcher.register("labState", () => lab().state());

// ---- a model the app does not know, installed: one load test gives it its badge (event `modelCheck`)

function isUnknownModel(entry: CatalogEntry): boolean {
  if (CATALOG.some((c) => c.id === entry.id)) return false;
  // the registered machine modelVerdict: a model with a verdict here (it loads, or it does not) is not unknown
  if (verdictOf(entryRef(entry), settings()) !== "unknown") return false;
  return !Object.values(DYNAMIC_DATA.packs).some((p) => packParts(p).some((m) => installedOf(m, [entry])));
}

async function checkNewModel(entry: CatalogEntry): Promise<void> {
  if (!isUnknownModel(entry)) return;
  const r = entryRef(entry);
  const say = (phase: "testing" | "done" | "failed", step?: string) => emitEvent("modelCheck", { ref: r, phase, step, badge: settings().placements?.[r] });
  say("testing", "Starting");
  const t = await startNpuTest([entry], { all: false, hybrid: true, onSetting: (_e, s) => say("testing", s.label) });
  if (!t.ok) { say("failed", t.error); return; }
  await t.done;
  // the check ends with the registered machine modelVerdict's own event: only a load GenieX really tried is judged
  let nameError: string | null = null;
  try { resolveServeRefFor(entry, await installedRefsTTL()); } catch (e) { nameError = (e as Error).message; }
  const verdict = nextState("modelVerdict", "checking", checkOutcome({ placed: !!settings().placements?.[r], nameError }));
  if (verdict === "loads") { say("done"); return; }
  if (verdict === "fails") {
    const reason = String(serverLastError?.raw ?? serverLastError?.title ?? "no load setting loaded it on this PC");
    saveSettings({ loadFailures: withLoadFailure(settings().loadFailures, r, reason, await geniexVersionTag(), new Date().toISOString()) });
  } else console.error(`[sidecar] unknown-model check: ${entry.name} was not recorded as failing, GenieX was never asked to load it: ${nameError}`);
  say("failed");
}

// A model the app does not know but that is ALREADY installed (imported outside the
// app) only ever got its badge when the app itself installed it. At startup —
// deferred, one at a time, never over a busy NPU — the same load test is offered to
// every installed unknown model. The placement guard makes it once per model, ever,
// which only holds since the saveSettings host fix persists placements at all.
const unknownModelCheck = startUnknownModelCheck({
  installedEntries,
  isUnknown: isUnknownModel,
  check: (entry) => checkNewModel(entry),
  busy: () => npuInUse({ chats: chatCount(), benchRunning: !!bench?.running, npuTestRunning: npuTest.running, leaseBusy: runtimeLease.isBusy(), agentRuns: agentRuns.size }),
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  initialDelayMs: 20_000,
  log: (line) => console.log(`[sidecar] unknown-model check: ${line}`),
});
dispatcher.register("unknownModelCheckState", () => unknownModelCheck.state());

// ---- sandbox (code, commands, sites) — pure Node, with the approval dialog and the shell
// asked of the host. The same runners the desktop build uses (src/core/runcode.ts), a temp
// folder per run, output streamed as `run` events, the process tree killed on stop.

const runs = new Map<string, { kill: () => void; write: (text: string) => void }>();
/** A run id names one run: a second run under the same id stops the first instead of orphaning it. */
function claimRun(runId: string, handle: { kill: () => void; write: (text: string) => void }): void {
  runs.get(runId)?.kill();
  runs.set(runId, handle);
}
/** A finished run removes only its own entry, never a newer run that took the same id. */
function releaseRun(runId: string, handle: unknown): void {
  if (runs.get(runId) === handle) runs.delete(runId);
}
const runDir = () => path.join(os.tmpdir(), "open-npu-run");

/** Ends a child and, on Windows, everything it started (a shell command leaves its program running otherwise). */
function killTree(c: import("child_process").ChildProcess | null): void {
  if (!c?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
  else c.kill();
}

/** The host's yes/no dialog: true only when the user approved. */
async function confirmRun(title: string, message: string, detail: string, okLabel: string): Promise<boolean> {
  try {
    const r = await dispatcher.callHost((m) => { void write(m); }, "confirmRun", [title, message, detail, okLabel], 600_000);
    return r === true;
  } catch { return false; } // no host to ask (a smoke driver, a headless run): nothing runs
}

let pythonFound: { cmd: string; args: string[] } | null | undefined;
/** The Python this PC would run a program with (first that answers --version), found once. */
function findPython(): { cmd: string; args: string[] } | null {
  if (pythonFound !== undefined) return pythonFound;
  pythonFound = null;
  for (const p of runnerFor("python", process.platform)!.programs) {
    if (spawnSync(p.cmd, [...p.args.filter((a) => a !== "-u"), "--version"], { windowsHide: true }).status === 0) { pythonFound = p; break; }
  }
  return pythonFound;
}

/** The terminal: a command typed by the user (pip install, dir, python -m ...) runs in the same folder and with the same Python as the programs. */
function startCommand(runId: string, command: string): void {
  const out = (text: string) => emitEvent("run", { runId, type: "out", text } satisfies RunEvent);
  const dir = runDir();
  fs.mkdirSync(dir, { recursive: true });
  const py = findPython();
  const line = py ? withPip(command, py) : command;
  out(`> ${line}\n`);
  let stopped = false;
  const c = spawn(line, { shell: true, cwd: dir, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
  c.stdout?.on("data", (d) => out(String(d)));
  c.stderr?.on("data", (d) => out(String(d)));
  const finish = (exit: Extract<RunEvent, { type: "exit" }>) => { clearTimeout(timer); releaseRun(runId, handle); emitEvent("run", exit); };
  const timer = setTimeout(() => { out("\n[stopped: it ran for 30 minutes]\n"); handle.kill(); }, 30 * 60_000);
  c.on("error", (e) => finish({ runId, type: "exit", code: null, stopped, error: e.message }));
  c.on("close", (code) => finish({ runId, type: "exit", code, stopped }));
  const handle = { kill: () => { stopped = true; killTree(c); }, write: (t: string) => { out(`${t}\n`); c.stdin?.write(`${t}\n`); } };
  claimRun(runId, handle);
}

/** Runs a code artifact the user chose to run, in a temp file, streaming what it prints. A window it opens (turtle, tkinter) shows as usual. */
function startRun(runId: string, language: string, code: string): void {
  const out = (text: string) => emitEvent("run", { runId, type: "out", text } satisfies RunEvent);
  const runner = runnerFor(language, process.platform);
  if (!runner) { emitEvent("run", { runId, type: "exit", code: null, stopped: false, error: `${language} cannot be run here.` } satisfies RunEvent); return; }
  const dir = runDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(runId).replace(/[^\w-]/g, "").slice(0, 40)}-${randomUUID()}.${runner.ext}`);
  // a new file only this user can read: "wx" never writes through a file or link someone else placed at the name
  fs.writeFileSync(file, code, { flag: "wx", mode: 0o600 });
  let stopped = false;
  let child: import("child_process").ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined = undefined;
  const finish = (exit: Extract<RunEvent, { type: "exit" }>) => {
    if (timer) clearTimeout(timer);
    releaseRun(runId, handle);
    fs.rm(file, { force: true }, () => undefined);
    emitEvent("run", exit);
  };
  const attempt = (i: number) => {
    const p = runner.programs[i];
    // this process already is plain node: a JavaScript runner needs no ELECTRON_RUN_AS_NODE
    const c = spawn(p.asNode ? process.execPath : p.cmd, [...p.args, file], { cwd: dir, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" } });
    child = c;
    c.stdout?.on("data", (d) => out(String(d)));
    c.stderr?.on("data", (d) => out(String(d)));
    c.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" && i + 1 < runner.programs.length) return attempt(i + 1);
      finish({ runId, type: "exit", code: null, stopped, error: e.code === "ENOENT" ? `${runner.label} is not installed (or not on the PATH), so this cannot run.` : e.message });
    });
    c.on("close", (code) => finish({ runId, type: "exit", code, stopped }));
  };
  const handle = { kill: () => { stopped = true; killTree(child); }, write: (t: string) => { out(`${t}\n`); child?.stdin?.write(`${t}\n`); } };
  claimRun(runId, handle);
  timer = setTimeout(() => { out("\n[stopped: it ran for 10 minutes]\n"); handle.kill(); }, 10 * 60_000);
  attempt(0);
}

dispatcher.register("runCode", async (runId: string, language: string, code: string) => {
  // The prompt shows what it authorizes: whole when it fits, else it says how much (approval.ts).
  const shown = approvalBody("code", String(code));
  const ok = shown.ok && await confirmRun(
    "MKMN — approve code execution",
    `Run this ${runnerFor(String(language), process.platform)?.label ?? "code"} code on your computer?`,
    `This runs with your user permissions and may read or change files or access the network. Review the complete code in MKMN before approving.\n\n${shown.text}`,
    "Run code"
  );
  if (!ok) { emitEvent("run", { runId: String(runId), type: "exit", code: null, stopped: true } satisfies RunEvent); return; }
  startRun(String(runId), String(language), String(code));
});

dispatcher.register("runCommand", async (runId: string, command: string) => {
  // A command too long to show whole is refused, never approved half-seen (approval.ts).
  const shown = approvalBody("command", String(command));
  if (!shown.ok) { emitEvent("run", { runId: String(runId), type: "exit", code: null, stopped: true, error: shown.reason } satisfies RunEvent); return; }
  const ok = await confirmRun(
    "MKMN — approve command execution",
    "Run this command with your user permissions?",
    `Commands can read or change files and access the network. Only approve a command you understand.\n\n${shown.text}`,
    "Run command"
  );
  if (!ok) { emitEvent("run", { runId: String(runId), type: "exit", code: null, stopped: true } satisfies RunEvent); return; }
  startCommand(String(runId), String(command));
});

dispatcher.register("writeRun", (runId: string, text: string) => { runs.get(String(runId))?.write(String(text)); });

dispatcher.register("stopRun", (runId: string) => { runs.get(String(runId))?.kill(); });

// ---- Computer Use: the person's one granted window, driven one accessibility
// step at a time (computerUse.ts). The loop is here because it is the sidecar's
// NPU-first model path that proposes; every driver call is a roundtrip to the
// Tauri host, which owns the pinned agent-desktop binary and validates the
// window grant on every call. The sidecar never sees a process or a handle.

/** The runs being driven, so the panel's Stop and the app shutdown abort them. */
const agentRuns = new Map<string, AbortController>();

/** One host capability call: the ONLY route the loop's driver has anywhere. */
function agentCallHost<T>(method: string, args: unknown[], timeoutMs = 10_000): Promise<T> {
  return dispatcher.callHost((m) => { void write(m); }, method, args, timeoutMs) as Promise<T>;
}

const agentDriver: AgentDriver = {
  observe: (hwnd, maxNodes) => agentCallHost("agentObserve", [hwnd, maxNodes]),
  act: (hwnd, action) => agentCallHost("agentAct", [hwnd, action]),
  endRun: () => agentCallHost("agentEndRun", [], 15_000),
};

/**
 * The review gate of Edit a copy: the run emits its proposed change and stops
 * here until the person answers in the interface. The resolver is registered
 * per run (never per panel) and consumed exactly once; a Stop aborts the
 * waitFor instead, so a stopped run never waits on an answer that will not
 * come.
 */
const docEditReviews = new Map<string, (ok: boolean) => void>();

registerAgent(dispatcher, { agentRuns, docEditReviews, runAgent, runDocEditAgent });

/** The sidecar's own fs, as the loop's DocEditFs sees it. */
const docEditFs: DocEditFs = {
  readFile: (p) => fs.promises.readFile(p),
  writeFile: (p, b) => fs.promises.writeFile(p, b),
  rename: (a, b) => fs.promises.rename(a, b),
  hash: async (p) => createHash("sha256").update(await fs.promises.readFile(p)).digest("hex"),
  exists: async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } },
  unlink: async (p) => { try { await fs.promises.unlink(p); } catch { /* already gone */ } },
};

async function runDocEditAgent(runId: string, sourcePath: string, task: string, modelId: string) {
  if (!sourcePath.trim() || !task.trim()) {
    emitEvent("agentRun", { runId, status: "failed", step: 0, phase: "settled", line: "Failed: the run was asked without a document or a task.", actions: [], at: Date.now() } satisfies AgentRunEvent);
    return;
  }
  const emit = (ev: AgentRunEvent) => {
    emitEvent("agentRun", ev);
    if (ev.status !== "running") agentRuns.delete(runId);
  };
  const ac = new AbortController();
  agentRuns.set(runId, ac);
  emit({ runId, status: "running", step: 0, phase: "observe", line: "Starting the run.", actions: [], at: Date.now() });
  // The NPU belongs to an open chat turn first: without its lease the run
  // refuses instead of competing (the same rule the window run keeps).
  const ok = await withChatSideLease(`Edit a copy: ${task.slice(0, 40)}`, async () => {
    const entry = entryById(modelId) ?? lastLoadedEntry;
    if (!entry) { emit({ runId, status: "failed", step: 0, phase: "settled", line: "Failed: pick a model first.", actions: [], at: Date.now() }); return; }
    const srv = await ensureServer(entry);
    lastLoadedEntry = entry;
    const model: AgentModel = {
      propose: (messages, signal) => collect(sidecarHost, entry, srv, messages, `agent:${runId}`, signal, "off"),
    };
    // Stop while the gate stands open (or before it opens): the wait ends at
    // once and the loop settles cancelled with "nothing was written".
    const review = { waitFor: (id: string, signal: AbortSignal) => reviewWait(docEditReviews, id, signal) };
    try {
      await runDocEdit({ runId, sourcePath, task, fs: docEditFs, model, review, emit, signal: ac.signal });
    } catch (e) {
      // The loop's own settle covers every expected fault; an unexpected throw
      // must still end the run with a terminal event, never leave the panel
      // waiting on a run that is already dead.
      if (!ac.signal.aborted) {
        emit({ runId, status: "failed", step: 0, phase: "settled", line: `Failed: the run stopped unexpectedly: ${String((e as Error)?.message ?? e).slice(0, 200)}.`, actions: [], at: Date.now() } satisfies AgentRunEvent);
      }
    }
  });
  if (ok === null) {
    emit({ runId, status: "failed", step: 0, phase: "settled", line: "Failed: the NPU is busy with another task. Wait for it to finish.", actions: [], at: Date.now() });
  }
}

async function runAgent(runId: string, hwnd: number, task: string, modelId: string) {
  if (!Number.isFinite(hwnd) || hwnd === 0 || !task.trim()) {
    emitEvent("agentRun", { runId, status: "failed", step: 0, phase: "settled", line: "Failed: the run was asked without a window or a task.", actions: [], at: Date.now() } satisfies AgentRunEvent);
    return;
  }
  const emit = (ev: AgentRunEvent) => {
    emitEvent("agentRun", ev);
    if (ev.status !== "running") agentRuns.delete(runId);
  };
  const ac = new AbortController();
  agentRuns.set(runId, ac);
  emit({ runId, status: "running", step: 0, phase: "observe", line: "Starting the run.", actions: [], at: Date.now() });
  // The NPU belongs to an open chat turn first: without its lease the run
  // refuses instead of competing (the same rule a summary keeps).
  const ok = await withChatSideLease(`Computer Use: ${task.slice(0, 40)}`, async () => {
    const entry = entryById(modelId) ?? lastLoadedEntry;
    if (!entry) { emit({ runId, status: "failed", step: 0, phase: "settled", line: "Failed: pick a model first.", actions: [], at: Date.now() }); return; }
    const srv = await ensureServer(entry);
    lastLoadedEntry = entry;
    const model: AgentModel = {
      propose: (messages, signal) => collect(sidecarHost, entry, srv, messages, `agent:${runId}`, signal, "off"),
    };
    try {
      await runAgentLoop({ runId, hwnd, task, driver: agentDriver, model, emit, signal: ac.signal });
    } catch (e) {
      // The loop's own settle covers every expected fault; an unexpected throw
      // must still end the run with a terminal event, never leave the panel
      // waiting on a run that is already dead (the grant was released by the
      // loop's finally).
      if (!ac.signal.aborted) {
        emit({ runId, status: "failed", step: 0, phase: "settled", line: `Failed: the run stopped unexpectedly: ${String((e as Error)?.message ?? e).slice(0, 200)}.`, actions: [], at: Date.now() } satisfies AgentRunEvent);
      }
    }
    // The loop's verdict was already streamed; nothing further is forwarded —
    // the panel's transcript is the run's record.
  });
  if (ok === null) {
    emit({ runId, status: "failed", step: 0, phase: "settled", line: "Failed: the NPU is busy with another task. Wait for it to finish.", actions: [], at: Date.now() });
  }
}

// ---- shutdown (the host's exit path): one cooperative cleanup, then the host kills
// the process. The Rust host calls this with a short grace period before killing the
// sidecar; after the response the stdio loop exits on its own (closing + no work).
dispatcher.register("appShutdown", () => {
  // Refuse further requests: the UI is going away, nothing new can be served.
  closing = true;
  try { bench?.stop(); } catch { /* already stopped */ }
  // Tool runs: children and their process trees (a shell command leaves its
  // program running otherwise).
  for (const r of runs.values()) { try { r.kill(); } catch { /* already exited */ } }
  runs.clear();
  // Voice: cancel in-flight model downloads and stop the worker (its pending
  // transcribe/speak calls reject with "The voice engine stopped").
  try { voice.cancelAllDownloads(); } catch { /* no downloads */ }
  void voice.stop().catch(() => undefined);
  // Computer Use runs: abort the loop (its finally clears the window grant on
  // the host); the person's stop settles cancelled, never failed.
  for (const c of agentRuns.values()) { try { c.abort(); } catch { /* already aborted */ } }
  agentRuns.clear();
  return { ok: true, closing: true };
});

dispatcher.register("launchSite", (files: { title: string; kind: string; language: string; content: string }[], entry: { title: string; kind: string; language: string; content: string }) =>
  launchSite(files, entry, (m, a, t) => dispatcher.callHost((msg) => { void write(msg); }, m, a, t)));

// ---- media (the pictures of a conversation, written under this process's data folder)

const MEDIA_DIR = dataFile("media");

registerKnowledge(dispatcher);

dispatcher.register("saveMedia", (dataUrl: string) => {
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === "string" ? dataUrl : "");
  if (!match) return { mediaId: "", path: "" };
  const bytes = Buffer.from(match[2], "base64");
  // a picture is capped like one attached in the window: never write an unbounded blob from the renderer
  if (!bytes.length || bytes.length > 32 * 1024 ** 2) return { mediaId: "", path: "" };
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const id = randomUUID();
  const ext = (match[1].split("/")[1] || "png").replace(/[^a-zA-Z0-9]/g, "") || "png";
  const filePath = path.join(MEDIA_DIR, `${id}.${ext}`);
  fs.writeFileSync(filePath, bytes);
  return { mediaId: id, path: filePath };
});

dispatcher.register("readMedia", (mediaId: string) => {
  // only a name this app wrote can be read: never a path from the renderer
  if (typeof mediaId !== "string" || !/^[a-f0-9-]{36}$/i.test(mediaId)) return null;
  try {
    const found = fs.readdirSync(MEDIA_DIR).find((f) => f.startsWith(`${mediaId}.`));
    if (!found) return null;
    const file = path.join(MEDIA_DIR, found);
    const read = readCapped(file, 32 * 1024 ** 2, () => new Error("too big"));
    if (!read || !read.st.isFile()) return null;
    const ext = found.slice(found.lastIndexOf(".") + 1).toLowerCase();
    const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" } as Record<string, string>)[ext] ?? "image/png";
    return { dataUrl: `data:${mime};base64,${read.buf.toString("base64")}` };
  } catch { return null; }
});

// ---- scheduled tasks: the same JsonStore + Scheduler the desktop build runs, over this
// process's own tasks.json. A run is a non-interactive chat; the artifacts it files go to
// the window as an `artifacts` event (the artifact store lives in the webview here).

const taskStore = new JsonStore<ScheduledTask>(dataFile("tasks.json"));

async function concreteEntry(id: string | null | undefined, biggest = false): Promise<CatalogEntry | null> {
  if (!id) return null;
  if (!isDynamicId(id)) return entryById(id) ?? null;
  const s = settings();
  const pack = mergedPack(DYNAMIC_DATA, tierOf(id), s.dynamic);
  if (!pack) return null;
  const installed = await installedEntries().catch(() => [] as CatalogEntry[]);
  if (biggest) return pack.models.flatMap((m) => { const e = installedOf(m, installed); return e ? [e] : []; }).sort((a, b) => (b.sizeGB ?? 0) - (a.sizeGB ?? 0))[0] ?? null;
  return pickModel(pack, "chat", installed, { loaded: lastLoadedEntry })?.entry ?? null;
}

async function runScheduledTask(task: ScheduledTask): Promise<{ status: "ok"; output: string; artifactIds: string[] }> {
  // the lease covers the preparations too (the model server is started below): a chat that starts while the entry
  // and the server are being worked out would otherwise race this task for the NPU
  const lease = runtimeLease.acquire("task", `Task ${task.name}`);
  if (!lease) throw new Error("NPU is currently busy with another task");
  try {
    const entry = await concreteEntry(task.modelId ?? settings().selectedModelId);
    if (!entry) throw new Error("No model selected. Pick one in Models.");
    const s = settings();
    const hw = await chatHardware();
    const ctx = scoreEntry(entry, hw).contextTokens || entry.recommendedContext;
    // The project context a chat gets: the renderer saves a snapshot of the project with
    // the task (the project store lives in the webview), so a scheduled run speaks with
    // the same instructions and knowledge instead of a bare prompt (project: null).
    // over the knowledge budget, the sections that match the task's prompt ride (the index
    // a chat searches), never the first bytes of the files cut off (taskKnowledge.ts)
    const project = task.project ? taskProjectView(task.project, knowledgeBudget(ctx), task.prompt, (p) => openKnowledgeIndex(knowledgeDirOf(), p.id, p.files)) : null;
    const system = buildSystemPrompt({ custom: composeInstructions(s, ctx), project, knowledgeChars: knowledgeBudget(ctx) });
    const srv = await ensureServer(entry);
    lastLoadedEntry = entry;
    const id = `task:${task.id}:${Date.now()}`;
    const ac = new AbortController();
    registerChat(id, ac);
    let answer = "";
    let run: LiveRun | null = null;
    try {
      const messages: ChatMessage[] = [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user", content: task.prompt }];
      // the task is a run: its one model call is a journaled step, its verdict is settle()'s
      run = createLiveRun({ pipeline: "task", runId: `task-${String(task.id).replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now().toString(36)}`, journalFile: process.env.VITEST ? null : undefined });
      const rec = await run.step({
        id: `${id}:answer`, kind: "model-call",
        input: { model: srv.model ?? entryRef(entry), messages: messages.length },
        schema: sString(), outputRetries: 0, transportRetries: 0,
        exec: async () => {
          // the gateway: identity on the system prompt (already in buildSystemPrompt, never doubled), the 45 s stall window
          const a = await new Gateway().ask({
            endpoint: srv.endpoint || DEFAULT_ENDPOINT, model: srv.model ?? entryRef(entry), messages,
            sampling: entry.sampling, signal: ac.signal, thinkOpen: thinkingSupport(entry) === "always"
          });
          return { output: a.text, reply: a.text, usage: a.usage };
        },
      });
      if (rec.status !== "ok") throw new Error(rec.error ?? "the task's model call did not settle ok");
      answer = rec.output as string;
    } finally {
      run?.finish(ac.signal.aborted ? "the task was stopped" : undefined);
      unregisterChat(id);
    }
    const now = Date.now();
    const artifacts: Artifact[] = artifactsIn(answer).map((a, i) => ({
      id: `task:${task.id}:${now}:${i}`, title: a.title, kind: a.kind, language: a.language, content: a.content,
      projectId: task.projectId, source: { type: "task", taskId: task.id }, created: now, updated: now
    }));
    // the artifact store lives in the webview: the bridge files these and refreshes the page
    if (artifacts.length) emitEvent("artifacts", artifacts);
    if (!answer.trim()) throw new Error("The model returned an empty answer.");
    void dispatcher.callHost((m) => { void write(m); }, "notify", [task.name, stripArtifacts(answer).slice(0, 160) || `${artifacts.length} file(s) created`], 15_000).catch(() => undefined);
    return { status: "ok" as const, output: answer, artifactIds: artifacts.map((a) => a.id) };
  } finally {
    lease.release();
  }
}

const scheduler = new Scheduler({
  store: taskStore,
  run: runScheduledTask,
  canRun: () => chatCount() === 0 && !bench?.running && !runtimeLease.isBusy(),
  onChange: (t) => emitEvent("tasks", t)
});
scheduler.start();

registerTasks(dispatcher, { taskStore, scheduler, benchRunning: () => !!bench?.running });

// ---- the stdio loop

let closing = false;
let outstanding = 0;
const maybeExit = () => { if (closing && outstanding === 0) process.exit(0); };

function main(): void {
  let buffered = "";
  process.stdin.setEncoding("utf8");
  // Foundry Local's catalog is discovered in the background (one CLI call): chat can
  // then resolve a foundry:<alias> id without waiting for the discovery.
  void foundryEntries().catch(() => undefined);
  // The router warms up in the background too (its own server on the processor), so the
  // first Dynamic request is already sorted by it. Every failure stays silent there and
  // the words' fallback decides, as designed.
  setTimeout(() => { try { warmRouter(); } catch { /* the words decide */ } }, 3_000);
  // The already-installed unknown models get their one load test (deferred inside;
  // headless --ask runs never reach main(), so they never trigger it).
  void unknownModelCheck.run().catch(() => undefined);
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      void handleLine(line);
    }
  });
  process.stdin.on("end", () => { closing = true; maybeExit(); });
  process.stdin.on("error", () => process.exit(1));
  process.on("uncaughtException", (e) => {
    try { process.stderr.write(`[sidecar] uncaught: ${(e && e.stack) || e}\n`); } catch { /* stderr gone */ }
  });
}

async function handleLine(line: string): Promise<void> {
  const m = decodeLine(line);
  if (!m) return;
  if (m.t === "req") {
    // Shutdown already started: answer every new request with a refusal instead of
    // spinning work up against an application that is going away.
    if (closing) {
      await write({ t: "res", id: m.id, ok: false, error: "MKMN is shutting down; this request was not started." });
      return;
    }
    outstanding++;
    try {
      await write(await dispatcher.respond(m));
    } finally {
      outstanding--;
      maybeExit();
    }
  } else if (m.t === "res") {
    dispatcher.resolveHostResponse(m);
  } else if (m.t === "event") {
    // events only travel from the sidecar outward; one from the host is meaningless
  }
}

// The one-shot CLI mode: `node main.js --ask "..."` runs ONE
// turn and exits; the protocol server (main()) is what runs otherwise. The argv
// is read exactly once, here.
if (process.argv.includes("--ask")) {
  headlessMode = true;
  const flush = (stream: NodeJS.WriteStream, s: string) => new Promise<void>((res) => stream.write(s, () => res()));
  void headlessAsk(
    process.argv.slice(2),
    sidecarHost,
    { out: (s) => flush(process.stdout, s), err: (s) => flush(process.stderr, s) },
    async () => { await foundryEntries().catch(() => undefined); }, // the catalog warm-up main() would have done
  ).then((code) => process.exit(code)).catch((e: unknown) => {
    process.stderr.write(`${(e as Error)?.message ?? String(e)}\n`, () => process.exit(1));
  });
} else {
  main();
}
