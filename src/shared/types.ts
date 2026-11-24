// Types shared by core, main process and renderer.

import type { BuildStatus, ServerState } from "./stateMachines.generated";

export type { BuildStatus, ServerState };

export type Engine = "llama_cpp" | "qairt";
/** Where a model comes from. */
export type SourceId = "hf" | "docker" | "modelscope" | "aihub";
export type Level = "green" | "amber" | "red";
export type ComputeTarget = "cpu" | "gpu" | "npu" | "hybrid";

/**
 * How the llama.cpp engine runs a model on the CPU or the GPU, like the load options of LM Studio.
 * Every field is optional: unset means "let llama.cpp decide".
 */
export interface RuntimeSettings {
  /** CPU threads for generating. 0 or unset = automatic. */
  threads?: number;
  /** CPU threads for reading the prompt. 0 or unset = same as threads. */
  threadsBatch?: number;
  /** Layers placed on the GPU: -1 = all, 0 = none, a number = that many (the rest stays in RAM and on the CPU). Unset = all on GPU, none on CPU. */
  gpuLayers?: number;
  /** Context window in tokens. 0 or unset = the model's recommended window. */
  ctx?: number;
  /** Prompt batch sizes (`--batch-size`, `--ubatch-size`). */
  batch?: number;
  ubatch?: number;
  flashAttn?: "auto" | "on" | "off";
  /** Map the model file instead of reading it into RAM: a model bigger than the free RAM then stays on disk and is paged in as needed. Default on. */
  mmap?: boolean;
  /** Pin the model in RAM so the system never swaps it out. Default off. */
  mlock?: boolean;
  /** Keep the attention cache (KV) in RAM instead of on the GPU, which leaves VRAM to the weights. Default off. */
  kvInRam?: boolean;
  /** Precision of the attention cache: smaller = less memory. */
  kvType?: "f16" | "q8_0" | "q4_0";
  /** Use only one NUMA node / pin threads (`--numa`), for servers. */
  numa?: "" | "distribute" | "isolate" | "numactl";
  /** Where llama-server is, when it is not the one MKMN installed. */
  serverPath?: string | null;
  /** Anything else for llama-server, as typed on a command line. */
  extraArgs?: string;
}

/** A job in building files that can be given to a model of its own. */
export type WriterRole = "plan" | "html" | "css" | "js";

export interface Sampling {
  temperature: number;
  top_p: number;
  top_k?: number;
  /** Min-p sampling threshold, when a model's own config names one. */
  min_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  /** Fixed seed for repeatable measurements (the fixed-workload speed track); absent = server default. */
  seed?: number;
  max_tokens: number;
}

export interface HardwareProfile {
  chipName: string;
  /** X1 family = Hexagon HTP v73, X2 = v81 (spec: "Snapdragon X2 profiles" is later work). */
  chipFamily: "x1" | "x2" | "unknown";
  isSnapdragon: boolean;
  ramGB: number;
  npuDetected: boolean;
  /** Graphics cards found (name, and memory when known), and the processor's thread count: the GPU and CPU options are shown from these. */
  gpus?: { name: string; vramGB?: number | null }[];
  cpuThreads?: number;
  /** The chat model runs on the CPU or the GPU: the NPU checks do not apply. */
  offNpu?: boolean;
  npuDriverVersion: string | null;
  /** NPU shared memory ceiling in GB. */
  npuBudgetGB: number;
  /** "measured" = read from the machine or entered by the user; "estimated" = about half of RAM. */
  npuBudgetSource: "measured" | "estimated" | "user";
  detectedAt: string;
  /** Architecture of THIS app process. MKMN must run native arm64 on Windows. */
  appArch: string;
  /** True when the machine is ARM64 but the app runs emulated (x64). Blocks nothing, but is shown as an error. */
  emulated: boolean;
}

export interface KvShape {
  /** Layers that hold a KV cache (attention layers only; hybrids have few). */
  attentionLayers: number;
  kvHeads: number;
  headDim: number;
}

export interface Verdict {
  level: Level;
  /** One-line reasons, most important first. */
  reasons: string[];
  /** Context size the app will launch the server with. */
  contextTokens: number;
  estNpuGB: number;
  estTokPerSec: number | null;
  /** Install is always allowed (spec: a warning, never a block). */
  installAllowed: true;
}

