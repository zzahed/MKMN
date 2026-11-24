import { listedHere } from "../core/modelList";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readBool, readNum, readObj, readSetting } from "../shared/settingsSchema";
import type { MkmnApi, CatalogItem, AppInfo, UpdateState, RuntimeInfo, NpuPlanView, AdaptiveStatusView, HardwareConfigFile, VectorModelStatusView } from "../shared/api";
import type { SetupState } from "../core/setup";
import { CATALOG, ref as entryRef } from "../core/catalog";
import { scoreEntry } from "../core/fit";
import { backendChoices, backendNote } from "../core/backends";
import { buildOffice, type OfficeKind } from "../core/office";
import { officeSourceOf } from "../core/exportFormats";
import { picFromData, type Pics } from "../core/slides";
import { fileExtension } from "../core/artifacts";
import { VersionBook, type HistoryStorage, type ArtifactSource } from "../core/versionBook";
import type { History } from "../core/versions";
import { DYNAMIC_DATA } from "../core/dynamic-data";
import { canonicalName, resolveModelIdentity } from "../core/modelIdentity";
import { effectiveLoad } from "../core/npuLoad";
import { dynamicEntry, isDynamicId, LANES, mergedPack, missingInPack, installedOf, packContextDetail, packParts, profileFor, tierOf, type BundleModel } from "../core/dynamic";
import type {
  ChatMessage,
  ChatOptions,
  ChatEvent,
  RunEvent,
  HardwareProfile,
  InstalledModel,
  ServerStatus,
  Settings,
  Meters,
  Project,
  Artifact,
  ScheduledTask,
  VoiceStatus,
  VoiceModelView,
  VoiceSettings,
  VoiceNeed,
  CatalogEntry,
  MemoryEstimate,
  PowerStatusInfo,
  Verdict,
  BenchmarkResult,
  QoSSummary,
  Sha256VerificationResult} from "../shared/types";
import type { AgentGrant, AgentRunEvent, DriverWindow } from "../shared/agent";
import { uninstallGate } from "./modelSwitch";

/**
 * One call into the Node sidecar through the Tauri host (src-tauri/src/sidecar.rs).
 * The args are the positional arguments of the method, serialized as a JSON array.
 */
async function sidecarCall<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  return invoke<T>("sidecar_call", { method, args });
}

const chatStarts = new Map<string, Promise<unknown>>();
const activeChats = new Set<string>();
/** Sleep inhibition can fail independently of chat startup. */
const chatInhibits = new Set<string>();
async function releaseChatInhibit(id: string): Promise<void> {
  if (!chatInhibits.delete(id)) return;
  try { await invoke("inhibit_sleep", { enable: false }); } catch { /* best effort, as when it was turned on */ }
}
const chatListeners = new Set<(e: ChatEvent) => void>();
const shutdownListeners = new Set<() => void>();
const serverListeners = new Set<(s: ServerStatus) => void>();
const artifactListeners = new Set<() => void>();
const taskListeners = new Set<(t: ScheduledTask) => void>();
/** The value an `on…` subscription of the API hands its callback: one type for the API, the listeners and the events. */
type EventOf<K extends keyof MkmnApi> = MkmnApi[K] extends (cb: (value: infer V) => void) => unknown ? V : never;
const voiceAudioListeners = new Set<(c: EventOf<"onVoiceAudio">) => void>();
const voiceStatusListeners = new Set<(s: VoiceStatus) => void>();
const voiceDownloadListeners = new Set<(p: EventOf<"onVoiceDownload">) => void>();
const setupListeners = new Set<(st: SetupState) => void>();
const updateListeners = new Set<(st: UpdateState) => void>();
const benchListeners = new Set<(s: EventOf<"onBench">) => void>();
const benchLiveListeners = new Set<(l: EventOf<"onBenchLive">) => void>();
const npuTestListeners = new Set<(s: EventOf<"onNpuTest">) => void>();
const modelCheckListeners = new Set<(e: EventOf<"onModelCheck">) => void>();
const benchMeasuredListeners = new Set<(e: EventOf<"onBenchMeasured">) => void>();
const labListeners = new Set<(s: EventOf<"onLab">) => void>();
const runListeners = new Set<(e: RunEvent) => void>();
const agentRunListeners = new Set<(e: AgentRunEvent) => void>();
const installListeners = new Set<(p: EventOf<"onInstall">) => void>();
const dynamicInstallListeners = new Set<(p: EventOf<"onDynamicInstall">) => void>();
/** Set inside createTauriApi (which owns the artifact store): files a task's artifacts. */
let onArtifactsEvent: ((payload: unknown) => void) | null = null;

/**
 * The host's coordinated shutdown event (`app-shutdown` from src-tauri/src/shutdown.rs),
 * wired once: the exit sequence goes on right after the emit (sidecar stop, supervisor,
 * job object), so every listener here must do its synchronous part (the chat save
 * flush) as soon as the event lands.
 */
let hostShutdownWired = false;
function wireHostShutdown(): void {
  if (hostShutdownWired || !isTauri()) return;
  hostShutdownWired = true;
  listen("app-shutdown", () => {
    for (const l of [...shutdownListeners]) l();
  }).catch(() => { hostShutdownWired = false; });
}

/**
 * The key the window reads its chats from at start (its writer is store.ts, which owns the
 * same literal). The bridge no longer writes a second key.
 */
const CONVERSATIONS_KEY = "opennpu.conversations";

/**
 * The chats a build older than this one wrote to the second key (`mkmn.conversations`) are
 * read at most ONCE, and only while the key the window reads at start (`opennpu.conversations`)
 * has nothing: an empty kept key means this profile never saved under it, so the old copy is
 * the only copy. Because it is the only copy, it is NOT removed here — only once a save has
 * actually landed under the kept key (a non-empty list read back at start, or the saver's
 * write reporting ok, both call `markLegacyMigrated`): removing the old key on the first
 * read would lose the chats of a window that died before its first save. Once migration is
 * marked, a chat deleted under the kept key can never return from the stale second copy;
 * the once-per-session read flag is the belt for the case even the removal is refused
 * (blocked storage).
 */
let legacyChatKeyRead = false;

/** Forgets the old conversations copy. Only ever called after the kept key holds a saved list. */
function forgetLegacyConversations(): void {
  try { localStorage.removeItem("mkmn.conversations"); } catch { /* nothing to forget */ }
}

/**
 * A scheduled task carries a COPY of its project (the scheduler runs in the sidecar,
 * which cannot read the project store). The copy follows the project: saving a
 * project refreshes it in each of its tasks, deleting the project removes it (the
 * task then runs without project context). Best-effort: a task the sidecar could
 * not update keeps its old copy until it is saved again.
 */
async function refreshTaskProjects(projectId: string, project: Project | null): Promise<void> {
  const mine = getLocalJson<ScheduledTask[]>("mkmn.tasks", []).filter((t) => t.projectId === projectId);
  let latest: ScheduledTask[] | null = null;
  for (const t of mine) {
    const next: ScheduledTask = project ? { ...t, project } : { ...t, projectId: null, project: null };
    latest = await sidecarCall<ScheduledTask[]>("saveTask", next).catch(() => latest);
  }
  if (latest) setLocalJson("mkmn.tasks", latest);
}

/**
 * The sidecar's progress events (`install`, `dynamicInstall`, ...) arrive as Tauri
 * `sidecar-event`s carrying { name, payload }; they are sorted into the listener sets here,
 * once. Outside Tauri (the tests, the plain browser preview) there is no event source.
 */
let sidecarEventsWired = false;

/** What the sidecar is doing besides chats, read from its own events, so a dead
 *  sidecar's work can be settled (see sidecarExited below): installs not yet done,
 *  the last state of each long job, the code runs still open. */
/** What the sidecar's foundryStatus answers (src/sidecar/register/foundry.ts); the page's view is built from it. */
type SidecarFoundryStatus = { installed: boolean; version: string | null; loaded: unknown; cached: number | null; note: string | null };
type Jobs = { npuTest: EventOf<"onNpuTest"> | null; bench: EventOf<"onBench"> | null; lab: EventOf<"onLab"> | null };
const inFlight: { installs: Map<string, EventOf<"onInstall">>; jobs: Jobs; runs: Set<string> } = {
  installs: new Map(),
  jobs: { npuTest: null, bench: null, lab: null },
  runs: new Set<string>(),
};
const STOPPED_LINE = "Stopped: the MKMN engine stopped unexpectedly. Start it again.";
function trackInstall(p: EventOf<"onInstall"> | null | undefined): void {
  if (!p || typeof p.ref !== "string") return;
  if (p.phase === "done" || p.phase === "error" || p.phase === "cancelled") inFlight.installs.delete(p.ref);
  else inFlight.installs.set(p.ref, p);
}
function trackJob<K extends keyof Jobs>(kind: K, s: Jobs[K]): void {
  if (s && typeof s === "object") inFlight.jobs[kind] = s.running ? s : null;
}
/** A list a job state carries (its lines, its log), or none. */
const listIn = (s: object, key: string): unknown[] => { const v = (s as Record<string, unknown>)[key]; return Array.isArray(v) ? v : []; };

