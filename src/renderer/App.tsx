import { figureImage, figuresOfText, renderFigures } from "./figureImages";
import { figureKey } from "../core/figures";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { invoke } from "@tauri-apps/api/core";
import { currentFiles, lineageKey } from "../core/versions";
import type { VersionResult } from "../core/versionBook";
import { replaceArtifact } from "../core/artifacts";
import { hashText } from "../core/memo";
import type { AppInfo, CatalogItem } from "../shared/api";
import type { Artifact, FriendlyError, HardwareProfile, Meters, Project, ScheduledTask, ServerStatus, Settings, VoiceStatus } from "../shared/types";
import { HUMAIN_LABEL, cloudProviderOf } from "../shared/humain";
import { readBool, readSetting, voiceSettings as readVoiceSettings } from "../shared/settingsSchema";
import { Chat } from "./Chat";
import { SetupScreen } from "./SetupScreen";
import type { SetupState } from "../core/setup";
import { Models } from "./Models";
import { parseBenchProfiles, type BenchProfile } from "../core/benchStore";
import { SettingsView } from "./SettingsView";
import type { SettingsTab } from "./settingsSearch";
import { tabLabel } from "./settingsSearch";
import { executionStatus, observedExecutionTarget } from "../core/settingsUi";
import { COMPUTE_LABEL } from "../core/adaptiveCompute";
import { MetersBar } from "./MetersBar";
import { Projects, newProject } from "./Projects";
import { Artifacts } from "./Artifacts";
import { Tasks } from "./Tasks";
import { Search } from "./Search";
import { SKILL_DOCS } from "../core/skillDocs";
import { allSkills } from "../core/skillsDefault";
import { registerLibraries } from "../core/skillLibs";
import { Customize } from "./Customize";
import { ArtifactIcon, BriefcaseIcon, ChipIcon, ClockIcon, GearIcon, PinIcon, ProjectIcon, SearchIcon } from "./Icons";
import { ICONS, Icon } from "./Icon";
import { usePresence, useFocusTrap, EXIT_MS, reducedMotion } from "./usePresence";
import { Conversation, Turn, adoptInlineMedia, hydrateConversations, loadConversations, mergeConversations, newConversation, writePersistableConversations } from "./store";
import { createConversationSaver, type ConversationSaver } from "./conversationSaver";
import { applyAppearance, storedAppearance, subscribeToSystemAppearance } from "./theme";
import { LogoMark } from "./Icons";
import { BRAND } from "./brand";
import { TitlebarMetrics } from "./TitlebarMetrics";
import { ModelSwitcher, switchNoteOutdated, type SwitchPhase } from "./modelSwitch";
import { initialObservation, lastUpdatedText, observeFailure, observeSuccess, phaseView, phaseViewSame, withTimeout, ObservationFeed, type Observation, type PhaseView } from "./metricsModel";

export type Tab = "chat" | "projects" | "artifacts" | "tasks" | "customize";
/** Settings is the one dialog: the Models library is its Models group since 2.10. */
type Dialog = "settings";

const SIDE_MIN = 200, SIDE_MAX = 440, NARROW_AT = 820;
/** The navigation rail's two widths: ONE source for the CSS variable (--rail-w),
    the drawer/backdrop offsets and the titlebar brand width — expanded or not. */
const RAIL_W = 60, RAIL_W_EXPANDED = 168;
const SHORT_STATE: Record<ServerStatus["state"], string> = { stopped: "Idle", starting: "Starting…", loading: "Loading…", ready: "Ready", busy: "Generating…", restarting: "Restarting…", failed: "Stopped", unloaded: "Unloaded" };
const STATE_LABEL:Record<ServerStatus["state"], string> = {
  stopped: "Model idle", starting: "Starting…", loading: "Loading model…", ready: BRAND.modelReady, busy: "Generating…", restarting: "Restarting…", failed: "The AI stopped working. Send your message again, or see Settings › Developer › Last error", unloaded: "Model unloaded — it reloads on the next message"
};

/** Every DISPLAYED meter field takes part in the value comparison: a changed memory
    budget or a changed explanation ("why the NPU figures are missing") is a
    meaningful update even when the percentages stand still. */
const metersSame = (a: Meters | null, b: Meters): boolean =>
  !!a && a.ramPercent === b.ramPercent && a.ramUsedGB === b.ramUsedGB && a.ramTotalGB === b.ramTotalGB &&
  a.npuMemGB === b.npuMemGB && a.npuBudgetGB === b.npuBudgetGB && a.npuUtilPercent === b.npuUtilPercent &&
  a.npuNote === b.npuNote && a.ramWarning === b.ramWarning;

/** Field-wise equality for the server status (deep, but these objects are small). */
const serverSame = (a: ServerStatus | null, b: ServerStatus): boolean =>
  !!a && JSON.stringify(a) === JSON.stringify(b);

/** What each startup read is called in words, for the loading/error screens. */
const BOOT_READ_LABEL: Record<string, string> = {
  settings: "Your settings", info: "App information", hw: "Hardware detection", setup: "First-run state",
  server: "The AI runtime status", voice: "Voice status", projects: "Projects", artifacts: "Files",
  tasks: "Tasks", catalog: "The model catalog", stored: "Saved chats",
};
/** The reads that gate the interface itself; the rest are optional data. */
const ESSENTIAL_BOOT_KEYS = ["settings", "info", "hw", "setup"];
/** The optional reads: they may still be in flight (or have failed) once the
    essentials have landed, and the app stays usable while that is said out loud. */
const OPTIONAL_BOOT_KEYS = ["server", "voice", "projects", "artifacts", "tasks", "catalog", "stored"];
/** Each poll request must finish (or give up) inside this window: the bridge cannot
    cancel a request once it is sent, so past this the caller stops waiting and the
    feed's ordering rule invalidates any late response. */
const FEED_TIMEOUT_MS = 10_000;
/** The same bound for each startup read (none may hold the window hostage). */
const STARTUP_TIMEOUT_MS = 10_000;
/** How often the freshness watchdog re-publishes the feed phases from the clock. */
const WATCHDOG_MS = 1_000;

/** One chat row of the sidebar: memoized on primitives, so while an answer streams
    (or any other state moves) the rows that did not change are not drawn again. */
const ChatRow = memo(function ChatRow(props: {
  id: string; title: string; named: boolean; pinned: boolean; archived: boolean; nested: boolean;
  active: boolean; busy: boolean; leaving: boolean; fresh: boolean; actionsOpen: boolean;
  onOpen: (id: string) => void; onArchive: (id: string, on: boolean) => void; onRemove: (id: string) => void; onPin: (id: string) => void; onActions: (id: string | null) => void;
}) {
  const { id, title, named, pinned, archived, nested, active, busy, leaving, fresh, actionsOpen, onOpen, onArchive, onRemove, onPin, onActions } = props;
  return (
    <div className={`recent-wrap ${leaving ? "leaving" : ""} ${fresh ? "" : "fresh"}`}><div className="recent-clip">
      <div className={`recent ${nested ? "nested" : ""} ${active ? "active" : ""} ${busy ? "busy" : ""}`} onClick={() => onOpen(id)}>
        {/* The title itself is a native button (keyboard Enter/Space, screen-reader
            role); the action buttons stay its siblings, never its children. */}
        <button type="button" className="recent-open" onClick={(e) => { e.stopPropagation(); onOpen(id); }}>
          <span className="recent-title"><span key={title} className={named ? "reveal" : undefined}>{title}</span></span>
        </button>
        {archived
          ? <button className="x show" title="Restore chat" aria-label="Restore chat" onClick={(e) => { e.stopPropagation(); onArchive(id, false); }}><Icon d={ICONS.retry} size={14} /></button>
          : <button className={`x more ${pinned ? "pinned" : ""}`} title="Chat actions" aria-label="Chat actions" aria-expanded={actionsOpen} onClick={(e) => { e.stopPropagation(); onActions(actionsOpen ? null : id); }}>⋯</button>}
        {archived && <button className="x show" title="Delete chat" aria-label="Delete chat" onClick={(e) => { e.stopPropagation(); onRemove(id); }}><Icon d={ICONS.trash} size={14} /></button>}
        {!archived && actionsOpen && (
          <div className="recent-actions" onMouseLeave={() => onActions(null)}>
            <button className={`x show pin ${pinned ? "on" : ""}`} title={pinned ? "Unpin chat" : "Pin chat"} aria-label={pinned ? "Unpin chat" : "Pin chat"} onClick={(e) => { e.stopPropagation(); onActions(null); onPin(id); }}><PinIcon /></button>
            <button className="x show" title="Archive chat" aria-label="Archive chat" onClick={(e) => { e.stopPropagation(); onActions(null); onArchive(id, true); }}><Icon d={ICONS.archive} size={14} /></button>
            <button className="x show" title="Delete chat" aria-label="Delete chat" onClick={(e) => { e.stopPropagation(); onActions(null); onRemove(id); }}><Icon d={ICONS.trash} size={14} /></button>
          </div>
        )}
      </div>
    </div></div>
  );
});