export interface CatalogEntry {
  id: string;
  name: string;
  /** Hugging Face repo, or AI Hub repo for native bundles. */
  repo: string;
  quant: string | null;
  engine: Engine;
  role: string;
  architecture: string;
  sizeGB: number;
  sizeApprox?: boolean;
  paramsB?: number;
  isMoe?: boolean;
  kv?: KvShape;
  /** Largest context that was actually run on the 7.8 GB test machine. */
  maxTestedContext?: number;
  recommendedContext: number;
  /** The context a QAIRT (native NPU) graph was COMPILED with, from the bundle's own genie_config.json.
   * Absent/unknown for a bundle not installed yet. GGUF models leave this unset: their window is configured at serve time (`--nctx`). */
  compiledContext?: number | null;
  sampling: Sampling;
  measured?: { tokPerSec: number; ttftSec: number };
  testNote?: string;
  /** Needs a newer NPU driver (native bundles above ~1.7B on 30.0.220.3000). */
  needsNewerDriver?: boolean;
  excluded?: boolean;
  excludeReason?: string;
  /** Default model flag per use. */
  default?: boolean;
  /** Where it was found; Hugging Face when missing. */
  source?: SourceId;
  /** A model served by a HUMAIN cloud provider: no file, no process, never the NPU. */
  cloud?: "fuse";
  /** A Foundry Local entry: the exact build (model id) it stands for, the key its measurements are kept under. */
  foundryBuild?: string;
  /** The Dynamic bundle model this entry was installed for, so the app knows it is that one whatever its repo is called. */
  dynamicRef?: string;
  /** A model run by Microsoft Foundry Local: the hardware its build is made for. */
  foundryDevice?: "NPU" | "GPU" | "CPU";
  /** A Foundry catalog entry that is in Foundry's own cache right now (catalog entries are listed installed or not). */
  foundryInstalled?: boolean;
}

export interface InstalledModel {
  name: string;
  /** Argument for `geniex infer/pull`, "<repo>:<quant>" when known. */
  ref: string;
  sizeGB?: number;
  /**
   * The precisions the cache declares for this repository (from `geniex list`'s
   * PRECISIONS column: "Q4_0", "W4A16", "Q4_K_M"…). Absent when the output named
   * none: a missing value is unknown, never "every precision".
   */
  precisions?: string[];
}

export interface HardwareVerification {
  verifiedNpu: boolean;
  cpuFallbackDetected: boolean;
  executionTarget: string;
  powerModeActive: string;
  lastTelemetryLog?: string;
  qosTier?: string;
  ecoqosActive?: boolean;
}

export interface QoSSummary {
  pid: number;
  tier: "Interactive" | "InferenceCritical" | "BackgroundEco";
  priorityClass: string;
  ecoqosActive: boolean;
  timerCoalescingActive: boolean;
  sleepInhibited: boolean;
  verifiedHwState: boolean;
  details: string;
}

export interface Sha256VerificationResult {
  path: string;
  sha256: string;
  matches?: boolean;
  ecoqosVerified: boolean;
}

export interface MemoryEstimate {
  modelRef: string;
  weightsGB: number;
  kvCacheGB: number;
  scratchpadGB: number;
  totalRequiredGB: number;
  availableRamGB: number;
  totalRamGB: number;
  npuBudgetGB: number;
  fits: boolean;
  recommendedNctx: number;
  recommendedKvType: string;
  isQairt: boolean;
  note: string;
}

export interface PowerStatusInfo {
  onAcPower: boolean;
  batteryPercent?: number;
  powerSaverRecommended: boolean;
  acLineStatus: number;
  /** Windows Energy Saver (battery saver) is on. */
  energySaverOn?: boolean;
}

export interface BenchmarkResult {
  modelRef: string;
  compute: string;
  powerMode: string;
  /** Milliseconds to the first token, when the run's telemetry gave a real one; null when it did not (never 0 — a first token cannot arrive in 0 s). */
  ttftMs: number | null;
  decodeTokPerSec: number;
  prefillTokPerSec?: number;
  loadTimeMs: number;
  tokensGenerated: number;
  ramUsedMB: number;
  verifiedNpu: boolean;
  outputSnippet: string;
  /** B07: the child process's own peak private memory (PrivateUsage) while it ran; ramUsedMB is system-wide. */
  childPrivateMemMB?: number;
  /** B07: observed spawn → first stdout byte, a real event (loadTimeMs is an estimate). */
  firstOutputMs?: number;
}

export interface ServerStatus {
  state: ServerState;
  endpoint: string;
  nctx: number | null;
  compute: ComputeTarget;
  restarts: number;
  lastError: FriendlyError | null;
  pid: number | null;
  /** True when the endpoint is served by another app instance's process that this one adopted (no child of its own). */
  adopted?: boolean;
  hardwareVerification?: HardwareVerification;
  model?: string | null;
  /** The context window the server was ACTUALLY started with (None for QAIRT — compiled). */
  servedNctx?: number | null;
  servedKvType?: string | null;
  servedKvInRam?: boolean;
  /**
   * How the context window is determined: "compiled" (QAIRT, baked into the Hexagon
   * graph — no --nctx is sent) or "configurable" (dynamic --nctx).
   */
  contextKind?: "compiled" | "configurable" | null;
}

export interface FriendlyError {
  id: string;
  title: string;
  fix: string;
  raw: string;
}

export interface InstallProgress {
  ref: string;
  phase: "checking" | "downloading" | "done" | "error" | "cancelled";
  percent: number | null;
  line?: string;
  error?: FriendlyError;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** A plain string, or parts when the message carries images (OpenAI format). */
  content: string | ContentPart[];
}

/** How much the model thinks before it answers. Off only exists for models whose template can switch it off; Auto picks a level per request. */
export type Effort = "auto" | "off" | "low" | "medium" | "high";

