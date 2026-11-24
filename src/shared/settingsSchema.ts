// The ONE declaration of every stored settings key.
//
// Every key that settings.json can hold is declared here once: its type, its ONE
// default, its allowed values, its scope (message | chat | app), its level
// (everyday | advanced), its new group, its label and one plain line, what a
// change requires (now | model-reload | restart), and the old words the search
// keeps matching. The Rust defaults and the read-time value checks are generated
// from this file by scripts/generate-settings-schema.mjs, and so is
// docs/settings-inventory.md. Nothing restates a default.
//
// Rules the file must keep:
//  - a stored key without an entry fails tests/settings-schema.test.ts;
//  - an entry nothing reads fails too, unless it carries a `hidden` reason;
//  - a label is at most 4 words and never names internals; the description is
//    one line of what the person gets, not how the app works.
//
// This module is read by three runtimes (vite, vitest, and plain `node` through
// the generator), so it stays self-contained: only `import type` here, no enums.

import type { Settings, VoiceSettings } from "./types";

export type SettingScope = "message" | "chat" | "app";
export type SettingLevel = "everyday" | "advanced";
export type SettingApplies = "now" | "model-reload" | "restart";
export type SettingType =
  | "boolean"
  | "string"
  | "number"
  | "enum"
  | "model-ref"
  | "string-list"
  | "object";

/** The groups of the Settings page, in their fixed order. */
export type SettingGroup =
  | "general"
  | "library"
  | "models"
  | "chats"
  | "files"
  | "web"
  | "fuse"
  | "node"
  | "about"
  | "voice"
  | "developer";

export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; label: string }> = [
  { id: "general", label: "App settings" },
  { id: "library", label: "Models" },
  { id: "models", label: "Speed & memory" },
  { id: "chats", label: "Chats & answers" },
  { id: "files", label: "Files & projects" },
  { id: "web", label: "Shared cloud tools" },
  { id: "fuse", label: "HUMAIN Fuse" },
  { id: "node", label: "HUMAIN Node" },
  { id: "voice", label: "Voice" },
  { id: "developer", label: "Developer" },
  { id: "about", label: "About" },
];

export interface SettingDecl {
  /** The stored key, as a dot path for nested keys ("voice.readAloud"). */
  key: string;
  type: SettingType;
  /** THE one default. Generated into the Rust host; never restated elsewhere. */
  default: unknown;
  /** Allowed values (enum) or the value range (number). */
  values?: readonly string[];
  min?: number;
  max?: number;
  /** Where the choice belongs: this message, this chat, or the whole app. */
  scope: SettingScope;
  /** everyday settings sit above the folded "Advanced" of their group. */
  level: SettingLevel;
  group: SettingGroup;
  /** At most 4 words, no internal names. */
  label: string;
  /** One line (about 60 characters) of what the person gets. */
  description: string;
  /** The detail behind the "?" tooltip, when one line is not enough. */
  tooltip?: string;
  /** What a change requires, said beside the control. */
  applies: SettingApplies;
  /** Words the search keeps matching, including the old names of this key. */
  oldWords?: string[];
  /** Recorded reason a key has no control of its own (the inventory lists it). */
  hidden?: string;
  /** A credential: never written to an export file, never shown in full. */
  secret?: true;
  /** Set on this PC only (why): never exported, refused on import. A path to a
   *  program the app RUNS is one; an imported file must not choose it. */
  thisPcOnly?: string;
  /** The key's place in the earlier Settings layout. */
  legacy?: { tab: string; section?: string };
}

