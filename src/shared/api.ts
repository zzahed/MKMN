import type { RequirementStatus, RequirementUpdate } from "../core/requirements";

/** What the update check found: winget's list for MKMN's packages, and GenieX (newer: null when it cannot be told). */
export interface RequirementUpdates { ok: boolean; message: string; updates: RequirementUpdate[]; geniex: { installed: string | null; newer: boolean | null } }
import type { SetupState, StepId } from "../core/setup";
import type { VersionAction, VersionList, VersionResult } from "../core/versionBook";
import type { FoundryAdminView, FoundryActionResult, FoundryModelInfo, FoundryRegisterInput, FoundryServerActionResult } from "../core/foundryHost";
import {
  SpeakChunk, VoiceDownloadProgress, VoiceModelView, VoiceNeed, VoiceSettings, VoiceStatus,
  BrowseQuery, BrowseResult, BrowseVariant, ResolveResult, CatalogEntry, ChatEvent, ChatMessage, ChatOptions, FriendlyError, HardwareProfile, HfSearchResult,
  InstallProgress, InstalledModel, Meters, ServerStatus, Settings, Verdict, Project, Artifact, ScheduledTask, RunEvent,
  MemoryEstimate, PowerStatusInfo, BenchmarkResult
} from "./types";
import type { AgentGrant, AgentRunEvent, DriverWindow } from "./agent";

export interface CatalogItem {
  entry: CatalogEntry;
  verdict: Verdict;
  hidden: boolean;
  installed: boolean;
  /** "<repo>:<quant>" argument for geniex. */
  ref: string;
  custom: boolean;
  /** Where this model was seen to run on this PC: all on the NPU, NPU and CPU together, or the CPU only. Unknown until it was tried. */
  runsOn?: "npu" | "hybrid" | "gpu" | "cpu";
}

export interface NpuPlanView {
  lines: { role: "chat" | "stt" | "tts"; name: string; onNpu: boolean; gb: number }[];
  budgetGB: number;
  usableGB: number;
  totalGB: number;
  fits: boolean;
  advice: string | null;
}

export interface UpdateState {
  status: "idle" | "checking" | "current" | "downloading" | "ready" | "error";
  version: string | null;
  percent: number | null;
  error: string | null;
  /** When the update server was last asked, and when this version was first run (epoch ms). */
  checkedAt: number | null;
  installedAt: number | null;
}

/** What the "where the model runs" selector shows: which targets this PC offers, the llama.cpp engine, and the resources the advanced options refer to. */
export interface RuntimeInfo {
  choices: { id: "npu" | "gpu" | "cpu"; available: boolean; note: string }[];
  /** Plain sentence about what the current choice does to memory. */
  note: string;
  llamaPath: string | null;
  llamaVersion: string | null;
  /** Whether this build offers llama.cpp at all: the Tauri build serves everything through
   * GenieX, so its install/locate controls must say so instead of doing nothing. */
  llamaAvailable: boolean;
  cpuName: string;
  cpuThreads: number;
  ramGB: number;
  gpus: { name: string; vramGB?: number | null }[];
  problems: string[];
}

export interface AppInfo {
  version: string;
  arch: string;
  platform: string;
  geniexPath: string | null;
  geniexVersion: string | null;
  geniexVersionWarning: string | null;
  problems: string[];
}

/** What the sidecar last decided per request, and the goals the selector offers. */
export interface AdaptiveStatusView {
  mode: "auto" | "manual";
  goal: "balanced" | "battery_saver" | "fastest";
  goals: { id: "balanced" | "battery_saver" | "fastest"; label: string; why: string }[];
  last: {
    config: { id: string; engine: string; compute: string; serveCompute: string } | null;
    reason: string[];
    provisional: boolean;
    gatedOut: { id: string; compute: string; why: string }[];
    at: number;
    entryId: string;
    goal: string;
    label: string;
  } | null;
  state: import("./types").Settings["adaptiveState"] | null;
}

/** The bridge exposed on window.mkmn by the preload script. */
export interface RouterStatus {
  model: string; sizeGB: number; installed: boolean; enabled: boolean; running: boolean;
  asked: number; lastMs: number | null; lastError: string | null;
  /** The server answering the router's asks (its compute is what it really runs on). */
  server?: { adopted: boolean; compute: string; nctx: number | null; state: string; pid: number | null } | null;
  /** Where the router runs: the CPU, or the GPU after the CPU proved too busy, with the reason. */
  placement?: { compute: "cpu" | "gpu"; reason: string | null };
}