export interface ChatOptions {
  effort: Effort | null;
  /** Let the model hand work to sub-agents. */
  subagents: boolean;
  /** First message of a chat: name the chat before answering. */
  title?: boolean;
  /**
   * The person pressed "Build it instead" on an offered answer: the request runs through
   * the build path without the build question being asked again (the click is the yes).
   */
  buildWanted?: boolean;
  retryModelLoad?: boolean;
  /** Voice chat: false when the request does not ask for a picture, so the model is not given the instructions for them. */
  images?: boolean;
  /** The project the chat belongs to: its folder, if any, can be explored. */
  projectId?: string | null;
  /** The folder of that project, resolved by the UI: the sidecar cannot read the project store, so the folder travels with the request. */
  projectFolder?: string | null;
  /** How many turns of the chat the summary at the start of the messages stands for (0 or absent: none). */
  memoTurns?: number;
  /**
   * The conversation the request belongs to, stable across its turns: it names the
   * offloaded fold of the older messages (so a later question can recall them) and
   * keys the background compaction that runs after an answer.
   */
  convId?: string;
  /** The rules (and library notes) of the skill loaded for this request; the file-writing steps are given them too. */
  skillNote?: string;
  /**
   * The project's knowledge files, content already converted to text, as the
   * renderer's project store holds them (the store lives in the webview, so
   * the files travel with the request, like the project folder does). The
   * orchestrator indexes them and retrieves the sections a question needs;
   * knowledge small enough to fit the budget rides packed whole as before.
   */
  knowledge?: { id: string; name: string; content: string }[];
}

/**
 * A file the user added to a message. Image bytes live in the local media store: the saved chat keeps `mediaId`, and
 * the data URL is loaded again when the chat is opened, so a restart never loses a picture the person attached.
 */
export interface Attachment {
  name: string;
  kind: "text" | "image";
  size: number;
  text?: string;
  /** In memory while the app runs; not written to saved chats when `mediaId` is set. */
  dataUrl?: string;
  /** The file in the local media store, written by `saveMedia`. */
  mediaId?: string;
  /** The saved file could not be read (deleted or damaged): say so instead of silently dropping the picture. */
  unavailable?: boolean;
}

export interface AgentCall { name: string; task: string }

export interface AgentRun extends AgentCall {
  index: number;
  status: "running" | "done" | "error";
  output: string;
  error?: string;
  /** "web" = a web search, shown as a search card instead of a sub-agent card. */
  kind?: "web" | "memo";
  /** "memo" only: the tokens of context freed once the summary is written. */
  saved?: number;
}

/** One line of the code check shown under an answer: what ran, what failed, what the reviewer changed. */
export interface ReviewStep {
  text: string;
  kind: "info" | "error" | "ok";
  /** The lines this step changed, as "- old / + new" rows: the code is always there to read. */
  diff?: string;
}

export interface ReviewRun {
  status: "running" | "done";
  steps: ReviewStep[];
  /** Small screenshots of the page after the keys and buttons were pressed (data URLs). Not saved with the chat. */
  shots?: string[];
}

/** The automatic improve loop: round by round, what was changed and what was thrown away. */
export interface LoopRun {
  status: "running" | "done";
  /** The round being worked on (1-based) and how many there can be. */
  round: number;
  rounds: number;
  /** When the time budget ends (epoch ms). */
  endsAt: number;
  accepted: number;
  steps: ReviewStep[];
}

/** One stage of the work on a file, or of the test run: what it is, how it went, how long it took. */
export interface BuildStage {
  /** "skeleton" | "engine" | "spec" | "write" | "edit" | "check" | "run" | "fix" */
  id: string;
  label: string;
  status: "running" | "done" | "error" | "skipped";
  note?: string;
  sec?: number;
  /** A small screenshot of the page after it was run (data URL). Not saved with the chat. */
  shot?: string;
  /** The file this stage is working on: the chat opens its panel on it while the stage runs. */
  file?: string;
  /** The helper that does this stage ("Writer", "Fixer", "Tester"...) and the model it runs on (none for the tester: it runs the page here). */
  agent?: string;
  model?: string;
  /** When the stage started (ms since 1970): the chat counts the running time itself, so the clock moves even while the model is silent. */
  at?: number;
  /** What the stage did, for the "Copy full log" button: what was asked, what came back, what was wrong. Not saved with the chat. */
  log?: string;
}

/** One file of a build: written new, or changed by edit blocks on the lines concerned. */
export interface BuildStep {
  file: string;
  action: "new" | "edit";
  job: string;
  status: "waiting" | "running" | "done" | "error";
  note?: string;
  /** What an edit changed, as "- old / + new" rows. */
  diff?: string;
  /** The stages this file went through, in order: starting point, rules, writing, check, fix. */
  stages?: BuildStage[];
}

/** Work on files split into short sessions of their own: the plan and how each file is going. */
/** One call to a model made by a build, kept for the log the person copies when something goes wrong. */
export interface BuildCall {
  n: number;
  /** The session's name, which says what it was for ("c:x:0:Plan:2"). */
  sid: string;
  /** Seconds from the start of the work to the end of the call, and how long it lasted. */
  at: number;
  sec: number;
  model?: string;
  /** Characters sent (system and messages), received as the answer, and thought. */
  sent: number;
  got: number;
  thought: number;
  tokens?: number;
  tokPerSec?: number | null;
  /** True when `tokens` is the stream-chunk count, not the server's verified usage — the same meaning as ChatStats.tokensEstimated. */
  tokensEstimated?: boolean;
  /** The start of what the model was told (its last message) and of what it answered, so a failure can be read. */
  prompt?: string;
  reply?: string;
  error?: string;
}