function wireSidecarEvents(): void {
  if (sidecarEventsWired || !isTauri()) return;
  sidecarEventsWired = true;
  // the payload is whatever the sidecar sent: each event below takes it as that event's type
  listen<{ name: string; payload: unknown }>("sidecar-event", (e) => {
    const name = e.payload?.name;
    const payload = e.payload?.payload;
    if (name === "install") { const p = payload as EventOf<"onInstall">; trackInstall(p); for (const l of installListeners) l(p); }
    else if (name === "dynamicInstall") { for (const l of dynamicInstallListeners) l(payload as EventOf<"onDynamicInstall">); }
    else if (name === "chat") {
      // the orchestrator in the sidecar streams the whole turn: agents, notices, the answer's
      // words, the reviewer's steps, and the terminal done or error. A terminal event releases
      // the sleep-inhibit the chat took when it started.
      const ev = payload as ChatEvent;
      if (ev && typeof ev.id === "string") {
        for (const l of chatListeners) l(ev);
        if (ev.type === "done" || ev.type === "error") {
          activeChats.delete(ev.id);
          void releaseChatInhibit(ev.id);
        }
      }
    }
    else if (name === "sidecarExited") {
      // The sidecar process died: every chat it had acknowledged is stranded (its turn
      // streamed as events from a process that no longer exists, and no replacement
      // sidecar knows that chat). Settle them HERE, on the host's lifecycle event: one
      // error event each — the same shape the chat call itself uses when it cannot
      // start — and the sleep-inhibits released. Without this a crash mid-turn leaves
      // the chat busy forever.
      for (const id of activeChats) {
        activeChats.delete(id);
        const ev: ChatEvent = {
          id,
          type: "error",
          error: { id: "sidecar-exited", title: "The chat was interrupted", fix: "The chat engine stopped unexpectedly. Send the message again to continue.", raw: String((payload as { generation?: unknown } | null)?.generation ?? "") }
        };
        for (const l of chatListeners) l(ev);
        void releaseChatInhibit(id);
      }
      // ... and every other job it held: an install ends in an error, each long job
      // stops with a line saying why (what it showed is kept), each open run exits.
      for (const p of inFlight.installs.values()) {
        const ended: EventOf<"onInstall"> = { ...p, phase: "error", percent: null, error: { id: "sidecar-exited", title: "The download was interrupted", fix: "The MKMN engine stopped unexpectedly. Start the install again.", raw: "" } };
        for (const l of installListeners) l(ended);
      }
      inFlight.installs.clear();
      const stop = <S extends object>(s: S): S => ({ ...s, running: false, lines: [...listIn(s, "lines"), STOPPED_LINE], log: [...listIn(s, "log"), STOPPED_LINE] });
      if (inFlight.jobs.npuTest) { const s = stop(inFlight.jobs.npuTest); for (const l of npuTestListeners) l(s); }
      if (inFlight.jobs.bench) { const s = stop(inFlight.jobs.bench); for (const l of benchListeners) l(s); }
      if (inFlight.jobs.lab) { const s = stop(inFlight.jobs.lab); for (const l of labListeners) l(s); }
      inFlight.jobs = { npuTest: null, bench: null, lab: null };
      for (const runId of inFlight.runs) {
        const ended = { runId, type: "exit" as const, code: null, stopped: true, error: "The MKMN engine stopped unexpectedly." };
        for (const l of runListeners) l(ended);
      }
      inFlight.runs.clear();
    }
    else if (name === "agentRun") { const p = payload as AgentRunEvent | null; if (p && typeof p === "object" && typeof p.runId === "string") { for (const l of agentRunListeners) l(p); } }
    else if (name === "setup") { for (const l of setupListeners) l(payload as SetupState); }
    else if (name === "update") { for (const l of updateListeners) l(payload as UpdateState); }
    else if (name === "bench") { const s = payload as EventOf<"onBench">; trackJob("bench", s); for (const l of benchListeners) l(s); }
    else if (name === "benchLive") { for (const l of benchLiveListeners) l(payload as EventOf<"onBenchLive">); }
    else if (name === "npuTest") { const s = payload as EventOf<"onNpuTest">; trackJob("npuTest", s); for (const l of npuTestListeners) l(s); }
    else if (name === "modelCheck") { for (const l of modelCheckListeners) l(payload as EventOf<"onModelCheck">); }
    else if (name === "benchMeasured") { for (const l of benchMeasuredListeners) l(payload as EventOf<"onBenchMeasured">); }
    else if (name === "lab") { const s = payload as EventOf<"onLab">; trackJob("lab", s); for (const l of labListeners) l(s); }
    else if (name === "run") {
      const p = payload as RunEvent | null;
      if (p && typeof p === "object" && typeof p.runId === "string") {
        if (p.type === "exit") inFlight.runs.delete(p.runId); else inFlight.runs.add(p.runId);
        for (const l of runListeners) l(p);
      }
    }
    else if (name === "tasks") { if (payload && typeof payload === "object") { for (const l of taskListeners) l(payload as ScheduledTask); } }
    else if (name === "artifacts") {
      // a scheduled task's artifacts, filed by the bridge (the artifact store lives in the
      // webview; the hook is set inside createTauriApi, which owns the store)
      onArtifactsEvent?.(payload);
    }
    else if (name === "voiceStatus") { for (const l of voiceStatusListeners) l(payload as VoiceStatus); }
    else if (name === "voiceDownload") { for (const l of voiceDownloadListeners) l(payload as EventOf<"onVoiceDownload">); }
    else if (name === "voiceAudio") {
      // JSON has no typed arrays: the samples arrive as a plain array, the player needs a Float32Array
      const raw = payload as (Omit<EventOf<"onVoiceAudio">, "samples"> & { samples?: Float32Array | number[] }) | null;
      const chunk = raw && typeof raw === "object" ? { ...raw, samples: raw.samples instanceof Float32Array ? raw.samples : Float32Array.from(raw.samples ?? []) } : raw;
      for (const l of voiceAudioListeners) l(chunk as EventOf<"onVoiceAudio">);
    }
  }).catch(() => { sidecarEventsWired = false; });
}

/** The histories of the files, kept in localStorage like the artifacts themselves. */
const tauriHistories: HistoryStorage = {
  get(id: string): History | undefined {
    return getLocalJson<History | null>(`mkmn.versions.${id}`, null) ?? undefined;
  },
  put(h: History): void {
    setLocalJson(`mkmn.versions.${h.id}`, h);
  },
  drop(id: string): void {
    try { localStorage.removeItem(`mkmn.versions.${id}`); } catch { /* nothing to forget */ }
  },
  list(): History[] {
    const out: History[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("mkmn.versions.")) {
          try {
            const raw = localStorage.getItem(k);
            const h = raw ? (JSON.parse(raw) as History) : null;
            if (h) out.push(h);
          } catch { /* a broken entry is skipped */ }
        }
      }
    } catch { /* no storage: no histories */ }
    return out;
  }
};
/** The artifact list as the version book sees it (localStorage is written by the bridge methods themselves). */
const tauriArtifactSource: ArtifactSource = {
  list: () => getLocalJson<Artifact[]>("mkmn.artifacts", []),
  upsert(a: Artifact) {
    const list = getLocalJson<Artifact[]>("mkmn.artifacts", []);
    const idx = list.findIndex((x) => x.id === a.id);
    if (idx >= 0) list[idx] = a;
    else list.push(a);
    setLocalJson("mkmn.artifacts", list);
  },
  remove(id: string) {
    setLocalJson("mkmn.artifacts", getLocalJson<Artifact[]>("mkmn.artifacts", []).filter((x) => x.id !== id));
  }
};

function getLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function setLocalJson<T>(key: string, val: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    console.error(`Failed to save ${key} to localStorage`, e);
    // Silent "saves" are lies: the app shows one honest warning instead of a UI that
    // believes work was stored when browser storage refused it (quota, private mode).
    try {
      window.dispatchEvent(new CustomEvent("mkmn-storage-error", { detail: { key, message: String(e) } }));
    } catch { /* no window to tell */ }
    return false;
  }
}

/** Where a model was measured to run: settings.placements is written under the
 *  repo-style ref AND (some writers, older data) the entry id, so the read tries both
 *  — one shared rule for the catalog items and the Dynamic packs. */
export function measuredPlacement<T>(settings: { placements?: Record<string, T> } | null | undefined, refStr: string, id: string): T | undefined {
  return settings?.placements?.[refStr] ?? settings?.placements?.[id];
}

export function dynamicItems(ramGB: number, installed: InstalledModel[], settings?: Settings, compiled: Record<string, number> = {}): CatalogItem[] {
  const profile = profileFor(DYNAMIC_DATA, ramGB, settings?.dynamic?.profile);
  const ids: { pack: string; lane?: (typeof LANES)[number] }[] = LANES.map((lane) => ({ pack: profile.packs[lane], lane }));
  const chosen = isDynamicId(readSetting(settings, "selectedModelId") ?? "") ? tierOf(readSetting(settings, "selectedModelId") ?? "") : null;
  if (chosen && DYNAMIC_DATA.packs[chosen] && !ids.some((x) => x.pack === chosen)) ids.push({ pack: chosen });
  const installedRefs = new Set<string>();
  for (const m of installed) {
    installedRefs.add(String(m.ref || m.name || "").toLowerCase());
  }
  // the per-artifact compiled evidence the sidecar read from the installed bundles (renderer-safe:
  // the renderer itself never touches the file system), keyed by the ONE canonical identity the
  // producer uses too — `ai-hub-models/X` arrives as `qualcomm/X`, so the lookup must canonicalize
  // the same way (a plain lowercase would miss every ai-hub-models artifact)
  const evidence = (m: BundleModel): number | null => compiled[canonicalName(m.repo)] ?? null;
  return ids.flatMap(({ pack, lane }) => {
    const p = DYNAMIC_DATA.packs[pack];
    if (!p) return [];
    const e = dynamicEntry(p, lane, evidence) as CatalogEntry & { contextTokens?: number; estNpuGB?: number; estTokPerSec?: number | null };
    // the pack's own artifact decides the window — from the compiled evidence when it exists, else the
    // built-in estimate, and the verdict SAYS which of the two the number is
    const ctx = packContextDetail(p, evidence);
    const verdict: Verdict = installedRefs.has(e.id.toLowerCase())
      ? { level: "green", reasons: ["installed", `${ctx.measured ? "Context" : "Context estimate"}: ${ctx.tokens} — ${ctx.why}`], contextTokens: e.contextTokens ?? ctx.tokens, estNpuGB: e.estNpuGB ?? 0, estTokPerSec: e.estTokPerSec ?? null, installAllowed: true }
      : { level: "amber", reasons: ["not installed", `${ctx.measured ? "Context" : "Context estimate"}: ${ctx.tokens} — ${ctx.why}`], contextTokens: e.contextTokens ?? ctx.tokens, estNpuGB: e.estNpuGB ?? 0, estTokPerSec: null, installAllowed: true };
    // "installed" is not "seen running on the NPU": where a pack model actually ran is
    // a measurement (settings.placements), never a default (the same rule as the catalog items).
    const measured = measuredPlacement(settings, entryRef(e), e.id);
    return [{ entry: e, verdict, hidden: false, installed: installedRefs.has(e.id.toLowerCase()), ref: e.id, custom: false, runsOn: measured }];
  });
}