/**
 * `Config/hardware.json` as stored: the hardware probe's raw result plus what the Rust
 * host persists there — `calibratedProfiles` holds the LOCAL single-model benchmark
 * measurements (one run per "<compute>|<powerMode>" per model ref), and `lastBenchmark`
 * the most recent result. The model cards read the local measurements from here.
 */
export interface HardwareConfigFile {
  calibratedProfiles?: Record<string, { runs?: Record<string, unknown>; [k: string]: unknown }>;
  lastBenchmark?: import("../shared/types").BenchmarkResult | null;
  [key: string]: unknown;
}

/** What starting the model server may ask for; anything left out comes from the settings. */
export interface PreloadRequest {
  model?: string;
  nctx?: number;
  compute?: import("../core/npuLoad").LoadSetting["compute"];
  vit_compute?: string;
  timeout_sec?: number;
  keepalive_sec?: number;
  strategy?: string;
  power_mode?: string;
  kv_type?: string;
  kv_in_ram?: boolean;
  ngl?: number;
  spec_type?: string;
  draft_model?: string;
  draft_tokens?: number;
  draft_min?: number;
  draft_p_min?: number;
  log_level?: string;
  port?: number;
  exe?: string;
  qairt_lib?: string;
  skip_update?: boolean;
}
/** What the Files & projects page shows of the multilingual search model. */
export interface VectorModelStatusView {
  installed: boolean;
  runtime: boolean;
  installing: boolean;
  bytes: number;
  label: string;
  error?: string;
  progress?: { done: number; of: number };
}