export interface BuildRun {
  /** "unresolved": the files were written, but the test run still shows a problem; never shown as a clean finish. */
  status: BuildStatus;
  /** True when the tokens count includes counts that are not the servers' verified usage (chunk counts or character-based estimates). When absent, the count is verified. */
  tokensEstimated?: boolean;
  steps: BuildStep[];
  /** What is happening right now, in a sentence the chat shows prominently ("Planning the files…", "Writing index.html · part 2 of 3"). */
  phase?: string;
  /** The last words a helper is writing or thinking right now, shown as a few scrolling lines. */
  live?: string;
  /** Tokens produced so far by every session of the work (real totals of finished calls plus an estimate for the one running), and lines written. */
  tokens?: number;
  lines?: number;
  /** The drawing being written right now (a drawer session), whole so far: the card shows it small as it appears. */
  art?: string;
  /** The unit of the program being written right now (construction engine), whole so far: the code panel shows it as it comes. */
  unit?: { name: string; label: string; code: string };
  /** The rules written before the code of a program (what the writer is told to follow). */
  spec?: string;
  /** Work counts of a deck build (and what power mode it ran in): model calls with their retries, preview updates, elapsed seconds, tokens of the finished calls. GPU/NPU vs WebView2 activity is NOT attributed here — that needs a runtime measurement. */
  deckMetrics?: { calls: number; retries: number; renders: number; reviews: number; previews: number; elapsedSec: number; tokens: number; mode: "full" | "low"; /** The deck rubric's score in [0, 1] once the slides are final (src/core/deckQuality.ts). */ quality?: number; /** What the rubric found short, as notes. */ qualityNotes?: string[] };
  /** The finished file's quality, scored by its feature's rubric (src/core/harness/quality.ts): which rubric, the score in [0, 1] and what fell short. A report, never a reason to fail the build. */
  quality?: { rubric: string; score: number; notes: string[] };
  /** The planner, before there are files: shown as soon as it starts. */
  start?: BuildStage[];
  /** The test run of the finished page: run it, press its keys and buttons, fix what it shows, run it again. */
  verify?: BuildStage[];
  /** The request that started the work, and the calls finished since the previous event (the window adds them up): for "Copy full log". */
  request?: string;
  calls?: BuildCall[];
  /** Settings that are off and would make the work better: shown as a line with a button that turns the setting on. */
}

/** One settled step of the turn's run, as the screen draws it: journal-sized (no prompt, no reply), the same record the journal holds. */
export interface RunStepView {
  seq: number;
  kind: string;
  status: "ok" | "failed" | "retry_exhausted" | "interrupted";
  seconds: number;
  tokens: { prompt: number; output: number; measured: boolean };
  error?: string;
}

/**
 * The turn's run as the harness holds it: the settled steps,
 * the per-turn budget account as it stands (the policy's cap, what the turn has
 * spent), and the verdict once finish() named it. The budget counts EVERY model
 * call of the turn — the main answer, the fold, the reviewer, the locator, the
 * sub-agents, the build sub-runs — even though the steps listed here are the
 * turn's own (a build's steps draw in the build card).
 */
export interface RunView {
  runId: string;
  pipeline: string;
  steps: RunStepView[];
  budget: { calls: number; outputTokens: number; maxCalls: number; maxOutputTokens: number };
  verdict?: { state: "done" | "unresolved" | "failed" | "cancelled"; error?: string };
}

export interface ChatStats {
  /** Why the model stopped: "stop" = it finished, "length" = the context or the token limit cut it off. */
  finish?: string | null;  /** From the request to the first token the model sent, thought or word. */
  ttftSec: number | null;
  /** From the request to the first word of the answer: the first token is often a thought, so this is what the person waited for. */
  answerSec?: number | null;
  /** What the app did before the request left: sorting, loading the model, searching. */
  prepSec?: number | null;
  prep?: { name: string; sec: number }[];
  tokPerSec: number | null;
  tokens: number;
  /**
   * True when `tokens` is NOT the server's verified token usage: the count is the number
   * of stream chunks (a chunk can hold many tokens), so the derived tok/s is an estimate.
   * Verified usage replaces it whenever the server sends `usage`.
   */
  tokensEstimated?: boolean;
  /** The prompt, in tokens, when the server says (usage). Since GenieX 0.11.0 this is the WHOLE prompt, KV-cache reuse included. */
  promptTokens?: number;
  /** The part of the prompt the server really evaluated (GenieX `timings.prompt_n`): the figure a prefill rate is measured on. */
  promptEvaluated?: number;
  /** The part of the prompt reused from the KV cache (`usage.prompt_tokens_details.cached_tokens`). */
  cachedTokens?: number;
  estimatedUsd?: number;
  totalSec: number;
}