export function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [settingsStart, setSettingsStart] = useState<SettingsTab | undefined>();
  /** The group Settings shows right now: the rail lights Models or Settings by it. */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  /** A scheduled task a search result named: the Tasks page opens it on arrival. */
  const [taskToOpen, setTaskToOpen] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [items, setItems] = useState<CatalogItem[]>([]);
  /** Local benchmark measurements (hardware.json's calibratedProfiles), read once at
   *  startup (the reload-after-restart path) and refreshed after a successful benchmark. */
  const [benchProfiles, setBenchProfiles] = useState<Record<string, BenchProfile>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const voiceSettings = useMemo(() => readVoiceSettings(settings), [settings]);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  /** The voice notice the person closed: it stays away until the text changes. */
  const [closedNotice, setClosedNotice] = useState("");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** The meters and the server status are OBSERVATIONS, not just values: the last
      successful reading is kept apart (with its time and failure counters) from the
      measured values, so a poll that stops refreshing visibly expires instead of
      sitting on screen looking live. The observation metadata lives in refs; only
      value changes and phase flips re-render (an unchanged fresh reading renders
      nothing new). */
  const metersObsRef = useRef<Observation<Meters>>(initialObservation());
  const [meters, setMeters] = useState<Meters | null>(null);
  const [metersView, setMetersView] = useState<PhaseView>({ phase: "loading", at: 0, stamp: "" });
  const serverObsRef = useRef<Observation<ServerStatus>>(initialObservation());
  const [serverView, setServerView] = useState<PhaseView>({ phase: "loading", at: 0, stamp: "" });
  const [bootErrors, setBootErrors] = useState<Record<string, string> | null>(null);
  /** The optional boot reads still in flight once the essentials have settled: named
      in the status banner so a pending section is identified, never silently missing. */
  const [bootPending, setBootPending] = useState<string[]>([]);
  const [booting, setBooting] = useState(true);
  const [changingChatMode, setChangingChatMode] = useState(false);
  const [chatModeError, setChatModeError] = useState("");
  const [modelSelectionError, setModelSelectionError] = useState<{ id: string; error: FriendlyError } | null>(null);
  const modelSelectionPending = useRef(false);
  // the pending model switch (Settings → Models → Use): its phase is shown with Cancel, its outcome as a note
  const switcherRef = useRef<ModelSwitcher | null>(null);
  const switchExplicit = useRef(true);
  const [switchPhase, setSwitchPhase] = useState<SwitchPhase>({ kind: "idle" });
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const switchPhaseError = useRef<string | null>(null);
  // a switch's outcome note says what runs: once a model is loaded again (the next message, another switch) it is outdated
  const lastServerState = useRef<string | null>(null);
  useEffect(() => {
    const next = server?.state ?? null;
    if (switchNoteOutdated(lastServerState.current, next)) setSwitchNote(null);
    lastServerState.current = next;
  }, [server?.state]);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [convs, setConvs] = useState<Conversation[]>(() => { const c = loadConversations(); return c.length ? c : [newConversation()]; });
  /** Debounced saver for the chats (see conversationSaver.ts): streamed tokens no longer
      stringify and write the whole history on every event. The host's shutdown event
      flushes it (registered with the other exit listeners below). */
  const saverRef = useRef<ConversationSaver | null>(null);
  if (!saverRef.current) {
    saverRef.current = createConversationSaver({
      write: writePersistableConversations,
      // the host keeps a second copy: picture bytes stay in the media store, only their ids are written
      writeHost: (clean) => { void api().saveConversations(clean).catch(() => undefined); },
      onResult: (saved) => {
        // the old `mkmn.conversations` copy is forgotten only once a save has landed under
        // the kept key: a failed write must not cost the only copy of the chats
        if (saved.ok) api().markLegacyMigrated();
        if (saved.droppedMedia) setStorageWarning("Storage was full: every chat was kept, but some picture bytes that had no saved file were dropped. Attach those pictures again to keep them.");
        else if (!saved.ok) setStorageWarning(`Chats could not be saved to this profile (${saved.error ?? "storage unavailable"}). They are kept while the app is open.`);
      }
    });
  }
  const [searchOpen, setSearchOpen] = useState(false);
  /** A chat that could not be written down, or pictures dropped to keep the chats: said once, never silently. */
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  /** A project save the storage refused: shown until a save of it lands. */
  const [projectSaveError, setProjectSaveError] = useState<{ project: Project; message: string } | null>(null);
  /** The chat deleted last, kept a few seconds so Undo can put it back where it was. */
  const [undoChat, setUndoChat] = useState<{ conv: Conversation; index: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The rail's expanded form (labels under the icons): remembered until it is switched back. */
  const [railExpanded, setRailExpanded] = useState<boolean>(() => { try { return localStorage.getItem("opennpu.railExpanded") === "1"; } catch { return false; } });
  // the write lives here, not in the state updater: updaters must stay pure (and
  // React may call them twice in development)
  useEffect(() => { try { localStorage.setItem("opennpu.railExpanded", railExpanded ? "1" : "0"); } catch { /* not saved */ } }, [railExpanded]);
  const toggleRail = () => setRailExpanded((v) => !v);
  /** Immediate rail tooltips (native titles are delayed and never show on keyboard focus). The rail is a
      scroll container, so a CSS ::after would be clipped — this one is fixed-positioned. */
  const [railTip, setRailTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tipFrom = useRef<HTMLElement | null>(null);
  const railTipEvent = (e: React.MouseEvent | React.FocusEvent, on: boolean) => {
    const el = (e.target as HTMLElement).closest?.(".rail-btn") as HTMLElement | null;
    if (on && el && el !== tipFrom.current) {
      tipFrom.current = el;
      const t = el.getAttribute("data-tip");
      if (!t || railExpanded) { setRailTip(null); return; }
      const r = el.getBoundingClientRect();
      setRailTip({ text: t, x: r.right + 8, y: r.top + r.height / 2 });
    } else if (!on || !el) { tipFrom.current = null; setRailTip(null); }
  };
  const [activeId, setActiveId] = useState<string>(() => convs[0].id);
  const [leaving, setLeaving] = useState<string[]>([]);
  const seen = useRef<Set<string>>(new Set(convs.map((c) => c.id)));
  const settingsModalRef = useRef<HTMLDivElement>(null);
  const dlg = usePresence<Dialog>(dialog);
  const sideMenu = usePresence<true>(menuOpen ? true : null);
  /** Closes the dialog. */
  const popDialog = () => setDialog(null);
  /** Opens Settings on a group (undefined: the last group the person looked at). */
  const openSettings = (start?: SettingsTab) => { setMenuOpen(false); setSettingsStart(start); setDialog("settings"); };
  useFocusTrap(settingsModalRef, dlg.value === "settings" && !dlg.closing, popDialog);
  useEffect(() => { if (dlg.value) settingsModalRef.current?.focus({ preventScroll: true }); }, [dlg.value]);
  // If the opener was unmounted in the same commit the dialog closed (e.g. "Use" in
  // the Models group), the trap cannot restore focus — the rail's first button takes it.
  useEffect(() => {
    if (dlg.value !== null) return;
    const t = setTimeout(() => {
      if (document.activeElement === document.body) document.querySelector<HTMLElement>(".rail-home")?.focus({ preventScroll: true });
    }, reducedMotion() ? 0 : EXIT_MS);
    return () => clearTimeout(t);
  }, [dlg.value]);
  useEffect(() => { convs.forEach((c) => seen.current.add(c.id)); }, [convs]);
  // Browser storage that refuses a write must never look like a save: the bridge raises
  // this event, the app shows one honest warning instead of silently losing work.
  useEffect(() => {
    const onStorageError = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key?: string } | undefined;
      setStorageWarning(`Browser storage refused a save ("${detail?.key ?? "your work"}"): free up space or remove old files, then save again. Nothing was lost until you close the page.`);
    };
    window.addEventListener("mkmn-storage-error", onStorageError);
    return () => window.removeEventListener("mkmn-storage-error", onStorageError);
  }, []);
  useEffect(() => { if (settings) applyAppearance((settings as Settings & { appearance?: string }).appearance ?? storedAppearance()); }, [settings]);
  useEffect(() => subscribeToSystemAppearance(() => {
    if ((settings as (Settings & { appearance?: string }) | null)?.appearance !== "light" &&
        (settings as (Settings & { appearance?: string }) | null)?.appearance !== "dark") {
      applyAppearance((settings as (Settings & { appearance?: string }) | null)?.appearance ?? storedAppearance());
    }
  }), [settings]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** One entry per file: the older states of a file are its versions, not more files. */
  const files = useMemo(() => currentFiles(artifacts), [artifacts]);

  const refreshCatalog = useCallback(async () => setItems(await api().catalog()), []);
  const reloadBench = useCallback(async () => {
    // a read failure must never blank the cards: keep whatever was shown (or nothing)
    try { setBenchProfiles(parseBenchProfiles(await api().hardwareConfig())); } catch { /* unmeasured state stands */ }
  }, []);
  useEffect(() => { void reloadBench(); }, [reloadBench]);
  // a benchmark-suite measurement saved to a profile: the Models list shows it at once
  useEffect(() => api().onBenchMeasured(() => { void reloadBench(); void refreshCatalog(); }), [reloadBench, refreshCatalog]);
  const refreshHardware = useCallback(async (force = false) => { setHw(await api().hardware(force)); await refreshCatalog(); }, [refreshCatalog]);
  /** Pictures of saved chats are files: load them once the window opens, and mark any that are gone. */
  const hydrate = useCallback(async (list: Conversation[]) => {
    // chats saved by older versions still carry the bytes: move them into the media store once
    const adopted = await adoptInlineMedia(list, (dataUrl) => api().saveMedia(dataUrl));
    return hydrateConversations(adopted, (id) => api().readMedia(id));
  }, []);

  /** The two feeds own the ONE ordering rule for every update source (startup reads,
      pushed events, polls, retries): the revision advances on every send and every
      pushed event, and only a response whose send-revision is still current applies.
      An older poll resolving after a newer event is dropped; a late response after a
      timeout is dropped (its token is gone). Created once, before any effect. */
  const metersFeedRef = useRef<ObservationFeed<Meters> | null>(null);
  const serverFeedRef = useRef<ObservationFeed<ServerStatus> | null>(null);
  if (!metersFeedRef.current) {
    metersFeedRef.current = new ObservationFeed<Meters>((m, at, unchanged) => {
      metersObsRef.current = observeSuccess(metersObsRef.current, m, at, unchanged);
      // only a real VALUE change re-renders: an unchanged successful reading still
      // counts as a fresh observation (the heartbeat moves), but an idle machine
      // reporting the same rounded RAM must not re-render the whole App tree
      setMeters((cur) => (metersSame(cur, m) ? cur : m));
      setMetersView((cur) => (cur.phase === "fresh" ? cur : { phase: "fresh", at: 0, stamp: "" }));
    });
  }
  if (!serverFeedRef.current) {
    serverFeedRef.current = new ObservationFeed<ServerStatus>((s, at, unchanged) => {
      serverObsRef.current = observeSuccess(serverObsRef.current, s, at, unchanged);
      setServer((cur) => (serverSame(cur, s) ? cur : s));
      setServerView((cur) => (cur.phase === "fresh" ? cur : { phase: "fresh", at: 0, stamp: "" }));
    });
  }
  /** The clock-driven view of both feeds — the watchdog's beat. A second that changes
      no visible text publishes nothing (phaseViewSame dedup), so a hung request pair
      still expires the readings at 30 s without re-rendering the app every second. */
  const publishViews = useCallback(() => {
    // "both feeds failing together" is what separates a failed read from a
    // disconnected backend
    const down = serverObsRef.current.failures > 0 && metersObsRef.current.failures > 0;
    const now = Date.now();
    const mv = phaseView(metersObsRef.current, now, down);
    const sv = phaseView(serverObsRef.current, now, down);
    // the updaters stay pure: both views were computed outside them
    setMetersView((cur) => (phaseViewSame(cur, mv) ? cur : mv));
    setServerView((cur) => (phaseViewSame(cur, sv) ? cur : sv));
  }, []);

  /** A pushed server-status event (the backend listener): always authoritative — it
      advances the revision, so any in-flight poll response for older state is dropped. */
  const applyServer = useCallback((s: ServerStatus) => {
    serverFeedRef.current?.pushEvent(s, Date.now(), serverSame(serverObsRef.current.value, s));
  }, []);

  /** One bounded server-status read through the feed — the poll and the startup read
      share it, so every server update obeys the same ordering rule. Returns the
      reading when it was applied, null when it was superseded, and throws (after
      recording the feed failure) when the request failed or timed out. */
  const readServerOnce = useCallback(async (force = false): Promise<ServerStatus | null> => {
    const feed = serverFeedRef.current!;
    const token = feed.beginRequest(force);
    if (token === null) return null; // a poll is already in flight
    try {
      const s = await withTimeout(api().server(), FEED_TIMEOUT_MS, "The AI runtime status");
      return feed.settleSuccess(token, s, Date.now(), serverSame(serverObsRef.current.value, s)) ? s : null;
    } catch (e) {
      if (feed.settleFailure(token, Date.now())) {
        serverObsRef.current = observeFailure(serverObsRef.current, Date.now());
        publishViews();
      }
      throw e;
    }
  }, [publishViews]);

  /** Per-key run counters: a retry (or a fresh startup run) invalidates every older
      attempt of the same read, so an old retry can never overwrite a newer result. */
  const keyRunRef = useRef<Record<string, number>>({});
  /** Keys with an attempt in flight RIGHT NOW: a Retry may not stack a second
      concurrent attempt for the same section (the feed bounds its polls; these
      forced one-shots are bounded here). */
  const keyInFlightRef = useRef<Set<string>>(new Set());

  /** One bounded, individually tracked boot read. It settles `bootPending` and
      `bootErrors` for its OWN key only — so the window can go usable the moment the
      essentials have settled, while optional sections still load or say what failed. */
  const grabKey = useCallback(async (key: string, op: () => Promise<unknown>, apply: (v: unknown) => void, signal: { aborted: boolean }) => {
    if (keyInFlightRef.current.has(key)) return; // already loading this section
    keyInFlightRef.current.add(key);
    const run = (keyRunRef.current[key] ?? 0) + 1;
    keyRunRef.current[key] = run;
    const stale = () => signal.aborted || keyRunRef.current[key] !== run;
    setBootErrors((cur) => {
      if (!cur?.[key]) return cur;
      const n = { ...cur }; delete n[key];
      return Object.keys(n).length ? n : null;
    });
    setBootPending((cur) => (cur.includes(key) ? cur : [...cur, key]));
    try {
      const v = await withTimeout(op(), STARTUP_TIMEOUT_MS, BOOT_READ_LABEL[key] ?? key);
      if (stale()) return; // a newer attempt owns this key now
      apply(v);
    } catch (e) {
      if (stale()) return;
      setBootErrors((cur) => ({ ...(cur ?? {}), [key]: (e as Error)?.message ?? String(e) }));
    } finally {
      keyInFlightRef.current.delete(key);
      if (!stale()) setBootPending((cur) => cur.filter((k) => k !== key));
    }
  }, []);

  /** What each boot read does and where its result lands — shared by the startup run
      and the per-key Retry, so a retry re-runs exactly the same read. */
  const bootReads = useMemo<Record<string, { op: () => Promise<unknown>; apply: (v: unknown) => void }>>(() => ({
    settings: { op: () => api().settings(), apply: (v) => setSettings(v as Settings) },
    info: { op: () => api().appInfo(), apply: (v) => setInfo(v as AppInfo) },
    hw: { op: () => api().hardware(), apply: (v) => setHw(v as HardwareProfile) },
    setup: { op: () => api().setupState(), apply: (v) => setSetup(v as SetupState) },
    server: {
      // through the feed: the startup read obeys the same ordering rule as events and
      // polls, and can never present an older response as the fresh state
      op: () => readServerOnce(true),
      apply: () => undefined,
    },
    voice: { op: () => api().voiceStatus(), apply: (v) => setVoice(v as VoiceStatus) },
    projects: { op: () => api().projects(), apply: (v) => setProjects(v as Project[]) },
    artifacts: { op: () => api().artifacts(), apply: (v) => setArtifacts(v as Artifact[]) },
    tasks: { op: () => api().tasks(), apply: (v) => setTasks(v as ScheduledTask[]) },
    catalog: { op: () => refreshCatalog(), apply: () => undefined },
    stored: {
      op: async () => {
        // the window may already have chats from its own storage (and a newer copy of some): keep both, newest wins
        const stored = await api().conversations();
        if (Array.isArray(stored) && stored.length > 0) return hydrate(stored as Conversation[]); // written by this window: saveConversations
        return null;
      },
      apply: (v) => { if (v) setConvs((cur) => mergeConversations(cur, v as Conversation[])); },
    },
  }), [readServerOnce, refreshCatalog, hydrate]);

  const runStartup = useCallback(async (signal: { aborted: boolean }) => {
    setBooting(true);
    const grab = (key: string) => grabKey(key, bootReads[key].op, bootReads[key].apply, signal);
    // Essential readiness first: the shape of the app. The moment all of them have
    // SETTLED, the window goes usable — optional data keeps loading in the banner
    // instead of holding the interface hostage.
    await Promise.all(ESSENTIAL_BOOT_KEYS.map(grab));
    if (!signal.aborted) setBooting(false);
    // the optional reads continue on their own; this run stays alive (for the abort
    // signal) until they have settled too
    await Promise.all(OPTIONAL_BOOT_KEYS.map(grab));
  }, [grabKey, bootReads]);

  /** Section-specific Retry: re-runs exactly that one read, through the same
      per-key invalidation, so an older retry attempt of the same key is dropped. */
  const retryBootKey = useCallback((key: string) => {
    const read = bootReads[key];
    if (read) void grabKey(key, read.op, read.apply, { aborted: false });
  }, [bootReads, grabKey]);

  useEffect(() => {
    const signal = { aborted: false };
    void runStartup(signal);
    return () => { signal.aborted = true; };
  }, [runStartup]);

  // The live listeners are registered ONCE, independently of the startup reads (a
  // retry of a failed read must never stack a second subscription).
  useEffect(() => {
    const offs = [
      api().onServer(applyServer), api().onVoiceStatus(setVoice),
      api().onTasks((t) => setTasks((all) => (all.some((x) => x.id === t.id) ? all.map((x) => (x.id === t.id ? t : x)) : [...all, t]))),
      api().onArtifacts(() => { void api().artifacts().then(setArtifacts); }),
      api().onFigureRequest((req) => { void figureImage({ key: figureKey(req.lang, req.raw), lang: req.lang, raw: req.raw }).then((v) => api().figureResult(req.id, v)); }),
      api().onSetup((s) => { setSetup(s); if (!s.active) { void refreshCatalog(); void api().appInfo().then(setInfo); void api().settings().then(setSettings); } })
    ];
    return () => offs.forEach((f) => f());
  }, [applyServer, refreshCatalog]);

  // A poll handle the Retry actions use: it re-runs the reads immediately, in the
  // SAME effect (no second interval, no duplicate listener can be created by it).
  const pollRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    // Each feed polls INDEPENDENTLY: a hung meter request can no longer block the
    // lifecycle observation, and each request is bounded by FEED_TIMEOUT_MS (the
    // feed's ordering rule drops whatever lands after that).
    const tickMeters = async () => {
      // A hidden window paints nothing: skip the poll while it is hidden (the native
      // monitoring and the inference tasks keep running on their own schedules).
      if (document.visibilityState === "hidden") return;
      const feed = metersFeedRef.current!;
      const token = feed.beginRequest();
      if (token === null) return; // one is already in flight — no unbounded concurrency
      try {
        const m = await withTimeout(api().meters(), FEED_TIMEOUT_MS, "The resource reading");
        if (alive) feed.settleSuccess(token, m, Date.now(), metersSame(metersObsRef.current.value, m));
      } catch {
        if (alive && feed.settleFailure(token, Date.now())) {
          metersObsRef.current = observeFailure(metersObsRef.current, Date.now());
          publishViews();
        }
      }
    };
    const tickServer = async () => {
      if (document.visibilityState === "hidden") return;
      try { await readServerOnce(); } catch { /* already recorded as a feed failure */ }
    };
    const tick = () => { void tickMeters(); void tickServer(); };
    pollRef.current = tick;
    void tick();
    const t = setInterval(tick, 3000);
    // The freshness watchdog: an independent, CLOCK-driven beat that re-publishes the
    // phases from the observation refs. A hung request pair can no longer keep a
    // reading looking fresh past its 30 s contract — and a second that changes no
    // visible text publishes nothing.
    const wd = setInterval(publishViews, WATCHDOG_MS);
    // becoming visible again re-evaluates freshness immediately and reads the feeds
    // right away instead of waiting a full interval
    const onVisible = () => { if (document.visibilityState === "visible") { publishViews(); tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; pollRef.current = () => {}; clearInterval(t); clearInterval(wd); document.removeEventListener("visibilitychange", onVisible); };
  }, [publishViews, readServerOnce]);

  // the chats read from this profile's localStorage are hydrated once; the stored copy is hydrated where it is loaded
  useEffect(() => {
    let live = true;
    // merge, not replace: a turn sent while the pictures were loading must not be thrown away
    void hydrate(convs).then((h) => { if (live && h !== convs) setConvs((cur) => mergeConversations(cur, h)); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const pendingTurns = convs.reduce((n, c) => n + c.turns.reduce((m, t) => m + (t.pending ? 1 : 0), 0), 0);
    saverRef.current!.touch(convs, pendingTurns);
  }, [convs]);
  // The exit paths must not lose the chats: window hidden, page closed or the host's
  // coordinated shutdown — each flushes at once (a synchronous storage write).
  useEffect(() => {
    const saver = saverRef.current!;
    const onHide = () => { if (document.visibilityState === "hidden") saver.flushNow(); };
    const onGone = () => saver.flushNow();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onGone);
    window.addEventListener("beforeunload", onGone);
    const offShutdown = api().onAppShutdown(() => saver.flushNow());
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onGone);
      window.removeEventListener("beforeunload", onGone);
      offShutdown();
    };
  }, []);

  const active = useMemo(() => convs.find((c) => c.id === activeId) ?? convs[0], [convs, activeId]);
  // the libraries of the installed skills, known before any page is drawn (a page asks for one with lib:name)
  // memoized: App re-renders every few seconds from the meters tick, and this must not rerun each time
  useMemo(() => {
    registerLibraries(allSkills(settings?.skills, settings?.removedSkills));
  }, [settings?.skills, settings?.removedSkills]);
  const selected = items.find((i) => i.entry.id === settings?.selectedModelId) ?? null;

  const updateTurns = useCallback((id: string, fn: (t: Turn[]) => Turn[], title?: string, named?: boolean) => {
    setConvs((all) => all.map((c) => (c.id === id ? { ...c, turns: fn(c.turns), updated: named ? c.updated : Date.now(), title: title ?? c.title, named: named ?? c.named } : c)));
  }, []);
  const togglePin = (id: string) => setConvs((all) => all.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  const [fold, setFold] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem("opennpu.fold") ?? "{}"); } catch { return {}; } });
  /** `closedByDefault`: a section nobody opened yet (the archive) starts folded. */
  const toggleFold = (k: string, closedByDefault = false) => setFold((f) => { const n = { ...f, [k]: !(f[k] ?? closedByDefault) }; try { localStorage.setItem("opennpu.fold", JSON.stringify(n)); } catch { /* not saved */ } return n; });
  /** How many rows each sidebar list shows: the rest comes a page at a time, so a year of chats never draws all at once. */
  const [more, setMore] = useState<Record<string, number>>({});
  /** The chat row whose actions (pin, archive, delete) are open: one "⋯" button keeps the title wide. */
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  /** Sidebar: width the person dragged it to (kept), and whether it is folded. Folded follows the window width by itself (`narrow`) until the person folds or opens it by hand; crossing the limit again hands it back to the window. */
  const [sideW, setSideW] = useState<number>(() => { try { const n = Number(localStorage.getItem("opennpu.sideW")); return n >= SIDE_MIN && n <= SIDE_MAX ? n : 280; } catch { return 280; } });
  const [narrow, setNarrow] = useState<boolean>(() => window.innerWidth < NARROW_AT);
  const [sideManual, setSideManual] = useState<boolean | null>(null);
  useEffect(() => {
    const on = () => { const n = window.innerWidth < NARROW_AT; setNarrow((was) => { if (was !== n) setSideManual(null); return n; }); };
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const sideFolded = sideManual ?? narrow;
  // Focus for the narrow drawer and the AI status panel: focus moves in when they
  // open and returns to the control that opened them when they close (Escape or a
  // click outside must never leave the keyboard lost behind hidden content).
  const sideToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const profileBtnRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    const open = narrow && !sideFolded;
    if (open && !drawerWasOpen.current) sidebarRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    if (!open && drawerWasOpen.current && document.activeElement instanceof HTMLElement && sidebarRef.current?.contains(document.activeElement)) {
      sideToggleRef.current?.focus();
    }
    drawerWasOpen.current = open;
  }, [narrow, sideFolded]);
  useEffect(() => {
    if (menuOpen) menuPanelRef.current?.focus({ preventScroll: true });
  }, [menuOpen]);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    (document.activeElement instanceof HTMLElement && menuPanelRef.current?.contains(document.activeElement)
      ? profileBtnRef.current : null)?.focus();
  }, []);
  // Ctrl+K opens Search from anywhere. When the status flyout is open it must close
  // through closeMenu (which parks focus on the profile button) BEFORE the search
  // captures where to return focus — the flyout unmounts ~120 ms later, so a return
  // target inside it would evaporate and dump the keyboard user at <body>.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); closeMenu(); setSearchOpen(true); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [closeMenu]);
  const dragSide = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = sideW;
    let w = startW;
    const move = (m: PointerEvent) => { w = Math.min(SIDE_MAX, Math.max(SIDE_MIN, startW + m.clientX - startX)); setSideW(w); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); try { localStorage.setItem("opennpu.sideW", String(w)); } catch { /* not saved */ } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [startText, setStartText] = useState<{ id: string; text: string } | null>(null);

  /** A chat in `projectId`, empty or started with `text` (typed on the project page). */
  const newChat = (projectId: string | null = null, text?: string) => {
    const empty = convs.find((c) => c.turns.length === 0 && !c.archived && (c.projectId ?? null) === projectId);
    const c = empty ?? newConversation(projectId);
    if (!empty) setConvs((all) => [c, ...all]);
    if (text?.trim()) setStartText({ id: c.id, text: text.trim() });
    setActiveId(c.id);
    setTab("chat");
    if (narrow) setSideManual(true);
  };

  /** Where to go when the open chat leaves the lists: another live chat, else a fresh one. */
  const leave = (id: string, rest: Conversation[]): Conversation[] => {
    const next = rest.find((c) => !c.archived) ?? null;
    if (id !== activeId) return next ? rest : [...rest, newConversation()];
    if (next) { setActiveId(next.id); return rest; }
    const fresh = newConversation();
    setActiveId(fresh.id);
    return [fresh, ...rest];
  };
  const archiveChat = (id: string, on: boolean) => setConvs((all) => leave(on ? id : "", all.map((c) => (c.id === id ? { ...c, archived: on, pinned: on ? false : c.pinned } : c))));

  const deleteChat = (id: string) => {
    const index = convs.findIndex((c) => c.id === id);
    const gone = convs[index];
    setConvs((all) => {
      return leave(id, all.filter((c) => c.id !== id));
    });
    // Undo for a few seconds: one click deletes, one click puts it back in its place.
    // Once the undo is gone, what the harness kept of the chat (its run journals) goes too.
    const forget = (convId: string) => { void api().forgetConversation(convId).catch(() => undefined); };
    if (gone && gone.turns.length > 0) {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      if (undoChat) forget(undoChat.conv.id); // the earlier deletion can no longer be undone
      setUndoChat({ conv: gone, index });
      undoTimer.current = setTimeout(() => { setUndoChat(null); forget(gone.id); }, 8000);
    } else if (gone) forget(gone.id);
  };
  const undoDelete = () => {
    if (!undoChat) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    const { conv, index } = undoChat;
    setConvs((all) => (all.some((c) => c.id === conv.id) ? all : [...all.slice(0, index), conv, ...all.slice(index)]));
    setUndoChat(null);
  };

  const removeChat = (id: string) => {
    if (leaving.includes(id)) return;
    setLeaving((l) => [...l, id]);
    setTimeout(() => { deleteChat(id); setLeaving((l) => l.filter((x) => x !== id)); }, 220);
  };

  const modelName = (id: string | null | undefined) => (id ? items.find((item) => item.entry.id === id)?.entry.name ?? id : null);
  /** What really runs after a switch that did not complete: the previous selection is kept, and the server's state is said as it is. */
  const runtimeNote = async (): Promise<string> => {
    const [st, s] = await Promise.all([api().server().catch(() => null), api().settings().catch(() => null)]);
    const prev = modelName(s?.selectedModelId);
    const loaded = st && (st.state === "ready" || st.state === "busy") ? st.model : null;
    const keep = prev ? `${prev} stays selected` : "No model is selected";
    return loaded ? `${keep}; ${loaded} is loaded.` : `${keep}; no model is loaded now${prev ? " (it starts with your next message)" : ""}.`;
  };
  const switcher = (): ModelSwitcher => {
    if (!switcherRef.current) {
      switcherRef.current = new ModelSwitcher({
        select: (id, signal) => api().selectModel(id, switchExplicit.current, { signal }),
        serverState: () => api().server().then((s) => (s?.state ?? null) as string | null),
        // only the model server's pending start stops: the CPU router belongs to the sidecar and stays up
        stopPending: () => api().stopServer(),
        onPhase: (p) => { if (p.kind === "failed") switchPhaseError.current = p.error; setSwitchPhase(p); },
      });
    }
    return switcherRef.current;
  };

  const chooseModel = async (id: string, explicit = true, fromLibrary = false) => {
    if (modelSelectionPending.current) {
      setSwitchNote(`A switch to ${modelName(switcherRef.current?.pendingId) ?? "another model"} is still running: wait for it, or Cancel it first.`);
      return;
    }
    modelSelectionPending.current = true;
    switchExplicit.current = explicit;
    setModelSelectionError(null);
    setSwitchNote(null);
    const name = modelName(id) ?? id;
    let cancellationNote: string | null = null;
    try {
      const result = await switcher().start(id, name);
      if (result === "done") {
        setSettings(await api().settings());
        if (fromLibrary) {
          setDialog(null);
          setTab("chat");
        }
      } else if (result === "cancelled") {
        cancellationNote = `The switch to ${name} was cancelled. ${await runtimeNote()}`;
        setSwitchPhase({ kind: "idle" });
      } else if (result === "failed") {
        const raw = switchPhaseError.current ?? "the model did not start";
        const status = await api().server().catch(() => null);
        const reported = status?.lastError;
        const base = reported?.raw === raw ? reported : { id: "model-selection", title: `Could not select ${name}`, fix: "", raw };
        const error = { ...base, fix: `${base.fix ? `${base.fix} ` : ""}${await runtimeNote()}` };
        setModelSelectionError({ id, error });
        setSwitchPhase({ kind: "idle" });
      }
    } finally {
      modelSelectionPending.current = false;
      setSwitchNote(cancellationNote);
    }
  };
  const cancelSwitch = () => void switcherRef.current?.cancel();
  const select = (id: string) => void chooseModel(id, true, true);
  /** The switch as it happens: "Starting <model>…", then "Warming up…" once GenieX lists it, with Cancel; then its outcome. */
  const modelSwitchStatus = (switchPhase.kind === "starting" || switchPhase.kind === "warming" || switchNote) && (
    <div className="banner banner-row model-switch" role="status" aria-live="polite">
      {switchPhase.kind === "starting" || switchPhase.kind === "warming" ? (
        <>
          <div>
            <strong>{switchPhase.kind === "starting" ? `Starting ${switchPhase.name}…` : `Warming up ${switchPhase.name}…`}</strong>
            <div>{switchPhase.kind === "starting" ? "Waiting for GenieX to list the model." : "GenieX lists the model; its first answer finishes the load."} The current selection is kept until it answers.</div>
          </div>
          <button type="button" className="linkbtn" onClick={cancelSwitch}>Cancel</button>
        </>
      ) : (
        <>
          <div>{switchNote}</div>
          <button type="button" className="banner-close" aria-label="Dismiss" onClick={() => setSwitchNote(null)}>×</button>
        </>
      )}
    </div>
  );
  const modelSelectionNotice = modelSelectionError && (
    <div className="banner warn banner-row" role="alert">
      <div>
        <strong>{modelSelectionError.error.title}</strong>
        {modelSelectionError.error.fix && <div>{modelSelectionError.error.fix}</div>}
        <details><summary>Raw message</summary><pre className="telemetry-log">{modelSelectionError.error.raw}</pre></details>
      </div>
      <button type="button" className="linkbtn" onClick={() => void chooseModel(modelSelectionError.id, true, dialog === "settings" && settingsTab === "library")}>Try again</button>
      <button type="button" className="banner-close" aria-label="Dismiss model selection error" onClick={() => setModelSelectionError(null)}>×</button>
    </div>
  );

  const saveProject = (p: Project) => {
    setProjects((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? { ...p, updated: Date.now() } : x)) : [...all, p]));
    // A refused save is said, with the project's name and a Retry: the edit stays on
    // screen (nothing is lost while the app is open), and it is not shown as saved.
    void api().saveProject(p).then(
      () => setProjectSaveError((e) => (e && e.project.id === p.id ? null : e)),
      (err) => setProjectSaveError({ project: p, message: (err as Error)?.message || "storage refused the write" }),
    );
  };
  const deleteProject = async (id: string) => {
    setProjects(await api().deleteProject(id));
    setArtifacts(await api().artifacts());
    setTasks(await api().tasks());
    setConvs((all) => all.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)));
  };
  const pinProject = (p: Project) => saveProject({ ...p, pinned: !p.pinned });
  const archiveProject = (p: Project, on: boolean) => {
    saveProject({ ...p, archived: on, pinned: on ? false : p.pinned });
    if (on && openProject === p.id) setOpenProject(null);
  };
  const saveArtifact = useCallback((a: Artifact) => { void api().saveArtifact(a).then(setArtifacts); }, []);
  const exportArtifact = (id: string, format?: string, draft?: Artifact) => {
    const a = artifacts.find((x) => x.id === id) ?? draft;
    // a Word or PowerPoint file holds diagrams and charts as pictures, which only this window can draw
    void (async () => {
      const images = a && (a.kind === "docx" || a.kind === "markdown" || a.kind === "pptx") ? await renderFigures(figuresOfText(a.content, a.kind === "pptx")).catch(() => undefined) : undefined;
      await api().exportArtifact(id, images, format, draft);
    })().catch((e) => window.alert((e as Error).message));
  };
  const openChat = (id: string) => { setActiveId(id); setTab("chat"); if (narrow) setSideManual(true); };
  // Stable handles for the memoized sidebar rows: they read the latest closures
  // through a ref, so the rows skip re-rendering when only something unrelated moved.
  const rowHandlers = useRef({ openChat, archiveChat, removeChat, togglePin });
  rowHandlers.current = { openChat, archiveChat, removeChat, togglePin };
  const openChatStable = useCallback((id: string) => rowHandlers.current.openChat(id), []);
  const archiveChatStable = useCallback((id: string, on: boolean) => rowHandlers.current.archiveChat(id, on), []);
  const removeChatStable = useCallback((id: string) => rowHandlers.current.removeChat(id), []);
  const togglePinStable = useCallback((id: string) => rowHandlers.current.togglePin(id), []);
  /** Settings changed anywhere: saved and kept. A stable handle, so the memoized chat turns do not redraw when it does not change. */
  const changeSettings = useCallback((p: Partial<Settings>) => { void api().saveSettings(p).then(setSettings); }, []);
  const showArtifact = (id: string, versions = false) => {
    const a = artifacts.find((x) => x.id === id);
    setOpenArtifact((a && files.find((f) => lineageKey(f) === lineageKey(a))?.id) ?? id);
    setVersionsOpen(versions);
    setTab("artifacts");
  };
  /** A version was chosen or restored: the file as the chat holds it takes its text, so the assistant works from it next. */
  const versionApplied = useCallback((r: VersionResult) => {
    void api().artifacts().then(setArtifacts);
    const m = /^(.+):(\d+):(\d+)$/.exec(r.artifactId ?? "");
    if (!m || r.content === undefined) return;
    const text = r.content;
    updateTurns(m[1], (turns) => turns.map((t, i) => (i === Number(m[2]) ? { ...t, content: replaceArtifact(t.content, Number(m[3]), text) } : t)));
  }, [updateTurns]);
  /** The skills guide opens as a message in a chat of its own. */
  const openSkillDocs = () => {
    const c: Conversation = { ...newConversation(null), title: "Writing skills", turns: [{ role: "assistant", content: SKILL_DOCS, modelName: "Guide" }] };
    setConvs((all) => [c, ...all]); setActiveId(c.id); setTab("chat");
  };
  const go = (t: Tab) => { setTab(t); if (t === "projects") setOpenProject(null); if (narrow) setSideManual(true); };
  // every tab a user has opened stays mounted (hidden) once visited: remounting the whole
  // page on each switch was what made navigation feel slow (same pattern as the busy chats)
  const [seenTabs, setSeenTabs] = useState<Tab[]>(["chat"]);
  useEffect(() => { setSeenTabs((s) => (s.includes(tab) ? s : [...s, tab])); }, [tab]);

  const sorted = [...convs].sort((a, b) => b.updated - a.updated);

  /** The AI status panel's contents, from this one definition: the sidebar footer
      renders it, and — when the sidebar is hidden — so does the titlebar flyout.
      It reports status only: selected vs loaded model, requested vs observed
      execution, and resource meters with their scope. Model management and
      preferences stay in their own destinations. */
  const loadedReady = !!server && (server.state === "ready" || server.state === "busy");
  // Freshness of the two poll-fed feeds (30 s contract from metricsModel): a reading
  // that stopped refreshing must read as unavailable, never as a live "Ready".
  const metersPhase = metersView.phase;
  const serverPhase = serverView.phase;
  const retryReads = () => pollRef.current();
  /** The compact status word next to the AI name — never a live-looking "Ready" when
      the observation behind it has expired or never arrived. */
  const shortServerState = !server ? "Connecting…"
    : serverPhase === "fresh" ? SHORT_STATE[server.state]
    : serverPhase === "stale" ? "Status may be out of date"
    : serverPhase === "disconnected" ? "Disconnected"
    : "Status unavailable";
  // `server.model` is the precise ref the runtime announced (e.g. "org/model:Q4");
  // the catalog turns it into the model's readable name, the raw ref stays in the tooltip
  const loadedItem = loadedReady && server.model ? items.find((i) => i.ref === server.model || i.entry.id === server.model) : undefined;
  // The size estimate describes the SELECTED model; it may only stand in for the NPU
  // memory meter when the loaded model IS the selected one. On a mismatch the estimate
  // is withheld — a number for a different model would be a made-up figure.
  const estimateForLoaded = loadedReady && selected && !!server.model
    && (server.model === selected.ref || server.model === selected.entry.id);
  const chatMode = readSetting(settings, "humainMode");
  const cloudProvider = cloudProviderOf(chatMode);
  const aiName = cloudProvider ? HUMAIN_LABEL[cloudProvider] : "On-device AI";
  async function chooseChatMode(mode: Settings["humainMode"]) {
    setChangingChatMode(true);
    setChatModeError("");
    try {
      setSettings(await api().saveSettings({ humainMode: mode }));
    } catch {
      setChatModeError("Couldn't save the chat location. Try again.");
    } finally {
      setChangingChatMode(false);
    }
  }
  const statusBody = (
    <>
      <strong>{aiName}</strong>
      <label className="ai-location">
        <span>Chat location</span>
        <select value={chatMode} disabled={!settings || changingChatMode || busyIds.size > 0}
          onChange={(event) => void chooseChatMode(event.target.value as Settings["humainMode"])}>
          <option value="local">Local · This PC</option>
          <option value="fuse">Cloud · HUMAIN Fuse</option>
          <option value="node">Cloud · HUMAIN Node</option>
        </select>
      </label>
      {chatModeError && <div role="alert" className="warn small">{chatModeError}</div>}
      {cloudProvider ? <>
        <div className="muted small">Model: {readSetting(settings, cloudProvider === "fuse" ? "humainFuseModel" : "humainNodeModel") || "Choose a model in HUMAIN settings"}</div>
      </> : <>
      {server && serverPhase === "fresh" && (
        <div className={`server-pill ${server.state}`} title={server.lastError?.title ?? server.endpoint}>
          <span className="dot" />
          <span>{STATE_LABEL[server.state]}{server.restarts > 0 ? ` · ${server.restarts} restart(s)` : ""}</span>
        </div>
      )}
      {/* A stale, failed or disconnected status observation must never read as a live
          state ("Ready"): the last-known state stands back, the stamp and Retry lead. */}
      {(!server || serverPhase !== "fresh") && (
        <div className={`server-pill ${server ? server.state : ""} obs-unavailable`} title={server ? `Last known state: ${STATE_LABEL[server.state]}` : undefined} role="status">
          <span className="dot" />
          <span>
            {serverPhase === "stale" && `Status unavailable · last updated ${lastUpdatedText(serverView.at)}`}
            {serverPhase === "failed" && "Can't check the AI right now. Try again, or restart MKMN if this continues."}
            {serverPhase === "disconnected" && "MKMN's AI service isn't answering. Try again, or restart MKMN."}
            {serverPhase === "loading" && "Checking AI status…"}
          </span>
          {(serverPhase === "stale" || serverPhase === "failed" || serverPhase === "disconnected") && (
            <button type="button" className="ghost obs-retry" onClick={retryReads}>Try again</button>
          )}
        </div>
      )}
      {selected && <div className="muted small">Selected: {selected.entry.name}</div>}
      {server && loadedReady
        ? <div className="muted small" title={loadedItem ? server.model ?? undefined : undefined}>Loaded: {loadedItem?.entry.name ?? (server.model || "not reported yet")}</div>
        : <div className="muted small">Loaded: nothing — the selected model loads when you send a message</div>}
      {/* Only a KNOWN mismatch (a model is announced and it is not the selected one)
          may say "differs": with nothing reported yet that would be a false claim. */}
      {selected && loadedReady && server.model && !estimateForLoaded && (
        <div className="muted small">The loaded model differs from the selected one, so no size estimate is shown for it.</div>
      )}
      {server && loadedReady && (() => {
        const exec = executionStatus(server, server.compute);
        const observed = observedExecutionTarget(server);
        return (
          <div className="muted small exec-lines">
            {/* One shared mapping (COMPUTE_LABEL): "hybrid" must never read as "CPU". */}
            {/* "Processing on this device" only while a live, fresh generation is actually
                running on the local server — never inferred from being offline. */}
            {serverPhase === "fresh" && server.state === "busy" && <div className="ok">{BRAND.localProcessing}</div>}
            <div>Requested device: {COMPUTE_LABEL[server.compute]}</div>
            <div className={exec.tone === "warn" ? "warn" : exec.tone === "ok" ? "ok" : undefined}>Observed: {exec.label}</div>
            {observed && <div>Runtime reported: {COMPUTE_LABEL[observed as keyof typeof COMPUTE_LABEL] ?? observed}</div>}
          </div>
        );
      })()}
      {voice && (voice.stt || voice.tts) && (
        <div className="muted small voice-pill">
          {voice.stt && <span>Dictation: {voice.sttProvider?.toUpperCase()}</span>}
          {voice.stt && voice.tts && " · "}
          {voice.tts && <span>Voice: {voice.ttsProvider?.toUpperCase()}</span>}
        </div>
      )}
      <MetersBar meters={meters} estNpuGB={estimateForLoaded ? selected?.verdict.estNpuGB : undefined} busy={busyIds.size > 0} phase={metersPhase} observedAt={metersView.at} onRetry={retryReads} />
      {/* One shared description of measurement scope (same words as the meters themselves):
          RAM is the whole PC; the NPU load is the NPU DEVICE (every runtime on it), so a
          busy device alone never proves which model is executing; NPU memory has no
          measurement — only explicitly marked estimates stand in. */}
      <div className="muted small">Meters: RAM is this whole PC · NPU load is the NPU device (every runtime on it, not this app alone) · NPU memory is measured when this PC exposes a counter, and otherwise a clearly marked estimate stands in.</div>
      </>}
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => openSettings(cloudProvider ?? "web")}><Icon d={ICONS.gear} />HUMAIN API keys</button>
      {!cloudProvider && <button className="menu-item" onClick={() => { setSettingsStart("developer"); setDialog("settings"); setMenuOpen(false); }}><Icon d={ICONS.gear} />Open {tabLabel("developer")} settings</button>}
    </>
  );

  // Startup readiness: while the essential reads have not landed, the window shows a
  // quiet loading screen; when one of them FAILED, it says exactly what failed with a
  // Retry that re-reads everything again (every read is idempotent, and local chats
  // and settings are never touched by a retry). Optional-data failures degrade to a
  // banner, not a wall.
  const essentialFailed = bootErrors ? ESSENTIAL_BOOT_KEYS.filter((k) => bootErrors[k]) : [];
  const optionalFailed = bootErrors ? Object.keys(bootErrors).filter((k) => !ESSENTIAL_BOOT_KEYS.includes(k)) : [];
  const retryStartup = () => { void runStartup({ aborted: false }); };
  if (booting && !settings) return (
    <div className="boot-screen" role="status" aria-live="polite">
      <LogoMark className="logo" />
      <p>Starting MKMN AI…</p>
    </div>
  );
  if (!booting && essentialFailed.length > 0) return (
    <div className="boot-screen" role="alert">
      <LogoMark className="logo" />
      <p><strong>MKMN AI could not load some of its own data.</strong></p>
      <ul>
        {essentialFailed.map((k) => <li key={k}>{BOOT_READ_LABEL[k]} failed{bootErrors![k] ? ` — ${bootErrors![k]}` : ""}</li>)}
      </ul>
      <p className="muted small">Chats and settings saved on this PC are safe: retrying reads them again and deletes nothing.</p>
      <button type="button" className="primary" onClick={retryStartup}>Retry</button>
    </div>
  );
  if (setup?.active) return <SetupScreen state={setup} />;

  return (
    <div className={`app ${railExpanded ? "rail-expanded" : ""}`} style={{ "--rail-w": railExpanded ? `${RAIL_W_EXPANDED}px` : `${RAIL_W}px` } as React.CSSProperties}>
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-brand" style={sideFolded ? undefined : { width: sideW + (railExpanded ? RAIL_W_EXPANDED - 12 : RAIL_W - 12) }} data-tauri-drag-region>
          <LogoMark className="logo" />
          <span className="wordmark">MKMN AI</span>
          <button className="side-toggle" ref={sideToggleRef} title={sideFolded ? "Show sidebar" : "Hide sidebar"} aria-label={sideFolded ? "Show sidebar" : "Hide sidebar"} aria-expanded={!sideFolded} onClick={() => setSideManual(!sideFolded)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2" /><path d="M6 2.9v10.2" /></svg>
          </button>
        </div>
        <div className="titlebar-spacer" data-tauri-drag-region style={{ flex: 1, height: "100%" }} />
        {sideFolded && (
          <div className="titlebar-status">
            <button type="button" ref={profileBtnRef} className={`tb-status ${cloudProvider ? "" : server?.state ?? ""} ${menuOpen ? "active" : ""}`} title="Chat location and AI status" aria-label={`${aiName}: ${cloudProvider ? "Cloud" : shortServerState}. Show the status panel.`} aria-expanded={menuOpen} onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}>
              <span className="dot" />
              <span>{cloudProvider ? aiName : server ? shortServerState : "AI"}</span>
            </button>
            {sideMenu.value && (
              <>
                <div className="menu-scrim" onClick={closeMenu} />
                <div className="side-menu flyout" ref={menuPanelRef} tabIndex={-1} role="region" aria-label={`${aiName} status`} data-state={sideMenu.closing ? "closed" : "open"} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); } }}>
                  {statusBody}
                </div>
              </>
            )}
          </div>
        )}
        <TitlebarMetrics />
        <div className="window-controls" style={{ display: "flex", alignItems: "center", height: "100%", WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => {
            if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
              void invoke("window_minimize");
            }
          }}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button className="win-btn" title="Maximize" aria-label="Maximize" onClick={() => {
            if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
              void invoke("window_maximize");
            }
          }}>
            <svg width="10" height="10" viewBox="0 0 10 10"><rect width="8" height="8" x="1" y="1" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
          </button>
          <button className="win-btn win-close" title="Close" aria-label="Close" onClick={() => {
            if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
              void invoke("window_close");
            } else {
              window.close();
            }
          }}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>
      <div className="app-body" onKeyDown={(e) => { if (e.key === "Escape" && narrow && !sideFolded) { setSideManual(true); e.stopPropagation(); } }}>
      <nav className={`app-rail ${railExpanded ? "expanded" : ""}`} aria-label="App navigation" onMouseOver={(e) => railTipEvent(e, true)} onMouseLeave={(e) => railTipEvent(e, false)} onFocus={(e) => railTipEvent(e, true)} onBlur={(e) => railTipEvent(e, false)}>
        <button type="button" className={`rail-btn rail-home ${tab === "chat" && !dialog ? "active" : ""}`} data-tip="Chats" aria-label="Chats" aria-current={tab === "chat" && !dialog ? "page" : undefined} onClick={() => { setDialog(null); setMenuOpen(false); go("chat"); setSideManual(false); }}><LogoMark /><span className="rail-label" aria-hidden="true">Chats</span></button>
        <button type="button" className={`rail-btn ${tab === "projects" && !dialog ? "active" : ""}`} data-tip="Projects" aria-label="Projects" aria-current={tab === "projects" && !dialog ? "page" : undefined} onClick={() => { setDialog(null); setMenuOpen(false); go("projects"); }}><ProjectIcon /><span className="rail-label" aria-hidden="true">Projects</span></button>
        <button type="button" className={`rail-btn ${tab === "artifacts" && !dialog ? "active" : ""}`} data-tip="Files" aria-label="Files" aria-current={tab === "artifacts" && !dialog ? "page" : undefined} onClick={() => { setDialog(null); setMenuOpen(false); go("artifacts"); }}><ArtifactIcon /><span className="rail-label" aria-hidden="true">Files</span></button>
        <button type="button" className={`rail-btn ${tab === "tasks" && !dialog ? "active" : ""}`} data-tip="Tasks" aria-label="Tasks" aria-current={tab === "tasks" && !dialog ? "page" : undefined} onClick={() => { setDialog(null); setMenuOpen(false); go("tasks"); }}><ClockIcon />{tasks.some((t) => t.running) && <span className="rail-running dot live" />}<span className="rail-label" aria-hidden="true">Tasks</span></button>
        <button type="button" className={`rail-btn ${tab === "customize" && !dialog ? "active" : ""}`} data-tip="Skills and About me" aria-label="Skills and About me" aria-current={tab === "customize" && !dialog ? "page" : undefined} onClick={() => { setDialog(null); setMenuOpen(false); go("customize"); }}><BriefcaseIcon /><span className="rail-label" aria-hidden="true">Skills</span></button>
        <div className="rail-utilities" role="group" aria-label="Search, models and preferences">
          {/* Search lives here, not only in the sidebar: the shortcut works everywhere,
              and the button keeps it reachable with the chat sidebar folded away. */}
          <button type="button" className="rail-btn" data-tip="Search · Ctrl+K" aria-label="Search (Ctrl+K)" aria-keyshortcuts="Control+K" onClick={() => { setMenuOpen(false); setSearchOpen(true); }}><SearchIcon /><span className="rail-label" aria-hidden="true">Search</span></button>
          <button type="button" className={`rail-btn ${dialog === "settings" && settingsTab === "library" ? "active" : ""}`} data-tip="Local Models — install and choose" aria-label="Local Models" aria-haspopup="dialog" onClick={() => openSettings("library")}><ChipIcon /><span className="rail-label" aria-hidden="true">Local Models</span></button>
          <button type="button" className={`rail-btn ${dialog === "settings" && settingsTab !== "library" ? "active" : ""}`} data-tip="Settings" aria-label="Settings" aria-haspopup="dialog" onClick={() => openSettings(undefined)}><GearIcon /><span className="rail-label" aria-hidden="true">Settings</span></button>
          <button type="button" className="rail-btn rail-expand" data-tip={railExpanded ? "Collapse the rail" : "Show labels"} aria-label={railExpanded ? "Hide the rail labels" : "Show the rail labels"} aria-pressed={railExpanded} onClick={toggleRail}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={railExpanded ? "m13 6-6 6 6 6" : "m11 6 6 6-6 6"} /></svg>
            <span className="rail-label" aria-hidden="true">{railExpanded ? "Collapse" : "Labels"}</span>
          </button>
        </div>
      </nav>
      {!sideFolded && narrow && <button type="button" className="sidebar-backdrop" aria-label="Close chat sidebar" onClick={() => { setSideManual(true); sideToggleRef.current?.focus(); }} />}
      {!sideFolded && <aside className={`sidebar ${narrow ? "sidebar-drawer" : ""}`} style={{ width: sideW }} ref={sidebarRef} aria-label="Chat sidebar">
        <div className="sidebar-heading"><strong>Chats</strong><button type="button" className="sidebar-search" title="Search chats, projects, files and tasks (Ctrl+K)" aria-label="Search chats, projects, files and tasks" onClick={() => setSearchOpen(true)}><SearchIcon /></button></div>
        <nav aria-label="Chat actions">
          <button className="navbtn" onClick={() => newChat()}><Icon d={ICONS.plus} />New chat</button>
        </nav>
        <div className="recents">
          {(() => {
            const PAGE = 20;
            const filtering = false;
            const matches = (c: Conversation) => c.turns.length > 0;
            const known = (c: Conversation) => !!c.projectId && projects.some((p) => p.id === c.projectId);
            const live = sorted.filter((c) => !c.archived && matches(c));
            const pinned = live.filter((c) => c.pinned);
            const loose = live.filter((c) => !c.pinned && !known(c));
            const gone = sorted.filter((c) => c.archived && matches(c));
            const goneProjects = projects.filter((p) => p.archived);
            /** The first `base` rows of a list, then a button that adds a page; a filter shows every match. */
            const paged = <T,>(key: string, list: T[], base: number, draw: (x: T) => ReactNode, step = PAGE) => {
              const n = filtering ? list.length : more[key] ?? base;
              return (
                <>
                  {list.slice(0, n).map(draw)}
                  {list.length > n && <button className="show-more" onClick={() => setMore((m) => ({ ...m, [key]: n + step }))}>Show more <span className="count">{Math.min(step, list.length - n)}</span></button>}
                </>
              );
            };
            const row = (c: Conversation, nested = false) => (
              <ChatRow key={c.id} id={c.id} title={c.title} named={!!c.named} pinned={!!c.pinned} archived={!!c.archived} nested={nested}
                active={c.id === active.id && tab === "chat"} busy={busyIds.has(c.id)} leaving={leaving.includes(c.id)} fresh={!seen.current.has(c.id)}
                actionsOpen={actionsFor === c.id} onOpen={openChatStable} onArchive={archiveChatStable} onRemove={removeChatStable} onPin={togglePinStable} onActions={setActionsFor} />
            );
            const section = (key: string, label: string, count: number, body: ReactNode, closedByDefault = false, action?: ReactNode) => {
              const closed = fold[key] ?? closedByDefault;
              return (
                <div className="group" key={key}>
                  <div className="group-head">
                    <button className="recents-title" onClick={() => toggleFold(key, closedByDefault)} aria-expanded={!closed}>{label} <span className="count">{count}</span> <span className={`caret ${closed ? "" : "open"}`}>▾</span></button>
                    {action}
                  </div>
                  {/* A collapsed fold hides its rows visually; `inert` takes them out of
                      the keyboard and the accessibility tree as well, so nothing hidden
                      can be reached or activated. */}
                  <div className={`fold ${closed ? "" : "open"}`}><div className="fold-inner" inert={closed}>{body}</div></div>
                </div>
              );
            };
            /** Pinned chats are shortcuts, not moves: they stay in their project's list
                (and its count) and appear again at the top of the sidebar. */
            const chatsOf = (p: Project) => live.filter((c) => c.projectId === p.id);
            const groups = projects
              .filter((p) => !p.archived)
              .map((p) => ({ p, list: chatsOf(p) }))
              .filter((g) => !filtering || g.list.length)
              .sort((x, y) => Number(!!y.p.pinned) - Number(!!x.p.pinned) || (y.list[0]?.updated ?? y.p.updated) - (x.list[0]?.updated ?? x.p.updated));
            return (
              <>
                {pinned.length > 0 && section("pinned", "Pinned", pinned.length, pinned.map((c) => row(c)))}
                {section("projects", "Projects", groups.length, groups.length ? paged("projects", groups, 8, ({ p, list }) => (
                  <div className="proj" key={p.id}>
                    <div className={`proj-head ${tab === "projects" && openProject === p.id ? "active" : ""}`}>
                      <button className="x show caret-btn" title={fold[`p:${p.id}`] ? "Show chats" : "Hide chats"} aria-label={fold[`p:${p.id}`] ? "Show chats" : "Hide chats"} aria-expanded={!fold[`p:${p.id}`]} onClick={() => toggleFold(`p:${p.id}`)}>
                        <span className={`caret ${fold[`p:${p.id}`] ? "" : "open"}`}>▾</span>
                      </button>
                      <button className="proj-name" onClick={() => { setOpenProject(p.id); setTab("projects"); if (narrow) setSideManual(true); }} title={p.name}>
                        <ProjectIcon /><span className="recent-title">{p.name}</span><span className="count">{list.length}</span>
                      </button>
                      <button className={`x pin ${p.pinned ? "on" : ""}`} title={p.pinned ? "Unpin project" : "Pin project"} aria-label={p.pinned ? "Unpin project" : "Pin project"} onClick={() => pinProject(p)}><PinIcon /></button>
                      <button className="x" title="Archive project" aria-label="Archive project" onClick={() => archiveProject(p, true)}><Icon d={ICONS.archive} size={14} /></button>
                      <button className="x" title="New chat in this project" aria-label="New chat in this project" onClick={() => { newChat(p.id); setFold((f) => ({ ...f, [`p:${p.id}`]: false })); }}><Icon d={ICONS.plus} size={14} /></button>
                    </div>
                    <div className={`fold ${fold[`p:${p.id}`] ? "" : "open"}`}><div className="fold-inner" inert={!!fold[`p:${p.id}`]}>{list.length ? paged(`p:${p.id}`, list, 5, (c) => row(c, true), 10) : <div className="muted small nested-empty">No chats yet</div>}</div></div>
                  </div>
                )) : null, false, (
                  <button type="button" className="group-add" title="New project" aria-label="New project"
                    onClick={() => { const p = newProject(); saveProject(p); setOpenProject(p.id); setTab("projects"); setFold((f) => ({ ...f, projects: false })); if (narrow) setSideManual(true); }}>
                    <Icon d={ICONS.plus} size={14} />
                  </button>
                ))}
                {/* The escape hatch sits outside the fold: a persisted-closed Projects
                    section must not hide the way to create the first project. */}
                {groups.length === 0 && (
                  <div className="muted small nested-empty">No projects yet — <button type="button" className="link" onClick={() => go("projects")}>create a project</button> to group chats.</div>
                )}
                {/* "Recent chats" says exactly what the list holds: conversations that
                    are not pinned and do not belong to a project (those live above). */}
                {section("recents", "Recent chats", loose.length, loose.length ? paged("recents", loose, PAGE, (c) => row(c)) : <div className="muted small nested-empty">Chats outside any project appear here.</div>)}
                {(gone.length > 0 || goneProjects.length > 0) && section("archived", "Archived", gone.length + goneProjects.length, (
                  <>
                    {goneProjects.map((p) => (
                      <div className="proj-head archived" key={p.id}>
                        <button className="proj-name" onClick={() => { setOpenProject(p.id); setTab("projects"); }} title={p.name}><ProjectIcon /><span className="recent-title">{p.name}</span></button>
                        <button className="x show" title="Restore project" aria-label="Restore project" onClick={() => archiveProject(p, false)}><Icon d={ICONS.retry} size={14} /></button>
                      </div>
                    ))}
                    {paged("archived", gone, 10, (c) => row(c))}
                  </>
                ), true)}
              </>
            );
          })()}
        </div>
        <div className="side-foot">
          {sideMenu.value && (
            <>
              <div className="menu-scrim" onClick={closeMenu} />
              <div className="side-menu" id="runtime-status" ref={menuPanelRef} tabIndex={-1} role="region" aria-label={`${aiName} status`} data-state={sideMenu.closing ? "closed" : "open"} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); } }}>
                {statusBody}
              </div>
            </>
          )}
          <button ref={profileBtnRef} className={`profile ${menuOpen ? "active" : ""}`} title="View AI status and memory use" aria-controls="runtime-status" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <span className="profile-name">{aiName}</span>
            <span className={`profile-state ${!cloudProvider && (server?.state === "failed" || serverPhase !== "fresh") ? "failed" : ""}`}>{cloudProvider ? "Cloud" : shortServerState}</span>
            <svg className="profile-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
          </button>
        </div>
        <div className="side-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={dragSide} onDoubleClick={() => { setSideW(280); try { localStorage.setItem("opennpu.sideW", "280"); } catch { /* not saved */ } }} />
      </aside>}
      <main className="main" inert={narrow && !sideFolded}>
        {!(dialog === "settings" && settingsTab === "library") && modelSwitchStatus}
        {!(dialog === "settings" && settingsTab === "library") && modelSelectionNotice}
        {info && (info.problems.length > 0 || info.geniexVersionWarning) && (
          <div className="banner">
            {info.problems.map((p) => <div key={p}>{p}</div>)}
            {info.geniexVersionWarning && <div>{info.geniexVersionWarning}</div>}
          </div>
        )}
        {voice?.notice && voice.notice !== closedNotice && <div className="banner soft banner-row"><span>{voice.notice}</span><button type="button" className="banner-close" aria-label="Close this message" title="Close" onClick={() => setClosedNotice(voice.notice ?? "")}>×</button></div>}
        {projectSaveError && (
          <div className="banner warn banner-row" role="alert">
            <span>The project “{projectSaveError.project.name}” could not be saved ({projectSaveError.message}). Your change is still on screen but not stored: free some space, then retry.</span>
            <button type="button" className="linkbtn" aria-label="Retry saving the project" onClick={() => saveProject(projects.find((x) => x.id === projectSaveError.project.id) ?? projectSaveError.project)}>Retry</button>
          </div>
        )}
        {undoChat && (
          <div className="banner soft banner-row" role="status">
            <span>Chat “{undoChat.conv.title}” deleted.</span>
            <button type="button" className="linkbtn" onClick={undoDelete}>Undo</button>
            <button type="button" className="banner-close" aria-label="Close this message" title="Close" onClick={() => setUndoChat(null)}>×</button>
          </div>
        )}
        {storageWarning && <div className="banner soft banner-row"><span>{storageWarning}</span><button type="button" className="banner-close" aria-label="Close this message" title="Close" onClick={() => setStorageWarning(null)}>×</button></div>}
        {!booting && essentialFailed.length === 0 && (optionalFailed.length > 0 || bootPending.length > 0) && (
          <div className="banner soft banner-row" role="status">
            <span>
              {bootPending.length > 0 && <>Still loading: {bootPending.map((k) => BOOT_READ_LABEL[k] ?? k).join(", ")}. </>}
              {optionalFailed.length > 0 && <>Some data could not be loaded: {optionalFailed.map((k) => BOOT_READ_LABEL[k] ?? k).join(", ")}. Everything already saved on this PC still works.</>}
            </span>
            {optionalFailed.map((k) => (
              <button key={k} type="button" className="ghost" onClick={() => retryBootKey(k)}>{`Retry ${(BOOT_READ_LABEL[k] ?? k).toLowerCase()}`}</button>
            ))}
          </div>
        )}
        {settings && convs.filter((c) => c.id === active.id || busyIds.has(c.id)).map((c) => (
          // a conversation that is still answering stays mounted (hidden) so leaving it does not drop the stream
          <div key={c.id} style={{ display: tab === "chat" && c.id === active.id ? "contents" : "none" }}>
          <Chat
            conv={c} selected={selected} server={server} voiceSettings={voiceSettings} voiceStatus={voice}
            project={projects.find((x) => x.id === c.projectId) ?? null}
            items={items} onCatalogChanged={() => void refreshCatalog()} effort={readSetting(settings, "effort")} subagents={readBool(settings, "subagents")}
            settings={settings} onSettings={changeSettings} changingChatMode={changingChatMode}
            onSelectModel={(id, explicit) => { void chooseModel(id, explicit); }}
            onEffort={(effort) => { void api().saveSettings({ effort }).then(setSettings); }}
            onPickModel={() => openSettings("library")} onOpenSettings={(group) => openSettings(group ?? "chats")} onTurns={updateTurns} onMemo={(id, memo) => setConvs((all) => all.map((x) => (x.id === id ? { ...x, memo: memo ?? undefined } : x)))} onMemoEvent={(convId, text, turns) => setConvs((all) => all.map((x) => {
  if (x.id !== convId) return x;
  // the summary stands for the conversation's first `turns` visible turns; the last of them
  // fingerprints it, so a summary only applies while the turns it stands for are still there
  const last = x.turns.filter((t) => !t.error && t.content)[turns - 1];
  return last ? { ...x, memo: { text, turns, hash: hashText(last.content), at: Date.now() } } : x;
}))}
            onBusy={(b) => setBusyIds((prev) => { if (prev.has(c.id) === b) return prev; const n = new Set(prev); if (b) n.add(c.id); else n.delete(c.id); return n; })}
            onOpenProject={(id) => { setOpenProject(id); setTab("projects"); }} onArtifact={saveArtifact} onExportArtifact={exportArtifact} onShowVersions={(id) => showArtifact(id, true)} onOpenArtifact={showArtifact} onVersionApplied={versionApplied}
            startText={startText?.id === c.id ? startText.text : undefined} onStarted={() => setStartText(null)}
          />
          </div>
        ))}
        {seenTabs.filter((t) => t !== "chat").map((t) => (
          <div key={t} className="view" style={{ display: tab === t ? undefined : "none" }}>
        {t === "projects" && (
          <Projects
            projects={projects} convs={convs} tasks={tasks} artifacts={files} contextTokens={selected?.verdict.contextTokens || 4096}
            openId={openProject} onOpen={setOpenProject} onSave={saveProject} onDelete={(id) => void deleteProject(id)}
            onNewChat={(id, text) => newChat(id, text)} onPin={pinProject} onArchive={archiveProject}
            onArchiveChat={archiveChat} onPinChat={togglePin} onOpenChat={openChat} onOpenTasks={() => setTab("tasks")} onOpenArtifact={showArtifact}
          />
        )}
        {t === "artifacts" && (
          <Artifacts
            artifacts={files} projects={projects} openId={openArtifact} onOpen={(id) => { setOpenArtifact(id); setVersionsOpen(false); }} versionsOpen={versionsOpen} onVersionsOpen={setVersionsOpen} onVersionApplied={versionApplied}
            onDelete={(id) => { void api().deleteArtifact(id).then(setArtifacts); }} onExport={exportArtifact}
          />
        )}
        {t === "tasks" && (
          <Tasks
            tasks={tasks} projects={projects} artifacts={artifacts} models={items} hasModel={!!selected} selectedModelName={selected?.entry.name ?? null}
            onSave={async (t2) => setTasks(await api().saveTask(t2))} onDelete={(id) => { void api().deleteTask(id).then(setTasks); }}
            onRun={(id) => { void api().runTask(id).catch((e) => window.alert((e as Error).message)); }} onOpenArtifact={showArtifact}
            openTaskId={taskToOpen} onOpened={() => setTaskToOpen(null)}
          />
        )}
        {t === "customize" && settings && (
          <Customize settings={settings} onSave={async (p) => setSettings(await api().saveSettings(p))} onOpenDocs={openSkillDocs}
            model={selected ? { name: selected.entry.name, contextTokens: selected.entry.compiledContext || selected.verdict.contextTokens || 4096 } : null} />
        )}
          </div>
        ))}
      </main>
      </div>
      {searchOpen && (
        <Search
          convs={convs} projects={projects} artifacts={files} tasks={tasks} onClose={() => setSearchOpen(false)}
          onChat={(id) => { setDialog(null); openChat(id); }} onProject={(id) => { setDialog(null); setOpenProject(id); setTab("projects"); }} onArtifact={(id) => { setDialog(null); showArtifact(id); }} onTasks={(id) => { setDialog(null); setTaskToOpen(id ?? null); setTab("tasks"); }}
        />
      )}
      {dlg.value && (
        <div className="modal-backdrop" data-state={dlg.closing ? "closed" : "open"} onClick={popDialog} aria-hidden={searchOpen ? true : undefined}>
          {dlg.value === "settings" && settings && hw && info && (
            <div className="modal modal-settings" ref={settingsModalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <span className="dialog-purpose">Settings</span>
                <button className="x" title="Close" aria-label="Close Settings" onClick={() => setDialog(null)}>×</button>
              </div>
              <div className="modal-body"><div className="view">
                <SettingsView
                  key={settingsStart ?? "default"} initialTab={settingsStart}
                  items={items}
                  settings={settings} hw={hw} info={info} server={server} voice={voice}
                  chatLocationBusy={changingChatMode || busyIds.size > 0}
                  onSave={async (p) => {
                    setSettings(await api().saveSettings(p));
                    // Scope the follow-up reads to the settings that changed: a checkbox
                    // save never re-reads the hardware, the catalog and the app info.
                    if (p.geniexPath !== undefined) setInfo(await api().appInfo());
                    if (p.npuBudgetOverrideGB !== undefined) setHw(await api().hardware());
                  }}
                  onSaveVoice={async (p) => { setSettings(await api().saveVoice(p)); }}
                  onRedetect={() => refreshHardware(true)}
                  onBenchSaved={() => { void reloadBench(); void refreshCatalog(); }}
                  onOpenCustomize={() => { setDialog(null); go("customize"); }}
                  onTabChange={setSettingsTab}
                  renderModels={() => <>{modelSwitchStatus}{modelSelectionNotice}<Models embedded items={items} hw={hw} onChanged={refreshCatalog} onUse={select} selectedId={settings?.selectedModelId ?? null} showK={readBool(settings, "showKQuants")} bench={{ profiles: benchProfiles, preferredCompute: settings?.compute }} /></>}
                />
              </div></div>
            </div>
          )}
        </div>
      )}
      {railTip && <div className="rail-tip" role="tooltip" style={{ left: railTip.x, top: railTip.y }}>{railTip.text}</div>}
    </div>
  );
}