export interface MkmnApi {
  appInfo(): Promise<AppInfo>;
  hardware(refresh?: boolean): Promise<HardwareProfile>;
  /** One project's knowledge index state, observed from the store — the Project knowledge screen shows it with each file's sections, pages and scanned pages. While indexing, `progress` names how many files of how many are cut. */
  knowledgeStatus(projectId: string, filesHash: string): Promise<{ state: string; error?: string; fileIds: string[]; progress?: { done: number; of: number } } | null>;
  /** The project's index build, started by the Files panel's add/remove: runs in the sidecar's background through the same knowledgeIndex machine, so the FIRST chat already finds the index ready. Resolves when the build lands (ready, or failed with its reason). */
  knowledgeBuild(projectId: string, files: Array<{ id: string; name: string; content: string }>): Promise<{ state: string; count?: number; error?: string } | null>;
  /** The multilingual search model for project files: installed, being installed (bytes so far), its size, and the last install error. */
  vectorModelStatus(): Promise<VectorModelStatusView | null>;
  /** Downloads the model from its pinned source and checks each file's SHA-256 before anything is replaced; resolves when the install ends. */
  vectorModelInstall(): Promise<VectorModelStatusView | null>;
  /** Removes the model's files; retrieval goes back to keywords and the model-written rewrite. */
  vectorModelRemove(): Promise<VectorModelStatusView | null>;
  catalog(): Promise<CatalogItem[]>;
  installed(): Promise<InstalledModel[]>;
  /** The artifact manifest (what the cache holds, per its own metadata) and the per-device evidence records behind the evidence badges. */
  modelEvidence(): Promise<{ manifest: import("../core/manifest").ArtifactManifestEntry[]; records: import("../core/manifest").EvidenceRecord[] }>;
  /** The Dynamic model: its sizes, which model does which kind of task (with the developer's changes), what is known, and what is missing. */
  dynamicInfo(): Promise<{ data: import("../core/dynamic").DynamicData; speeds: Record<string, number>; profile: string; autoProfile: string; installedRefs: string[]; runsOn: Record<string, "npu" | "hybrid" | "gpu" | "cpu">; engines: Record<string, "geniex" | "foundry">; missing: Record<string, string[]> }>;
  /** The compiled window of every installed QAIRT pack artifact, keyed by canonical repo (read from each bundle's genie_config.json by the main process). Artifacts without evidence are absent — their context numbers are then estimates. */
  compiledContexts(): Promise<Record<string, number>>;
  /** Measured generation speeds by catalog id (chat EMA and benchmark evidence merged; only models timed on this machine appear). */
  speedsById(): Promise<Record<string, number>>;
  /** The memory configuration the Dynamic packs are shown for (16, 24 or 32 GB). */
  setDynamicProfile(id: string): Promise<void>;
  /** Installs the models of a Dynamic pack that are not there yet. Progress arrives through onDynamicInstall. */
  installDynamic(tier: string): Promise<void>;
  /** Installs one model of a pack (the voice chat model), not the whole pack. */
  installDynamicModel(tier: string, ref: string): Promise<void>;
  /** Removes every installed model of a Dynamic pack, in one go. */
  uninstallDynamic(tier: string): Promise<{ ok: boolean; removed: string[]; failed: string[] }>;
  onDynamicInstall(cb: (p: { tier: string; name: string; step: number; total: number; phase: "start" | "done" | "error"; error?: string }) => void): () => void;
  /** The benchmark (Developer settings): the models worth testing here, the number of tests, and where results are written. */
  benchRoster(): Promise<{ targets: (import("../core/bench").BenchTarget & { installed: boolean; tested: boolean })[]; tests: { launch: number; express: number; quick: number; full: number }; costs: Record<"launch" | "express" | "quick" | "full", import("../core/benchEstimate").TestCost[]>; freeGB: number | null; folder: string }>;
  benchState(): Promise<import("../core/benchRunner").BenchState>;
  benchStart(cfg: import("../core/benchRunner").BenchConfig): Promise<{ ok: boolean; error?: string }>;
  benchStop(): Promise<void>;
  /** The NPU load test (Developer settings): installed models (those that failed in a benchmark first), start, stop, and its log. */
  npuTestRoster(): Promise<{ id: string; name: string; sizeGB: number; failedBefore: boolean }[]>;
  npuTestState(): Promise<{ running: boolean; lines: string[]; results: import("../core/npuTest").LoadAttempt[] }>;
  npuTestStart(ids: string[], all: boolean, hybrid: boolean): Promise<{ ok: boolean; error?: string }>;
  npuTestStop(): Promise<void>;
  /** Stops geniex and restarts the NPU device node (Windows asks for permission): what a failed load can need, instead of restarting the PC. */
  npuReset(): Promise<{ ok: boolean; message: string }>;
  /** Whether the automatic reset was allowed (the one-time Windows permission) and is on. */
  /** The app found the NPU holding memory with nothing running and is resetting it before loading a model. */
  onNpuClean(cb: (p: { phase: "start" | "done"; gb?: number; ok?: boolean; message?: string }) => void): () => void;
  /** Microsoft Foundry Local, for the comparison page: installed or not, the models it shares with the benchmark (pairs), and what its commands said. */
  foundryStatus(): Promise<{ installed: boolean; version: string | null; source: "server" | "table" | "known"; models: number; pairs: { key: string; twinKey: string; name: string; alias: string; device: string; sizeGB: number }[]; foundryOnly: number; log: string[] }>;
  /** Everything the Developer Foundry panel reads in one pass: server, persistent settings, cache, and the full diagnostics report. */
  foundryAdmin(): Promise<FoundryAdminView>;
  /** `foundry config set`: one of port, cache-directory, idle-timeout-minutes or log-level. */
  foundryConfigSet(key: string, value: string): Promise<FoundryActionResult>;
  /** `foundry config reset`: one setting, or every setting when no key is named. */
  foundryConfigReset(key?: string): Promise<FoundryActionResult>;
  /** `foundry cache cd`: point the cache at an existing folder. */
  foundryCacheSet(path: string): Promise<FoundryActionResult>;
  /** `foundry cache remove`: one cached model, or every cached model when no alias is named. */
  foundryCacheRemove(alias?: string): Promise<FoundryActionResult>;
  /** `foundry server start|stop|restart`; a blank port lets Foundry choose, and the address is read back from status. */
  foundryServer(action: "start" | "stop" | "restart", opts?: { port?: number | null; idleTimeoutMinutes?: number | null }): Promise<FoundryServerActionResult>;
  /** `foundry server logs`: the daemon and SDK lines this version can read. */
  foundryLogs(lines?: number): Promise<string>;
  /** `foundry model info`: details and execution providers, with the text output when the version cannot answer JSON. */
  foundryModelInfo(alias: string): Promise<{ info: FoundryModelInfo | null; text: string }>;
  /** `foundry model register`: add an ONNX Runtime GenAI folder in place. */
  foundryModelRegister(input: FoundryRegisterInput): Promise<FoundryActionResult>;
  /** `foundry model unregister`: remove a local registration; its files stay. */
  foundryModelUnregister(alias: string): Promise<FoundryActionResult>;
  /** `foundry model load`: load a cached build, optionally naming its device. */
  foundryModelLoad(alias: string, device?: string | null): Promise<FoundryActionResult>;
  /** `foundry model unload`: unload one model from the daemon. */
  foundryModelUnload(alias: string): Promise<FoundryActionResult>;
  /** `foundry transcribe -f <file>`: one-shot file transcription through a cached speech model. */
  foundryTranscribe(input: { file: string; model?: string; language?: string }): Promise<{ ok: boolean; text?: string; error?: string }>;
  /** Run `foundry report` to open a pre-filled GitHub issue with diagnostics. */
  foundryReport(): Promise<{ ok: boolean; message: string }>;
  /** Every runtime MKMN needs or can use (src/core/requirements.ts), and whether it is on this PC now. */
  requirements(): Promise<RequirementStatus[]>;
  /** Installs one requirement of the fixed list from the internet (winget); the message says what happened. */
  installRequirement(id: string): Promise<{ ok: boolean; message: string }>;
  /** Newer versions of what is installed: winget's packages of the fixed list, and whether a newer GenieX installer was published. */
  requirementUpdates(): Promise<RequirementUpdates>;
  /** Updates one requirement's winget package (a package of the fixed list only). */
  updateRequirement(id: string, pkg: string): Promise<{ ok: boolean; message: string }>;
  /** A native audio-file picker for one-shot transcription. */
  foundryPickAudio(): Promise<string | null>;
  /** One reading of the battery (mWh and mW), as Windows reports it. */
  batteryRead(): Promise<import("../core/battery").BatteryReading>;
  /** The one-button comparison of GenieX with Microsoft Foundry Local: installs Foundry Local if needed, reads its catalog, pairs the models, starts the comparison. */
  engineCompareStart(o: { mode: "launch" | "express"; maxPairs: number }): Promise<{ ok: boolean; error?: string }>;
  /** The prompt lab (Developer settings): starts a series of prompts (the text of a Markdown file) on the models picked, stops it, reads where it is. */
  labStart(o: { md: string; modelIds: string[] }): Promise<{ ok: boolean; error?: string }>;
  labStop(): Promise<boolean>;
  labState(): Promise<import("../core/labRunner").LabState>;
  onLab(cb: (s: import("../core/labRunner").LabState) => void): () => void;
  /** `unavailable`: why the one-click comparison cannot run in this build (said before any click). */
  engineCompareState(): Promise<{ running: boolean; steps: { id: string; label: string; status: "pending" | "running" | "done" | "failed"; detail?: string }[]; ok?: boolean; unavailable?: string }>;
  onEngineCompare(cb: (s: { running: boolean; steps: { id: string; label: string; status: "pending" | "running" | "done" | "failed"; detail?: string }[]; ok?: boolean }) => void): () => void;
  npuResetStatus(): Promise<{ ready: boolean; auto: boolean }>;
  /** Everything about this PC and this install that someone helping needs, as text to paste: machine, NPU, versions, bundles, settings, recent logs. */
  supportInfo(): Promise<string>;
  /** A model the app did not know was installed and is being loaded under the best setting this PC accepts, then badged. */
  onModelCheck(cb: (p: { ref: string; phase: "testing" | "done" | "failed"; step?: string; badge?: "npu" | "hybrid" | "cpu" }) => void): () => void;
  onNpuTest(cb: (s: { running: boolean; lines: string[]; results: import("../core/npuTest").LoadAttempt[] }) => void): () => void;
  /** The finished models of the run (answers left out), for the charts and statistics. */
  benchResults(): Promise<import("../core/bench").ModelResult[]>;
  /** Writes the latest run's measured speeds and devices to the profiles the Models list reads; the number of finished models handed over. */
  benchImportResults(): Promise<number>;
  /** A benchmark-suite measurement was saved to a model's profile: the Models list should read the profiles again. */
  onBenchMeasured(cb: (p: { ref: string }) => void): () => void;
  /** Writes the report to publish (Markdown, HTML, charts, CSV, raw answers) next to the results and shows it in the file manager. `files` names exactly what was written, relative to `dir` (a launch-only export has no report.html or charts). */
  benchExport(): Promise<{ ok: boolean; error?: string; dir?: string; report?: string; html?: string; files?: string[] }>;
  /** Shows a result file in the file manager, or the results folder when null. */
  benchReveal(file: string | null): Promise<boolean>;
  onBench(cb: (s: import("../core/benchRunner").BenchState) => void): () => void;
  /** The words the model under test is writing, as it writes them. */
  onBenchLive(cb: (l: import("../core/benchRunner").BenchLive) => void): () => void;
  hfSearch(query: string): Promise<HfSearchResult[]>;
  /** Whatever was pasted (link, command, repo id, name): a model is opened and judged, anything else comes back as a search. */
  resolveModel(input: string): Promise<ResolveResult>;
  /** The Explore browser: models from every chosen source, estimated against this machine. */
  browse(q: BrowseQuery): Promise<BrowseResult>;
  /** The versions (size, quant) of one Docker Hub model. */
  dockerVariants(name: string): Promise<BrowseVariant[]>;
  install(entry: CatalogEntry): Promise<void>;
  cancelInstall(ref: string): Promise<void>;
  uninstall(entry: CatalogEntry): Promise<{ ok: boolean; message: string }>;
  /** `geniex model set-type <name> <llm|vlm>`: which path a cached model takes (a VLM loads its projector; an LLM runs text only). */
  geniexSetType(input: { name: string; type: "llm" | "vlm" }): Promise<{ ok: boolean; message: string }>;
  /** `geniex config list`: the CLI's own stored configuration (chipset and friends), as text. */
  geniexConfigList(): Promise<{ ok: boolean; text?: string; error?: string }>;
  /** `geniex clean`: remove every cached model (the UI confirms twice). */
  geniexClean(): Promise<{ ok: boolean; message: string }>;
  /** `geniex pull <name> --local-path <path>`: import a local model folder or an AI Hub .zip. Progress rides the install events. */
  geniexPullLocal(input: { path: string; name: string; type?: "llm" | "vlm" }): Promise<{ ok: boolean; name?: string; error?: string; cancelled?: boolean }>;
  /** A native picker for a model folder (directory: true) or an AI Hub .zip file. */
  geniexPickLocal(kind: "folder" | "zip"): Promise<string | null>;
  selectModel(id: string, explicit?: boolean, opts?: { signal?: AbortSignal }): Promise<void>;
  preloadModel(req?: PreloadRequest): Promise<ServerStatus>;
  server(): Promise<ServerStatus>;
  stopServer(): Promise<void>;
  serverLog(): Promise<string[]>;
  chat(id: string, modelId: string, messages: ChatMessage[], opts: ChatOptions): Promise<void>;
  /** Summarizes the oldest part of a chat now (the messages as a request would send them, the last one being the draft). `turns` is how many turns of the chat the summary stands for. */
  compactChat(id: string, modelId: string, messages: ChatMessage[], memoTurns: number, convId?: string): Promise<{ text: string; turns: number } | { error: string }>;
  abortChat(id: string): Promise<void>;
  /** Cuts the step the build is working on short: it goes on with the next one, or with the previous one written again when `back` is set. */
  skipStep(id: string, back?: boolean): Promise<void>;
  /** The router of the Dynamic model: a tiny model on the processor that sorts the requests the words are unsure about. */
  routerStatus(): Promise<RouterStatus>;
  routerInstall(): Promise<{ done: boolean; failures: string[] }>;
  routerCandidates(): Promise<{ chosen: string | null; candidates: { id: string; name: string; sizeGB: number }[] }>;
  /** Asks every candidate the same few questions and keeps the quickest that answers them all right. */
  routerBench(): Promise<{ rows: { id: string; name: string; sizeGB: number; ms: number | null; right: number; total: number; error: string | null }[]; chosen: string | null }>;
  routerTest(text: string): Promise<{ kind: string | null; ms: number; rules: { category: string; confidence: number; reason: string }; asked: { id: string; yes: boolean }[] }>;
  /** The closed file question put to the router ("which file does this request name: docx, xlsx, site, tool?"): it decides
   *  which deep office rules the request carries before the prompt is built. null = a definite no; undefined = the router
   *  is silent (keep today's behaviour). Never a word list. */
  routerFileKind(text: string): Promise<string | null | undefined>;
  /** An old .doc/.xls/.ppt as .docx/.xlsx/.pptx through an office suite installed on this PC; null when there is none. */
  convertLegacyDoc(name: string, bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array } | null>;
  /** A diagram the window could not draw, given to the model for a correction (null when none could be made). */
  fixBlock(kind: string, raw: string, reason: string): Promise<string | null>;
  /** Downloads a public library (https, JavaScript or CSS) once, when a skill is installed. */
  fetchLibrary(url: string): Promise<{ ok: true; source: string; kind: "js" | "css" } | { ok: false; error: string }>;
  settings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Writes the settings export (the JSON document the Settings page builds from
   *  the person's non-default values) to a file the person chooses. Null when
   *  the dialog was cancelled. */
  exportSettingsJson(contents: string): Promise<string | null>;
  /** Reads the settings export file the person chose. Null when the dialog was
   *  cancelled; the contents are validated by the caller (schema checks). */
  importSettingsJson(): Promise<string | null>;
  /** What the host's last repair of settings.json recorded (a damaged file moved
   *  aside, keys salvaged), or null when nothing was ever repaired. */
  settingsRepairNotice(): Promise<unknown | null>;
  /** One real search through the configuration being tested: when `cfg` is given the
   *  DRAFT on the settings page is tested directly (no race with the save), otherwise
   *  the saved settings. Errors are redacted: no credential or instance address in text. */
  humainRealtimeOpen(session: string, model: string): Promise<void>;
  humainRealtimeEvents(session: string): Promise<unknown[]>;
  humainRealtimeSend(session: string, event: unknown): Promise<void>;
  humainRealtimeClose(session: string): Promise<void>;
  humainKeySaved(credential: import("./humain").HumainProvider): Promise<boolean>;
  humainSaveKey(credential: import("./humain").HumainProvider, key: string | null): Promise<void>;
  humainModels(provider: import("./humain").HumainProvider): Promise<import("./humain").HumainModel[]>;
  humainOperation(provider: import("./humain").HumainProvider, method: string, path: string, body?: unknown,
    upload?: import("./humain").HumainUpload): Promise<import("./humain").HumainResult>;
  pickGeniex(): Promise<string | null>;
  runtimeInfo(): Promise<RuntimeInfo>;
  /** Downloads the llama.cpp build for this PC and the chosen target. Progress arrives through onSetup (step "llama"). */
  installLlamaServer(): Promise<void>;
  pickLlamaServer(): Promise<string | null>;
  /** Opens the system folder picker. Null when cancelled. */
  pickFolder(): Promise<string | null>;
  openGeniexDownload(): Promise<void>;
  meters(): Promise<Meters>;
  estimateMemory(modelRef: string, nctx?: number, kvType?: string): Promise<MemoryEstimate>;
  powerStatus(): Promise<PowerStatusInfo>;
  runBenchmark(modelRef: string, compute?: string, powerMode?: string, nctx?: number): Promise<BenchmarkResult>;
  /** Cancels a running quick benchmark (the Rust runner stops at the next test boundary and kills a hung server). */
  cancelBenchmark(): Promise<void>;
  /** What the adaptive compute selector last decided (engine · device · evidence · why), and the goals it offers. */
  adaptiveStatus(): Promise<AdaptiveStatusView>;
  hardwareConfig(): Promise<HardwareConfigFile>;
  saveHardwareConfig(patch: Partial<HardwareConfigFile>): Promise<HardwareConfigFile>;
  inhibitSleep(enable: boolean): Promise<void>;
  getQoSStatus(pid?: number): Promise<import("./types").QoSSummary>;
  setQoSTier(tier: string, pid?: number): Promise<import("./types").QoSSummary>;
  verifySha256(path: string, expectedSha256?: string): Promise<import("./types").Sha256VerificationResult>;
  /** What Windows exposes about the NPU (counter sets, sample values, why nothing is read), for the meters that show n/a. */
  npuDiagnostics(): Promise<{ ok: boolean; problem: string | null; windows: string | null; windowsHasNpuMonitoring: boolean | null; sets: string[]; adapter: string | null; adapters: string[]; topUtil: string[]; allSets: string[]; sample: string[]; util: number | null; memGB: number | null }>;
  setupState(): Promise<SetupState>;
  setupSkip(id: StepId): Promise<void>;
  setupRetry(id: StepId): Promise<void>;
  /** Run the unsigned installer the step names (by its SHA-256), after the person read that it is unsigned. */
  setupRunUnsigned(id: StepId): Promise<void>;
  setupDismiss(): Promise<void>;
  setupConfirm(): Promise<void>;
  setupDecline(): Promise<void>;
  onSetup(cb: (s: SetupState) => void): () => void;
  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateInstall(): Promise<void>;
  /** Downloads the installer of the latest release and runs it, even when this version is already the latest. */
  updateForce(): Promise<UpdateState>;
  onUpdate(cb: (s: UpdateState) => void): () => void;
  npuPlan(): Promise<NpuPlanView>;
  voiceModels(): Promise<VoiceModelView[]>;
  voiceStatus(): Promise<VoiceStatus>;
  voiceDownload(id: string): Promise<void>;
  voiceCancelDownload(id: string): Promise<void>;
  voiceRemove(id: string): Promise<void>;
  /** Load the models named in settings, honoring each CPU / NPU switch. */
  voiceApply(): Promise<VoiceStatus>;
  /** `partial`: a preview of speech still being said; null when the recognizer was busy and skipped it. */
  transcribe(samples: Float32Array, sampleRate: number, partial?: boolean): Promise<string | null>;
  /** The speech models still missing for what is asked (dictation, read-aloud), each with the one that suits this PC best. Nothing when they are installed. */
  voiceNeeds(kinds: ("stt" | "tts")[]): Promise<VoiceNeed[]>;
  /** Downloads and selects them in one go (`alt`: the CPU model instead of the recommended one). Progress arrives through onVoiceDownload. */
  voiceQuickInstall(kinds: ("stt" | "tts")[], alt?: boolean): Promise<{ ok: boolean; error?: string }>;
  speak(id: string, text: string): Promise<void>;
  cancelSpeak(id: string): Promise<void>;
  saveVoice(patch: Partial<VoiceSettings>): Promise<Settings>;
  onVoiceDownload(cb: (p: VoiceDownloadProgress) => void): () => void;
  onVoiceAudio(cb: (c: SpeakChunk) => void): () => void;
  onVoiceStatus(cb: (s: VoiceStatus) => void): () => void;
  /** The chats as this window last saved them (saveConversations); the host keeps them as JSON. */
  conversations(): Promise<unknown[]>;
  saveConversations(c: unknown[]): Promise<unknown[]>;
  /** Forgets the old `mkmn.conversations` copy — called only once a save has landed under the kept key (see conversationSaver's onResult). */
  markLegacyMigrated(): void;
  /** The host's coordinated shutdown event (Tauri build): registered callbacks flush the pending chat saves. Returns the unsubscribe. */
  onAppShutdown(cb: () => void): () => void;
  saveMedia(dataUrl: string, name?: string): Promise<{ mediaId: string; path: string }>;
  /** Reads a saved picture back as a data URL; null when it was deleted or cannot be read. */
  readMedia(mediaId: string): Promise<{ dataUrl: string } | null>;
  projects(): Promise<Project[]>;
  saveProject(p: Project): Promise<Project[]>;
  /** Removes the project, then its knowledge index, search vectors and offloaded knowledge text in the sidecar (a failure there is logged, not thrown). */
  deleteProject(id: string): Promise<Project[]>;
  artifacts(): Promise<Artifact[]>;
  /** Insert or update; chat artifacts use a stable id so a regenerated answer replaces the old one. */
  saveArtifact(a: Artifact): Promise<Artifact[]>;
  /** Deletes the file with all its versions. */
  deleteArtifact(id: string): Promise<Artifact[]>;
  /** The versions of a file (null when it has none), the text of one, and what the person does with them: use one, go back to one (a new version), rename, delete. */
  artifactVersions(id: string): Promise<VersionList | null>;
  artifactVersionText(id: string, versionId: string): Promise<string | null>;
  artifactVersionAction(id: string, action: VersionAction): Promise<VersionResult>;
  /** Writes the artifact to a file the user chooses. Resolves to the path, or null if cancelled. */
  /** Saves a Word, Excel or PowerPoint file made from its text form (a sheet block of the chat, for example); the path, or null when cancelled. */
  saveOffice(kind: "docx" | "xlsx" | "pptx", source: string, name: string): Promise<string | null>;
  /** Saves an artifact as a file; `draft` is the file as the window shows it, used when nothing was saved yet (the answer is still being written); `images` are the pictures (PNG data addresses, by key) of the diagrams and charts a Word or PowerPoint file holds. */
  exportArtifact(id: string, images?: Record<string, string>, format?: string, draft?: Artifact): Promise<string | null>;
  /** Runs a code artifact (Python, JavaScript) on this computer. Output arrives through onRun; resolves when it started or could not start. */
  runCode(runId: string, language: string, code: string): Promise<void>;
  /** Writes the files of a site to a folder and opens its page in the default browser. `entry` is the file to start from. */
  launchSite(files: { title: string; kind: string; language: string; content: string }[], entry: { title: string; kind: string; language: string; content: string }): Promise<{ path?: string; error?: string }>;
  /** The preview frame tried to go to another page of the site (a script set location, or a link was followed). */
  onSiteNav(cb: (to: string) => void): () => void;
  /** The app asks the window to draw a diagram or a chart as a picture (for a presentation being made); the window answers with figureResult. */
  onFigureRequest(cb: (req: { id: string; lang: "mermaid" | "chart"; raw: string }) => void): () => void;
  figureResult(id: string, dataUrl: string | null): Promise<void>;
  /** Terminal: runs a command (pip install, ...) in the folder and with the Python of the programs. Output arrives through onRun like a program's. */
  runCommand(runId: string, command: string): Promise<void>;
  /** Sends a line to the standard input of a running program or command (an input() waiting for an answer). */
  writeRun(runId: string, text: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  onRun(cb: (e: RunEvent) => void): () => void;
  /** Computer Use: the visible top-level windows one may be granted (MKMN's own are removed). A driver that cannot start is an error, never an empty list. */
  agentListWindows(): Promise<DriverWindow[]>;
  /** Computer Use: grants ONE window for ONE run (the host validates and records it; every later call is checked against it). */
  agentBeginRun(hwnd: number): Promise<AgentGrant>;
  /** Computer Use: starts the sidecar's loop on the granted window (progress arrives through onAgentRun; the verdict is the last event). */
  agentStartRun(runId: string, hwnd: number, task: string, modelId: string): Promise<void>;
  /** Computer Use: stops a run (the person's stop settles cancelled, never failed) and clears the grant. */
  agentStopRun(runId: string): Promise<void>;
  /** Computer Use: the progress of a run — observe/propose/act/verify lines, then the verdict. */
  onAgentRun(cb: (e: AgentRunEvent) => void): () => void;
  /** Edit a copy: opens the file dialog for ONE saved Word document (.docx/.docm); null when the person cancels. */
  docPickSource(): Promise<string | null>;
  /** Edit a copy: starts the sidecar's edit-a-copy loop on the picked file (progress arrives through onAgentRun; no window grant is asked or given). */
  docEditStart(runId: string, sourcePath: string, task: string, modelId: string): Promise<void>;
  /** Edit a copy: answers the review gate of ONE run — true saves the edited copy, false cancels (nothing is written). */
  docEditDecide(runId: string, approved: boolean): Promise<void>;
  /** Edit a copy: opens the verified edited copy with its default app (only a .docx/.docm is accepted); false when the host could not. */
  openEditedCopy(path: string): Promise<boolean>;
  tasks(): Promise<ScheduledTask[]>;
  saveTask(t: ScheduledTask): Promise<ScheduledTask[]>;
  deleteTask(id: string): Promise<ScheduledTask[]>;
  /** Removes what the harness kept of a deleted chat (its run journals and payloads). */
  forgetConversation(convId: string): Promise<{ journals: number; payloads: number }>;
  runTask(id: string): Promise<void>;
  onTasks(cb: (t: ScheduledTask) => void): () => void;
  onArtifacts(cb: () => void): () => void;
  onInstall(cb: (p: InstallProgress) => void): () => void;
  onChat(cb: (e: ChatEvent) => void): () => void;
  onServer(cb: (s: ServerStatus) => void): () => void;
}

export type { FriendlyError };