export type ChatEvent =
  /** A short proper name for the chat, made from its first message. */
  | { id: string; type: "title"; text: string }
  | { id: string; type: "thinking"; text: string }
  | { id: string; type: "answer"; text: string }
  /** The model looped: the answer is cut back to its first `keep` characters, and written again from there. */
  | { id: string; type: "retract"; keep: number }
  /** A sub-agent started, streamed more output, or finished. */
  | { id: string; type: "agent"; agent: AgentRun }
  /** Something was done to the request or the answer that the person should know (older messages left out, a cut answer continued). */
  | { id: string; type: "notice"; text: string }
  /** The oldest part of the chat was summarized: `text` stands for its first `turns` turns and is kept with the chat. `conv` names the conversation it belongs to — a fold made in the background arrives after the turn is over, when another chat may be open. */
  | { id: string; type: "memo"; text: string; turns: number; conv?: string }
  /** The turn's own run as the harness holds it: sent as each step settles and once more at the end with the verdict. The stage cards tell the work's story; this one tells what the machinery did and what the budget stands at. */
  | { id: string; type: "run"; run: RunView }
  /** The improve loop progressed. Carries the whole run so far. */
  | { id: string; type: "loop"; loop: LoopRun }
  /** Files are being built or changed, one session each. Carries the whole run so far. */
  | { id: string; type: "build"; build: BuildRun }
  /**
   * The build votes split (the router said no, or did not answer, and the chat model said
   * yes): the request is answered in the chat, and this one action is offered under the
   * answer. Choosing it sends the same request through the build path — the click is the
   * yes, and no vote is asked again.
   */
  | { id: string; type: "offer"; offer: { action: "build"; request: string } }
  /** The code check / reviewer progressed. Carries the whole run so far. */
  | { id: string; type: "review"; review: ReviewRun }
  /** The reviewer fixed an artifact: this is the whole answer text from now on. */
  | { id: string; type: "replace"; text: string }
  | { id: string; type: "done"; stats: ChatStats }
  | { id: string; type: "error"; error: FriendlyError };

/** Output of a code artifact run on this computer. */
export type RunEvent = { runId: string; type: "out"; text: string } | { runId: string; type: "exit"; code: number | null; stopped: boolean; error?: string };

export interface Meters {
  ramPercent: number;
  ramUsedGB: number;
  ramTotalGB: number;
  /** null when Windows exposes no counter for it on this machine. */
  npuMemGB: number | null;
  npuBudgetGB: number;
  npuUtilPercent: number | null;
  /** Why the NPU figures are missing, when they are. */
  npuNote?: string | null;
  ramWarning: boolean;
}