export const SETTINGS_SCHEMA = [
  // ---------------------------------------------------------------- General
  {
    key: "appearance", type: "enum", default: "system", values: ["light", "dark", "system"],
    scope: "app", level: "everyday", group: "general", applies: "now",
    label: "Theme", description: "Light, dark, or follow Windows.",
    oldWords: ["dark", "light", "system", "theme", "appearance", "colours"],
    legacy: { tab: "general", section: "sec-general-appearance" },
  },
  {
    key: "closeAction", type: "enum", default: "quit", values: ["quit", "tray"],
    scope: "app", level: "everyday", group: "general", applies: "now",
    label: "Close button", description: "Closing exits MKMN, or hides it to the tray.",
    tooltip: "\"Hide to the tray\" keeps MKMN running in the notification area after the window closes.",
    oldWords: ["quit", "tray", "notification area", "exit", "close", "window"],
    legacy: { tab: "general", section: "sec-general-close" },
  },
  {
    key: "developer", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "developer", applies: "now",
    label: "Developer tools", description: "Show the Developer group with its tests and panels.",
    oldWords: ["developer mode", "advanced tools", "show developer"],
    legacy: { tab: "adv-system", section: "sec-sys-devtools" },
  },
  {
    key: "migrateLegacyData", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "general", applies: "restart",
    label: "Legacy data copy", description: "Copy the old data folder on next start.",
    hidden: "read by the host's opt-in legacy-data migration (paths.rs); the installer offers it, no Settings control",
  },

  {
    key: "closeNoticeOff", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "general", applies: "now",
    label: "Close reminder", description: "Show the one-time notice about closing to the tray.",
    oldWords: ["first-close notice", "notice", "reminder"],
    legacy: { tab: "general", section: "sec-general-close" },
  },
  {
    key: "uiZoom", type: "number", default: 1, min: 0.5, max: 2,
    scope: "app", level: "advanced", group: "general", applies: "now",
    label: "Interface size", description: "The zoom of the whole window.",
    hidden: "no reader found (Ctrl + / Ctrl - zoom is not persisted); kept so old files keep the key",
  },

  // ---------------------------------------------------------- Models & speed
  {
    key: "computeMode", type: "enum", default: "manual", values: ["auto", "manual"],
    scope: "app", level: "everyday", group: "models", applies: "model-reload",
    label: "Device choice", description: "Pick the chip yourself, or let MKMN choose per request.",
    oldWords: ["performance mode", "adaptive", "automatic"],
    legacy: { tab: "models", section: "sec-models-compute" },
  },
  {
    key: "autoGoal", type: "enum", default: "balanced", values: ["balanced", "battery_saver", "fastest"],
    scope: "app", level: "everyday", group: "models", applies: "model-reload",
    label: "Auto goal", description: "What the automatic choice aims at: speed or battery.",
    oldWords: ["goal", "battery", "fastest", "balanced"],
    legacy: { tab: "models", section: "sec-models-compute" },
  },
  {
    key: "compute", type: "enum", default: "npu", values: ["cpu", "gpu", "npu", "hybrid"],
    scope: "app", level: "everyday", group: "models", applies: "model-reload",
    label: "Runs on", description: "The chip models run on, when you choose it yourself.",
    oldWords: ["compute", "npu", "cpu", "gpu", "hybrid"],
    legacy: { tab: "models", section: "sec-models-compute" },
  },
  {
    key: "idleReleaseSec", type: "number", default: 300, min: 0, max: 86400,
    scope: "app", level: "everyday", group: "models", applies: "model-reload",
    label: "Release when idle", description: "How long an unused model stays in memory.",
    tooltip: "0 = never release. The memory is freed once the model has been idle this long.",
    oldWords: ["keep alive", "keepalive", "retention", "memory release", "unload", "always loaded"],
    legacy: { tab: "models", section: "sec-models-retention" },
  },
  {
    key: "warmUpWhileTyping", type: "boolean", default: false,
    scope: "app", level: "everyday", group: "models", applies: "now",
    label: "Warm up while typing",
    description: "Load the chat's local model as you start typing, before Send.",
    tooltip: "Can shorten the wait after Send. The model may use memory and power before a message is sent, also for a draft you never send. Local models only.",
    oldWords: ["preload", "warm up", "warm-up", "predictive", "load while typing"],
    legacy: { tab: "models", section: "sec-models-retention" },
  },
  {
    key: "keepaliveSec", type: "number", default: 300, min: 0, max: 86400,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Keep-alive", description: "The same wait, named as the runtime receives it.",
    hidden: "kept in step with idleReleaseSec by the retention editor; idleReleaseSec is the user-facing knob",
    legacy: { tab: "models", section: "sec-models-retention" },
  },
  {
    key: "loadingStrategy", type: "enum", default: "demand", values: ["always", "demand"],
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Loading strategy", description: "Load a model when needed, or keep one always ready.",
    oldWords: ["loading strategy", "preload"],
    legacy: { tab: "models", section: "sec-models-retention" },
  },
  {
    key: "startupTimeoutSec", type: "number", default: 90, min: 30, max: 300,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Startup timeout", description: "How long a slow model may take to start.",
    oldWords: ["startup", "timeout"],
    legacy: { tab: "models", section: "sec-models-retention" },
  },
  {
    key: "npuBudgetOverrideGB", type: "number", default: null, min: 1, max: 64,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "NPU memory cap", description: "Use less of the NPU memory than was detected.",
    oldWords: ["memory use", "budget", "npu shared memory", "memory estimate"],
    legacy: { tab: "models", section: "sec-models-memory" },
  },
  {
    key: "nctxMode", type: "enum", default: "auto", values: ["auto", "2048", "4096", "8192"],
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Context window", description: "How much of a chat is held at once.",
    oldWords: ["context", "window", "tokens", "long conversation"],
    legacy: { tab: "models", section: "sec-models-context" },
  },
  {
    key: "kvType", type: "enum", default: "f16", values: ["f16", "q8_0", "q4_0"],
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Cache precision", description: "Trade conversation memory for quality.",
    oldWords: ["cache precision", "quantize cache", "f16", "q8"],
    legacy: { tab: "models", section: "sec-models-context" },
  },
  {
    key: "kvInRam", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Cache in RAM", description: "Keep the conversation cache in system memory.",
    oldWords: ["kv in ram", "cache memory"],
    legacy: { tab: "models", section: "sec-models-context" },
  },
  {
    key: "powerProfile", type: "enum", default: "auto",
    values: ["auto", "burst", "high_performance", "sustained_high_performance", "balanced", "low_balanced", "power_saver", "high_power_saver", "low_power_saver"],
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Power mode", description: "Peak speed, steady speed, or by power source.",
    tooltip: "\"By power source\" picks peak speed on mains power and adapts on battery. The other names are the runtime's own clock modes, quietest first: low power saver, power saver, high power saver, low balanced, balanced, high performance, sustained high performance, burst.",
    oldWords: ["power mode", "battery", "clock", "power profile", "burst", "balanced", "saver"],
    legacy: { tab: "models", section: "sec-models-power" },
  },
  {
    key: "speculativeDecoding", type: "object", default: { enabled: false },
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Draft decoding", description: "Draft small steps ahead to answer faster.",
    hidden: "the leaves (enabled, specType, draftTokens) are declared separately; the switch writes the object",
    legacy: { tab: "models", section: "sec-models-speculative" },
  },
  {
    key: "speculativeDecoding.enabled", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Draft decoding", description: "Draft small steps ahead to answer faster.",
    oldWords: ["speculative decoding", "draft tokens", "spec", "faster answers"],
    legacy: { tab: "models", section: "sec-models-speculative" },
  },
  {
    key: "speculativeDecoding.specType", type: "enum", default: "ngram-simple",
    values: ["ngram-simple", "ngram-cache", "ngram-mod", "ngram-map-k", "ngram-map-k4v", "draft-simple", "draft-mtp", "draft-eagle3"],
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Draft strategy", description: "How the draft steps are guessed.",
    oldWords: ["speculative decoding", "draft strategy", "ngram", "mtp", "eagle"],
    legacy: { tab: "models", section: "sec-models-speculative" },
  },
  {
    key: "speculativeDecoding.draftTokens", type: "number", default: 4, min: 1, max: 8,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Draft steps", description: "How far ahead each draft runs.",
    legacy: { tab: "models", section: "sec-models-speculative" },
  },
  {
    key: "speculativeDecoding.draftModel", type: "string", default: "",
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Draft model", description: "A small model that drafts, for the draft strategies.",
    tooltip: "A cached model name or a local .gguf path. Only the draft-* strategies use one; the ngram strategies guess from the text itself.",
    legacy: { tab: "models", section: "sec-models-speculative" },
  },
  {
    key: "speculativeDecoding.draftMin", type: "number", default: 0, min: 0, max: 16,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Fewest draft steps", description: "Shortest draft batch accepted each step.",
    tooltip: "0 = the runtime's own default.",
    legacy: { tab: "models", section: "sec-models-speculative" },
  },
  {
    key: "speculativeDecoding.draftPMin", type: "number", default: 0, min: 0, max: 1,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Draft confidence", description: "How sure a draft token must be to count.",
    tooltip: "0 = the runtime's own default.",
    legacy: { tab: "models", section: "sec-models-speculative" },
  },
  {
    key: "geniexNgl", type: "number", default: -1, min: -1, max: 999,
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Offload layers", description: "How many layers run on the accelerator.",
    tooltip: "For the llama.cpp models: -1 = all layers, 0 = none (everything on the CPU), a number = that many. A QAIRT bundle always runs whole on the NPU.",
    oldWords: ["ngl", "gpu layers", "offload", "layers"],
    legacy: { tab: "models", section: "sec-models-offload" },
  },
  {
    key: "vitCompute", type: "string", default: "",
    scope: "app", level: "advanced", group: "models", applies: "model-reload",
    label: "Vision encoder", description: "Where a vision model reads pictures.",
    tooltip: "A compute unit for the image part of a vision model (a chip like \"cpu\" or an NPU session like \"HTP1\"). Empty uses the runtime's default. A second NPU session can keep a vision model that fails on one session working.",
    oldWords: ["vit compute", "vision encoder", "image encoder", "vit-compute"],
    legacy: { tab: "models", section: "sec-models-offload" },
  },
  {
    key: "allowHybridLoad", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "library", applies: "model-reload",
    label: "Allow part-CPU loading", description: "Let a model the NPU refuses run partly on the CPU.",
    tooltip: "Off by default: models run on the NPU. When on, a model the NPU refuses may load as a hybrid (NPU and CPU) as a last resort, and its badge says so.",
    oldWords: ["hybrid loading", "hybrid", "cpu fallback"],
    legacy: { tab: "library", section: "sec-library-options" },
  },
  {
    key: "adaptiveState", type: "object", default: {},
    scope: "app", level: "advanced", group: "models", applies: "now",
    label: "Auto state", description: "The automatic device choice's last decision.",
    hidden: "the automatic selector's last decision, kept for display and cooldown; a record, not a preference",
  },
  {
    key: "selectedModelId", type: "model-ref", default: null,
    scope: "app", level: "advanced", group: "library", applies: "model-reload",
    label: "Chosen model", description: "The model the chat uses.",
    hidden: "the chosen model, edited from the model menu; not a Settings control",
  },
  {
    key: "lastModelId", type: "model-ref", default: null,
    scope: "app", level: "advanced", group: "library", applies: "now",
    label: "Last model", description: "The previous choice, kept for history.",
    hidden: "written with selectedModelId; no reader; kept so old files keep the key",
  },
  {
    key: "pinnedGeniexVersion", type: "model-ref", default: null,
    scope: "app", level: "advanced", group: "developer", applies: "restart",
    label: "Pinned version", description: "A runtime version held instead of the newest.",
    hidden: "declared but never read; kept so old files keep the key",
  },
  {
    key: "qairtLib", type: "string", default: "",
    thisPcOnly: "a runtime folder on this PC is chosen here, never by an imported file",
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Runtime libraries", description: "Run the NPU engine on another runtime copy.",
    tooltip: "A QAIRT SDK root or a folder of QNN libraries, used instead of the runtime bundled with GenieX. Leave empty for the bundled one. Only NPU (QAIRT) models use it.",
    oldWords: ["qairt", "qnn libraries", "runtime sdk", "qairt-lib"],
    legacy: { tab: "adv-runtime", section: "sec-rt-genies" },
  },
  {
    key: "geniexLog", type: "enum", default: "none",
    values: ["none", "error", "warn", "info", "debug", "trace"],
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Runtime log level", description: "How much the runtime itself writes to its log.",
    tooltip: "\"None\" sends nothing. The higher levels are for support: the runtime's own words join the server log under Last error.",
    oldWords: ["geniex log", "log level", "debug log", "trace"],
    legacy: { tab: "adv-runtime", section: "sec-rt-genies" },
  },
  {
    key: "geniexUpdateCheck", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Runtime update check", description: "Let the runtime look online for a newer version when it starts.",
    tooltip: "Off: the model server starts with --skip-update and makes no update request. On: the runtime checks as it would on its own; its notice only reaches the server log.",
    oldWords: ["skip update", "skip-update", "geniex update", "update check"],
    legacy: { tab: "adv-runtime", section: "sec-rt-genies" },
  },

  // -------------------------------------------------------- Chats & answers
  {
    key: "effort", type: "enum", default: "auto", values: ["auto", "off", "low", "medium", "high"],
    scope: "message", level: "everyday", group: "chats", applies: "now",
    label: "Thinking", description: "How long the model thinks before answering.",
    oldWords: ["thinking level", "effort", "reasoning", "auto"],
    legacy: { tab: "build", section: "sec-chats-thinking" },
  },
  {
    key: "subagents", type: "boolean", default: false,
    scope: "chat", level: "everyday", group: "chats", applies: "now",
    label: "Sub-agents", description: "Split a big job into parts, one after another.",
    oldWords: ["agents", "split job", "delegate"],
    legacy: { tab: "build", section: "sec-chats-agents" },
  },
  {
    key: "autoCompact", type: "boolean", default: true,
    scope: "chat", level: "everyday", group: "chats", applies: "now",
    label: "Keep long chats going", description: "Summarize the oldest messages in the background.",
    tooltip: "After an answer, the oldest part of a long conversation is summarized and kept with the chat; a question about those turns still finds them.",
    oldWords: ["summarize old messages", "compact", "summary", "long chat", "memory", "context"],
    legacy: { tab: "build", section: "sec-chats-long" },
  },
  {
    key: "privacy.retentionDays", type: "number", default: null, min: 1, max: 3650,
    scope: "app", level: "advanced", group: "chats", applies: "restart",
    label: "Keep chat records for", description: "Days run records and long replies are kept; empty keeps them.",
    tooltip: "Run journals and offloaded replies older than this are removed when the app starts. Empty keeps everything, as before.",
    oldWords: ["retention", "delete old", "history", "journals", "privacy"],
    hidden: "no Settings control yet: set it in Config/settings.json; the sidecar reads it at start (src/core/retention.ts)",
  },
  {
    key: "turnBudget", type: "object", default: null,
    scope: "chat", level: "advanced", group: "chats", applies: "now",
    label: "Turn budget", description: "A cap on the model calls one turn may make.",
    hidden: "the pair is edited as two selects; the policy owns the unset fallback",
    legacy: { tab: "build", section: "sec-build-behavior" },
  },
  {
    key: "turnBudget.maxCalls", type: "number", default: 120, min: 1, max: 100000,
    scope: "chat", level: "advanced", group: "chats", applies: "now",
    label: "Calls per turn", description: "Model calls one turn may make at most.",
    legacy: { tab: "build", section: "sec-build-behavior" },
  },
  {
    key: "turnBudget.maxOutputTokens", type: "number", default: 100000, min: 1, max: 100000000,
    scope: "chat", level: "advanced", group: "chats", applies: "now",
    label: "Output per turn", description: "Answer tokens one turn may spend at most.",
    legacy: { tab: "build", section: "sec-build-behavior" },
  },
  {
    key: "toolsOnCommand", type: "boolean", default: false,
    scope: "chat", level: "everyday", group: "chats", applies: "now",
    label: "Tools on / only", description: "A tool runs only when the message starts with /.",
    tooltip: "Without a command it is a plain chat: no tool, no router, no file-building steps.",
    oldWords: ["tools on command only", "slash words", "command only", "tools"],
    legacy: { tab: "behavior", section: "sec-chats-tools" },
  },

  // ------------------------------------------------------- Files & projects
  {
    key: "openFilesBesideChat", type: "boolean", default: true,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Files beside chat", description: "Written files open in the panel on the right.",
    tooltip: "Off: a written file stays a card in the answer and opens from the Files page.",
    oldWords: ["files beside the chat", "panel", "artifacts"],
    legacy: { tab: "build", section: "sec-files-panels" },
  },
  {
    key: "autoCheck", type: "boolean", default: false,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Code check", description: "Run what it writes and fix the errors.",
    oldWords: ["code check", "run and fix", "auto check", "review"],
    legacy: { tab: "build", section: "sec-build-check" },
  },
  {
    key: "reviewerModelId", type: "model-ref", default: null,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Review model", description: "A bigger model that reads and fixes the code.",
    oldWords: ["review model", "reviewer", "fix rounds"],
    legacy: { tab: "build", section: "sec-build-check" },
  },
  {
    key: "reviewRounds", type: "number", default: 2, min: 1, max: 3,
    scope: "app", level: "advanced", group: "files", applies: "now",
    label: "Fix rounds", description: "Check-and-fix rounds at most.",
    oldWords: ["review rounds", "fix rounds"],
    legacy: { tab: "build", section: "sec-build-check" },
  },
  {
    key: "writers", type: "object", default: {},
    scope: "app", level: "advanced", group: "files", applies: "now",
    label: "Which model writes", description: "Give each writing role its own model.",
    oldWords: ["which model writes what", "planner", "html", "css", "javascript", "writers", "roles"],
    legacy: { tab: "build", section: "sec-build-writers" },
  },
  {
    key: "agentLoop", type: "boolean", default: false,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Auto-improve", description: "Keep improving written code, round after round.",
    oldWords: ["auto-improve", "improve loop", "agent loop", "rounds"],
    legacy: { tab: "build", section: "sec-build-improve" },
  },
  {
    key: "agentRounds", type: "number", default: 6, min: 1, max: 50,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Improve rounds", description: "Improvement rounds at most.",
    oldWords: ["rounds"],
    legacy: { tab: "build", section: "sec-build-improve" },
  },
  {
    key: "agentMinutes", type: "number", default: 30, min: 1, max: 480,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Improve time", description: "Minutes the improving may run at most.",
    oldWords: ["time at most"],
    legacy: { tab: "build", section: "sec-build-improve" },
  },
  {
    key: "agentGoal", type: "string", default: "",
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Improve goal", description: "What to improve, in your words.",
    oldWords: ["direction", "goal"],
    legacy: { tab: "build", section: "sec-build-improve" },
  },
  {
    key: "deckLowPower", type: "boolean", default: false,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Low-power slides", description: "Keep the slide count; skip the extra checks.",
    tooltip: "Skips the vision check of screenshots, redraws a slide at most once a second while it is written, and fixes only slides the app's own layout check finds too tight.",
    oldWords: ["presentations", "low power", "slides", "deck"],
    legacy: { tab: "build", section: "sec-build-improve" },
  },
  {
    key: "skillAutoModel", type: "boolean", default: true,
    scope: "app", level: "everyday", group: "files", applies: "now",
    label: "Follow skill's model", description: "A skill can switch to the model it recommends.",
    oldWords: ["skill model switching", "quick model", "recommended model"],
    legacy: { tab: "build", section: "sec-build-improve" },
  },
  {
    key: "skills", type: "object", default: [],
    scope: "app", level: "advanced", group: "files", applies: "now",
    label: "Skills", description: "The step-by-step recipes you made or imported.",
    hidden: "edited on the Customize page; the schema records the stored list",
  },
  {
    key: "removedSkills", type: "string-list", default: [],
    scope: "app", level: "advanced", group: "files", applies: "now",
    label: "Removed skills", description: "Default skills you uninstalled; they can be put back.",
    hidden: "managed on the Customize page; the schema records the stored list",
  },
  {
    key: "customInstructions", type: "string", default: "",
    scope: "app", level: "advanced", group: "files", applies: "now",
    label: "About me", description: "Your standing instructions to the assistant.",
    hidden: "edited on the Customize page (the Personal instructions editor)",
  },
  {
    key: "customInstructions2", type: "string", default: "",
    scope: "app", level: "advanced", group: "files", applies: "now",
    label: "About me (part 2)", description: "Second part, for models with a long window.",
    hidden: "second part of the personal instructions, edited on the Customize page",
  },
  {
    key: "customInstructions3", type: "string", default: "",
    scope: "app", level: "advanced", group: "files", applies: "now",
    label: "About me (part 3)", description: "Third part, for models with a long window.",
    hidden: "third part of the personal instructions, edited on the Customize page",
  },
  {
    key: "quickModelIds", type: "string-list", default: [],
    scope: "app", level: "advanced", group: "library", applies: "now",
    label: "Pinned models", description: "The models listed in the quick model menu.",
    hidden: "edited in the model menu's pin control, not in Settings",
  },

  {
    key: "humainUsdRates", type: "object", default: {},
    scope: "app", level: "advanced", group: "web", applies: "now",
    label: "Chat cost estimates", description: "Set USD rates per million tokens for a cloud model.",
    legacy: { tab: "search", section: "sec-humain-cost" },
  },
  {
    key: "humainDisabledFeatures", type: "object", default: {},
    scope: "app", level: "advanced", group: "web", applies: "now",
    label: "HUMAIN capabilities", description: "Enable or disable provider capabilities.",
    legacy: { tab: "search", section: "sec-humain-features" },
  },
  {
    key: "humainFuseEffort", type: "enum", default: "default", values: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
    scope: "app", level: "everyday", group: "fuse", applies: "now",
    label: "Fuse thinking", description: "Choose the reasoning effort for Fuse chat.",
    legacy: { tab: "fuse", section: "sec-humain-fuse-chat" },
  },
  {
    key: "humainChatSearch", type: "enum", default: "off", values: ["off", "search", "research"],
    scope: "app", level: "everyday", group: "fuse", applies: "now",
    label: "Fuse chat search", description: "Use hosted search or ask for a cited research answer.",
    legacy: { tab: "fuse", section: "sec-humain-fuse-chat" },
  },
  {
    key: "humainMode", type: "enum", default: "local", values: ["local", "fuse", "node"],
    scope: "app", level: "everyday", group: "chats", applies: "now",
    label: "Chat location", description: "Choose where chat runs: on this PC, HUMAIN Fuse, or HUMAIN Node.",
    oldWords: ["chat provider", "where chat runs", "cloud chat", "local chat", "on-device chat"],
    legacy: { tab: "chats", section: "sec-chats-location" },
  },
  {
    key: "humainFuseModel", type: "string", default: "",
    scope: "app", level: "everyday", group: "fuse", applies: "now",
    label: "Fuse chat model", description: "Select an available chat model.",
    legacy: { tab: "fuse", section: "sec-humain-fuse" },
  },
  {
    key: "humainFuseChatApi", type: "enum", default: "chat/completions", values: ["chat/completions", "responses", "messages"],
    scope: "app", level: "advanced", group: "fuse", applies: "now",
    label: "Fuse chat API", description: "Choose the API supported by the chat model.",
    legacy: { tab: "fuse", section: "sec-humain-fuse" },
  },
  {
    key: "humainNodeModel", type: "string", default: "",
    scope: "app", level: "everyday", group: "node", applies: "now",
    label: "Node chat model", description: "Select an available chat model.",
    legacy: { tab: "node", section: "sec-humain-node" },
  },
  {
    key: "humainNodeChatApi", type: "enum", default: "chat/completions", values: ["chat/completions", "responses", "messages"],
    scope: "app", level: "advanced", group: "node", applies: "now",
    label: "Node chat API", description: "Choose the API supported by the chat model.",
    legacy: { tab: "node", section: "sec-humain-node" },
  },

  // ----------------------------------------------------------------- Voice
  {
    key: "voice.micDeviceId", type: "string", default: "",
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Microphone", description: "Which microphone to listen through.",
    oldWords: ["microphone choice", "mic", "input device", "headset"],
    legacy: { tab: "voice", section: "sec-voice-mic" },
  },
  {
    key: "voice.sttModelId", type: "model-ref", default: null,
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Dictation model", description: "The model that turns speech into text.",
    oldWords: ["dictation model", "speech to text", "stt", "transcribe"],
    legacy: { tab: "voice", section: "sec-voice-dictation" },
  },
  {
    key: "voice.sttLanguage", type: "string", default: "",
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Dictation language", description: "Hint the spoken language; empty detects it.",
    oldWords: ["dictation language", "language"],
    legacy: { tab: "voice", section: "sec-voice-dictation" },
  },
  {
    key: "voice.liveText", type: "boolean", default: true,
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Show words live", description: "Show the words while you speak.",
    oldWords: ["show the words as i speak", "live text", "preview"],
    legacy: { tab: "voice", section: "sec-voice-dictation" },
  },
  {
    key: "voice.ttsModelId", type: "model-ref", default: null,
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Read-aloud voice", description: "The voice that reads answers aloud.",
    oldWords: ["read-aloud voice", "text to speech", "tts", "speaker"],
    legacy: { tab: "voice", section: "sec-voice-tts" },
  },
  {
    key: "voice.ttsSpeed", type: "number", default: 1, min: 0.5, max: 2,
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Read-aloud speed", description: "How fast the voice reads.",
    oldWords: ["read-aloud speed", "speed", "faster voice"],
    legacy: { tab: "voice", section: "sec-voice-tts" },
  },
  {
    key: "voice.voiceModelId", type: "string", default: "",
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Voice chat model", description: "The model voice conversation talks with.",
    tooltip: "Empty picks the small fast one; \"chat\" uses the conversation's own model.",
    oldWords: ["model for voice chat", "voice model", "conversation voice"],
    legacy: { tab: "voice", section: "sec-voice-chat" },
  },
  {
    key: "voice.allowInterrupt", type: "boolean", default: true,
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Interrupt by speaking", description: "Speaking over the assistant stops it.",
    oldWords: ["interrupt by speaking", "barge in", "stop talking"],
    legacy: { tab: "voice", section: "sec-voice-chat" },
  },
  {
    key: "voice.autoSend", type: "boolean", default: true,
    scope: "app", level: "everyday", group: "voice", applies: "now",
    label: "Send when I stop", description: "Send the transcription when you fall silent.",
    oldWords: ["send when i stop talking", "auto send"],
    legacy: { tab: "voice", section: "sec-voice-chat" },
  },
  {
    key: "voice.sttCompute", type: "enum", default: "cpu", values: ["cpu", "npu"],
    scope: "app", level: "advanced", group: "voice", applies: "model-reload",
    label: "Dictation runs on", description: "The chip the dictation model runs on.",
    oldWords: ["stt compute"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.ttsCompute", type: "enum", default: "cpu", values: ["cpu", "npu"],
    scope: "app", level: "advanced", group: "voice", applies: "model-reload",
    label: "Voice runs on", description: "The chip the read-aloud voice runs on.",
    oldWords: ["tts compute"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.minLevel", type: "number", default: 0.015, min: 0.002, max: 0.125,
    scope: "app", level: "advanced", group: "voice", applies: "now",
    label: "Mic threshold", description: "Quietest sound that starts a transcription.",
    oldWords: ["microphone test", "level", "threshold", "sensitivity"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.minSpeechMs", type: "number", default: 300, min: 80, max: 2000,
    scope: "app", level: "advanced", group: "voice", applies: "now",
    label: "Shortest speech", description: "Shortest sound that counts as speech.",
    oldWords: ["shortest speech"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.endSilenceMs", type: "number", default: 700, min: 200, max: 4000,
    scope: "app", level: "advanced", group: "voice", applies: "now",
    label: "End silence", description: "Silence that ends what you said and sends it.",
    oldWords: ["silence", "end"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.smartEnd", type: "boolean", default: true,
    scope: "app", level: "advanced", group: "voice", applies: "now",
    label: "Smart silence", description: "Adapt the ending silence to what was said.",
    oldWords: ["smart end", "silence"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.interruptLevel", type: "number", default: 0.056, min: 0.01, max: 0.125,
    scope: "app", level: "advanced", group: "voice", applies: "now",
    label: "Interrupt threshold", description: "How loud an interruption must be.",
    oldWords: ["interrupt level", "barge in"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.interruptMs", type: "number", default: 1000, min: 200, max: 4000,
    scope: "app", level: "advanced", group: "voice", applies: "now",
    label: "Interrupt hold", description: "How long real words must last to interrupt.",
    oldWords: ["interrupt ms"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.waitMs", type: "number", default: 2500, min: 500, max: 10000,
    scope: "app", level: "advanced", group: "voice", applies: "now",
    label: "Pause before replying", description: "The wait that keeps a pause from cutting in.",
    oldWords: ["wait ms", "pause"],
    legacy: { tab: "voice", section: "sec-voice-calibration" },
  },
  {
    key: "voice.ttsSid", type: "number", default: 0, min: 0, max: 1000,
    scope: "app", level: "advanced", group: "voice", applies: "model-reload",
    label: "Voice speaker id", description: "Which speaker a multi-voice model uses.",
    legacy: { tab: "voice", section: "sec-voice-tts" },
  },

  // ------------------------------------------------------------- Developer
  {
    key: "geniexPath", type: "string", default: null,
    thisPcOnly: "a path to a program MKMN runs is chosen on this PC, never by an imported file",
    scope: "app", level: "advanced", group: "developer", applies: "restart",
    label: "Runtime path", description: "Where the model runtime is, when not standard.",
    oldWords: ["geniex runtime", "install runtime", "runtime"],
    legacy: { tab: "adv-runtime", section: "sec-rt-genies" },
  },
  {
    key: "showKQuants", type: "boolean", default: false,
    scope: "app", level: "advanced", group: "library", applies: "now",
    label: "Show K-quants", description: "List the K and IQ quant kinds in the model list.",
    oldWords: ["show k-quants", "quant", "iq"],
    legacy: { tab: "adv-runtime", section: "sec-library-options" },
  },
  {
    key: "autoResetNpu", type: "boolean", default: true,
    scope: "app", level: "advanced", group: "developer", applies: "now",
    label: "Auto NPU reset", description: "Reset the NPU by itself when it is stuck.",
    hidden: "nothing in the desktop build acts on it (no automatic NPU reset there); the NPU load test shows it off and disabled, saying so; kept so old files keep the key",
  },
  {
    key: "runtime", type: "object", default: {},
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Engine options", description: "The engine's own advanced options.",
    hidden: "the llama.cpp engine's advanced fields, edited field-by-field in the runtime panel; unset lets the engine decide",
    legacy: { tab: "adv-runtime", section: "sec-rt-endpoint" },
  },
  {
    key: "dynamic", type: "object", default: {},
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Dynamic model", description: "Which model does which kind of task.",
    hidden: "the Dynamic model's leaves are edited in the routing editor; the object itself has no control",
    legacy: { tab: "adv-routing", section: "sec-route-dynamic" },
  },
  {
    key: "dynamic.profile", type: "string", default: "",
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Memory profile", description: "The chosen memory configuration.",
    hidden: "edited in the Dynamic model's routing editor",
  },
  {
    key: "dynamic.table", type: "object", default: {},
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Choice table", description: "Your changes to which model does what.",
    hidden: "edited in the Dynamic model's routing editor",
  },
  {
    key: "dynamic.router", type: "boolean", default: true,
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Use the router", description: "Let a tiny model read the unsure requests.",
    hidden: "edited in the Dynamic model's routing editor",
  },
  {
    key: "dynamic.routerModel", type: "string", default: "",
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Router model", description: "The tiny model that reads the unsure requests.",
    hidden: "edited in the Dynamic model's routing editor",
  },
  {
    key: "dynamic.askModel", type: "boolean", default: true,
    scope: "app", level: "advanced", group: "developer", applies: "model-reload",
    label: "Ask the model", description: "Ask the loaded model when words cannot sort a request.",
    hidden: "declared but never read; kept so old files keep the key",
  },
  {
    key: "placements", type: "object", default: {},
    scope: "app", level: "advanced", group: "library", applies: "model-reload",
    label: "Measured places", description: "Where each model was seen to run on this PC.",
    hidden: "written by the benchmark and the NPU load test; a record, not a preference",
  },
  {
    key: "loadFailures", type: "object", default: {},
    scope: "app", level: "advanced", group: "library", applies: "model-reload",
    label: "Failed model loads", description: "Models no setting loaded on this PC, with the reason and GenieX version.",
    hidden: "written by the load test of a model; a record, not a preference",
  },
  {
    key: "geniexSkippedUpdate", type: "string", default: null,
    scope: "app", level: "advanced", group: "developer", applies: "now",
    label: "Skipped runtime update", description: "The newer runtime release the person skipped on the setup screen.",
    hidden: "written when the optional runtime update is skipped; a record, not a preference",
  },
  {
    key: "loadProfiles", type: "object", default: {},
    scope: "app", level: "advanced", group: "library", applies: "model-reload",
    label: "Load profiles", description: "The load settings that worked, kept per model.",
    hidden: "written when a benchmark profile is saved; a record, not a preference",
  },
] as const satisfies readonly SettingDecl[];

// ---------------------------------------------------------------- lookups

type SchemaEntry = (typeof SETTINGS_SCHEMA)[number];
export type SchemaKey = SchemaEntry["key"];
type DeclOf<K extends string> = Extract<SchemaEntry, { key: K }>;
// Literals widen at the read boundary: a default `""` must not turn
// `readSetting(s, "searxngUrl")` into the type `""`, nor `"auto"` into a type
// that cannot equal `"burst"` — callers legitimately compare against other
// declared enum values of the same key. Enum keys read as the union of their
// declared values, which is exactly what a stored valid value can be.
type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;
type DefaultOf<K extends string> =
  DeclOf<K> extends infer E
    ? E extends { values: readonly (infer V)[] }
      ? V extends string ? V : Widen<(E & { default: unknown })["default"]>
      : Widen<DeclOf<K>["default"]>
    : never;

const DECLS: ReadonlyMap<string, SchemaEntry> = new Map(SETTINGS_SCHEMA.map((d) => [d.key, d]));

export function settingDecl(key: string): SettingDecl | undefined {
  return DECLS.get(key) as SettingDecl | undefined;
}

export function settingDefault<K extends string>(key: K): DefaultOf<K> {
  const decl = DECLS.get(key);
  if (!decl) throw new Error(`no schema entry for the settings key "${key}"`);
  return structuredClone(decl.default) as DefaultOf<K>;
}

export type SettingsInput = Partial<Settings> | null | undefined;

/** The stored value of one key, or undefined when nothing was stored. */
function rawValue(s: SettingsInput, key: string): unknown {
  const dot = key.indexOf(".");
  const head = dot === -1 ? key : key.slice(0, dot);
  const rest = dot === -1 ? null : key.slice(dot + 1);
  const headVal = (s as Record<string, unknown> | null | undefined)?.[head];
  if (rest === null) return headVal;
  if (headVal === null || typeof headVal !== "object") return undefined;
  return (headVal as Record<string, unknown>)[rest];
}

/** Why a stored value is not accepted, or null when it is. The reason names the key. */
export function valueProblem(decl: SettingDecl, v: unknown): string | null {
  // null is the stored "not set" of a setting whose default is null (the Default buttons save it)
  if (v === null && decl.default === null) return null;
  switch (decl.type) {
    case "boolean":
      return typeof v === "boolean" ? null : `expected true or false, got ${typeof v}`;
    case "string":
      return typeof v === "string" ? null : `expected text, got ${typeof v}`;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `expected a number, got ${typeof v}`;
      if (decl.min !== undefined && v < decl.min) return `below the minimum ${decl.min}`;
      if (decl.max !== undefined && v > decl.max) return `above the maximum ${decl.max}`;
      return null;
    case "enum":
      return typeof v === "string" && decl.values?.includes(v) ? null : `not one of: ${(decl.values ?? []).join(", ")}`;
    case "model-ref":
      return v === null || typeof v === "string" ? null : `expected a model id or empty, got ${typeof v}`;
    case "string-list":
      return Array.isArray(v) && v.every((x) => typeof x === "string")
        ? null
        : "expected a list of words";
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? null
        : `expected a settings object for "${decl.key}"`;
  }
}

/** Read one key the way the app acts on it: an absent or invalid stored value
 *  yields the schema's default. Every settings read goes through here, so the
 *  default exists exactly once. */
export function readSetting<K extends string>(s: SettingsInput, key: K): DefaultOf<K> {
  const decl = DECLS.get(key);
  if (!decl) throw new Error(`no schema entry for the settings key "${key}"`);
  const v = rawValue(s, key);
  if (v === undefined) return structuredClone(decl.default) as DefaultOf<K>;
  return (valueProblem(decl as SettingDecl, v) === null ? v : structuredClone(decl.default)) as DefaultOf<K>;
}

export function readBool<K extends Extract<SchemaEntry, { type: "boolean" }>["key"]>(s: SettingsInput, key: K): boolean {
  return readSetting(s, key) as boolean;
}

export function readNum<K extends Extract<SchemaEntry, { type: "number" }>["key"]>(s: SettingsInput, key: K): number {
  return readSetting(s, key) as number;
}

/** Objects (the writers map, the Dynamic model's choices, the skills list) have
 *  editors that own their shape; this reads the stored object the way the app
 *  acts on it — the schema's default when absent or not an object. */
export function readObj<T = unknown>(s: SettingsInput, key: string): T {
  return readSetting(s, key) as T;
}

/** The voice settings as the app acts on them: every declared leaf read from the
 *  stored object, defaults filling whatever is absent or invalid. */
export function voiceSettings(s: SettingsInput): VoiceSettings {
  const out: Record<string, unknown> = {};
  for (const d of SETTINGS_SCHEMA) {
    if (d.key.startsWith("voice.")) out[d.key.slice("voice.".length)] = readSetting(s, d.key);
  }
  return out as unknown as VoiceSettings;
}

// ---------------------------------------------------------------- search

export interface SearchEntryLite {
  label: string;
  tab: string;
  section?: string;
  aliases: string[];
  scope: "global" | "conversation";
}

/** The search index entries the schema holds: every key with a place on the
 *  Settings page, findable by its label and the old words the search keeps.
 *  A row's tab is the key's group (the page's place since 2.10); the section id
 *  from the earlier place stays, so a deep link opens the exact control. */
export function schemaSearchEntries(): SearchEntryLite[] {
  const out: SearchEntryLite[] = [];
  for (const d of SETTINGS_SCHEMA as readonly SettingDecl[]) {
    if (!d.legacy) continue;
    out.push({
      label: d.label,
      tab: d.group,
      ...(d.legacy.section ? { section: d.legacy.section } : {}),
      aliases: [...(d.oldWords ?? [])],
      scope: d.scope === "app" ? "global" : "conversation",
    });
  }
  return out;
}

// ------------------------------------------------------ changed, export, import

/** The schema's generation, recorded in every export file: a future version can
 *  refuse an export written under different declarations instead of misreading it. */
export const SETTINGS_SCHEMA_GENERATION = 1;

/** Structural equality (objects and arrays compared by content): a stored value
 *  counts as changed only when it truly differs from the schema default. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Declared keys that other declared keys nest under (speculativeDecoding in
 *  speculativeDecoding.enabled, turnBudget in its pair, dynamic in its leaves):
 *  the leaf is the unit of change, so the parent object is never listed beside
 *  the leaves that explain it. */
function hasChildKeys(key: string): boolean {
  if (key.includes(".")) return false;
  return (SETTINGS_SCHEMA as readonly SettingDecl[]).some((d) => d.key.startsWith(`${key}.`));
}

/** The keys whose stored value differs from the schema default — the Changed
 *  dots, the group counts, the Only-changed view and Export all read this.
 *  Values are read the way the app acts on them: an absent or invalid stored
 *  value reads as the default, so it is never reported as a change. */
export function changedKeys(s: SettingsInput): string[] {
  const out: string[] = [];
  for (const d of SETTINGS_SCHEMA as readonly SettingDecl[]) {
    if (hasChildKeys(d.key)) continue;
    if (!sameValue(readSetting(s, d.key), d.default)) out.push(d.key);
  }
  return out;
}

/** The changed keys a Reset may touch: those with a control on the Settings page.
 *  A key with a `hidden` reason is a record the app writes (measured places, load
 *  profiles, the chosen model) or text edited on another page (personal
 *  instructions, skills): it is data, never offered for a reset. */
export function resettableChangedKeys(s: SettingsInput): string[] {
  return changedKeys(s).filter((k) => !settingDecl(k)?.hidden);
}

/** The person's non-default settings as an export document: the schema
 *  generation that wrote it, and the values. A nested key exports its WHOLE
 *  stored object (the turn-budget pair, the draft-decoding triple, the voice
 *  block), so an import writes it back exactly as it was read — never half an
 *  object. */
export function exportSettings(s: SettingsInput): { generation: number; values: Record<string, unknown> } {
  // A credential and a this-PC-only value (a program path) never leave in a file.
  const heads = new Set(changedKeys(s)
    .filter((k) => { const d = settingDecl(k); return !d?.secret && !d?.thisPcOnly; })
    .map((k) => k.split(".")[0]));
  const values: Record<string, unknown> = {};
  for (const h of heads) values[h] = h === "voice" ? voiceSettings(s) : readSetting(s, h);
  return { generation: SETTINGS_SCHEMA_GENERATION, values };
}

export interface ImportResult {
  /** The voice block's leaves (write through the voice save path, which merges). */
  voice: Record<string, unknown>;
  /** The top-level values (write through the settings save path). */
  rest: Record<string, unknown>;
  /** What was refused, and why. The empty key names the whole file. */
  refusals: Array<{ key: string; reason: string }>;
  /** The generation the file recorded, when it named one. */
  generation: number | null;
}

const UNDECLARED = "MKMN does not declare this setting";

/** Read an export document back. Every key is checked against the schema
 *  (`valueProblem`), a key the schema does not declare is refused — never
 *  written — and a document from a NEWER schema generation is refused whole,
 *  because its keys may mean something else now. Values equal to the default
 *  pass the same checks as any other value: an import writes what the file
 *  holds, and the default is a valid value. */
export function importSettings(parsed: unknown): ImportResult {
  const out: ImportResult = { voice: {}, rest: {}, refusals: [], generation: null };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    out.refusals.push({ key: "", reason: "the file does not hold settings (expected a JSON object)" });
    return out;
  }
  const doc = parsed as Record<string, unknown>;
  out.generation = typeof doc.generation === "number" ? doc.generation : null;
  if (out.generation !== null && out.generation > SETTINGS_SCHEMA_GENERATION) {
    out.refusals.push({ key: "", reason: `the file was exported by a newer version of MKMN (schema generation ${out.generation})` });
    return out;
  }
  const values = doc.values !== undefined
    ? doc.values
    : doc; // a bare { key: value } object is accepted too
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    out.refusals.push({ key: "", reason: "the file does not hold a values object" });
    return out;
  }
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (key === "voice") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        out.refusals.push({ key, reason: "expected a settings object for the voice block" });
        continue;
      }
      for (const [leaf, lv] of Object.entries(value as Record<string, unknown>)) {
        const full = `voice.${leaf}`;
        const decl = settingDecl(full);
        if (!decl) { out.refusals.push({ key: full, reason: UNDECLARED }); continue; }
        const problem = valueProblem(decl, lv);
        if (problem) out.refusals.push({ key: full, reason: problem });
        else out.voice[leaf] = lv;
      }
      continue;
    }
    const decl = settingDecl(key);
    if (!decl) { out.refusals.push({ key, reason: UNDECLARED }); continue; }
    if (decl.secret) { out.refusals.push({ key, reason: "a credential is entered on this PC, never imported from a file" }); continue; }
    if (decl.thisPcOnly) { out.refusals.push({ key, reason: decl.thisPcOnly }); continue; }
    const problem = valueProblem(decl, value);
    if (problem) { out.refusals.push({ key, reason: problem }); continue; }
    // A nested value is checked leaf by leaf: "an object" alone would let a string
    // or a negative number through inside it.
    if (hasChildKeys(key) && value !== null && typeof value === "object") {
      const leafProblems: Array<{ key: string; reason: string }> = [];
      for (const [leaf, lv] of Object.entries(value as Record<string, unknown>)) {
        const full = `${key}.${leaf}`;
        const ld = settingDecl(full);
        if (!ld) { leafProblems.push({ key: full, reason: UNDECLARED }); continue; }
        const lp = valueProblem(ld, lv);
        if (lp) leafProblems.push({ key: full, reason: lp });
      }
      if (leafProblems.length) { out.refusals.push(...leafProblems); continue; }
    }
    out.rest[key] = value;
  }
  return out;
}

/** The patch that writes leaf values back through the settings save path: a
 *  nested key ("turnBudget.maxCalls") merges into its parent's STORED object,
 *  so the pair's other half survives; a top-level key passes as it is. The
 *  voice block is never in the result — it merges through the voice save path
 *  (the settings patch would replace the whole block). */
export function leafValuePatch(s: SettingsInput, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(values)) {
    if (k === "voice" || k.startsWith("voice.")) continue;
    const dot = k.indexOf(".");
    if (dot === -1) { out[k] = val; continue; }
    const head = k.slice(0, dot);
    const leaf = k.slice(dot + 1);
    const parent = (s as Record<string, unknown> | null | undefined)?.[head];
    out[head] = {
      ...(parent && typeof parent === "object" && !Array.isArray(parent) ? parent : {}),
      [leaf]: val,
    };
  }
  return out;
}