/**
 * Model identity resolution runs through the ONE shared resolver
 * (src/core/modelIdentity.ts) — the same function the sidecar's chat, test and
 * benchmark paths use, so preload, select and chat resolve an alias to the same
 * exact cache reference. This bridge wrapper only gathers the context (the saved
 * custom entries and the installed inventory) and applies the shared function;
 * an unresolvable application id ("custom:...", "dynamic:9B") is refused here
 * instead of being forwarded to GenieX.
 */
async function resolveServeRef(modelId: string): Promise<string> {
  const [customEntries, installed] = await Promise.all([
    sidecarCall<CatalogEntry[]>("customEntries").catch(() => [] as CatalogEntry[]),
    invoke<InstalledModel[]>("get_installed_models_cmd").catch(() => [] as InstalledModel[]),
  ]);
  const r = resolveModelIdentity(modelId, {
    customEntries,
    installedRefs: installed.map((m) => String(m.ref || m.name || "")).filter(Boolean),
  });
  if (!r.ok) throw new Error(r.reason);
  return r.ref;
}

/** Hardware readings that are simply unavailable, reported as such — never an invented machine. */
const unknownHardware = (): HardwareProfile => ({
  chipName: "Unknown",
  chipFamily: "unknown",
  isSnapdragon: false,
  ramGB: 0,
  npuDetected: false,
  npuDriverVersion: null,
  npuBudgetGB: 0,
  npuBudgetSource: "estimated",
  detectedAt: new Date().toISOString(),
  appArch: "unknown",
  emulated: false,
} as unknown as HardwareProfile);