export interface Settings {
  /** Stored locally; system follows Windows appearance changes. */
  appearance?: "light" | "dark" | "system";
  geniexPath: string | null;
  /** The optional GenieX release ("v0.12.0") skipped on the setup screen: the launch check does not offer it again. */
  geniexSkippedUpdate?: string | null;
  npuBudgetOverrideGB: number | null;
  /** Shown K-quants / IQ quants in search (spec: hide unless the user opts in). */
  showKQuants: boolean;
  compute: ComputeTarget;
  /**
   * Where the compute choice comes from: "manual" (the user's `compute` choice, the
   * classic behavior) or "auto" (MKMN picks a validated configuration before each
   * request, per `autoGoal`, and keeps it stable for the whole generation).
   */
  computeMode?: "auto" | "manual";
  /** The goal the automatic selection optimizes for (used when computeMode is "auto"). */
  autoGoal?: "balanced" | "battery_saver" | "fastest";
  /** The last automatic decision, kept for display and for the switch cooldown. */
  adaptiveState?: { at?: number; configId?: string; goal?: string; reason?: string[]; provisional?: boolean; engine?: string; compute?: string; lastSwitchAt?: number; lastSwitchTo?: string };
  /** Advanced options of the llama.cpp engine, used when the chat model runs on the GPU or the CPU (see core/runtime.ts). */
  runtime?: RuntimeSettings;
  keepaliveSec: number;
  /**
   * Idle model release: how long an idle model stays loaded before GenieX releases it
   * (`--keepalive`, the runtime's only eviction mechanism). 0 = never release.
   * The UI keeps this in step with keepaliveSec; this is the user-facing knob.
   */
  idleReleaseSec?: number;
  /** Start loading the chat's local model at the first typed character (Speed & memory; off by default). */
  warmUpWhileTyping?: boolean;
  startupTimeoutSec?: number;
  loadingStrategy?: "always" | "demand";
  powerProfile?: "auto" | "burst" | "sustained_high_performance" | "power_saver" | "high_performance" | "balanced" | "low_balanced" | "high_power_saver" | "low_power_saver";
  nctxMode?: "auto" | "2048" | "4096" | "8192";
  kvType?: "f16" | "q8_0" | "q4_0";
  kvInRam?: boolean;
  speculativeDecoding?: { enabled: boolean; specType?: string; draftTokens?: number; draftModel?: string; draftMin?: number; draftPMin?: number };
  /** Layers the GenieX server offloads to the GPU/NPU (`--ngl`, llama.cpp models only). Unset/-1 = all. */
  geniexNgl?: number;
  /** Compute unit for a vision model's image encoder (`--vit-compute`, e.g. "cpu" or "HTP1"). Empty = the runtime's default. */
  vitCompute?: string;
  /** A different QAIRT runtime the NPU engine runs against (`--qairt-lib`). Empty = the bundled runtime. */
  qairtLib?: string | null;
  /** Log level of the GenieX runtime itself (`--log`/GENIEX_LOG); "none" sends no flag. */
  geniexLog?: "none" | "error" | "warn" | "info" | "debug" | "trace";
  /** Let GenieX look for its own updates when the server starts (false sends --skip-update). */
  geniexUpdateCheck?: boolean;
  selectedModelId: string | null;
  pinnedGeniexVersion: string | null;
  voice: VoiceSettings;
  /** Applied to every chat and every scheduled task ("Customize"). */
  customInstructions: string;
  /** Second and third part of the personal instructions, for models whose context can carry more (see core/instructions.ts). */
  customInstructions2?: string;
  customInstructions3?: string;
  /** The skills the person made or imported (the ones that come with the app are in core/skills-default.json). */
  /** Ids of the default skills the person uninstalled (Customize > Skills); they can be put back. */
  removedSkills?: string[];
  skills?: import("../core/skills").Skill[];
  /** Choosing a skill switches to the model it recommends when that model is installed (default on). */
  skillAutoModel?: boolean;
  /** Thinking level chosen in the model menu; applied to models that can think. */
  effort: Effort;
  /** Models may delegate to sub-agents. */
  subagents: boolean;
  /**
   * A tuned per-turn budget: the cap on ALL model calls one user-visible
   * turn makes, summed across every run it spawns. null/unset = the policy's measured
   * default (src/core/harness/policy.ts). A saved pair that is not two positive numbers is
   * ignored (the default stands) — the guard is never disabled by a bad value.
   */
  turnBudget?: { maxCalls: number; maxOutputTokens: number } | null;
  /** Days run journals and offloaded payloads are kept (src/core/retention.ts); null keeps them. */
  privacy?: { retentionDays?: number | null };
  /** Installed models listed in the quick model menu. Unset = all of them. */
  quickModelIds?: string[];
  /** Run the artifacts the model writes (pages in a hidden window, JS / Python syntax) and send the errors back. */
  autoCheck: boolean;
  /** Bigger, slower model that reads the code and the errors and fixes them. null = the writing model fixes its own errors. */
  reviewerModelId: string | null;
  /** How many check-and-fix rounds at most. */
  reviewRounds: number;
  /** Which model writes what when files are built: the planner, the page, the stylesheet, the script. A role without a model uses the chat model. */
  writers: Partial<Record<WriterRole, string>>;
  /** The Developer tab is shown in Settings. */
  developer: boolean;
  /** Changes to the Dynamic model: which models do which kind of task, and whether the model may be asked to sort a request. */
  /** Models that only load on the NPU under some setting (window, NPU sessions, buffer size), found by the benchmark or the NPU load test: the app starts them that way. */
  /** Models that do not load on the NPU alone may run in hybrid mode (part on the CPU), found by the benchmark or the NPU load test. */
  allowHybridLoad?: boolean;
  /** The NPU is reset by itself when it is stuck (after one permission from Windows). On unless set to false. */
  autoResetNpu?: boolean;
  /**
   * What the window's close button does — the ONE close-behavior setting shared by
   * the renderer, the Tauri host (`closeAction` reads here; the legacy Rust
   * `minimizeToTray` boolean is migrated away).
   * "quit" is the default: closing MKMN exits the whole application. "tray" is an
   * explicit user choice: hide to the notification area and keep running.
   */
  closeAction?: "tray" | "quit";
  /** The one-time notice about closing to the notification area was dismissed for good. */
  closeNoticeOff?: boolean;
  /** Where each model was seen to run on this PC (by its geniex reference): all on the NPU, NPU and CPU together, or the CPU only. */
  placements?: Record<string, "npu" | "hybrid" | "gpu" | "cpu">;
  /** The models no setting loaded on this PC: hidden from the list until a newer GenieX or a successful load. */
  loadFailures?: Record<string, { reason: string; geniex: string | null; at: string }>;
  loadProfiles?: Record<string, { id: string; label: string; maxCtx?: number; env?: Record<string, string>; compute?: string; at: string; v?: number }>;
  dynamic?: { profile?: string; table?: Record<string, Partial<Record<string, string[]>>>; askModel?: boolean; router?: boolean; routerModel?: string };
  /** On by default. On: a tool that is switched on still runs only when the message starts with its command (/web, /images, /agents, /check, /improve), and the router is not asked whether to search. */
  toolsOnCommand?: boolean;
  /**
   * Summarize the oldest part of a long conversation before the window is full: the
   * fold runs in the background right after an answer, so the next send never waits
   * for it. On by default (`!== false`); "Summarize now" in the chat always works.
   */
  autoCompact?: boolean;
  humainUsdRates?: Record<string, { input: number; output: number }>;
  humainDisabledFeatures?: Partial<Record<import("./humain").HumainFeature, boolean>>;
  humainFuseEffort?: typeof import("./humain").FUSE_EFFORTS[number];
  humainChatSearch?: "off" | "search" | "research";
  humainMode?: import("./humain").HumainMode;
  humainFuseModel?: string;
  humainNodeModel?: string;
  humainFuseChatApi?: "chat/completions" | "responses" | "messages";
  humainNodeChatApi?: "chat/completions" | "responses" | "messages";
  /** After an answer with files, keep improving them round after round. */
  agentLoop: boolean;
  agentRounds: number;
  agentMinutes: number;
  /** What to improve, in the user's words; empty = better in every way. */
  agentGoal: string;
  /** Presentations that skip optional work: the requested slide count is kept, there is no vision check of the screenshots, while a slide is being written its preview redraws at most once a second, and a slide is fixed when the app's own layout check finds it too tight. */
  deckLowPower?: boolean;
  /** Files the assistant writes open in the panel beside the chat. On by default; off leaves them as cards in the answer and opens the Files page instead. */
  openFilesBesideChat?: boolean;
  /** UI size, Ctrl + / Ctrl - / Ctrl 0. */
  uiZoom?: number;
}

// ---- projects, artifacts, scheduled tasks

export interface ProjectFile {
  id: string;
  name: string;
  content: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  /** Standing instructions: how the assistant should behave inside this project. */
  instructions: string;
  /** Knowledge: text the assistant gets as context in every chat of the project. */
  files: ProjectFile[];
  /** A folder on this computer the assistant may explore (read only) in every chat of the project. */
  folder?: string;
  /** Kept at the top of the sidebar's project list. */
  pinned?: boolean;
  /** Hidden from the sidebar and the project list until restored. Its chats are kept. */
  archived?: boolean;
  created: number;
  updated: number;
}

export type ArtifactKind = "html" | "svg" | "markdown" | "code" | "docx" | "xlsx" | "pptx";

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  /** Language of a "code" artifact. */
  language: string;
  content: string;
  projectId: string | null;
  source: { type: "chat" | "task" | "manual"; conversationId?: string; taskId?: string };
  /** What this save changed, in a few words: the title of the version it makes (see core/versions). */
  note?: string;
  /** Who made the change; "auto" for a fix the app kept by itself. */
  by?: "assistant" | "auto" | "you";
  created: number;
  updated: number;
}

export type Schedule =
  | { kind: "once"; at: number }
  | { kind: "interval"; everyMin: number }
  | { kind: "daily"; time: string }
  /** days: 0 = Sunday … 6 = Saturday */
  | { kind: "weekly"; days: number[]; time: string };

export interface TaskRun {
  id: string;
  startedAt: number;
  finishedAt: number;
  status: "ok" | "error";
  output: string;
  error?: string;
  artifactIds: string[];
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  projectId: string | null;
  /** The project as it was when the task was last saved (Tauri: the project store lives in
   * the webview, so the scheduler's run carries a snapshot). */
  project?: Project | null;
  /** null = whichever model is selected when it runs. */
  modelId: string | null;
  schedule: Schedule;
  enabled: boolean;
  created: number;
  nextRun: number | null;
  running: boolean;
  runs: TaskRun[];
}

export interface HfSearchResult {
  repo: string;
  downloads: number;
  likes: number;
  updated: string | null;
}

/** The "Explore" browser: models from several sources, estimated against this machine before anything is downloaded. */
export type BrowseSort = "downloads" | "likes" | "trending" | "recent";
/** Which 4-bit family a file belongs to: Q4_0 runs best on the NPU, the other 4-bit quants may use the CPU, the rest is 8-bit and up. */
export type QuantClass = "q4_0" | "other4" | "other";

export interface BrowseQuery {
  query: string;
  sort: BrowseSort;
  /** How many repos to scan on Hugging Face (more = further down the list). */
  limit: number;
  sources: SourceId[];
  /** A repo shows when it has a file in one of these families. Sources that do not list files are not filtered. */
  quants: QuantClass[];
  /** Estimates to show: green = should run, amber = caution, red = unknown or too big (still installable). */
  levels: Level[];
}

export interface BrowseRow {
  source: SourceId;
  repo: string;
  /** What `geniex pull` is given. For Docker Hub a version still has to be picked. */
  ref: string;
  url: string;
  engine: Engine;
  downloads: number;
  likes: number;
  updated: string | null;
  description: string | null;
  paramsB: number | null;
  architecture: string | null;
  isMoe: boolean;
  pipeline: string | null;
  tags: string[];
  /** Context the model was trained for, from the GGUF header. */
  contextLength?: number | null;
  /** Quants found in the file names, e.g. ["Q4_0", "Q8_0"]. */
  quants: string[];
  /** The quant the estimate is made for. */
  quant: string | null;
  hasQ4_0: boolean;
  /** Estimated size of that file. */
  estGB: number | null;
  /** The size and quant are chosen on a second step (Docker Hub tags). */
  needsVersion: boolean;
  /** Estimate at a short context; the exact check runs on "Check and install". */
  verdict: Verdict;
}

/** One downloadable version of a Docker Hub model: size and quant are in its tag. */
export interface BrowseVariant {
  tag: string;
  ref: string;
  quant: string | null;
  paramsB: number | null;
  sizeGB: number | null;
  updated: string | null;
  verdict: Verdict;
}