export function createTauriApi(): MkmnApi {
  wireSidecarEvents();
  // A replacement sidecar checks setup again. Keep this window's decision so
  // that background check cannot replace an active chat with onboarding.
  let setupDismissed = false;
  const visibleSetup = (state: SetupState): SetupState => setupDismissed ? { ...state, active: false } : state;
  const finishSetup = async (method: "setupDecline" | "setupDismiss"): Promise<void> => {
    const previous = setupDismissed;
    setupDismissed = true;
    try { await sidecarCall(method); }
    catch (error) { setupDismissed = previous; throw error; }
  };
  const startSetup = async (method: string, ...args: unknown[]): Promise<void> => {
    setupDismissed = false;
    await sidecarCall(method, ...args);
  };
  const versionBook = new VersionBook(tauriHistories, tauriArtifactSource);
  // a scheduled task's artifacts, filed into the local store the pages read, with a version
  // snapshot like a hand-saved one, and the pages told to refresh
  onArtifactsEvent = (payload) => {
    if (!Array.isArray(payload)) return;
    const list = getLocalJson<Artifact[]>("mkmn.artifacts", []);
    for (const a of payload) {
      if (!a || typeof a.id !== "string") continue;
      const idx = list.findIndex((x) => x.id === a.id);
      if (idx >= 0) list[idx] = a; else list.push(a);
      versionBook.save(a);
    }
    setLocalJson("mkmn.artifacts", list);
    for (const l of artifactListeners) l();
  };
  return {
    async appInfo(): Promise<AppInfo> {
      return invoke<AppInfo>("get_app_info_cmd");
    },

    async hardware(refresh = false): Promise<HardwareProfile> {
      return invoke<HardwareProfile>("get_hardware_cmd", { refresh });
    },

    async catalog(): Promise<CatalogItem[]> {
      const [hw, settings, installedList, customEntries, foundryEntries, compiled] = await Promise.all([
        invoke<HardwareProfile>("get_hardware_cmd").catch(() => unknownHardware()),
        invoke<Settings>("get_settings").catch(() => null),
        invoke<InstalledModel[]>("get_installed_models_cmd").catch(() => []),
        sidecarCall<CatalogEntry[]>("customEntries").catch(() => []),
        // Foundry Local models this machine could serve (cached builds, exact device badge):
        // selectable models like the catalog's, served by the sidecar's foundry host.
        sidecarCall<CatalogEntry[]>("foundryEntries").catch(() => [] as CatalogEntry[]),
        // the compiled window of each installed QAIRT pack artifact (the sidecar reads the
        // bundles; the renderer may not) — absent entries keep the labeled estimate
        sidecarCall<Record<string, number>>("compiledContexts").catch(() => ({})),
      ]);

      const installedNames = new Set(installedList.map((m) => m.name.toLowerCase()));
      const customIds = new Set(customEntries.map((e) => e.id));
      // Foundry's own cache decides which of its catalog entries are installed (the GenieX
      // inventory never holds them); the rest are offered with an Install button.
      const foundryIds = new Set(foundryEntries.filter((e) => e.foundryInstalled === true).map((e) => e.id));

      const itemOf = (entry: CatalogEntry): CatalogItem => {
        const verdict = scoreEntry(entry, hw);
        const refStr = entryRef(entry);
        const installed = foundryIds.has(entry.id) ||
          installedNames.has(refStr.toLowerCase()) ||
          installedNames.has(entry.repo.toLowerCase()) ||
          installedNames.has(entry.id.toLowerCase());

        const pref = (entry as CatalogEntry & { preferredCompute?: string }).preferredCompute;
        // Where a model runs is a MEASUREMENT (settings.placements, written by the load
        // test and the benchmark), not a default: a fresh entry must not wear an "NPU"
        // badge it was never seen to earn. Only an explicit shipped hybrid/CPU
        // preference is reflected when nothing was measured here.
        const measured = measuredPlacement(settings, refStr, entry.id);
        return {
          entry,
          verdict,
          hidden: !!entry.excluded,
          installed,
          ref: refStr,
          custom: customIds.has(entry.id),
          runsOn: measured ?? (pref === "hybrid" || pref === "cpu" ? pref : undefined)
        };
      };

      // The shipped catalog, the user's resolved custom entries (custom-models.json —
      // the same list the sidecar installs and serves from), the Foundry Local entries,
      // and the Dynamic packs: one authoritative selectable list, so a custom model
      // survives refresh/restart.
      const items: CatalogItem[] = [
        ...CATALOG.map(itemOf),
        ...customEntries.map(itemOf),
        ...foundryEntries.map(itemOf),
      ];

      // only what can work here: no model whose load failed on this PC, no GPU/CPU Foundry build unless allowed
      return listedHere(items.concat(dynamicItems(hw.ramGB, installedList, settings ?? undefined, compiled ?? {})), {
        loadFailures: settings?.loadFailures, placements: settings?.placements,
        allowHybridLoad: readBool(settings, "allowHybridLoad"), selectedModelId: settings?.selectedModelId,
      });
    },

    async installed(): Promise<InstalledModel[]> {
      return invoke<InstalledModel[]>("get_installed_models_cmd");
    },

    async modelEvidence(): Promise<{ manifest: import("../core/manifest").ArtifactManifestEntry[]; records: import("../core/manifest").EvidenceRecord[] }> {
      // One Tauri command each: the manifest scan (spawn_blocking in Rust) and the evidence store.
      const [manifest, records] = await Promise.all([
        invoke<import("../core/manifest").ArtifactManifestEntry[]>("model_manifest_cmd").catch(() => []),
        invoke<import("../core/manifest").EvidenceRecord[]>("get_model_evidence_cmd").catch(() => []),
      ]);
      return { manifest, records };
    },

    async compiledContexts(): Promise<Record<string, number>> {
      // the sidecar reads each installed QAIRT bundle's genie_config.json; the renderer may not touch files
      return sidecarCall<Record<string, number>>("compiledContexts").catch(() => ({}));
    },

    async speedsById(): Promise<Record<string, number>> {
      // the sidecar merges its chat EMA with the host's evidence store; an empty map is
      // the honest fallback (a model this machine never timed shows no speed)
      return sidecarCall<Record<string, number>>("speedsById").catch(() => ({}));
    },

    async dynamicInfo() {
      const [hw, settings, installedList] = await Promise.all([
        invoke<HardwareProfile>("get_hardware_cmd").catch(() => null),
        invoke<Settings>("get_settings").catch(() => null),
        invoke<InstalledModel[]>("get_installed_models_cmd").catch(() => []),
      ]);const ramGB = hw?.ramGB ?? 0;
      // The profile the user picked (settings.dynamic.profile) wins; null gives the
      // automatic one for this machine's RAM — the same precedence the desktop build uses.
      const profile = profileFor(DYNAMIC_DATA, ramGB, settings?.dynamic?.profile);
      const autoProfile = profileFor(DYNAMIC_DATA, ramGB);
      // The entries the app ACTUALLY has installed (matched the same way everywhere:
      // by the pack model's concrete refs, never by synthetic catalog ids).
      const dynEntries = Object.values(DYNAMIC_DATA.packs).flatMap((p) => packParts(mergedPack(DYNAMIC_DATA, p.id, settings?.dynamic) ?? p));
      const installed = installedList
        .map((m) => dynEntries.find((e) => String(m.ref ?? m.name ?? "").toLowerCase() === String(e.ref ?? "").toLowerCase() || String(m.name ?? "").toLowerCase() === String(e.repo ?? "").toLowerCase()))
        .filter((e): e is NonNullable<typeof e> => !!e) as unknown as CatalogEntry[];
      const packs = Object.fromEntries(
        Object.keys(DYNAMIC_DATA.packs).map((id) => [id, mergedPack(DYNAMIC_DATA, id, settings?.dynamic) ?? DYNAMIC_DATA.packs[id]])
      );
      // Measured speeds come from the sidecar's own timing records; only models this
      // machine really timed appear (there is no hard-coded sample speed).
      const speeds = await sidecarCall<Record<string, number>>("speedsByRef").catch(() => ({}));
      const badgeOf = (b: string | null | undefined) => (b === "npu" || b === "cpu" || b === "hybrid" ? b : null);

      return {
        data: { ...DYNAMIC_DATA, packs },
        speeds,
        profile: profile.id,
        autoProfile: autoProfile.id,
        installedRefs: Object.values(DYNAMIC_DATA.packs).flatMap((p) => packParts(p).filter((m) => installedOf(m, installed)).map((m) => m.ref)),
        runsOn: Object.fromEntries(Object.values(DYNAMIC_DATA.packs).flatMap((p) => p.models.flatMap((m) => {
          const e = installedOf(m, installed);
          const b = e ? badgeOf(settings?.placements?.[entryRef(e)]) : null;
          return b ? [[m.ref, b] as const] : [];
        }))),
        engines: Object.fromEntries(Object.values(DYNAMIC_DATA.packs).flatMap((p) => p.models.flatMap((m) => {
          const e = installedOf(m, installed);
          return e ? [[m.ref, "geniex"] as const] : [];
        }))),
        missing: Object.fromEntries(Object.values(DYNAMIC_DATA.packs).map((p) => [p.id, missingInPack(p, installed).map((m) => m.ref)]))
      };
    },

    async setDynamicProfile(id: string): Promise<void> {
      // settings merge at the top level, so the whole dynamic object is sent back with the profile in it
      const s = await invoke<Partial<Settings>>("get_settings").catch((): Partial<Settings> => ({}));
      await invoke("save_settings_cmd", { patch: { dynamic: { ...(s?.dynamic ?? {}), profile: id } } });
    },
    async installDynamic(tier: string): Promise<void> {
      wireSidecarEvents();
      await sidecarCall("installDynamic", tier);
    },
    async installDynamicModel(tier: string, ref: string): Promise<void> {
      wireSidecarEvents();
      await sidecarCall("installDynamicModel", tier, ref);
    },
    async uninstallDynamic(tier: string): Promise<{ ok: boolean; removed: string[]; failed: string[] }> {
      // the sidecar removes files; the server it may be holding is the Rust host's to stop
      const st = await invoke<ServerStatus>("get_server_status").catch(() => null);
      const gate = uninstallGate(st?.state);
      if (gate === "refuse") return { ok: false, removed: [], failed: [`a model is loading or answering (${st?.model ?? "the model server"}): nothing was removed`] };
      if (gate === "stop") await invoke("stop_server").catch(() => {});
      return sidecarCall("uninstallDynamic", tier);
    },
    onDynamicInstall(cb): () => void {
      dynamicInstallListeners.add(cb);
      return () => dynamicInstallListeners.delete(cb);
    },

    async benchRoster() {
      return sidecarCall("benchRoster");
    },
    async benchState() {
      return sidecarCall("benchState");
    },
    async benchStart(cfg): Promise<{ ok: boolean; error?: string }> {
      return sidecarCall("benchStart", cfg);
    },
    async benchStop(): Promise<void> {
      await sidecarCall("benchStop").catch(() => {});
    },
    async npuTestRoster() {
      return sidecarCall("npuTestRoster");
    },
    async npuTestState() {
      return sidecarCall("npuTestState");
    },
    async npuTestStart(ids: string[], all: boolean, hybrid: boolean): Promise<{ ok: boolean; error?: string }> {
      return sidecarCall("npuTestStart", ids, all, hybrid);
    },
    async npuTestStop(): Promise<void> {
      await sidecarCall("npuTestStop").catch(() => {});
    },
    async npuReset(): Promise<{ ok: boolean; message: string }> {
      // the sidecar stops the server through the host, then runs the UAC-prompted device restart
      return sidecarCall("npuReset");
    },
    onNpuClean(_cb): () => void {
      return () => {};
    },
    async foundryStatus() {
      // The sidecar owns the foundry daemon/CLI lifecycle: it discovers the exe,
      // checks the version, and reads the cached models. Mapped into the comparison
      // page's shape; the pairwise comparison flow itself is not wired in this build.
      const f = await sidecarCall<SidecarFoundryStatus>("foundryStatus").catch(() => null);
      if (!f) return { installed: false, version: null, source: "known", models: 0, pairs: [], foundryOnly: 0, log: [] };
      return {
        installed: !!f.installed,
        version: f.version ?? null,
        source: "known",
        models: typeof f.cached === "number" ? f.cached : 0,
        pairs: [],
        foundryOnly: 0,
        log: f.note ? [f.note] : [],
        loaded: f.loaded ?? null,
        note: f.note ?? null,
      };
    },
    async foundryAdmin() {
      return sidecarCall("foundryAdmin");
    },
    async foundryConfigSet(key: string, value: string) {
      return sidecarCall("foundryConfigSet", key, value);
    },
    async foundryConfigReset(key?: string) {
      return sidecarCall("foundryConfigReset", key);
    },
    async foundryCacheSet(path: string) {
      return sidecarCall("foundryCacheSet", path);
    },
    async foundryCacheRemove(alias?: string) {
      return sidecarCall("foundryCacheRemove", alias);
    },
    async foundryServer(action: "start" | "stop" | "restart", opts?: { port?: number | null; idleTimeoutMinutes?: number | null }) {
      return sidecarCall("foundryServer", action, opts);
    },
    async foundryLogs(lines?: number): Promise<string> {
      return sidecarCall<string>("foundryLogs", lines).catch(() => "");
    },
    async foundryModelInfo(alias: string) {
      return sidecarCall("foundryModelInfo", alias);
    },
    async foundryModelRegister(input) {
      return sidecarCall("foundryModelRegister", input);
    },
    async foundryModelUnregister(alias: string) {
      return sidecarCall("foundryModelUnregister", alias);
    },
    async foundryModelLoad(alias: string, device?: string | null) {
      return sidecarCall("foundryModelLoad", alias, device);
    },
    async foundryModelUnload(alias: string) {
      return sidecarCall("foundryModelUnload", alias);
    },
    async foundryTranscribe(input: { file: string; model?: string; language?: string }) {
      return sidecarCall("foundryTranscribe", input);
    },
    async foundryReport(): Promise<{ ok: boolean; message: string }> {
      return sidecarCall("foundryReport");
    },
    async requirements() {
      return sidecarCall("requirements");
    },
    async installRequirement(id: string): Promise<{ ok: boolean; message: string }> {
      return sidecarCall("installRequirement", { id });
    },
    async requirementUpdates() {
      return sidecarCall("requirementUpdates");
    },
    async updateRequirement(id: string, pkg: string): Promise<{ ok: boolean; message: string }> {
      return sidecarCall("updateRequirement", { id, pkg });
    },
    async geniexSetType(input: { name: string; type: "llm" | "vlm" }): Promise<{ ok: boolean; message: string }> {
      return sidecarCall("geniexSetType", input);
    },
    async geniexConfigList(): Promise<{ ok: boolean; text?: string; error?: string }> {
      return sidecarCall("geniexConfigList");
    },
    async geniexClean(): Promise<{ ok: boolean; message: string }> {
      return sidecarCall("geniexClean");
    },
    async geniexPullLocal(input: { path: string; name: string; type?: "llm" | "vlm" }): Promise<{ ok: boolean; name?: string; error?: string; cancelled?: boolean }> {
      return sidecarCall("geniexPullLocal", input);
    },
    async geniexPickLocal(kind: "folder" | "zip"): Promise<string | null> {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = kind === "folder"
        ? await open({ multiple: false, directory: true, title: "Choose the model folder" })
        : await open({ multiple: false, directory: false, title: "Choose the AI Hub .zip file", filters: [{ name: "AI Hub model", extensions: ["zip"] }] });
      return typeof picked === "string" ? picked : null;
    },
    async foundryPickAudio(): Promise<string | null> {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"] }]
      });
      return typeof picked === "string" ? picked : null;
    },
    async batteryRead() {
      return sidecarCall("batteryRead");
    },
    async engineCompareStart(_o): Promise<{ ok: boolean; error?: string }> {
      return { ok: false, error: "The engine comparison is not available in this build yet." };
    },
    async labStart(o: { md: string; modelIds: string[] }): Promise<{ ok: boolean; error?: string }> {
      return sidecarCall("labStart", o);
    },
    async labStop(): Promise<boolean> {
      return sidecarCall<boolean>("labStop").catch(() => false);
    },
    async labState() {
      return sidecarCall("labState");
    },
    onLab(cb): () => void {
      labListeners.add(cb);
      return () => labListeners.delete(cb);
    },
    async engineCompareState() {
      // Said up front, so the screen disables the one-click comparison instead of
      // refusing it after the click; running ticked pairs with the benchmark works.
      return { running: false, steps: [], unavailable: "The one-click comparison is not in this build yet. Tick the pairs below and run them with the benchmark instead." };
    },
    onEngineCompare(_cb): () => void {
      return () => {};
    },
    async npuResetStatus(): Promise<{ ready: boolean; auto: boolean }> {
      // the interactive reset runs (UAC prompt through the sidecar); the automatic one does not
      return sidecarCall<{ ready: boolean; auto: boolean }>("npuResetStatus").catch(() => ({ ready: false, auto: false }));
    },
    async supportInfo(): Promise<string> {
      const hw = await invoke<HardwareProfile>("get_hardware_cmd").catch(() => null);
      const app = await invoke<AppInfo>("get_app_info_cmd").catch(() => null);
      return JSON.stringify({ hw, app }, null, 2);
    },
    onBenchMeasured(cb): () => void {
      benchMeasuredListeners.add(cb);
      return () => benchMeasuredListeners.delete(cb);
    },
    async benchImportResults(): Promise<number> {
      return sidecarCall("benchImportResults");
    },
    onModelCheck(cb): () => void {
      modelCheckListeners.add(cb);
      return () => modelCheckListeners.delete(cb);
    },
    onNpuTest(cb): () => void {
      npuTestListeners.add(cb);
      return () => npuTestListeners.delete(cb);
    },
    async benchResults() {
      return sidecarCall("benchResults");
    },
    async benchExport() {
      // the report is written by the sidecar next to the run's results; the caller reveals it
      return sidecarCall("benchExport");
    },
    async benchReveal(file: string | null): Promise<boolean> {
      return sidecarCall<boolean>("benchReveal", file).catch(() => false);
    },
    onBench(cb): () => void {
      benchListeners.add(cb);
      return () => benchListeners.delete(cb);
    },
    onBenchLive(cb): () => void {
      benchLiveListeners.add(cb);
      return () => benchLiveListeners.delete(cb);
    },
    async hfSearch(query: string) {
      return sidecarCall("hfSearch", query);
    },
    async resolveModel(input: string) {
      return sidecarCall("resolveModel", input);
    },
    async browse(q) {
      return sidecarCall("browse", q);
    },
    async dockerVariants(name: string) {
      return sidecarCall("dockerVariants", name);
    },
    async install(entry: CatalogEntry): Promise<void> {
      wireSidecarEvents();
      await sidecarCall("install", entry);
    },
    async cancelInstall(ref: string): Promise<void> {
      // nothing to cancel when no pull is running; a dead sidecar has nothing running either
      await sidecarCall("cancelInstall", ref).catch(() => {});
    },
    async uninstall(entry: CatalogEntry): Promise<{ ok: boolean; message: string }> {
      // Removing a Foundry Local model touches only Foundry's own cache: the GenieX
      // server (and the model it serves) stays up.
      if (!entry.id.startsWith("foundry:")) {
        const st = await invoke<ServerStatus>("get_server_status").catch(() => null);
        // a model that is starting, loading or answering is reading its files: nothing is removed under it
        const gate = uninstallGate(st?.state);
        if (gate === "refuse") return { ok: false, message: `a model is ${st?.state === "busy" ? "answering" : "loading"} (${st?.model ?? "the model server"}). Wait for it, or cancel the switch, then remove the model.` };
        if (gate === "stop") await invoke("stop_server").catch(() => {});
      }
      return sidecarCall("uninstall", entry);
    },

    async selectModel(id: string, explicit = true, opts?: { signal?: AbortSignal }): Promise<void> {
      // A cancelled switch (Settings → Models → Cancel) never reaches the host, and its late answer saves nothing.
      const signal = opts?.signal;
      const cancelled = () => Object.assign(new Error("The model switch was cancelled"), { name: "AbortError" });
      if (signal?.aborted) throw cancelled();
      // A Foundry Local model is served by the sidecar's Foundry host on the first chat:
      // it is never started through GenieX. The choice is saved; nothing else to start.
      if (id.startsWith("foundry:")) {
        await invoke("save_settings_cmd", { patch: { selectedModelId: id, lastModelId: id } });
        return;
      }
      const refStr = await resolveServeRef(id);
      const settings = await invoke<Settings>("get_settings");
      const port = 18181;
      const timeoutSec = readNum(settings, "startupTimeoutSec");
      const strategy = readSetting(settings, "loadingStrategy");
      const powerMode = readSetting(settings, "powerProfile");
      // The SAME effective-load resolver as a preload and the chat path: the model's kept
      // load profile wins over the global compute, so choosing a model starts it the way
      // it is known to load.
      const eff = effectiveLoad({ serveRef: refStr, entryRef: id, profiles: settings?.loadProfiles, globalCompute: readSetting(settings, "compute") });
      const nctx = eff.nctx ?? (settings?.nctxMode && settings?.nctxMode !== "auto" ? parseInt(settings.nctxMode, 10) : undefined);
      const kvType = readSetting(settings, "kvType");
      const kvInRam = readBool(settings, "kvInRam");
      // An explicit number always wins — including 0 (never unload). Truthiness would
      // silently drop a saved 0 back to the strategy default.
      const keepaliveSec = typeof settings?.keepaliveSec === "number" && Number.isFinite(settings.keepaliveSec) ? settings.keepaliveSec : undefined;
      const specType = readBool(settings, "speculativeDecoding.enabled") ? readSetting(settings, "speculativeDecoding.specType") : undefined;
      const draftTokens = readBool(settings, "speculativeDecoding.enabled") ? readNum(settings, "speculativeDecoding.draftTokens") : undefined;
      const draftModel = readBool(settings, "speculativeDecoding.enabled") ? (readSetting(settings, "speculativeDecoding.draftModel") || undefined) : undefined;
      const draftMin = readBool(settings, "speculativeDecoding.enabled") ? (readNum(settings, "speculativeDecoding.draftMin") || undefined) : undefined;
      const draftPMin = readBool(settings, "speculativeDecoding.enabled") ? (readNum(settings, "speculativeDecoding.draftPMin") || undefined) : undefined;
      // Engine loading options that geniex serve takes as defaults: layer offload,
      // the vision encoder's compute unit, a different QAIRT runtime, its own log level.
      const ngl = readNum(settings, "geniexNgl");
      const vitCompute = readSetting(settings, "vitCompute") || undefined;
      const qairtLib = (readSetting(settings, "qairtLib") || "").trim() || undefined;
      const logLevel = readSetting(settings, "geniexLog");
      const skipUpdate = !readBool(settings, "geniexUpdateCheck");

      // No model-only short-circuit here: the supervisor compares the FULL effective
      // configuration and decides reuse itself, so a compute/context/KV change reaches
      // the runtime, and a genuinely identical start stays idempotent.
      // one engine on the NPU: a Foundry Local model still loaded is put down first (two engines on the NPU crashed its DSP)
      if (signal?.aborted) throw cancelled();
      const srv = await invoke<ServerStatus>("start_server", {
        req: {
          retry_model_load: explicit,
          exe: readSetting(settings, "geniexPath") || undefined,
          port,
          model: refStr,
          timeout_sec: timeoutSec,
          strategy,
          keepalive_sec: keepaliveSec,
          compute: eff.compute,
          power_mode: powerMode,
          nctx,
          kv_type: kvType,
          kv_in_ram: kvInRam,
          spec_type: specType,
          draft_tokens: draftTokens,
          draft_model: draftModel,
          draft_min: draftMin,
          draft_p_min: draftPMin,
          ngl,
          vit_compute: vitCompute,
          qairt_lib: qairtLib,
          log_level: logLevel,
          skip_update: skipUpdate,
          metrics: true,
        }
      });
      // Only a model that started becomes the app's choice: a failed start (the call
      // above throws) leaves the previous selection as it was, and so does a switch
      // cancelled while the host was still answering (its late answer is not a choice).
      if (signal?.aborted) throw cancelled();
      await invoke("save_settings_cmd", { patch: { selectedModelId: id, lastModelId: id } });
      for (const l of serverListeners) l(srv);
    },

    async preloadModel(req): Promise<ServerStatus> {
      const settings = await invoke<Partial<Settings>>("get_settings").catch((): Partial<Settings> => ({}));
      const modelId = req?.model || settings?.selectedModelId || "qwen3-4b-thinking-2507";
      const refStr = await resolveServeRef(modelId);
      const timeoutSec = req?.timeout_sec || readNum(settings, "startupTimeoutSec");
      const strategy = req?.strategy || readSetting(settings, "loadingStrategy");
      const powerMode = req?.power_mode || readSetting(settings, "powerProfile");
      // F16: the SAME effective-load resolver the sidecar's chat path uses —
      // explicit request > the model's kept load profile > global compute — so a
      // preloaded server is the server chat would have started, not a second
      // configuration the first chat request then has to load over.
      const eff = effectiveLoad({
        setting: req?.compute !== undefined || req?.nctx !== undefined ? { compute: req?.compute, maxCtx: req?.nctx } : undefined,
        serveRef: refStr,
        profiles: settings?.loadProfiles,
        globalCompute: settings?.compute,
      });
      const compute = eff.compute;
      const kvType = req?.kv_type || readSetting(settings, "kvType");
      const kvInRam = req?.kv_in_ram !== undefined ? req.kv_in_ram : readBool(settings, "kvInRam");
      // Same zero-idle rule: a saved 0 (never unload) must survive, not be dropped
      // into the strategy default by a truthiness check.
      const keepaliveSec = req?.keepalive_sec ?? (typeof settings?.keepaliveSec === "number" && Number.isFinite(settings.keepaliveSec) ? settings.keepaliveSec : undefined);
      const specType = req?.spec_type || (readBool(settings, "speculativeDecoding.enabled") ? readSetting(settings, "speculativeDecoding.specType") : undefined);
      const draftTokens = req?.draft_tokens !== undefined ? req.draft_tokens : (readBool(settings, "speculativeDecoding.enabled") ? readNum(settings, "speculativeDecoding.draftTokens") : undefined);
      const draftModel = req?.draft_model ?? (readBool(settings, "speculativeDecoding.enabled") ? (readSetting(settings, "speculativeDecoding.draftModel") || undefined) : undefined);
      const draftMin = req?.draft_min ?? (readBool(settings, "speculativeDecoding.enabled") ? (readNum(settings, "speculativeDecoding.draftMin") || undefined) : undefined);
      const draftPMin = req?.draft_p_min ?? (readBool(settings, "speculativeDecoding.enabled") ? (readNum(settings, "speculativeDecoding.draftPMin") || undefined) : undefined);
      const ngl = req?.ngl ?? readNum(settings, "geniexNgl");
      const vitCompute = req?.vit_compute || readSetting(settings, "vitCompute") || undefined;
      const qairtLib = (req?.qairt_lib ?? readSetting(settings, "qairtLib") ?? "").trim() || undefined;
      const logLevel = req?.log_level || readSetting(settings, "geniexLog");
      const skipUpdate = req?.skip_update ?? !readBool(settings, "geniexUpdateCheck");

      // one engine on the NPU: a Foundry Local model still loaded is put down first (two engines on the NPU crashed its DSP)
      const status = await invoke<ServerStatus>("preload_model", {
        req: {
          // Caller options first, then the resolved fields: a raw application id riding
          // in req.model ("dynamic:9B", "custom:...") must never overwrite the resolved
          // concrete ref — the spread used to come last and did exactly that, sending
          // an unresolvable id to GenieX.
          ...(req ?? {}),
          exe: req?.exe ?? (readSetting(settings, "geniexPath") || undefined),
          port: req?.port || 18181,
          model: refStr,
          timeout_sec: timeoutSec,
          strategy,
          keepalive_sec: keepaliveSec,
          compute,
          power_mode: powerMode,
          nctx: req?.nctx !== undefined ? req.nctx : (eff.nctx ?? (settings?.nctxMode && settings?.nctxMode !== "auto" ? parseInt(settings.nctxMode, 10) : undefined)),
          kv_type: kvType,
          kv_in_ram: kvInRam,
          spec_type: specType,
          draft_tokens: draftTokens,
          draft_model: draftModel,
          draft_min: draftMin,
          draft_p_min: draftPMin,
          ngl,
          vit_compute: vitCompute,
          qairt_lib: qairtLib,
          log_level: logLevel,
          skip_update: skipUpdate,
          metrics: true,
        }
      });
      for (const l of serverListeners) {
        l(status);
      }
      return status;
    },

    async server(): Promise<ServerStatus> {
      return invoke<ServerStatus>("get_server_status");
    },

    async stopServer(): Promise<void> {
      await invoke("stop_server");
      const status = await invoke<ServerStatus>("get_server_status").catch(() => null);
      if (status) {
        for (const l of serverListeners) l(status);
      }
    },

    async serverLog(): Promise<string[]> {
      return invoke<string[]>("get_server_logs");
    },

    async chat(id: string, modelId: string, messages: ChatMessage[], opts: ChatOptions): Promise<void> {
      // The chat orchestrator runs in the Node sidecar: it starts the model server through the
      // Rust host (the `startChatServer` host capability — geniex.exe has one owner), streams
      // the turn as `chat` sidecar events (routed to chatListeners in wireSidecarEvents), and
      // names, compacts, reviews and improves like the desktop build. The bridge hands over the
      // project's folder (the project store lives here, in the webview) and keeps the machine
      // awake until the turn's terminal event arrives.
      const project = opts.projectId
        ? getLocalJson<Project[]>("mkmn.projects", []).find((p) => p.id === opts.projectId)
        : undefined;
      // the knowledge files travel with the request too (their text is already converted;
      // the sidecar indexes them and retrieves the sections a question needs)
      const withFolder: ChatOptions = { ...opts, projectFolder: project?.folder ?? null, knowledge: project?.files?.length ? project.files.map((f) => ({ id: f.id, name: f.name, content: f.content })) : undefined };
      const start = (async () => {
        try {
          await invoke("inhibit_sleep", { enable: true });
          chatInhibits.add(id);
        } catch { /* sleep inhibition is best effort: the chat runs either way */ }
        activeChats.add(id);
        await sidecarCall("chat", id, modelId, messages, withFolder);
      })();
      chatStarts.set(id, start);
      try {
        await start;
        // answered at once; the turn itself arrives as events
      } catch (err) {
        if (!activeChats.delete(id)) return; // the sidecar exit already settled it
        await releaseChatInhibit(id);
        for (const l of chatListeners) {
          l({
            id,
            type: "error",
            error: { id: "chat-init-error", title: "Chat initialization failed", fix: (err instanceof Error && err.message) || "The chat could not start.", raw: String(err) }
          });
        }
      } finally { chatStarts.delete(id); }
    },

    async compactChat(id: string, modelId: string, messages: ChatMessage[], memoTurns: number, convId?: string) {
      // the summary is built in the sidecar, under the open turn's lease when one is answering
      return sidecarCall("compactChat", id, modelId, messages, memoTurns, ...(convId ? [convId] : []));
    },

    async abortChat(id: string): Promise<void> {
      // the orchestrator in the sidecar holds the turn's AbortController: it answers with a
      // terminal `done` (zeroed stats), which also releases the sleep-inhibit
      await chatStarts.get(id)?.catch(() => undefined);
      try { await sidecarCall("abortChat", id); }
      catch (e) {
        activeChats.delete(id);
        void releaseChatInhibit(id);
        throw e;
      }
    },

    async skipStep(id: string, back?: boolean): Promise<void> {
      await sidecarCall("skipStep", id, !!back).catch(() => {});
    },

    async routerStatus() {
      // the router now runs in the Tauri build too (a small model on the processor,
      // sidecar-owned): the truth comes from the sidecar, with the honest stub only
      // as the fallback when the call itself fails
      try {
        return await sidecarCall("routerStatus");
      } catch {
        return {
          model: "none",
          sizeGB: 0,
          installed: false,
          enabled: false,
          running: false,
          asked: 0,
          lastMs: null,
          lastError: null
        };
      }
    },
    async routerInstall() {
      return sidecarCall("routerInstall");
    },
    async routerCandidates() {
      try {
        return await sidecarCall("routerCandidates");
      } catch {
        return { chosen: null, candidates: [] };
      }
    },
    async routerBench() {
      return sidecarCall("routerBench");
    },
    async routerTest(text: string) {
      return sidecarCall("routerTest", text);
    },
    async routerFileKind(text: string): Promise<string | null | undefined> {
      // the closed file question ("what file does the request ask to be made?"), answered by the router in the
      // sidecar and remembered there: it decides which deep file rules the request's system prompt carries
      return sidecarCall("routerFileKind", text);
    },

    async convertLegacyDoc(name: string, bytes: Uint8Array) {
      return sidecarCall("convertLegacyDoc", name, Array.from(bytes));
    },
    async fixBlock(kind: string, raw: string, reason: string): Promise<string | null> {
      // the mended diagram/chart JSON comes from the sidecar's chat model (the one already loaded)
      return sidecarCall<string | null>("fixBlock", kind, raw, reason);
    },
    async fetchLibrary(url: string) {
      return sidecarCall("fetchLibrary", url);
    },

    async settings(): Promise<Settings> {
      return invoke<Settings>("get_settings");
    },

    async saveSettings(patch: Partial<Settings>): Promise<Settings> {
      return invoke<Settings>("save_settings_cmd", { patch });
    },

    async exportSettingsJson(contents: string): Promise<string | null> {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const target = await save({ defaultPath: "mkmn-settings.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!target) return null;
      await writeFile(target, new TextEncoder().encode(contents));
      return target;
    },

    async importSettingsJson(): Promise<string | null> {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const target = await open({ multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof target !== "string") return null;
      return new TextDecoder().decode(await readFile(target));
    },

    async settingsRepairNotice(): Promise<unknown | null> {
      // the command returns Null when nothing was ever repaired; a bridge error
      // (older host) reads the same way — the notice is informational only
      try { return await invoke<unknown>("get_settings_repair_notice"); } catch { return null; }
    },

    humainRealtimeOpen: (session, model) => sidecarCall("humainRealtimeOpen", session, model),
    humainRealtimeEvents: (session) => sidecarCall("humainRealtimeEvents", session),
    humainRealtimeSend: (session, event) => sidecarCall("humainRealtimeSend", session, event),
    humainRealtimeClose: (session) => sidecarCall("humainRealtimeClose", session),
    humainKeySaved: (credential) => sidecarCall("humainKeySaved", credential),
    humainSaveKey: (credential, key) => sidecarCall("humainSaveKey", credential, key),
    humainModels: (provider) => sidecarCall("humainModels", provider),
    humainOperation: (provider, method, path, body, upload) =>
      invoke("sidecar_call", { method: "humainOperation", args: [provider, method, path, body ?? null, upload ?? null] }),

    async knowledgeStatus(projectId: string, filesHash: string): Promise<{ state: string; error?: string; fileIds: string[]; progress?: { done: number; of: number } } | null> {
      // the sidecar owns the knowledge store; a sidecar that cannot answer says nothing (the screen hides the state)
      return sidecarCall<{ state: string; error?: string; fileIds: string[]; progress?: { done: number; of: number } } | null>("knowledgeStatus", projectId, filesHash).catch(() => null);
    },

    async vectorModelStatus() {
      return sidecarCall<VectorModelStatusView | null>("vectorModelStatus").catch(() => null);
    },
    async vectorModelInstall() {
      return sidecarCall<VectorModelStatusView | null>("vectorModelInstall").catch((e) => ({ installed: false, runtime: true, installing: false, bytes: 0, label: "", error: String((e as Error)?.message ?? e) }));
    },
    async vectorModelRemove() {
      return sidecarCall<VectorModelStatusView | null>("vectorModelRemove").catch(() => null);
    },
    async knowledgeBuild(projectId: string, files: Array<{ id: string; name: string; content: string }>): Promise<{ state: string; count?: number; error?: string } | null> {
      return sidecarCall<{ state: string; count?: number; error?: string } | null>("knowledgeBuild", projectId, files).catch(() => null);
    },

    async pickGeniex(): Promise<string | null> {
      return null;
    },

    async runtimeInfo(): Promise<RuntimeInfo> {
      // Real readings from the Rust hardware probe only: an invented machine identity
      // here contradicted the same page's hardware panel on every other PC.
      const [hw, settings, appInfo] = await Promise.all([
        invoke<HardwareProfile>("get_hardware_cmd").catch(() => unknownHardware()),
        invoke<Settings>("get_settings").catch(() => null),
        invoke<AppInfo>("get_app_info_cmd").catch(() => null),
      ]);
      const geniex = !!appInfo?.geniexPath || !!(settings?.geniexPath);
      return {
        choices: backendChoices(hw, { geniex, platform: "win32", arch: hw.appArch ?? "unknown" }),
        note: backendNote(readSetting(settings, "compute"), readObj(settings, "runtime")),
        llamaPath: null, // the Tauri build serves through GenieX; there is no llama-server path
        llamaVersion: null,
        llamaAvailable: false, // the install/locate controls must say so, not silently do nothing
        cpuName: hw.chipName ?? "Unknown",
        cpuThreads: hw.cpuThreads ?? 0,
        ramGB: hw.ramGB ?? 0,
        gpus: hw.gpus ?? [],
        problems: (hw as HardwareProfile & { problems?: string[] }).problems ?? []
      };
    },

    async installLlamaServer(): Promise<void> {
      // an honest refusal instead of a retry of a step this build never offers: the
      // panel shows the reason (llamaAvailable is false) rather than a dead button
      throw new Error("llama.cpp is not part of this build: the models are served by Qualcomm's GenieX runtime (NPU, hybrid, GPU and CPU).");
    },
    async pickLlamaServer(): Promise<string | null> {
      throw new Error("Locating llama-server is not available in this build: the models are served by Qualcomm's GenieX runtime.");
    },
    async pickFolder(): Promise<string | null> { return sidecarCall<string | null>("pickFolder"); },
    async openGeniexDownload(): Promise<void> {
      // first-launch setup installs GenieX: pressing its install path again retries the step
      await startSetup("setupRetry", "geniex");
    },

    async meters(): Promise<Meters> {
      return invoke<Meters>("get_meters_cmd");
    },

    async estimateMemory(modelRef: string, nctx?: number, kvType?: string): Promise<MemoryEstimate> {
      return invoke<MemoryEstimate>("estimate_memory_cmd", { modelRef, nctx, kvType });
    },

    async powerStatus(): Promise<PowerStatusInfo> {
      return invoke<PowerStatusInfo>("get_power_status_cmd");
    },

    async runBenchmark(modelRef: string, compute?: string, powerMode?: string, nctx?: number): Promise<BenchmarkResult> {
      // the benchmark runs its own GenieX on the NPU: a Foundry Local model still loaded there crashes the DSP
      return invoke<BenchmarkResult>("run_benchmark_cmd", { modelRef, compute, powerMode, nctx });
    },

    async cancelBenchmark(): Promise<void> {
      // the Rust runner stops at the next test boundary, kills a hung server, and records the cancellation
      await invoke("cancel_benchmark_cmd").catch(() => undefined);
    },

    async adaptiveStatus(): Promise<AdaptiveStatusView> {
      return sidecarCall<AdaptiveStatusView>("adaptiveStatus");
    },

    async hardwareConfig(): Promise<HardwareConfigFile> {
      return invoke<HardwareConfigFile>("get_hardware_config_cmd");
    },

    async saveHardwareConfig(patch) {
      return invoke<HardwareConfigFile>("save_hardware_config_cmd", { patch });
    },

    async inhibitSleep(enable: boolean): Promise<void> {
      return invoke<void>("inhibit_sleep", { enable });
    },

    async getQoSStatus(pid?: number): Promise<QoSSummary> {
      return invoke<QoSSummary>("get_qos_status_cmd", { pid });
    },

    async setQoSTier(tier: string, pid?: number): Promise<QoSSummary> {
      return invoke<QoSSummary>("set_qos_tier_cmd", { tier, pid });
    },

    async verifySha256(path: string, expectedSha256?: string): Promise<Sha256VerificationResult> {
      return invoke<Sha256VerificationResult>("verify_sha256_cmd", { path, expectedSha256 });
    },

    async npuDiagnostics() {
      return invoke("npu_diagnostics_cmd");
    },

    async setupState(): Promise<SetupState> {
      return visibleSetup(await sidecarCall<SetupState>("setupState"));
    },
    async setupSkip(id: string): Promise<void> { await sidecarCall("setupSkip", id); },
    async setupRetry(id: string): Promise<void> { await startSetup("setupRetry", id); },
    async setupRunUnsigned(id: string): Promise<void> { await startSetup("setupRunUnsigned", id); },
    async setupDismiss(): Promise<void> { await finishSetup("setupDismiss"); },
    async setupConfirm(): Promise<void> { await startSetup("setupConfirm"); },
    async setupDecline(): Promise<void> { await finishSetup("setupDecline"); },
    onSetup(cb: (st: SetupState) => void): () => void {
      const listener = (state: SetupState) => cb(visibleSetup(state));
      setupListeners.add(listener);
      return () => setupListeners.delete(listener);
    },

    async updateState(): Promise<UpdateState> {
      // the updater is the same honest "disabled" class the desktop build runs (no update
      // transport exists until a signed MKMN release channel does)
      return sidecarCall<UpdateState>("updateState");
    },
    async updateCheck(): Promise<UpdateState> {
      return sidecarCall<UpdateState>("updateCheck");
    },
    async updateInstall(): Promise<void> {
      await sidecarCall("updateInstall");
    },
    async updateForce(): Promise<UpdateState> {
      return sidecarCall<UpdateState>("updateForce");
    },
    onUpdate(cb: (st: UpdateState) => void): () => void {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },

    async npuPlan(): Promise<NpuPlanView> {
      return {
        lines: [],
        budgetGB: 24,
        usableGB: 28,
        totalGB: 32,
        fits: true,
        advice: null
      };
    },

    async voiceModels(): Promise<VoiceModelView[]> {
      return sidecarCall<VoiceModelView[]>("voiceModels");
    },
    async voiceStatus(): Promise<VoiceStatus> {
      return sidecarCall<VoiceStatus>("voiceStatus");
    },
    async voiceDownload(id: string): Promise<void> {
      await sidecarCall("voiceDownload", id); // progress arrives as voiceDownload events
    },
    async voiceCancelDownload(id: string): Promise<void> {
      await sidecarCall("voiceCancelDownload", id).catch(() => {});
    },
    async voiceRemove(id: string): Promise<void> {
      await sidecarCall("voiceRemove", id);
    },
    async voiceApply(): Promise<VoiceStatus> {
      return sidecarCall<VoiceStatus>("voiceApply");
    },
    async transcribe(samples: Float32Array, sampleRate: number, partial?: boolean): Promise<string | null> {
      return sidecarCall<string | null>("transcribe", Array.from(samples), sampleRate, partial);
    },
    async voiceNeeds(kinds: ("stt" | "tts")[]): Promise<VoiceNeed[]> {
      return sidecarCall<VoiceNeed[]>("voiceNeeds", kinds);
    },
    async voiceQuickInstall(kinds: ("stt" | "tts")[], alt?: boolean): Promise<{ ok: boolean; error?: string }> {
      return sidecarCall("voiceQuickInstall", kinds, alt);
    },
    async speak(id: string, text: string): Promise<void> {
      await sidecarCall("speak", id, text); // the audio arrives as voiceAudio events
    },
    async cancelSpeak(id: string): Promise<void> {
      await sidecarCall("cancelSpeak", id).catch(() => {});
    },
    async saveVoice(patch: Partial<VoiceSettings>): Promise<Settings> {
      // the sidecar clamps the thresholds, merges, and reloads the models when the choice changed
      return sidecarCall<Settings>("saveVoice", patch);
    },
    onVoiceDownload(cb): () => void {
      voiceDownloadListeners.add(cb);
      return () => voiceDownloadListeners.delete(cb);
    },
    onVoiceAudio(cb): () => void {
      voiceAudioListeners.add(cb);
      return () => voiceAudioListeners.delete(cb);
    },
    onVoiceStatus(cb): () => void {
      voiceStatusListeners.add(cb);
      return () => voiceStatusListeners.delete(cb);
    },

    // Projects CRUD
    async projects(): Promise<Project[]> {
      return getLocalJson<Project[]>("mkmn.projects", []);
    },
    async saveProject(p: Project): Promise<Project[]> {
      const list = getLocalJson<Project[]>("mkmn.projects", []);
      const idx = list.findIndex((x) => x.id === p.id);
      const updated = { ...p, updated: Date.now() };
      if (idx >= 0) list[idx] = updated;
      else list.push(updated);
      if (!setLocalJson("mkmn.projects", list)) throw new Error("The project could not be saved: local storage refused the write.");
      await refreshTaskProjects(p.id, updated);
      return list;
    },
    async deleteProject(id: string): Promise<Project[]> {
      const list = getLocalJson<Project[]>("mkmn.projects", []).filter((p) => p.id !== id);
      if (!setLocalJson("mkmn.projects", list)) throw new Error("The project could not be removed: local storage refused the write.");
      await refreshTaskProjects(id, null);
      // its knowledge index, vectors and offloaded knowledge text go with it. Not awaited: the
      // project is already removed, and a busy sidecar may take up to its call timeout (600 s)
      // to answer, so a failure here is logged, never thrown
      void sidecarCall<string[]>("knowledgeForget", id).catch((e) => console.error(`[projects] the knowledge files of a deleted project could not be removed: ${(e as Error).message}`));
      return list;
    },

    // Artifacts CRUD
    async artifacts(): Promise<Artifact[]> {
      return getLocalJson<Artifact[]>("mkmn.artifacts", []);
    },
    async saveArtifact(a: Artifact): Promise<Artifact[]> {
      const list = getLocalJson<Artifact[]>("mkmn.artifacts", []);
      const idx = list.findIndex((x) => x.id === a.id);
      const updated = { ...a, updated: Date.now() };
      if (idx >= 0) list[idx] = updated;
      else list.push(updated);
      if (!setLocalJson("mkmn.artifacts", list)) throw new Error("The file could not be saved: local storage refused the write.");
      versionBook.save(updated);
      for (const l of artifactListeners) l();
      return list;
    },
    async deleteArtifact(id: string): Promise<Artifact[]> {
      const list = getLocalJson<Artifact[]>("mkmn.artifacts", []).filter((a) => a.id !== id);
      if (!setLocalJson("mkmn.artifacts", list)) throw new Error("The file could not be removed: local storage refused the write.");
      versionBook.forget(id);
      for (const l of artifactListeners) l();
      return list;
    },
    async artifactVersions(id: string) {
      return versionBook.versions(id);
    },
    async artifactVersionText(id: string, versionId: string): Promise<string | null> {
      return versionBook.text(id, versionId);
    },
    async artifactVersionAction(id: string, action) {
      return versionBook.act(id, action);
    },
    async saveOffice(kind: OfficeKind, source: string, name: string): Promise<string | null> {
      if (kind !== "docx" && kind !== "xlsx" && kind !== "pptx") throw new Error(`Unknown office kind: ${kind}`);
      if (typeof source !== "string" || source.length > 4_000_000) throw new Error("The document is too large to save.");
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const target = await save({ defaultPath: `${String(name || "document").replace(/[^\w .-]+/g, "_")}.${kind}`, filters: [{ name: kind, extensions: [kind] }] });
      if (!target) return null;
      const bytes = await buildOffice(kind, source);
      await writeFile(target, bytes);
      return target;
    },
    async exportArtifact(id: string, images?: Record<string, string>, format?: string, draft?: Artifact): Promise<string | null> {
      const a = tauriArtifactSource.list().find((x) => x.id === id) ?? (draft && typeof draft.content === "string" && draft.content ? draft : undefined);
      if (!a) throw new Error("This file has not been written yet. Try again when the answer is finished.");
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const safe = (t: string) => t.replace(/[^\w .-]+/g, "_");
      const from = officeSourceOf(a.kind);
      // the pictures of drawn figures, as the layouts read them (the same rule as the desktop build)
      const pics: Pics = {};
      if (images && typeof images === "object") {
        for (const [k, v] of Object.entries(images)) {
          if (/^fig:/.test(k) && typeof v === "string" && v.length < 12 * 1024 ** 2) {
            const p = picFromData(v, "");
            if (p) pics[k] = p;
          }
        }
      }
      let ext: string, data: Uint8Array | string;
      if (from) {
        // the office file itself, or its markdown text; pdf and LibreOffice formats need
        // the office suite, which this build does not carry. An unsupported request is
        // REFUSED with the reason: silently writing the source format under the
        // requested name produced a .pdf full of .xlsx bytes.
        const want = format ?? (a.kind === "markdown" ? "md" : from);
        if (want !== "md" && want !== from) {
          throw new Error(`This build cannot save .${want} files (it carries no office suite or PDF writer). Save as .${from} or .md instead.`);
        }
        if (want === "md") { ext = "md"; data = a.content; }
        else { ext = from; data = await buildOffice(from, a.content, pics); }
      } else {
        if (format && format !== fileExtension(a.kind, a.language ?? "")) {
          // same honesty for the non-office kinds: the extension asked for is the extension written
          throw new Error(`This file can only be saved as .${fileExtension(a.kind, a.language ?? "")}.`);
        }
        ext = fileExtension(a.kind, a.language ?? "");
        data = a.content;
      }
      const target = await save({ defaultPath: `${safe(a.title)}.${ext}`, filters: [{ name: ext, extensions: [ext] }] });
      if (!target) return null;
      if (typeof data === "string") await writeFile(target, new TextEncoder().encode(data));
      else await writeFile(target, data);
      return target;
    },

    // Code execution & sites — the sandbox runs in the sidecar: the approval dialog and the
    // "open it" come from the Rust host, the output streams back as `run` events.
    async runCode(runId: string, language: string, code: string): Promise<void> {
      await sidecarCall("runCode", runId, language, code);
    },
    async launchSite(files, entry) {
      return sidecarCall("launchSite", files, entry);
    },
    onSiteNav(_cb): () => void {
      return () => {};
    },
    onFigureRequest(_cb): () => void {
      return () => {};
    },
    async figureResult(_id: string, _dataUrl: string | null): Promise<void> {},
    async runCommand(runId: string, command: string): Promise<void> {
      await sidecarCall("runCommand", runId, command);
    },
    async writeRun(runId: string, text: string): Promise<void> {
      await sidecarCall("writeRun", runId, text).catch(() => {});
    },
    async stopRun(runId: string): Promise<void> {
      await sidecarCall("stopRun", runId).catch(() => {});
    },
    onRun(cb): () => void {
      wireSidecarEvents();
      runListeners.add(cb);
      return () => runListeners.delete(cb);
    },

    // Computer Use — the window list and the grant are the HOST's (the driver is
    // never reachable from here); the run streams `agentRun` events from the sidecar.
    async agentListWindows(): Promise<DriverWindow[]> {
      return invoke<DriverWindow[]>("agent_list_windows_cmd");
    },
    async agentBeginRun(hwnd: number): Promise<AgentGrant> {
      return invoke<AgentGrant>("agent_begin_run_cmd", { hwnd });
    },
    async agentStopRun(runId: string): Promise<void> {
      // The host command aborts the sidecar's run AND clears the grant (also
      // when the sidecar is already gone).
      await invoke("agent_stop_cmd", { runId }).catch(() => {});
    },
    async agentStartRun(runId: string, hwnd: number, task: string, modelId: string): Promise<void> {
      // fire and forget on the sidecar's side: the progress streams back as agentRun events
      await sidecarCall("agentRun", runId, hwnd, task, modelId);
    },
    onAgentRun(cb: (e: AgentRunEvent) => void): () => void {
      wireSidecarEvents();
      agentRunListeners.add(cb);
      return () => agentRunListeners.delete(cb);
    },

    // Edit a copy — the file dialog is the bridge's (like geniexPickLocal); the loop
    // is the sidecar's and streams the same `agentRun` events. No grant, no driver.
    async docPickSource(): Promise<string | null> {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        title: "Choose the Word document to edit a copy of",
        filters: [{ name: "Word document", extensions: ["docx", "docm"] }],
      });
      return typeof picked === "string" ? picked : null;
    },
    async docEditStart(runId: string, sourcePath: string, task: string, modelId: string): Promise<void> {
      // fire and forget on the sidecar's side: the progress streams back as agentRun events
      await sidecarCall("agentDocEdit", runId, sourcePath, task, modelId);
    },
    async docEditDecide(runId: string, approved: boolean): Promise<void> {
      // the review gate's answer: the sidecar resolves the run's wait, and the
      // loop either writes the copy or settles cancelled with nothing written
      await sidecarCall("agentDocEditDecide", runId, approved).catch(() => {});
    },
    async openEditedCopy(path: string): Promise<boolean> {
      // the host accepts ONLY an existing Word document here, so a stray path
      // can never be opened as a program
      return sidecarCall<boolean>("openEditedCopy", path).catch(() => false);
    },

    // Tasks — the store and the scheduler live in the sidecar (tasks.json under its data
    // folder): the schedule is validated and the next run computed there, changes arrive
    // as `tasks` events.
    async tasks(): Promise<ScheduledTask[]> {
      return sidecarCall<ScheduledTask[]>("tasks").catch(() => getLocalJson<ScheduledTask[]>("mkmn.tasks", []));
    },
    async saveTask(t: ScheduledTask): Promise<ScheduledTask[]> {
      // The project store lives in THIS webview, and the scheduler runs in the sidecar:
      // a snapshot of the project rides with the task, so a scheduled run's system prompt
      // carries the same project context a chat gets (the sidecar cannot read this store).
      const withProject: ScheduledTask = t.projectId
        ? { ...t, project: getLocalJson<Project[]>("mkmn.projects", []).find((p) => p.id === t.projectId) ?? null }
        : { ...t, project: null };
      const list = await sidecarCall<ScheduledTask[]>("saveTask", withProject);
      setLocalJson("mkmn.tasks", list); // keep the page's cache in step for a same-tick read
      return list;
    },
    async deleteTask(id: string): Promise<ScheduledTask[]> {
      const list = await sidecarCall<ScheduledTask[]>("deleteTask", id);
      setLocalJson("mkmn.tasks", list);
      return list;
    },
    async forgetConversation(convId: string): Promise<{ journals: number; payloads: number }> {
      return sidecarCall<{ journals: number; payloads: number }>("forgetConversation", convId);
    },
    async runTask(id: string): Promise<void> {
      await sidecarCall("runTask", id);
    },
    onTasks(cb): () => void {
      wireSidecarEvents();
      taskListeners.add(cb);
      return () => taskListeners.delete(cb);
    },
    onArtifacts(cb): () => void {
      artifactListeners.add(cb);
      return () => artifactListeners.delete(cb);
    },

    // Global Events
    onInstall(cb): () => void {
      installListeners.add(cb);
      return () => installListeners.delete(cb);
    },
    onChat(cb: (e: ChatEvent) => void): () => void {
      chatListeners.add(cb);
      return () => chatListeners.delete(cb);
    },
    // The host's coordinated shutdown (src-tauri/src/shutdown.rs emits `app-shutdown`
    // before the sidecar and the supervisor are stopped): the renderer flushes its
    // pending chat saves here, synchronously, while the process is still alive.
    onAppShutdown(cb: () => void): () => void {
      wireHostShutdown();
      shutdownListeners.add(cb);
      return () => shutdownListeners.delete(cb);
    },
    async conversations() {
      // The chats live under the key the window reads at start (store.ts loadConversations).
      // The old second key is read at most once, and only when the kept key holds nothing
      // (a profile saved by an older build that never wrote the kept key). While the kept
      // key is still empty the old copy stays in place: it is the only copy until a save
      // lands under the kept key (markLegacyMigrated), so it is not removed on this read.
      const kept = getLocalJson<unknown[]>(CONVERSATIONS_KEY, []);
      const hasKept = Array.isArray(kept) && kept.length > 0;
      let legacy: unknown[] = [];
      if (!hasKept && !legacyChatKeyRead) legacy = getLocalJson<unknown[]>("mkmn.conversations", []);
      legacyChatKeyRead = true;
      if (hasKept) forgetLegacyConversations();
      if (hasKept) return kept;
      return Array.isArray(legacy) ? legacy : [];
    },
    // The old copy's removal: called by the saver's onResult once its write reported ok
    // (the kept key now holds a saved, non-empty list), so a failed first write never
    // costs the only copy of the chats.
    markLegacyMigrated(): void {
      forgetLegacyConversations();
    },
    async saveConversations(c) {
      // No host copy in this build: the renderer's own save (one key, once per flush)
      // is the stored copy, and the window reads it back at start. Writing a second
      // key meant stringifying the whole history twice on every streamed token.
      return c;
    },
    async saveMedia(dataUrl: string, _name?: string): Promise<{ mediaId: string; path: string }> {
      // the picture is written to the sidecar's media folder (a real file, read back by id)
      return sidecarCall<{ mediaId: string; path: string }>("saveMedia", dataUrl).catch(() => ({ mediaId: "", path: "" }));
    },
    async readMedia(mediaId: string): Promise<{ dataUrl: string } | null> {
      return sidecarCall<{ dataUrl: string } | null>("readMedia", mediaId).catch(() => null);
    },
    onServer(cb: (s: ServerStatus) => void): () => void {
      serverListeners.add(cb);
      return () => serverListeners.delete(cb);
    }
  };
}

export function setupTauriBridge(): void {
  if (typeof window === "undefined") return;

  const runningInTauri = isTauri() || "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (runningInTauri && !window.mkmn) {
    console.log("[TauriBridge] Initializing native Tauri v2 API bridge for MKMN AI");
    window.mkmn = createTauriApi();
  }
  if (runningInTauri) {
    // A web address clicked in the interface goes to the default browser through the opener
    // plugin (its permission here covers http/https addresses only): a webview does not leave
    // for an outside page, and a new window of its own is not something this app offers.
    document.addEventListener(
      "click",
      (ev) => {
        const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        const href = a?.getAttribute("href") ?? "";
        if (!a || !/^https?:\/\//i.test(href)) return;
        ev.preventDefault();
        import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(href))
          .catch((e) => console.warn("[TauriBridge] the link could not be opened:", e));
      },
      true
    );
  }
}