export interface BrowseResult {
  rows: BrowseRow[];
  /** Repos looked at before the filters. */
  scanned: number;
  /** Repos left out by the filters. */
  hidden: number;
  /** A source that could not be reached, in plain words. */
  notes: string[];
}

/** What a pasted link, command or name turned into. */
export type ResolveResult =
  | { type: "model"; inspection: HfInspection }
  | { type: "search"; query: string; note: string | null };

export interface HfInspection {
  repo: string;
  files: { path: string; sizeBytes: number }[];
  chosen: { path: string; quant: string; sizeGB: number; note: string | null } | null;
  gguf: GgufInfo | null;
  verdict: Verdict | null;
  entry: CatalogEntry | null;
  notes: string[];
}

export interface GgufInfo {
  architecture: string;
  name: string | null;
  blockCount: number | null;
  attentionLayers: number | null;
  headCount: number | null;
  kvHeads: number | null;
  headDim: number | null;
  contextLength: number | null;
  expertCount: number | null;
  paramsB: number | null;
}

// ---------------------------------------------------------------- voice

export type VoiceKind = "stt" | "tts";
export type VoiceFamily = "whisper" | "moonshine" | "transducer" | "kokoro" | "vits" | "foundry";

export interface VoiceModel {
  id: string;
  kind: VoiceKind;
  name: string;
  family: VoiceFamily;
  /** Release archive name without ".tar.bz2" (k2-fsa/sherpa-onnx releases). */
  archive: string;
  /** SHA-256 (hex) and exact size of that archive: a download that does not match is never extracted. */
  sha256?: string;
  bytes?: number;
  sizeMB: number;
  languages: string;
  note: string;
  default?: boolean;
  /** Named speaker ids when known; otherwise the UI offers a numeric voice with a preview button. */
  voices?: { sid: number; name: string }[];
  /** Numeric sid range for models whose voice names are not listed here. */
  sidCount?: number;
  /** A Microsoft Foundry Local model (run by its server, not by the voice worker): its alias, and the hardware its build is made for. */
  foundryAlias?: string;
  device?: "NPU" | "GPU" | "CPU";
}

export interface VoiceModelView {
  model: VoiceModel;
  installed: boolean;
}

/** A speech model the app proposes to install in one click: the best one for this PC, and the plain CPU one when it is not that. */
export interface VoiceNeed {
  kind: VoiceKind;
  model: VoiceModel;
  alt?: VoiceModel;
}

export interface VoiceSettings {
  sttModelId: string | null;
  ttsModelId: string | null;
  ttsSid: number;
  ttsSpeed: number;
  /** Voice chat: speaking over the assistant stops it. */
  allowInterrupt: boolean;
  /** Voice chat: send the transcription right away. */
  autoSend: boolean;
  /** Language hint for multilingual dictation; "" = auto-detect. */
  sttLanguage: string;
  /** Where each voice model runs. CPU keeps the NPU free for the chat model; NPU is faster if it fits. */
  sttCompute: "cpu" | "npu";
  ttsCompute: "cpu" | "npu";
  /** Quietest sound (RMS, 0..1) that can start a transcription: below it, nothing is sent to the recognizer. */
  minLevel: number;
  /** Voice chat, while the assistant talks: quietest sound (RMS, 0..1) that can interrupt it. */
  interruptLevel: number;
  /** The microphone to use ("" = the system default). */
  micDeviceId: string;
  /** Voice chat: how long (ms) real words must be said without a break to interrupt the assistant. */
  interruptMs: number;
  /** Shortest sound (ms) that counts as speech. */
  minSpeechMs: number;
  /** Silence (ms) that ends what I say and sends it. */
  endSilenceMs: number;
  /** Adapt that silence to what was said: short after a finished sentence, longer after a comma or a linking word. */
  smartEnd: boolean;
  /** The model voice chat talks with: "" the fast one the app picks, "chat" the conversation's own model, or a model id. */
  voiceModelId: string;
  /** Voice chat: silence (ms) before the assistant answers, long enough that stopping to think does not trigger it. */
  waitMs: number;
  /** Show the words while they are being said, and correct them as the sentence goes on. */
  liveText: boolean;
}

export interface VoiceStatus {
  worker: "off" | "starting" | "ready" | "failed";
  stt: string | null;
  tts: string | null;
  /** Provider actually in use; differs from the setting when the NPU load failed and CPU took over. */
  sttProvider: "cpu" | "npu" | null;
  ttsProvider: "cpu" | "npu" | null;
  /** The language the loaded recognizer was configured with ("" = auto): a changed sttLanguage must reload it. */
  sttLang?: string | null;
  /** Plain-words note, e.g. why a model fell back to the CPU. */
  notice: string | null;
  ttsSampleRate: number | null;
  error: FriendlyError | null;
}

export interface VoiceDownloadProgress {
  id: string;
  phase: "downloading" | "extracting" | "done" | "error" | "cancelled";
  percent: number | null;
  error?: FriendlyError;
}

export interface SpeakChunk {
  id: string;
  samples: Float32Array;
  sampleRate: number;
  done: boolean;
  /** Which voice session emitted this chunk: one stopped earlier must not play stale audio (see voiceChat). */
  generation?: number;
}
