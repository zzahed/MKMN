import { Requirements } from "./Requirements";
import { HumainSettings } from "./HumainSettings";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { RadioSeg } from "./RadioSeg";
import { DynamicEditor } from "./DynamicEditor";
import { NpuLoadTest } from "./NpuLoadTest";
import { ResetNpuButton } from "./ResetNpuButton";
import { EngineCompare } from "./EngineCompare";
import { FoundryPanel } from "./FoundryPanel";
import { ProviderMatrix } from "./ProviderMatrix";
import { PromptLab } from "./PromptLab";
import { RuntimePanel } from "./RuntimePanel";
import { BatteryProbe } from "./BatteryProbe";
import { useDocumentVisible } from "./useDocumentVisible";
import { Benchmark } from "./Benchmark";
import { CopySupport } from "./CopySupport";
import { isDynamicId } from "../core/dynamic";
import { benchOptionLabel } from "../core/modelList";
import { ICONS, IconButton } from "./Icon";
import { AudioIcon, ChipIcon, GaugeIcon, GearIcon, GlobeIcon, LogoLockup, ProjectIcon, RoleplayIcon, TerminalIcon } from "./Icons";
import { BRAND } from "./brand";
import { MicTest } from "./VoiceSetup";
import { VOICE_LIMITS } from "../core/voiceModels";
import { fastVoiceModel } from "../core/voicePick";
import {
  budgetProblem, calibrationResetPatch, createEstimateGate, createSaveFeedback,
  createSliderCommit, dictationLanguageOptions, executionStatus, memoryEstimateView, normalizeBenchTarget,
  observedExecutionTarget, benchmarkTargets, retentionPatch, retentionFromIdle, runsOnNote,
  speakerProblem, voiceDeviceCapable, voicePlacementWarning,
} from "../core/settingsUi";
import type { SaveFeedbackState } from "../core/settingsUi";
import { COMPUTE_LABEL } from "../core/adaptiveCompute";
import type { AppInfo, CatalogItem, NpuPlanView } from "../shared/api";
import type { HardwareProfile, ServerStatus, Settings, VoiceDownloadProgress, VoiceModel, VoiceModelView, VoiceSettings, VoiceStatus, PowerStatusInfo, BenchmarkResult } from "../shared/types";
import { readBool, readNum, readObj, readSetting, settingDefault, settingDecl, changedKeys, resettableChangedKeys, exportSettings, importSettings, leafValuePatch, SETTING_GROUPS } from "../shared/settingsSchema";
import { applyAppearance, type AppearanceMode } from "./theme";
import { DEV_SECTIONS, PRIMARY_TABS, SETTINGS_SECTIONS, redirectTab, searchSettings, tabLabel, type SettingsTab } from "./settingsSearch";
import { MultilingualSearch } from "./MultilingualSearch";

// ---------------------------------------------------------------- navigation (module scope)

const NAV_ICONS: Record<SettingsTab, () => React.ReactElement> = {
  "general": GearIcon, "library": ChipIcon, "models": GaugeIcon, "chats": RoleplayIcon, "files": ProjectIcon,
  "web": GlobeIcon, "fuse": GlobeIcon, "node": GlobeIcon, "about": GearIcon, "voice": AudioIcon, "developer": TerminalIcon,
};

/**
 * Defined at module scope ON PURPOSE: a component created inside the settings body
 * gets a new identity on every parent render (including the power poll), which
 * remounts the whole navigation and drops keyboard focus mid-keystroke.
 */
function NavButton({ c, active, onSelect, changedCount }: { c: { id: SettingsTab; label: string; hint: string }; active: boolean; onSelect: (id: SettingsTab) => void; changedCount: number }) {
  // One line per group: the icon, the name, and how many of its settings were
  // changed. The group's hint is its tooltip and the heading line of its page.
  return (
    <button type="button" className={`set-nav-item ${active ? "on" : ""}`} onClick={() => onSelect(c.id)} aria-current={active ? "page" : undefined} title={c.hint}>
      <span className="set-ico">{NAV_ICONS[c.id]()}</span>
      <span className="set-txt">{c.label}</span>
      {changedCount > 0 && <span className="changed-count" title={`${changedCount} changed from the default`} aria-label={`${changedCount} changed`}>{changedCount}</span>}
    </button>
  );
}

/** A stored value said in words for the Changed list: never raw JSON. */
function plainValue(v: unknown, type?: string): string {
  if (v === null || v === undefined || v === "") return "not set";
  // a choice from a list reads as a word: "Medium", never the stored "medium"
  if (type === "enum" && typeof v === "string") return v.charAt(0).toUpperCase() + v.slice(1);
  if (v === true) return "On";
  if (v === false) return "Off";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "none" : `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") { const n = Object.keys(v as object).length; return n === 0 ? "none" : `${n} value${n === 1 ? "" : "s"}`; }
  return String(v);
}

/** A quiet label above a run of sections in a long group (Developer). */
function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="set-subhead" role="presentation">{children}</div>;
}

// ---------------------------------------------------------------- shared controls

/** The Changed dot for one stored key: shown when the stored value differs from
 *  the schema default. The one authority is settingsSchema.changedKeys — the dot
 *  never guesses from a control's own draft or a hand-copied default. */
function Dot({ c, k }: { c: ReadonlySet<string>; k: string }) {
  if (!c.has(k)) return null;
  return <span className="changed-dot" title="Changed from the default" />;
}

/** Slider that keeps its own value while dragging and saves through the ONE commit
 *  latch (core/settingsUi.ts, createSliderCommit): debounce, pointer release, keyboard
 *  and blur all funnel into it, so a value saves once when it changed — and unmount
 *  (navigating away) flushes the pending value instead of dropping it. */
function Range({ value, min, max, step, onSave, ariaLabel, format, disabled }: {
  value: number; min: number; max: number; step: number; ariaLabel: string; format?: (v: number) => string; disabled?: boolean;
  onSave: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const commitRef = useRef<ReturnType<typeof createSliderCommit> | undefined>(undefined);
  if (!commitRef.current) commitRef.current = createSliderCommit({ initial: value, save: (v) => onSaveRef.current(v) });
  const commit = commitRef.current;
  // onSave is recreated by the parent on renders: reach it through a ref so the
  // long-lived commit latch always calls the current one
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  useEffect(() => () => commit.dispose(), [commit]);
  useEffect(() => { setLocal(value); commit.sync(value); }, [value, commit]);
  return (
    <input
      type="range" min={min} max={max} step={step} value={local} aria-label={ariaLabel} disabled={disabled}
      aria-valuetext={format ? format(local) : undefined}
      onChange={(e) => { const v = parseFloat(e.currentTarget.value); setLocal(v); commit.change(v); }}
      // read the DOM value: the render closure can be stale by the time the gesture ends
      onPointerUp={(e) => { const v = parseFloat(e.currentTarget.value); setLocal(v); commit.gestureEnd(v); }}
      onKeyUp={(e) => { if (e.key !== "Tab") commit.gestureEnd(parseFloat(e.currentTarget.value)); }}
      onBlur={() => commit.blur()}
    />
  );
}

/** Text that commits on blur or Enter — never a save per keystroke. */
function TextCommit({ value, onSave, placeholder, type = "text", ariaLabel, width }: {
  value: string; onSave: (v: string) => void; placeholder?: string; type?: "text" | "password"; ariaLabel: string; width?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { const t = draft.trim(); if (t !== value) onSave(t); };
  return (
    <input
      type={type} value={draft} placeholder={placeholder} aria-label={ariaLabel}
      style={width ? { width } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}

/** The microphone choice, previously only reachable from the voice bar. */
function MicPicker({ value, onSave }: { value: string; onSave: (id: string) => void }) {
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let live = true;
    const list = () => {
      navigator.mediaDevices?.enumerateDevices().then((d) => {
        if (!live) return;
        const mics = d.filter((x) => x.kind === "audioinput" && x.deviceId !== "communications" && x.deviceId !== "default");
        setDevices(mics.map((x, i) => ({ id: x.deviceId, label: x.label || `Microphone ${i + 1}` })));
      }).catch(() => undefined);
    };
    list();
    navigator.mediaDevices?.addEventListener("devicechange", list);
    return () => { live = false; navigator.mediaDevices?.removeEventListener("devicechange", list); };
  }, []);
  return (
    <label className="small">
      <span className="sr-only">Microphone</span>
      <select value={value} onChange={(e) => onSave(e.target.value)}>
        <option value="">System default</option>
        {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      {devices.length === 0 && <span className="muted small">No other microphone found (names appear after the first use of the microphone).</span>}
    </label>
  );
}

function PlanBar({ plan }: { plan: NpuPlanView }) {
  const onNpu = plan.lines.filter((l) => l.onNpu);
  const colors: Record<string, string> = { chat: "var(--accent)", stt: "var(--cat-2)", tts: "var(--cat-4)" };
  return (
    <div className="plan">
      <div className="track plan-track">
        {onNpu.map((l) => <div key={l.role} className="seg-fill" style={{ width: `${Math.min(100, (l.gb / plan.budgetGB) * 100)}%`, background: colors[l.role] }} title={`${l.name}: ${l.gb} GB`} />)}
        <div className="limit" style={{ left: `${Math.min(100, (plan.usableGB / plan.budgetGB) * 100)}%` }} />
      </div>
      <div className="small muted">
        {onNpu.length === 0 ? "Nothing is on the NPU." : onNpu.map((l) => `${l.role === "chat" ? "Chat" : l.role === "stt" ? "Dictation" : "Read-aloud"} ${l.gb} GB`).join(" + ")}
        {" · "}safe limit {plan.usableGB} of {plan.budgetGB} GB
      </div>
      {plan.advice ? <div className="warn small">{plan.advice}</div> : onNpu.length > 1 && <div className="ok small">Everything on the NPU fits together.</div>}
    </div>
  );
}

function VoiceModelList({ kind, models, selected, progress, onSelect, onDownload, onCancel, onRemove }: {
  kind: "stt" | "tts"; models: VoiceModelView[]; selected: string | null; progress: Record<string, VoiceDownloadProgress>;
  onSelect: (id: string) => void; onDownload: (id: string) => void; onCancel: (id: string) => void; onRemove: (id: string) => void;
}) {
  return (
    <div className="list">
      {models.filter((m) => m.model.kind === kind).map(({ model, installed }) => {
        const p = progress[model.id];
        const busy = p && (p.phase === "downloading" || p.phase === "extracting");
        return (
          <div key={model.id} className={`row-item ${selected === model.id ? "sel" : ""}`}>
            <label className="grow">
              <input type="radio" name={`v-${kind}`} disabled={!installed} checked={selected === model.id} onChange={() => onSelect(model.id)} />
              <span> {model.name}{model.default && <span className="tag">default</span>}{model.device === "NPU" && <span className="tag">NPU</span>}</span>
              <div className="muted small">{model.languages} · ~{model.sizeMB} MB · {model.note}</div>
              {p?.error && <div className="error-box"><strong>{p.error.title}</strong><div>{p.error.fix}</div></div>}
            </label>
            {busy ? (
              <div className="install-progress">
                {/* percent === null is genuinely indeterminate: say so, never draw a fake 0% or 100% */}
                <div
                  className="track"
                  role="progressbar"
                  aria-label={p.phase === "extracting" ? "Unpacking" : "Downloading"}
                  {...(typeof p.percent === "number" ? { "aria-valuenow": Math.round(p.percent), "aria-valuemin": 0, "aria-valuemax": 100 } : {})}
                >
                  <div className={`fill ${typeof p.percent === "number" ? "" : "indeterminate"}`} style={typeof p.percent === "number" ? { width: `${p.percent}%` } : undefined} />
                </div>
                <span className="small muted" aria-live="polite">{p.phase === "extracting" ? "Unpacking…" : typeof p.percent === "number" ? `${p.percent}%` : "Downloading…"}</span>
                <IconButton d={ICONS.close} label="Cancel" onClick={() => onCancel(model.id)} />
              </div>
            ) : installed ? <IconButton d={ICONS.trash} label="Remove" onClick={() => onRemove(model.id)} />
              : <IconButton className="accent" d={ICONS.download} label="Download" onClick={() => onDownload(model.id)} />}
          </div>
        );
      })}
    </div>
  );
}

/** Where a speech model runs: the NPU choice exists only for models that have an NPU build. */
function VoiceComputeChoice({ kind, model, value, onSave }: {
  kind: "stt" | "tts"; model: VoiceModel | null; value: "cpu" | "npu"; onSave: (c: "cpu" | "npu") => void;
}) {
  const capable = voiceDeviceCapable(model);
  const warning = voicePlacementWarning(kind, value, model);
  return (
    <div>
      <RadioSeg
        value={value}
        ariaLabel={`${kind === "stt" ? "Dictation" : "Read-aloud"} device`}
        onChange={onSave}
        options={[
          { id: "cpu", label: "CPU", why: "Leaves the NPU free for the chat model" },
          { id: "npu", label: "NPU", disabled: !capable, why: capable ? "Faster" : "This model has no NPU build" },
        ]}
      />
      {!capable && <div className="muted small">This model runs on the CPU: its runtime has no NPU build. NPU dictation needs a speech model with an NPU build.</div>}
      {warning && <div className="warn small" role="status">{warning}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- save feedback

/**
 * One shared save contract: Saving → Saved, and failed saves stay with their own Retry.
 * The state machine itself (overlapping saves, timer cancellation, per-setting failure
 * slots, stale-retry refusal) is the tested pure store `createSaveFeedback` in
 * core/settingsUi.ts; this hook only bridges it to React and returns BOTH slots — the
 * caller renders every failure and the busy/confirmation side by side, so a success
 * never conceals a failure.
 */
function useSaver(): { fb: SaveFeedbackState; attempt: (what: string, apply: () => Promise<unknown>, opKey?: string) => Promise<boolean>; dismissFailure: (id: number) => void } {
  const store = useMemo(() => createSaveFeedback(), []);
  useEffect(() => () => store.dispose(), [store]);
  const fb = useSyncExternalStore(store.subscribe, store.get);
  return { fb, attempt: store.attempt, dismissFailure: store.dismissFailure };
}

// ---------------------------------------------------------------- page

/** Where a benchmark ran, as measured: the target it was run on, and whether the NPU was seen doing the work. */
export function benchWhere(r: { compute: string; verifiedNpu: boolean }): string {
  const target = (r.compute || "unknown").toUpperCase();
  return /npu/i.test(r.compute) ? `${target}${r.verifiedNpu ? " · verified" : " · not verified"}` : target;
}
export function SettingsView({ settings, hw, info, server, voice, items, onSave, onSaveVoice, onRedetect, onOpenCustomize, onBenchSaved, renderModels, onTabChange, initialTab, chatLocationBusy }: {
  settings: Settings; hw: HardwareProfile; info: AppInfo; server: ServerStatus | null; voice: VoiceStatus | null;
  /** The ONE authoritative catalog (App owns it; Models refreshes it after every
      install/remove). Derived views (dropdowns, capability gating, benchmark targets)
      re-derive from it, so they can never go stale while this page stays mounted. */
  items: CatalogItem[];
  onSave: (p: Partial<Settings>) => Promise<void>; onSaveVoice: (p: Partial<VoiceSettings>) => Promise<void>; onRedetect: () => Promise<void>;
  /** For search entries that live in the Customize page (personalization, skills). */
  onOpenCustomize?: () => void;
  /** The Models library, drawn as the Models group of this page (App owns its data). */
  renderModels?: () => React.ReactNode;
  /** Told whenever the shown group changes (the rail lights Models or Settings by it). */
  onTabChange?: (tab: SettingsTab) => void;
  initialTab?: SettingsTab;
  chatLocationBusy?: boolean;
  /** A successful benchmark just wrote new measurements into hardware.json: the caller refreshes the model list and the local-measurement chips. */
  onBenchSaved?: () => void;
}) {
  const v = settings.voice;
  /** The turn-budget pair from its two halves: Default on one half keeps the other;
   *  only both at Default store nothing (the policy default then stands). */
  const turnPair = (calls: number | null, tokens: number | null) =>
    calls === null && tokens === null ? null
      : { maxCalls: calls ?? (settingDefault("turnBudget.maxCalls") as number), maxOutputTokens: tokens ?? (settingDefault("turnBudget.maxOutputTokens") as number) };
  /** The stored turn-budget pair, read the way the app acts on it (schema default when absent). */
  const tb = () => readObj<{ maxCalls?: number; maxOutputTokens?: number } | null>(settings, "turnBudget");
  const [tab, setTab] = useState<SettingsTab>(() => {
    // A saved location or an initial deep link may still name a pre-2.10 tab id;
    // redirectTab resolves both, and unknown ids land on General, never a blank page.
    if (initialTab) return redirectTab(initialTab);
    try {
      return redirectTab(localStorage.getItem("mkmn.settings.tab"));
    } catch { return "general"; }
  });
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState(settings.npuBudgetOverrideGB?.toString() ?? "");
  const [budgetErr, setBudgetErr] = useState<string | null>(null);
  const [sidDraft, setSidDraft] = useState(String(v.ttsSid));
  const [sidErr, setSidErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyErr, setCopyErr] = useState(false);
  const [plan, setPlan] = useState<NpuPlanView | null>(null);
  const [models, setModels] = useState<VoiceModelView[]>([]);
  const [progress, setProgress] = useState<Record<string, VoiceDownloadProgress>>({});
  const [log, setLog] = useState<string[]>([]);
  /** The installed models, derived from the SHARED catalog: App's `items` are
      refreshed by Models after every install/remove, so every dropdown, capability
      gate and benchmark target here follows the current catalog without this page
      remounting (drafts, scroll and disclosures survive). */
  const installed = useMemo(
    () => items.filter((i) => i.installed && !i.hidden && !isDynamicId(i.entry.id)),
    [items],
  );
  /** The selected model is no longer in the installed catalog (removed while this
      page was mounted, or removed elsewhere): say so where its name is used, never
      silently fall back. The check runs on the SHARED catalog's installed flag, not
      on the `installed` view — a selected model that is merely hidden is still on
      disk and must not be announced as removed. Dynamic packs and voices are managed
      elsewhere, so they are not "removed" from this list. */
  const selectedMissing = !!settings.selectedModelId && !isDynamicId(settings.selectedModelId)
    && !items.some((i) => i.installed && i.entry.id === settings.selectedModelId);

  // Snapdragon NPU states
  const [powerInfo, setPowerInfo] = useState<PowerStatusInfo | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<BenchmarkResult | null>(null);
  const [benchModel, setBenchModel] = useState<string>("");
  const [benchCompute, setBenchCompute] = useState<string>("npu");
  const [benchPowerMode, setBenchPowerMode] = useState<string>("burst");
  const [benchMsg, setBenchMsg] = useState<string | null>(null);

  const { fb, attempt, dismissFailure } = useSaver();
  const bodyRef = useRef<HTMLDivElement>(null);
  // The opKey names the SETTING inside the patch, so failures of different settings
  // coexist and a newer save of the same setting resolves its own older failure (a
  // stale retry would otherwise overwrite the newer choice).
  const opKey = (p: object) => `settings:${Object.keys(p).sort().join("+")}`;
  const save = useCallback((p: Partial<Settings>) => attempt(`settings (${Object.keys(p).sort().join(", ")})`, () => onSave(p), opKey(p)), [attempt, onSave]);
  const saveV = useCallback((p: Partial<VoiceSettings>) => attempt("voice settings", () => onSaveVoice(p), "voice"), [attempt, onSaveVoice]);

  /** A QAIRT bundle is a precompiled NPU artifact: it has no CPU path at all, so the
      benchmark never offers one (the runner would refuse it; there is no effect
      silently reverting the choice because the choice cannot be made). The target is
      derived from the model's engine and normalized again before every run: a choice
      made for one model must never be submitted for another. */
  const benchEngine = installed.find((i) => i.ref === benchModel)?.entry.engine;
  const benchTargets = benchmarkTargets(benchEngine);
  const benchEffective = normalizeBenchTarget(benchCompute, benchEngine);
  // the "Runs on" line, only when the effective target differs from the pick (a compiled
  // bundle's stale hybrid choice): the one case the line adds something the select does not say
  const benchNote = runsOnNote(benchCompute, benchEngine);
  // the selected model's long ref, shown once under the select: the options carry names only
  const benchSelRef = installed.find((i) => i.ref === benchModel)?.ref ?? null;
  useEffect(() => {
    // the selection follows the model: a hybrid choice for a GGUF model normalizes
    // to the NPU when the selection changes to a compiled bundle
    setBenchCompute((c) => normalizeBenchTarget(c, benchEngine));
  }, [benchEngine]);

  /** A compiled bundle's capability is known from the SELECTED model itself, before it
      loads: its context and cache are baked into the artifact (finding 6 — the old
      check waited for server.contextKind, so the controls were live until then). */
  const selectedEntry = installed.find((i) => i.entry.id === settings.selectedModelId)?.entry;
  const selectedIsCompiled = selectedEntry?.engine === "qairt";

  const refreshPlan = useCallback(async () => setPlan(await api().npuPlan()), []);
  const refreshModels = useCallback(async () => setModels(await api().voiceModels()), []);

  // Pause the power poll while the window is hidden: the reading is only ever shown
  // here, and a hidden WebView has no use for a 4 s IPC round-trip.
  const docVisible = useDocumentVisible();
  useEffect(() => {
    if (!docVisible) return;
    void api().powerStatus().then(setPowerInfo).catch(() => undefined);
    const interval = setInterval(() => {
      void api().powerStatus().then(setPowerInfo).catch(() => undefined);
    }, 4000);
    return () => clearInterval(interval);
  }, [docVisible]);

  useEffect(() => { void refreshModels(); }, [refreshModels]);
  useEffect(() => api().onVoiceDownload(async (p) => {
    setProgress((s) => ({ ...s, [p.id]: p }));
    if (p.phase === "done") {
      await refreshModels();
      // first download of a kind becomes the selection
      const m = (await api().voiceModels()).find((x) => x.model.id === p.id)?.model;
      if (m) {
        const cur = (await api().settings()).voice;
        if (m.kind === "stt" && !cur.sttModelId) await onSaveVoice({ sttModelId: m.id });
        if (m.kind === "tts" && !cur.ttsModelId) await onSaveVoice({ ttsModelId: m.id });
      }
    }
  }), [refreshModels, onSaveVoice]);

  const activeRef = settings.selectedModelId && !selectedMissing
    ? (installed.find((i) => i.entry.id === settings.selectedModelId)?.ref || settings.selectedModelId)
    : (installed[0]?.ref || "qualcomm/Qwen3-1.7B:W4A16");

  // Default the benchmark target to the active model, once.
  useEffect(() => { if (!benchModel && activeRef) setBenchModel(activeRef); }, [benchModel, activeRef]);
  // A benchmark selection that is no longer installed (removed while this page was
  // mounted) cannot be run: it falls back to the active model instead of sitting in
  // the dropdown as a selection with no card behind it.
  useEffect(() => {
    if (benchModel && installed.length > 0 && !installed.some((i) => i.ref === benchModel)) setBenchModel(activeRef);
  }, [benchModel, activeRef, installed]);

  // The memory estimate is gated (core/settingsUi.ts, createEstimateGate): it follows
  // the selected model, the context and cache settings, the memory budget and the
  // hardware re-detection, refreshes about every 30 s while the memory page is open,
  // and never shows one model's numbers as another model's answer.
  const estimateGate = useMemo(
    () => createEstimateGate((ref, nctx, kv) => api().estimateMemory(ref, nctx, kv)),
    [],
  );
  useEffect(() => () => estimateGate.dispose(), [estimateGate]);
  const gate = useSyncExternalStore(estimateGate.subscribe, estimateGate.get);
  useEffect(() => {
    const nctx = settings.nctxMode && settings.nctxMode !== "auto" ? parseInt(settings.nctxMode, 10) : undefined;
    // the memory budget is part of the estimate's configuration identity: the override
    // (or the device budget behind it) changes the fit verdict, so it is in the key
    estimateGate.request(activeRef, nctx, settings.kvType, settings.npuBudgetOverrideGB ?? hw.npuBudgetGB);
    if (tab !== "models") return;
    const iv = window.setInterval(() => estimateGate.request(activeRef, nctx, settings.kvType, settings.npuBudgetOverrideGB ?? hw.npuBudgetGB), 30_000);
    return () => window.clearInterval(iv);
    // hw.npuBudgetGB changes on a re-detect or an override: the fit depends on it, so ask again.
  }, [estimateGate, activeRef, settings.nctxMode, settings.kvType, settings.npuBudgetOverrideGB, hw.npuBudgetGB, installed.length, tab]);

  useEffect(() => { void refreshPlan(); }, [refreshPlan, settings.compute, settings.selectedModelId, v.sttCompute, v.ttsCompute, v.sttModelId, v.ttsModelId, settings.npuBudgetOverrideGB]);
  useEffect(() => { void api().serverLog().then(setLog); }, [server?.state]);

  useEffect(() => setBudget(settings.npuBudgetOverrideGB?.toString() ?? ""), [settings.npuBudgetOverrideGB]);
  useEffect(() => setSidDraft(String(v.ttsSid)), [v.ttsSid]);

  const developer = readBool(settings, "developer");

  const selectTab = useCallback((id: SettingsTab) => {
    // leaving the Only-changed list returns the normal group view; the group
    // choice is remembered (the same storage key as before, now a group id)
    setOnlyChanged(false);
    setResetAsk(null);
    setTab(id);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    // The Models group is reached from the rail's own Models button; reopening
    // Settings from the gear lands on the last SETTINGS group, not on the library.
    if (id !== "library") try { localStorage.setItem("mkmn.settings.tab", id); } catch { /* not saved */ }
  }, []);
  useEffect(() => { onTabChange?.(tab); }, [tab, onTabChange]);

  // ------------------------------------------------------- changed / reset

  /** The keys whose stored value differs from the schema default, and the same
   *  keys grouped: the Changed dots, the nav counts, the Only-changed view and
   *  the per-group Reset all read this. */
  const changed = useMemo(() => new Set(changedKeys(settings)), [settings]);
  /** What the counts, the Changed list and the group Reset cover: only keys with a
   *  control here. Records and text edited elsewhere are data, never reset. */
  const resettable = useMemo(() => resettableChangedKeys(settings), [settings]);
  const changedByGroup = useMemo(() => {
    const m = new Map<SettingsTab, string[]>();
    for (const k of resettable) {
      const g = settingDecl(k)?.group;
      if (!g) continue;
      const list = m.get(g) ?? [];
      list.push(k);
      m.set(g, list);
    }
    return m;
  }, [resettable]);
  const [onlyChanged, setOnlyChanged] = useState(false);
  /** A group Reset waiting for its confirmation (the keys it would reset), and the
   *  values a Reset just replaced, so one click puts them back (Undo). */
  const [resetAsk, setResetAsk] = useState<string[] | null>(null);
  const [undo, setUndo] = useState<{ values: Record<string, unknown>; n: number } | null>(null);

  /** Write leaf values (schema keys, dot paths) through the right save path: the
   *  voice block merges through the voice save path (the settings patch replaces
   *  a whole top-level key, so a half voice object would drop the other keys),
   *  everything else as a nested patch built against the stored objects. */
  const applyLeaf = useCallback(async (values: Record<string, unknown>): Promise<boolean> => {
    const voicePatch: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(values)) {
      if (k === "voice") {
        if (val && typeof val === "object" && !Array.isArray(val)) Object.assign(voicePatch, val);
        continue;
      }
      if (k.startsWith("voice.")) { voicePatch[k.slice("voice.".length)] = val; continue; }
      Object.assign(rest, leafValuePatch(settings, { [k]: val }));
    }
    // Both saves are awaited: the caller reports only what really landed.
    const okV = Object.keys(voicePatch).length ? await saveV(voicePatch as Partial<VoiceSettings>) : true;
    const okR = Object.keys(rest).length ? await save(rest as Partial<Settings>) : true;
    return okV && okR;
  }, [settings, save, saveV]);

  /** Reset with Undo: the values being replaced are kept so one click restores them. */
  const resetWithUndo = useCallback(async (keys: string[]) => {
    const previous: Record<string, unknown> = {};
    for (const k of keys) previous[k] = readSetting(settings, k);
    setResetAsk(null);
    const values: Record<string, unknown> = {};
    for (const k of keys) values[k] = settingDefault(k);
    // Undo is offered only once the reset has really been saved; a failed save
    // keeps its own Retry line instead.
    const saved = await applyLeaf(values);
    if (saved) setUndo({ values: previous, n: keys.length });
  }, [settings, applyLeaf]);

  /** The group Reset asks first, inline, naming what it will change. */
  const resetGroup = useCallback(() => {
    const keys = changedByGroup.get(tab) ?? [];
    if (keys.length === 0) return;
    setUndo(null);
    setResetAsk(keys);
  }, [changedByGroup, tab]);

  // ------------------------------------------------------- export / import

  /** Status lines for Export and Import (their own channel: a cancelled file
   *  dialog is the user saying no, not a failed save, so these never ride the
   *  save-line's failure list). */
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<{ accepted: number; refusals: { key: string; reason: string }[] } | null>(null);

  const doExport = async () => {
    const doc = exportSettings(settings);
    const n = Object.keys(doc.values).length;
    if (n === 0) { setExportNote("Nothing to export: every setting is at its default."); return; }
    try {
      const path = await api().exportSettingsJson(JSON.stringify(doc, null, 2));
      setExportNote(path ? `Exported ${n} setting${n === 1 ? "" : "s"} to ${path}` : null);
    } catch (err) {
      setExportNote(`Export failed: ${(err as Error).message}`);
    }
  };

  const doImport = async () => {
    let text: string | null;
    try {
      text = await api().importSettingsJson();
    } catch (err) {
      setImportReport({ accepted: 0, refusals: [{ key: "", reason: (err as Error).message }] });
      return;
    }
    if (text === null) return; // cancelled: nothing happened, so nothing is reported
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setImportReport({ accepted: 0, refusals: [{ key: "", reason: `the file is not JSON (${(err as Error).message})` }] });
      return;
    }
    const res = importSettings(parsed);
    // Only values whose save landed count as imported.
    const nVoice = Object.keys(res.voice).length;
    const nRest = Object.keys(res.rest).length;
    const voiceSaved = nVoice ? await saveV(res.voice as Partial<VoiceSettings>) : true;
    const restSaved = nRest ? await save(res.rest as Partial<Settings>) : true;
    const importSaved = (voiceSaved ? nVoice : 0) + (restSaved ? nRest : 0);
    const refusals = [...res.refusals];
    if (!voiceSaved) refusals.push({ key: "voice", reason: "saving failed; see the line above, with its Retry" });
    if (!restSaved) refusals.push({ key: "", reason: `saving ${nRest} value${nRest === 1 ? "" : "s"} failed; see the line above, with its Retry` });
    setImportReport({ accepted: importSaved, refusals });
  };

  // ------------------------------------------------------- repair notice

  /** What the host's last repair of settings.json did, if it ever did one
   *  (shown in the Developer group, where the file's health belongs). */
  const [repairNotice, setRepairNotice] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void api().settingsRepairNotice().then((n) => setRepairNotice(n && typeof n === "object" ? (n as Record<string, unknown>) : null)).catch(() => undefined);
  }, []);

  // ------------------------------------------------------- GenieX management (Developer)

  /** `geniex config list` output, fetched on demand (never polled: the CLI is a process spawn). */
  const [geniexConfig, setGeniexConfig] = useState<{ state: "idle" | "loading" | "ready" | "error"; text: string }>({ state: "idle", text: "" });
  /** The set-type control: which installed model and what came of the change. */
  const [typeModel, setTypeModel] = useState("");
  const [typeBusy, setTypeBusy] = useState(false);
  const [typeNote, setTypeNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  /** `geniex clean` removes EVERY cached model (including anything installed outside
   *  MKMN), so it confirms twice: the first press arms, the second within a few
   *  seconds executes, and arming expires on its own so a stray click stays harmless. */
  const [cleanArmed, setCleanArmed] = useState(false);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanNote, setCleanNote] = useState<string | null>(null);
  const cleanTimer = useRef<number | null>(null);
  useEffect(() => () => { if (cleanTimer.current !== null) window.clearTimeout(cleanTimer.current); }, []);
  const armClean = useCallback(() => {
    setCleanArmed(true);
    setCleanNote(null);
    if (cleanTimer.current !== null) window.clearTimeout(cleanTimer.current);
    cleanTimer.current = window.setTimeout(() => setCleanArmed(false), 5000);
  }, []);
  const runClean = useCallback(() => {
    if (cleanTimer.current !== null) window.clearTimeout(cleanTimer.current);
    setCleanArmed(false);
    setCleanBusy(true);
    setCleanNote(null);
    void api().geniexClean()
      .then((r) => setCleanNote(r.message || (r.ok ? "Done." : "geniex clean refused the request.")))
      .catch((e) => setCleanNote(String((e as Error)?.message ?? e)))
      .finally(() => setCleanBusy(false));
  }, []);

  /** A search result opens the destination tab, then scrolls to and focuses the section.
      A section inside a collapsed <details> (or holding one) is opened first: scrolling
      to invisible content would land nowhere visible. */
  const goto = useCallback((e: { tab?: SettingsTab; section?: string; dest?: string }) => {
    if (e.dest === "customize") { onOpenCustomize?.(); setQuery(""); return; }
    if (e.tab) selectTab(e.tab);
    setQuery("");
    if (!e.section) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(e.section!);
        if (!el) return;
        // open every disclosure on the path to the section, then the ones inside it
        let p: HTMLElement | null = el;
        while (p) {
          if (p instanceof HTMLDetailsElement) p.open = true;
          p = p.parentElement;
        }
        el.querySelectorAll("details").forEach((d) => { (d as HTMLDetailsElement).open = true; });
        el.scrollIntoView({ block: "start" });
        el.focus({ preventScroll: true });
      });
    });
  }, [selectTab, onOpenCustomize]);

  // The test runs on the DRAFT (what the fields hold right now), not the saved
  // settings: no race with the blur-save, and the answer is bound to exactly this
  // provider + credential + address by the tester's fingerprint.

  const commitBudget = () => {
    const problem = budgetProblem(budget, hw);
    setBudgetErr(problem);
    if (problem) return;
    void save({ npuBudgetOverrideGB: budget.trim() ? parseFloat(budget) : null });
  };
  const useDetectedMemory = () => { setBudget(""); setBudgetErr(null); void save({ npuBudgetOverrideGB: null }); };

  const commitSid = () => {
    const n = parseInt(sidDraft, 10);
    const problem = Number.isNaN(n) ? "Enter a speaker number." : speakerProblem(n, ttsModel);
    setSidErr(problem);
    if (problem || n === v.ttsSid) return;
    void saveV({ ttsSid: n });
  };

  const runBenchmark = async () => {
    if (benchRunning || !benchModel) return;
    // validate again against the model's engine at run time: the state can hold a
    // choice made for a different model (the select is normalized, but never trusted)
    const target = normalizeBenchTarget(benchCompute, benchEngine);
    if (target !== benchCompute) setBenchCompute(target);
    setBenchRunning(true);
    setBenchMsg(null);
    try {
      const res = await api().runBenchmark(benchModel, target, benchPowerMode);
      setBenchResult(res);
      setBenchMsg(`✓ Benchmark complete: ${res.decodeTokPerSec} tok/s decode, ${res.ttftMs === null ? "TTFT not measured" : `${res.ttftMs}ms TTFT`} (${res.verifiedNpu ? "Hexagon HTP verified" : "NPU execution not verified by counters or log"})`);
      // the successful run just wrote new measurements into hardware.json: the model
      // list re-reads them, so its local-measurement chips show this result too
      onBenchSaved?.();
    } catch (err: any) {
      // a failed (or cancelled) run persisted nothing — the existing measurements stand
      setBenchMsg(`Benchmark failed: ${err.message || String(err)}`);
    } finally {
      setBenchRunning(false);
    }
  };

  const copyEndpoint = async () => {
    setCopyErr(false);
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // a blocked clipboard must not look like a successful copy
      setCopyErr(true);
    }
  };

  const mem = memoryEstimateView(gate.est);
  const memHasNumbers = gate.phase === "ready" || gate.phase === "refreshing" || gate.phase === "stale";
  const requested = server?.compute ?? settings.compute;
  const exec = executionStatus(server, requested);
  const observed = observedExecutionTarget(server);
  const rt = retentionFromIdle(settings.idleReleaseSec, settings.keepaliveSec);
  const ttsModel = models.find((m) => m.model.id === v.ttsModelId)?.model ?? null;
  const sttModel = models.find((m) => m.model.id === v.sttModelId)?.model ?? null;
  const endpoint = server?.endpoint ?? "http://127.0.0.1:18181/v1";
  const inAuto = settings.computeMode === "auto";

  /** One shared save indicator for every control on every page, at the head's side. */
  const saveLine = (
          <div className="save-line" role="status" aria-live="polite">
            {fb.failures.length > 0 || fb.transient ? (
              <>
                {/* Every unresolved failed save has its own line with its own Retry and
                    Dismiss — a later failure or success of a DIFFERENT setting never
                    erases it. The busy/confirmation line renders beside them, so both
                    states are honest at once. */}
                {fb.failures.map((f) => (
                  <span key={f.id}>
                    <span className="warn">⚠ {f.text}</span>
                    <button type="button" className="ghost" onClick={f.retry}>Retry</button>
                    <button type="button" className="ghost" onClick={() => dismissFailure(f.id)}>Dismiss</button>
                  </span>
                ))}
                {fb.transient && (
                  <span className={fb.transient.tone === "ok" ? "ok" : "muted"}>
                    {fb.transient.tone === "ok" ? "✓ " : ""}{fb.transient.text}
                  </span>
                )}
              </>
            ) : <span className="muted small">Changes save automatically.</span>}
          </div>
  );

  /** The group drawn below the head: none while the Only-changed list is shown. */
  const view: SettingsTab | null = onlyChanged ? null : tab;
  const hits = searchSettings(query).filter((h) => !h.section || !DEV_SECTIONS.has(h.section) || developer);

  return (
    <div className="page set-page">
      <div className="set-layout">
        <aside className="set-side">
          <h1 className="set-title">Settings</h1>
          <div className="set-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              onKeyDown={(e) => {
                // Escape clears a filled search (the dialog closes on the next one);
                // Enter opens the first result; Down moves into the results.
                if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); }
                else if (e.key === "Enter" && hits.length > 0) { e.preventDefault(); goto(hits[0]); }
                else if (e.key === "ArrowDown" && hits.length > 0) { e.preventDefault(); document.querySelector<HTMLButtonElement>(".set-search-hits button")?.focus(); }
              }}
            />
            {/* The result count is announced as it changes (aria-live); an empty result is a
                stated outcome with a way forward, never a silent nothing. */}
            {query.trim() !== "" && (
              <div className="set-search-pop">
                <p className="muted small" role="status" aria-live="polite">
                  {hits.length === 0
                    ? <>No settings found for “{query.trim()}”. Try a shorter word — for example “theme” or “microphone”.</>
                    : `${hits.length} setting${hits.length === 1 ? "" : "s"} found`}
                </p>
                {hits.length > 0 && (
                  <ul className="set-search-hits" aria-label={`Search results (${hits.length})`}>
                    {hits.map((h) => (
                      <li key={`${h.tab}-${h.section ?? ""}-${h.label}`}>
                        <button type="button" onClick={() => goto(h)}>
                          {h.label}
                          <span className="muted small">{h.tabLabel}{h.scope === "conversation" ? " · also in the This chat menu" : ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <nav className="set-nav" aria-label="Settings categories" onKeyDown={(e) => {
            // Up and Down move between the groups and open them; Home and End jump to the ends
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".set-nav-item")];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (at < 0) return;
            e.preventDefault();
            const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next].focus();
            items[next].click();
          }}>
            {SETTINGS_SECTIONS.map(({ label, tabs }) => (
              <div className="set-nav-group" key={label} role="group" aria-label={label}>
                {label !== "About" && <span className="set-nav-heading" aria-hidden="true">{label}</span>}
                {tabs.map((id) => (
                  <NavButton key={id} c={{ id, label: tabLabel(id), hint: PRIMARY_TABS.find((t) => t.id === id)?.hint ?? "" }}
                    active={!onlyChanged && tab === id} onSelect={selectTab} changedCount={(changedByGroup.get(id) ?? []).length} />
                ))}
              </div>
            ))}
          </nav>
          {/* Narrow windows: the strip becomes a compact, keyboard-accessible select. */}
          <select
            className="set-nav-select"
            aria-label="Settings category"
            value={tab}
            onChange={(e) => selectTab(e.target.value as SettingsTab)}
          >
            {SETTINGS_SECTIONS.map(({ label, tabs }) => (
              <optgroup key={label} label={label}>
                {tabs.map((id) => {
                  const count = (changedByGroup.get(id) ?? []).length;
                  return <option key={id} value={id}>{tabLabel(id)}{count > 0 ? ` (${count} changed)` : ""}</option>;
                })}
              </optgroup>
            ))}
          </select>
          {/* The page's tools: what changed, and the person's values in or out. */}
          <div className={`set-tools ${tab === "library" ? "on-library" : ""}`} role="group" aria-label="Your settings">
            <label className="switch-row small">
              <input type="checkbox" role="switch" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
              <span>Only changed ({resettable.length})</span>
            </label>
            <div className="muted small">Leaves out the search key and this PC's own paths.</div>
            <div className="set-tools-buttons">
              <button type="button" className="ghost small-btn" onClick={() => void doExport()} disabled={changed.size === 0} title="Save the settings you changed to a file. Leaves out the search key and this PC's own paths.">Export changed…</button>
              <button type="button" className="ghost small-btn" onClick={() => void doImport()} title="Read settings from a file; each value is checked first">Import…</button>
            </div>
          </div>
        </aside>
        <div className="set-body" ref={bodyRef}>
          {/* The group's own head: its name, what it holds, and a Reset for what was
              changed in it (the schema defaults, never a hand-copied set). */}
          {!onlyChanged && (
            <header className="set-head">
              <div className="set-head-text">
                <h2 className="set-head-title">{tabLabel(tab)}</h2>
                <p className="muted small">{PRIMARY_TABS.find((t) => t.id === tab)?.hint}</p>
              </div>
              <div className="set-head-side">
                {saveLine}
                {(changedByGroup.get(tab) ?? []).length > 0 && (
                  <button type="button" className="ghost small-btn" onClick={resetGroup}>
                    Reset this group ({(changedByGroup.get(tab) ?? []).length})
                  </button>
                )}
              </div>
            </header>
          )}
          {onlyChanged && (
            <header className="set-head">
              <div className="set-head-text">
                <h2 className="set-head-title">Changed settings</h2>
                <p className="muted small">Everything that differs from its default, with a Reset for each.</p>
              </div>
              <div className="set-head-side">
                {saveLine}
                <button type="button" className="ghost small-btn" onClick={() => setOnlyChanged(false)}>Show all settings</button>
              </div>
            </header>
          )}
          {resetAsk && (
            <div className="set-confirm" role="alertdialog" aria-label="Reset this group">
              <span>Reset {resetAsk.length} setting{resetAsk.length === 1 ? "" : "s"} in {tabLabel(tab)} to {resetAsk.length === 1 ? "its default" : "their defaults"}: {resetAsk.map((k) => settingDecl(k)?.label ?? k).join(", ")}.</span>
              <span className="set-confirm-actions">
                <button type="button" className="primary small-btn" onClick={() => resetWithUndo(resetAsk)}>Reset {resetAsk.length === 1 ? "it" : `all ${resetAsk.length}`}</button>
                <button type="button" className="ghost small-btn" onClick={() => setResetAsk(null)}>Cancel</button>
              </span>
            </div>
          )}
          {undo && !resetAsk && (
            <div className="set-confirm done" role="status">
              <span>{undo.n} setting{undo.n === 1 ? "" : "s"} back to {undo.n === 1 ? "its default" : "their defaults"}.</span>
              <span className="set-confirm-actions">
                <button type="button" className="ghost small-btn" onClick={() => { applyLeaf(undo.values); setUndo(null); }}>Undo</button>
                <button type="button" className="ghost small-btn" aria-label="Dismiss" onClick={() => setUndo(null)}>×</button>
              </span>
            </div>
          )}
          {/* While the Only-changed list is shown, the group pages give it the room. */}
          {exportNote && <div className="muted small" role="status">{exportNote}</div>}
          {importReport && (
            <div className="import-report" role="status">
              {importReport.accepted > 0 && <div className="ok small">✓ Imported {importReport.accepted} value{importReport.accepted === 1 ? "" : "s"}.</div>}
              {importReport.refusals.length > 0 && (
                <div className="warn small" role="alert">
                  Refused {importReport.refusals.length} value{importReport.refusals.length === 1 ? "" : "s"}:
                  <ul>
                    {importReport.refusals.map((r, i) => <li key={i}>{r.key ? <code>{r.key}</code> : "The file"}: {r.reason}</li>)}
                  </ul>
                </div>
              )}
              {importReport.accepted === 0 && importReport.refusals.length === 0 && <div className="muted small">The file holds no settings.</div>}
            </div>
          )}

          {/* The Only-changed view: every key whose stored value differs from the
              schema default, with a Reset per row — the shortest path to "what
              have I touched", and a reset for each of them. */}
          {onlyChanged && (resettable.length === 0 ? (
            <p className="muted small" role="status">Every setting is at its default.</p>
          ) : (
            <section aria-label="Changed settings" className="set-changed-list">
              {/* in the page's group order, so the list reads like the navigation */}
              {resettable
                .map((k) => ({ k, decl: settingDecl(k) }))
                .filter((x): x is { k: string; decl: NonNullable<ReturnType<typeof settingDecl>> } => !!x.decl)
                .sort((a, b) => SETTING_GROUPS.findIndex((g) => g.id === a.decl.group) - SETTING_GROUPS.findIndex((g) => g.id === b.decl.group))
                .map(({ k, decl }) => {
                const group = SETTING_GROUPS.find((g) => g.id === decl.group);
                const now = readSetting(settings, k);
                return (
                  <div className="changed-row" key={k}>
                    <div className="changed-main">
                      <div><strong>{decl.label}</strong> <span className="chip-quiet">{group?.label}</span></div>
                      <div className="muted small">{decl.description}</div>
                      <div className="changed-values small">
                        <span>Now <b>{decl.secret ? "set (hidden)" : plainValue(now, decl.type)}</b></span>
                        <span className="muted">Default {plainValue(decl.default, decl.type)}</span>
                      </div>
                    </div>
                    <div className="changed-actions">
                      {decl.legacy?.section && (
                        <button type="button" className="ghost small-btn" onClick={() => goto({ tab: decl.group, section: decl.legacy!.section })}>Open</button>
                      )}
                      <button type="button" className="ghost small-btn" onClick={() => resetWithUndo([k])} title={`Back to ${plainValue(decl.default, decl.type)}`}>Reset</button>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}

 {/* ============================== General ============================== */}
 {view === "general" && <>
      <section id="sec-general-appearance" tabIndex={-1}>
        <h2>Appearance <Dot c={changed} k="appearance" /></h2>
        <p className="muted small">Choose a theme for this window. System follows your Windows appearance setting.</p>
        <div className="appearance-options" role="radiogroup" aria-label="Appearance">
          {([["system", "System", "Follow Windows"], ["light", "Light", "Bright, neutral surfaces"], ["dark", "Dark", "Low-light workspace"]] as const).map(([mode, label, detail]) => (
            <label className={`appearance-option ${((settings as Settings & { appearance?: AppearanceMode }).appearance ?? "system") === mode ? "selected" : ""}`} key={mode}>
              <input type="radio" name="appearance" value={mode} checked={((settings as Settings & { appearance?: AppearanceMode }).appearance ?? "system") === mode}
                onChange={() => { applyAppearance(mode); void save({ appearance: mode } as Partial<Settings>); }} />
              <span className={`appearance-preview ${mode}`} aria-hidden="true"><i /><i /><i /></span>
              <span><strong>{label}</strong><span className="muted small">{detail}</span></span>
            </label>
          ))}
        </div>
      </section>
      <section id="sec-general-close" tabIndex={-1}>
        <h2>When I close the window <Dot c={changed} k="closeAction" /></h2>
        {/* The ONE unified close setting ("closeAction"): the default is a full exit —
            the app and every process it owns stop. Keeping the app running in the
            notification area is an explicit choice made here. */}
        <label className="check"><input type="radio" name="closeAction" checked={settings.closeAction !== "tray"} onChange={() => void save({ closeAction: "quit" })} /> Close the app completely (default — everything MKMN runs is stopped)</label>
        <label className="check"><input type="radio" name="closeAction" checked={settings.closeAction === "tray"} onChange={() => void save({ closeAction: "tray" })} /> Keep MKMN running in the notification area (it keeps using memory; quit from the tray icon)</label>
        <label className="check"><input type="checkbox" checked={!settings.closeNoticeOff} onChange={(e) => void save({ closeNoticeOff: !e.target.checked })} /> Tell me the first time the window is closed <Dot c={changed} k="closeNoticeOff" /></label>
      </section>

 </>}
 {view === "about" && (
      <section id="sec-about-mkmn" tabIndex={-1} aria-labelledby="about-heading">
        <h2 id="about-heading">About MKMN AI</h2>
        <div className="about-lockup"><LogoLockup className="about-logo" /></div>
        <p className="muted small brand-tagline">{BRAND.fullName} · {BRAND.tagline}</p>
        <p className="small brand-supporting">{BRAND.supporting}</p>
        <p>{BRAND.descriptor} {BRAND.aboutStory}</p>
        {/* One product/privacy paragraph; the itemized detail lives in HUMAIN. */}
        <p className="muted small">
          {BRAND.productExplainer} {BRAND.connectedNote} See{" "}
          <button type="button" className="linklike" onClick={() => goto({ tab: "web", section: "sec-humain-routing" })}>
            Cloud Intelligence
          </button>{" "}
          for exactly what each feature sends.
        </p>
        <p className="muted small">{BRAND.independence}</p>
        <p className="muted small">{BRAND.attribution}</p>
        <section id="sec-about-update" tabIndex={-1} aria-labelledby="about-update-heading">
          <h3 id="about-update-heading">Version &amp; updates</h3>
          <div className="update-note">
            <strong>Installed build</strong><span>v{info.version} ({info.arch})</span>
            <p className="muted small">
              MKMN does not check for updates by itself. To update, get a verified MKMN release from a source you trust and run its Windows installer
              (MKMN-&lt;version&gt;-arm64-Setup.exe); your chats and local model files stay on this device.
            </p>
          </div>
        </section>
        <section id="sec-about-help" tabIndex={-1} aria-labelledby="about-help-heading">
          <h3 id="about-help-heading">Help and bug reports</h3>
          <CopySupport />
          <div className="muted small">For help, include the copied diagnostics and describe what happened. Remove any confidential information before sharing.</div>
        </section>
      </section>
 )}

 {/* ============================== Models (the library) ============================== */}
 {view === "library" && <>
      {readSetting(settings, "humainMode") !== "local" && (
        <section aria-label="Chat location">
          <p className="small">Chat is using a cloud provider. To chat with a model on this PC, change <button type="button" className="linklike" onClick={() => goto({ tab: "chats", section: "sec-chats-location" })}>Chat location</button>.</p>
        </section>
      )}
      <div id="sec-library" tabIndex={-1} className="set-library">
        {renderModels?.()}
      </div>
      <section id="sec-library-options" tabIndex={-1}>
        <h2>Library options</h2>
        <p className="muted small">What the list shows, and the one way a model may leave the NPU.</p>
        <label className="check">
          <input type="checkbox" checked={readBool(settings, "showKQuants")} onChange={(e) => void save({ showKQuants: e.target.checked })} />
          <span> Show K-quants and IQ quants in the list (they may use the CPU) <Dot c={changed} k="showKQuants" /></span>
        </label>
        <label className="check" title={settingDecl("allowHybridLoad")?.tooltip}>
          <input type="checkbox" checked={readBool(settings, "allowHybridLoad")} onChange={(e) => void save({ allowHybridLoad: e.target.checked } as Partial<Settings>)} />
          <span> Allow part-CPU loading as a last resort: a model the NPU refuses may run partly on the CPU, and its badge says so <Dot c={changed} k="allowHybridLoad" /></span>
        </label>
        <p className="muted small">Takes effect the next time a model loads.</p>
      </section>
 </>}

 {/* ============================== Speed & memory ============================== */}
 {view === "models" && <>
      {selectedMissing && (
        <div className="warn small" role="status" style={{ marginBottom: 10 }}>
          The selected model ({settings.selectedModelId}) is no longer installed. Install it again or choose another in the{" "}
          <button type="button" className="link" onClick={() => selectTab("library")}>Models library</button>.
        </div>
      )}
      {/* The group leads with ONE compact strip of the four facts that decide every
          control below it; the technical options stay in their own sections. */}
      <section id="sec-models-summary" tabIndex={-1} aria-label="Current performance setup" className="perf-strip">
        <div className="perf-tile">
          <span className="muted small">Selected model</span>
          <strong>{selectedEntry?.name ?? (selectedMissing ? "none (removed)" : settings.selectedModelId ?? "none")}</strong>
          <span className="small"><button type="button" className="link" onClick={() => selectTab("library")}>Models library</button></span>
        </div>
        <div className="perf-tile">
          <span className="muted small">Execution mode</span>
          <strong>{inAuto ? `Automatic — currently ${COMPUTE_LABEL[settings.compute]}` : COMPUTE_LABEL[settings.compute]}</strong>
        </div>
        <div className="perf-tile">
          <span className="muted small">Model retention</span>
          <strong>{rt.idleReleaseSec === 0 ? "Kept loaded when idle" : `Released after ${Math.round(rt.idleReleaseSec / 60)} min idle`}</strong>
        </div>
        <div className="perf-tile">
          <span className="muted small">Memory fit</span>
          <strong>{gate.phase === "loading" || gate.phase === "stale" || gate.phase === "refreshing" ? "Measuring…"
            : gate.phase === "failed" ? "Could not measure — retry in Memory use"
            : gate.phase === "unavailable" ? "No estimate available"
            : mem.phase === "fits" ? "Fits the safe limit" : "Above the safe limit"}</strong>
        </div>
      </section>
      <section id="sec-models-compute" tabIndex={-1}>
        <RuntimePanel settings={settings} onSave={async (p) => { await save(p); }} changed={changed} />
      </section>

      <section id="sec-models-retention" tabIndex={-1}>
        <h2>Model retention</h2>
        <p className="muted small">How long the model stays loaded when you are not talking to it. <Dot c={changed} k="idleReleaseSec" /><Dot c={changed} k="startupTimeoutSec" /></p>
        <div className="row">
          <label className="small">
            <span>Release model when idle</span>
            <select
              value={rt.idleReleaseSec}
              onChange={(e) => void save(retentionPatch(Number(e.target.value)))}
            >
              <option value={0}>Never — keep it loaded</option>
              <option value={60}>After 1 minute idle</option>
              <option value={300}>After 5 minutes idle</option>
              <option value={900}>After 15 minutes idle</option>
            </select>
          </label>
          <label className="small">
            <span>Startup check timeout</span>
            <select
              value={readNum(settings, "startupTimeoutSec")}
              onChange={(e) => void save({ startupTimeoutSec: parseInt(e.target.value, 10) })}
            >
              <option value={30}>30 seconds</option>
              <option value={60}>60 seconds</option>
              <option value={90}>90 seconds</option>
              <option value={120}>120 seconds</option>
              <option value={180}>180 seconds</option>
              <option value={300}>300 seconds</option>
            </select>
          </label>
          <button type="button" className="ghost" onClick={() => void save(retentionPatch(300))}>Reset</button>
        </div>
        <label className="switch-row small">
          <input
            type="checkbox"
            role="switch"
            checked={readBool(settings, "warmUpWhileTyping")}
            onChange={(e) => void save({ warmUpWhileTyping: e.target.checked })}
          />
          <span>Warm up model while typing <Dot c={changed} k="warmUpWhileTyping" /></span>
        </label>
        <p className="muted small">
          Starts loading the chat's local model as soon as you type the first character, so less time passes after Send. The model may use memory and power before you send anything, also for a draft you never send. Off by default.
        </p>
        <p className="muted small">
          {rt.idleReleaseSec === 0
            ? "The selected model stays in memory, so every message starts instantly, at the cost of the memory it holds."
            : `The model is released after ${Math.round(rt.idleReleaseSec / 60)} minute${rt.idleReleaseSec === 60 ? "" : "s"} idle to free memory. The first message after a release reloads it (about 10-25 s on the NPU).`}
        </p>
      </section>

      <section id="sec-models-memory" tabIndex={-1}>
        <h2>Memory use <Dot c={changed} k="npuBudgetOverrideGB" /></h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <p className="muted small" style={{ margin: 0 }}>What the selected model is expected to occupy before it loads.</p>
          <span className={`tag ${(gate.phase === "failed" || mem.phase === "over") && gate.phase !== "stale" && gate.phase !== "refreshing" ? "status-warn" : mem.phase === "fits" && (gate.phase === "ready" || gate.phase === "refreshing" || gate.phase === "stale") ? "status-ok" : ""}`}>
            {gate.phase === "loading" ? "Measuring…"
              : gate.phase === "refreshing" ? "Refreshing…"
              : gate.phase === "stale" ? "Configuration changed — measuring…"
              : gate.phase === "failed" ? "Couldn't measure"
              : gate.phase === "unavailable" ? "No estimate available"
              : mem.phase === "fits" ? "✓ Fits the safe limit"
              : "⚠ Above the safe limit"}
          </span>
        </div>

        {gate.phase === "stale" && (
          <p className="muted small" role="status">
            These numbers are for {gate.label} — the previous configuration. They are not the answer for the current one, which is being measured now.
          </p>
        )}
        {gate.phase === "failed" && (
          <p className="warn small" role="status">
            The memory request failed, so there is nothing to show.{" "}
            <button type="button" className="ghost" onClick={() => estimateGate.retry()}>Retry</button>
          </p>
        )}
        {gate.phase === "unavailable" && <p className="muted small" role="status">This machine did not return usable memory readings, so no estimate is shown.</p>}

        {memHasNumbers ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 8 }}>
            <div className="stat"><div className="muted small">Model weights</div><div style={{ fontSize: 16, fontWeight: 700 }}>{mem.weightsGB} GB</div></div>
            <div className="stat"><div className="muted small">Conversation cache ({readSetting(settings, "kvType")})</div><div style={{ fontSize: 16, fontWeight: 700 }}>{mem.kvCacheGB} GB</div></div>
            <div className="stat"><div className="muted small">Runtime scratchpad</div><div style={{ fontSize: 16, fontWeight: 700 }}>{mem.scratchpadGB} GB</div></div>
            <div className="stat"><div className="muted small">Total required</div><div style={{ fontSize: 16, fontWeight: 700 }}>{mem.totalRequiredGB} GB</div></div>
          </div>
        ) : null}
        {gate.phase === "loading" && <p className="muted small" role="status">Measuring the memory the model needs…</p>}

        {mem.availableRamGB !== null ? (
          <div style={{ background: "var(--code-bg)", borderRadius: 6, padding: "8px 12px", marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
              <span className="muted">Available RAM (measured, refreshed about every 30 s):</span>
              <strong>{mem.availableRamGB} GB available / {mem.totalRamGB ?? "unknown"} total</strong>
            </div>
            {mem.barPercent !== null && (
              <div className="track" role="progressbar" aria-label="Required memory against available RAM" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(mem.barPercent)} style={{ height: 6 }}>
                <div className={`fill ${mem.phase === "over" ? "warn" : ""}`} style={{ width: `${mem.barPercent}%` }} />
              </div>
            )}
          </div>
        ) : (
          <p className="muted small" style={{ marginTop: 8 }}>Available RAM is not reported by this machine right now.</p>
        )}
        {mem.note && <p className="muted small" style={{ marginTop: 4 }}>{mem.note}</p>}

        <div className="row" style={{ marginTop: 10 }}>
          <label className="small">
            <span>NPU shared memory (GB) — from Task Manager → Performance → NPU → Shared memory</span>
            <input
              type="number" min="1" step="0.1" value={budget} placeholder={String(hw.npuBudgetGB)}
              aria-label="NPU shared memory override in GB"
              aria-invalid={!!budgetErr}
              aria-describedby={budgetErr ? "npu-budget-error" : undefined}
              onChange={(e) => setBudget(e.target.value)}
              onBlur={commitBudget}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitBudget(); } }}
            />
          </label>
          <button type="button" className="ghost" onClick={commitBudget} title="Also applied when you leave the field or press Enter">Apply</button>
          <button type="button" className="ghost" onClick={useDetectedMemory}>Use detected memory</button>
          <button type="button" className="ghost" onClick={() => void onRedetect()}>Re-detect hardware</button>
        </div>
        {budgetErr && <div className="warn small" id="npu-budget-error" role="alert">{budgetErr}</div>}
        <div className="muted small">
          Fit checks size everything from {settings.npuBudgetOverrideGB ? `your number (${settings.npuBudgetOverrideGB} GB, set by you)` : `the detected value (${hw.npuBudgetGB} GB, ${hw.npuBudgetSource === "estimated" ? "estimated: about half of RAM" : "measured"})`}. If the estimate is wrong, enter the real one.
        </div>
      </section>

      {plan && (settings.compute === "npu" || settings.compute === "hybrid") && (
        <section id="sec-models-plan" tabIndex={-1}>
          <h2>NPU memory plan</h2>
          <PlanBar plan={plan} />
        </section>
      )}

      <section id="sec-models-context" tabIndex={-1}>
        <h2>Conversation length &amp; cache <Dot c={changed} k="nctxMode" /><Dot c={changed} k="kvType" /><Dot c={changed} k="kvInRam" /></h2>
        <p className="muted small">How many tokens one conversation can hold, and how precisely the cache is kept.</p>
        <div className="row">
          <label className="small">
            <span>Context window</span>
            <select
              value={readSetting(settings, "nctxMode")}
              disabled={selectedIsCompiled}
              onChange={(e) => void save({ nctxMode: e.target.value as Settings["nctxMode"] })}
            >
              <option value="auto">Auto (memory-managed)</option>
              <option value="2048">2048 tokens (low memory)</option>
              <option value="4096">4096 tokens (standard)</option>
              <option value="8192">8192 tokens (extended)</option>
            </select>
          </label>
          <button type="button" className="ghost" disabled={selectedIsCompiled} onClick={() => void save({ nctxMode: "auto", kvType: "f16", kvInRam: false })}>Reset</button>
        </div>
        {selectedIsCompiled && (
          <div className="muted small" role="note">
            The selected model is a compiled bundle: its context and cache are baked into the model itself, so these settings do not apply to it.
            The choices are kept for when you pick a model they do apply to.
          </div>
        )}
        <details style={{ marginTop: 6 }}>
          <summary className="small"><strong>Advanced: cache storage and precision</strong> <span className="muted">· how much memory the cache takes</span></summary>
          <div className="row">
            <label className="small">
              <span>Cache precision</span>
              <select
                value={readSetting(settings, "kvType")}
                disabled={selectedIsCompiled}
                onChange={(e) => void save({ kvType: e.target.value as Settings["kvType"] })}
              >
                <option value="f16">F16 (high fidelity — default)</option>
                <option value="q8_0">Q8_0 (balanced — half the cache memory)</option>
                <option value="q4_0">Q4_0 (smallest — a quarter)</option>
              </select>
            </label>
            <label className="check small">
              <input type="checkbox" disabled={selectedIsCompiled} checked={readBool(settings, "kvInRam")} onChange={(e) => void save({ kvInRam: e.target.checked })} />
              <span>Keep the conversation cache in RAM when the NPU runs short</span>
            </label>
          </div>
          {!selectedIsCompiled && <div className="muted small">A smaller precision halves (or quarters) the cache memory; F16 keeps the most fidelity. One setting for every runtime.</div>}
        </details>
        {server && (server.state === "ready" || server.state === "busy") ? (
          <div className="muted small" role="status">
            Effective now: context {server.contextKind === "compiled" ? "compiled into the model" : server.servedNctx ? `${server.servedNctx} tokens` : "model default"}
            {server.servedKvType ? ` · cache ${server.servedKvType}` : ""}{typeof server.servedKvInRam === "boolean" ? ` · cache in RAM: ${server.servedKvInRam ? "yes" : "no"}` : ""}.
          </div>
        ) : (
          <div className="muted small">Takes effect the next time a model loads.</div>
        )}
      </section>

      <section id="sec-models-power" tabIndex={-1}>
        <h2>Power mode <Dot c={changed} k="powerProfile" /></h2>
        <div className="row">
          <label className="small" style={{ maxWidth: 420 }}>
            <span className="sr-only">Power mode</span>
            <select
              value={readSetting(settings, "powerProfile")}
              onChange={(e) => void save({ powerProfile: e.target.value as Settings["powerProfile"] })}
            >
              <option value="auto">Auto (burst on AC, saver on battery)</option>
              <option value="burst">Burst (maximum performance)</option>
              <option value="high_performance">High performance</option>
              <option value="sustained_high_performance">Sustained high performance</option>
              <option value="balanced">Balanced</option>
              <option value="low_balanced">Low balanced</option>
              <option value="power_saver">Power saver (less heat, saves battery)</option>
              <option value="high_power_saver">High power saver</option>
              <option value="low_power_saver">Low power saver (quietest, slowest)</option>
            </select>
          </label>
          <button type="button" className="ghost" onClick={() => void save({ powerProfile: "auto" })}>Reset</button>
        </div>
        <p className="muted small">
          {powerInfo === null ? "Checking the power supply…" :
            (readSetting(settings, "powerProfile")) === "auto"
              ? (powerInfo?.onAcPower ? "On AC power: burst performance is available." : "On battery: power saving is active.")
              : (readSetting(settings, "powerProfile") === "burst" ? "Pins the NPU clocks to maximum frequency for the lowest latency." : "The runtime runs the NPU clocks in the mode chosen above (all eight are the runtime's own modes).")}
        </p>
      </section>

      {/* The group's folded Advanced: the sections that hold only advanced keys. */}
      <details className="set-adv">
        <summary className="small"><strong>Advanced</strong> <span className="muted">· experimental speed-ups</span></summary>
      <section id="sec-models-speculative" tabIndex={-1}>
        <h2>Speculative decoding <Dot c={changed} k="speculativeDecoding.enabled" /></h2>
        <details>
          <summary className="small"><strong>Technical: draft tokens on the CPU</strong> <span className="muted">· experimental speed-up, off by default</span></summary>
          <p className="muted small">
            Drafts tokens on the CPU and verifies them on the NPU. <strong>Off by default, and deliberately so:</strong> it stays off until the installed
            runtime is confirmed to support it, the memory cost of the draft buffers is known, and a measured speedup exists. The app never sends the
            flag before the capability probe confirms it. The strategies (llama.cpp models only): the <code>ngram-*</code> ones guess the draft from the
            text already written; the <code>draft-*</code> ones ask a second small model (or an MTP/EAGLE head) to draft.
          </p>
          <label className="check small">
            <input
              type="checkbox"
              checked={readBool(settings, "speculativeDecoding.enabled")}
              onChange={(e) => void save({
                speculativeDecoding: e.target.checked ? {
                  enabled: true,
                  specType: readSetting(settings, "speculativeDecoding.specType"),
                  draftTokens: readNum(settings, "speculativeDecoding.draftTokens"),
                  draftModel: readSetting(settings, "speculativeDecoding.draftModel"),
                  draftMin: readNum(settings, "speculativeDecoding.draftMin"),
                  draftPMin: readNum(settings, "speculativeDecoding.draftPMin"),
                } : { enabled: false },
              })}
            />
            <span>Enable speculative decoding (when this runtime and model support it)</span>
          </label>
          {readBool(settings, "speculativeDecoding.enabled") && (
            <div className="row" style={{ marginTop: 8 }}>
              <label className="small">
                <span>Draft strategy</span>
                <select
                  value={readSetting(settings, "speculativeDecoding.specType")}
                  onChange={(e) => void save({
                    speculativeDecoding: {
                      enabled: true,
                      specType: e.target.value,
                      draftTokens: readNum(settings, "speculativeDecoding.draftTokens"),
                      draftModel: readSetting(settings, "speculativeDecoding.draftModel"),
                      draftMin: readNum(settings, "speculativeDecoding.draftMin"),
                      draftPMin: readNum(settings, "speculativeDecoding.draftPMin"),
                    },
                  })}
                >
                  <option value="ngram-simple">ngram-simple (guess from the text)</option>
                  <option value="ngram-cache">ngram-cache</option>
                  <option value="ngram-mod">ngram-mod</option>
                  <option value="ngram-map-k">ngram-map-k</option>
                  <option value="ngram-map-k4v">ngram-map-k4v</option>
                  <option value="draft-simple">draft-simple (small draft model)</option>
                  <option value="draft-mtp">draft-mtp (MTP head)</option>
                  <option value="draft-eagle3">draft-eagle3 (EAGLE-3 head)</option>
                </select>
              </label>
              <label className="small" style={{ maxWidth: 110 }}>
                <span>Draft steps</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={readNum(settings, "speculativeDecoding.draftTokens")}
                  onChange={(e) => void save({
                    speculativeDecoding: {
                      enabled: true,
                      specType: readSetting(settings, "speculativeDecoding.specType"),
                      draftTokens: Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 4))),
                      draftModel: readSetting(settings, "speculativeDecoding.draftModel"),
                      draftMin: readNum(settings, "speculativeDecoding.draftMin"),
                      draftPMin: readNum(settings, "speculativeDecoding.draftPMin"),
                    },
                  })}
                />
              </label>
            </div>
          )}
          {readBool(settings, "speculativeDecoding.enabled") && /^draft-/.test(readSetting(settings, "speculativeDecoding.specType")) && (
            <div className="row" style={{ marginTop: 8 }}>
              <label className="small" style={{ maxWidth: 340 }}>
                <span>Draft model (cached name or local .gguf path)</span>
                <input
                  type="text"
                  value={readSetting(settings, "speculativeDecoding.draftModel")}
                  placeholder="unsloth/Qwen3-0.6B-GGUF:Q4_0"
                  onChange={(e) => void save({
                    speculativeDecoding: {
                      enabled: true,
                      specType: readSetting(settings, "speculativeDecoding.specType"),
                      draftTokens: readNum(settings, "speculativeDecoding.draftTokens"),
                      draftModel: e.target.value,
                      draftMin: readNum(settings, "speculativeDecoding.draftMin"),
                      draftPMin: readNum(settings, "speculativeDecoding.draftPMin"),
                    },
                  })}
                />
              </label>
              <label className="small" style={{ maxWidth: 120 }}>
                <span>Fewest steps (0 = default)</span>
                <input
                  type="number"
                  min={0}
                  max={16}
                  value={readNum(settings, "speculativeDecoding.draftMin")}
                  onChange={(e) => void save({
                    speculativeDecoding: {
                      enabled: true,
                      specType: readSetting(settings, "speculativeDecoding.specType"),
                      draftTokens: readNum(settings, "speculativeDecoding.draftTokens"),
                      draftModel: readSetting(settings, "speculativeDecoding.draftModel"),
                      draftMin: Math.max(0, Math.min(16, Math.round(Number(e.target.value) || 0))),
                      draftPMin: readNum(settings, "speculativeDecoding.draftPMin"),
                    },
                  })}
                />
              </label>
              <label className="small" style={{ maxWidth: 120 }}>
                <span>Draft confidence (0 = default)</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={readNum(settings, "speculativeDecoding.draftPMin")}
                  onChange={(e) => void save({
                    speculativeDecoding: {
                      enabled: true,
                      specType: readSetting(settings, "speculativeDecoding.specType"),
                      draftTokens: readNum(settings, "speculativeDecoding.draftTokens"),
                      draftModel: readSetting(settings, "speculativeDecoding.draftModel"),
                      draftMin: readNum(settings, "speculativeDecoding.draftMin"),
                      draftPMin: Math.max(0, Math.min(1, Number(e.target.value) || 0)),
                    },
                  })}
                />
              </label>
            </div>
          )}
        </details>
      </section>

      <section id="sec-models-offload" tabIndex={-1}>
        <h2>Model loading <Dot c={changed} k="geniexNgl" /><Dot c={changed} k="vitCompute" /></h2>
        <p className="muted small">The engine's own loading defaults, for the models that run through the local runtime.</p>
        <div className="row">
          <label className="small" style={{ maxWidth: 260 }}>
            <span>Offload layers (llama.cpp models)</span>
            <input
              type="number"
              min={-1}
              max={999}
              value={readNum(settings, "geniexNgl")}
              onChange={(e) => void save({ geniexNgl: Math.max(-1, Math.min(999, Math.round(Number(e.target.value) || (e.target.value === "-1" ? -1 : 0)))) })}
            />
          </label>
          <label className="small" style={{ maxWidth: 240 }}>
            <span>Vision encoder compute unit</span>
            <input
              type="text"
              value={readSetting(settings, "vitCompute")}
              placeholder="empty = runtime default"
              onChange={(e) => void save({ vitCompute: e.target.value })}
            />
          </label>
        </div>
        <p className="muted small">
          −1 = every layer on the accelerator, 0 = everything on the CPU, a number = that many layers. A precompiled NPU bundle always runs whole
          on the NPU. The vision encoder of a vision model (its image reader) can be placed on a second NPU session (for example <code>HTP1</code>) or
          on the CPU (<code>cpu</code>) when one session cannot hold the whole model.
        </p>
      </section>
      </details>
 </>}

 {/* ============================== Voice ============================== */}
 {view === "voice" && <>
      <section id="sec-voice-mic" tabIndex={-1}>
        <h2>Microphone <Dot c={changed} k="voice.micDeviceId" /></h2>
        <p className="muted small">Which microphone dictation and voice chat listen to, and a quick test.</p>
        <MicPicker value={v.micDeviceId} onSave={(id) => void saveV({ micDeviceId: id })} />
        <MicTest voice={v} />
      </section>

      <section id="sec-voice-dictation" tabIndex={-1}>
        <h2>Dictation <Dot c={changed} k="voice.sttModelId" /></h2>
        <p className="muted small">The model that turns your speech into text.</p>
        <VoiceModelList kind="stt" models={models} selected={v.sttModelId} progress={progress}
          onSelect={(id) => void saveV({ sttModelId: id })}
          onDownload={(id) => void api().voiceDownload(id)} onCancel={(id) => void api().voiceCancelDownload(id).catch((e) => window.alert((e as Error).message))}
          onRemove={async (id) => { await api().voiceRemove(id); await refreshModels(); await onSaveVoice({}); }} />
        <div className="row">
          <label className="small">Language <Dot c={changed} k="voice.sttLanguage" />
            <select value={v.sttLanguage} onChange={(e) => void saveV({ sttLanguage: e.target.value })}>
              {dictationLanguageOptions(sttModel, v.sttLanguage).map((o) => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
          </label>
          {sttModel && <span className="muted small" style={{ alignSelf: "end", paddingBottom: 6 }}>{sttModel.languages}</span>}
        </div>
        <label className="check small"><input type="checkbox" checked={v.liveText} onChange={(e) => void saveV({ liveText: e.target.checked })} /> Show the words as I speak, and correct them as the sentence goes on <Dot c={changed} k="voice.liveText" /></label>
        <div className="muted small">Removing a model takes it off this PC; dictation falls back to another installed model, or asks to install one.</div>
      </section>

      <section id="sec-voice-tts" tabIndex={-1}>
        <h2>Read-aloud <Dot c={changed} k="voice.ttsModelId" /></h2>
        <p className="muted small">The voice that reads answers and speaks in voice chat.</p>
        <VoiceModelList kind="tts" models={models} selected={v.ttsModelId} progress={progress}
          onSelect={(id) => void saveV({ ttsModelId: id, ttsSid: 0 })}
          onDownload={(id) => void api().voiceDownload(id)} onCancel={(id) => void api().voiceCancelDownload(id).catch((e) => window.alert((e as Error).message))}
          onRemove={async (id) => { await api().voiceRemove(id); await refreshModels(); await onSaveVoice({}); }} />
        <div className="row">
          <label className="small">Voice
            {ttsModel?.voices ? (
              <select value={v.ttsSid} onChange={(e) => { setSidErr(null); void saveV({ ttsSid: parseInt(e.target.value, 10) }); }}>
                {ttsModel.voices.map((x) => <option key={x.sid} value={x.sid}>{x.name}</option>)}
              </select>
            ) : (
              <span className="row" style={{ gap: 6, margin: 0 }}>
                <input
                  type="number" min={0} max={(ttsModel?.sidCount ?? 1) - 1} value={sidDraft}
                  aria-label="Speaker number" aria-invalid={!!sidErr} aria-describedby={sidErr ? "tts-sid-error" : undefined}
                  onChange={(e) => setSidDraft(e.target.value)} onBlur={commitSid}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitSid(); } }}
                />
                <button type="button" className="ghost" disabled={!ttsModel} onClick={async () => { try { await api().voiceApply(); await api().speak(`preview-${Date.now()}`, "Hello! This is how I sound."); } catch (e) { window.alert((e as Error).message); } }}>Preview</button>
              </span>
            )}
          </label>
          <label className="small">Speed {v.ttsSpeed.toFixed(1)}× <Dot c={changed} k="voice.ttsSpeed" />
            <Range value={v.ttsSpeed} min={0.7} max={1.5} step={0.1} ariaLabel="Read-aloud speed" onSave={(n) => void saveV({ ttsSpeed: n })} />
          </label>
          {ttsModel?.voices && <button type="button" className="ghost" disabled={!ttsModel} onClick={async () => { try { await api().voiceApply(); await api().speak(`preview-${Date.now()}`, "Hello! This is how I sound."); } catch (e) { window.alert((e as Error).message); } }}>Preview</button>}
        </div>
        {sidErr && <div className="warn small" id="tts-sid-error" role="alert">{sidErr}</div>}
        {ttsModel && !ttsModel.voices && <div className="muted small">Voices are numbered for this model; try a few with Preview.</div>}
      </section>

      <section id="sec-voice-chat" tabIndex={-1}>
        <h2>Voice conversation <Dot c={changed} k="voice.voiceModelId" /></h2>
        <label className="small" style={{ maxWidth: 480 }}>Model for voice chat
          <select value={v.voiceModelId} onChange={(e) => void saveV({ voiceModelId: e.target.value })} aria-label="Model for voice chat">
            <option value="">Fast model (automatic){fastVoiceModel(installed) ? `: ${fastVoiceModel(installed)!.entry.name}` : ": none installed, the conversation's model is used"}</option>
            <option value="chat">The model used in the conversation</option>
            {installed.map((i) => <option key={i.entry.id} value={i.entry.id}>{i.entry.name} · ~{i.entry.sizeGB} GB</option>)}
          </select>
        </label>
        <p className="muted small">A voice conversation needs short answers fast. By default the app uses its best small model that runs wholly on the NPU. Typed chats keep the model you selected.</p>
        <label className="check"><input type="checkbox" checked={v.allowInterrupt} onChange={(e) => void saveV({ allowInterrupt: e.target.checked })} /> Let me interrupt by speaking: the answer stops and keeps only what was said aloud (use headphones if the speakers echo) <Dot c={changed} k="voice.allowInterrupt" /></label>
        <label className="check"><input type="checkbox" checked={v.autoSend} onChange={(e) => void saveV({ autoSend: e.target.checked })} /> Send voice messages as soon as I stop talking <Dot c={changed} k="voice.autoSend" /></label>
        {voice?.notice && <div className="warn small">{voice.notice}</div>}
      </section>

      <section id="sec-voice-calibration" tabIndex={-1}>
        <details>
          <summary className="small"><strong>Advanced: placement and calibration</strong> <span className="muted">· where the speech models run, thresholds and timing</span></summary>
          <div className="role-row">
            <div><strong>Dictation placement</strong><Dot c={changed} k="voice.sttCompute" /><div className="muted small">{voice?.stt ? `running on ${voice.sttProvider?.toUpperCase()}` : "not loaded"}</div></div>
            <VoiceComputeChoice kind="stt" model={sttModel} value={v.sttCompute} onSave={(c) => void saveV({ sttCompute: c })} />
          </div>
          <div className="role-row">
            <div><strong>Read-aloud placement</strong><Dot c={changed} k="voice.ttsCompute" /><div className="muted small">{voice?.tts ? `running on ${voice.ttsProvider?.toUpperCase()}` : "not loaded"}</div></div>
            <VoiceComputeChoice kind="tts" model={ttsModel} value={v.ttsCompute} onSave={(c) => void saveV({ ttsCompute: c })} />
          </div>
          <p className="muted small">Nothing is transcribed unless the sound is both loud enough and long enough, so a keyboard click or a fan never starts a message.</p>
          <label className="small">Quietest sound that counts: {Math.round((v.minLevel / VOICE_LIMITS.minLevel.max) * 100)}% <Dot c={changed} k="voice.minLevel" />
            <Range value={v.minLevel} min={VOICE_LIMITS.minLevel.min} max={VOICE_LIMITS.minLevel.max} step={0.001} ariaLabel="Quietest sound that counts" onSave={(n) => void saveV({ minLevel: n })} />
          </label>
          {/* The interrupt thresholds only act when interrupting itself is on (finding 3's
              parent gating): disabled with the reason, never silently adjustable. */}
          <div className={v.allowInterrupt ? "" : "muted"}>
            <label className="small">Loudness needed to interrupt the assistant: {Math.round(v.interruptLevel * 800)}% <Dot c={changed} k="voice.interruptLevel" />
              <Range value={v.interruptLevel} min={VOICE_LIMITS.interruptLevel.min} max={VOICE_LIMITS.interruptLevel.max} step={0.001} ariaLabel="Loudness needed to interrupt" disabled={!v.allowInterrupt} onSave={(n) => void saveV({ interruptLevel: n })} />
            </label>
            <label className="small">Time spoken without a break to interrupt it: {(v.interruptMs / 1000).toFixed(1)} s <Dot c={changed} k="voice.interruptMs" />
              <Range value={v.interruptMs} min={VOICE_LIMITS.interruptMs.min} max={VOICE_LIMITS.interruptMs.max} step={100} ariaLabel="Time spoken to interrupt" format={(x) => `${(x / 1000).toFixed(1)} seconds`} disabled={!v.allowInterrupt} onSave={(n) => void saveV({ interruptMs: n })} />
            </label>
            {!v.allowInterrupt && <div className="muted small">Interrupting is off (in Voice conversation, above): these thresholds do nothing until it is turned back on. Their values are kept.</div>}
          </div>
          <p className="muted small">An interruption also needs real words in the transcription: a cough, a laugh or a "hmm" never stops the assistant.</p>
          <label className="small">Shortest speech that counts: {v.minSpeechMs} ms <Dot c={changed} k="voice.minSpeechMs" />
            <Range value={v.minSpeechMs} min={VOICE_LIMITS.minSpeechMs.min} max={VOICE_LIMITS.minSpeechMs.max} step={20} ariaLabel="Shortest speech that counts" format={(x) => `${x} milliseconds`} onSave={(n) => void saveV({ minSpeechMs: n })} />
          </label>
          <label className="small">Silence that ends a dictated piece: {(v.endSilenceMs / 1000).toFixed(1)} s <Dot c={changed} k="voice.endSilenceMs" />
            <Range value={v.endSilenceMs} min={VOICE_LIMITS.endSilenceMs.min} max={VOICE_LIMITS.endSilenceMs.max} step={50} ariaLabel="Silence that ends a dictated piece" format={(x) => `${(x / 1000).toFixed(1)} seconds`} onSave={(n) => void saveV({ endSilenceMs: n })} />
          </label>
          <label className="small">Wait before answering in voice chat: {(v.waitMs / 1000).toFixed(1)} s{v.smartEnd ? " (a little less after a finished sentence, longer after an open one)" : ""} <Dot c={changed} k="voice.waitMs" />
            <Range value={v.waitMs} min={VOICE_LIMITS.waitMs.min} max={VOICE_LIMITS.waitMs.max} step={100} ariaLabel="Wait before answering in voice chat" format={(x) => `${(x / 1000).toFixed(1)} seconds`} onSave={(n) => void saveV({ waitMs: n })} />
          </label>
          <label className="check"><input type="checkbox" checked={v.smartEnd} onChange={(e) => void saveV({ smartEnd: e.target.checked })} /> Adapt that silence to what I said <Dot c={changed} k="voice.smartEnd" /></label>
          {/* Reset restores the ONE voice defaults (DEFAULT_VOICE_SETTINGS via
              calibrationResetPatch): a second hand-copied list of numbers here had
              drifted from the real defaults and "reset" wrote wrong values. */}
          <button type="button" className="ghost" onClick={() => void saveV(calibrationResetPatch())}>Reset calibration to defaults</button>
        </details>
      </section>
 </>}

 {/* ============================== Chats & answers ============================== */}
 {view === "chats" && <>
      <section id="sec-chats-location" tabIndex={-1}>
        <h2>Where chat runs <Dot c={changed} k="humainMode" /></h2>
        <div className="row">
          <label className="small">Chat location
            <select value={readSetting(settings, "humainMode")} disabled={chatLocationBusy || fb.transient?.tone === "busy"}
              aria-describedby={chatLocationBusy ? "chat-location-busy" : undefined}
              onChange={(e) => void save({ humainMode: e.target.value as Settings["humainMode"] })}>
              <option value="local">Local · This PC</option>
              <option value="fuse">Cloud · HUMAIN Fuse</option>
              <option value="node">Cloud · HUMAIN Node</option>
            </select>
          </label>
          <button type="button" className="linklike" onClick={() => selectTab("library")}>Manage local models</button>
          <button type="button" className="linklike" onClick={() => goto({ tab: "web", section: "sec-humain-routing" })}>Set up a cloud provider</button>
        </div>
        {chatLocationBusy && <p className="muted small" id="chat-location-busy">Chat location is available when the current reply or location change finishes.</p>}
        <p className="muted small">Cloud chat sends conversation context and attached content only to the selected provider.</p>
      </section>
      <section id="sec-chats-thinking" tabIndex={-1}>
        <h2>Thinking <Dot c={changed} k="effort" /></h2>
        <p className="muted small">How long a model that can think does so before answering. The This chat menu changes it for the next message.</p>
        <label className="small" style={{ maxWidth: 420 }}>Thinking level
          <select value={readSetting(settings, "effort")} onChange={(e) => void save({ effort: e.target.value as Settings["effort"] })}>
            <option value="auto">Auto (per request)</option>
            <option value="off">Off (when the model allows)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <div className="muted small">Auto picks a level per request; Off applies when the model allows it.</div>
      </section>
      <section id="sec-chats-tools" tabIndex={-1}>
        <h2>Tools and commands</h2>
        <p className="muted small">Controls when the model runs tools for file work and other tasks. Also in the This chat menu.</p>
        <label className="check"><input type="checkbox" checked={readBool(settings, "toolsOnCommand")} onChange={(e) => void save({ toolsOnCommand: !!e.target.checked })} /> Tools run only on a slash command (/agents, /build…) instead of by themselves <Dot c={changed} k="toolsOnCommand" /></label>
        <div className="muted small">On: a plain message is a plain chat — no tool runs unless the message starts with a command.</div>
      </section>
      <section id="sec-chats-agents" tabIndex={-1}>
        <h2>Sub-agents <Dot c={changed} k="subagents" /></h2>
        <p className="muted small">Lets a big job be split into parts done one after another. Offered only when the request asks for it or splits into independent parts.</p>
        <label className="check"><input type="checkbox" checked={readBool(settings, "subagents")} onChange={(e) => void save({ subagents: e.target.checked })} /> Allow sub-agents</label>
      </section>
      <section id="sec-chats-long" tabIndex={-1}>
        <h2>Long chats <Dot c={changed} k="autoCompact" /></h2>
        <label className="check"><input type="checkbox" checked={readBool(settings, "autoCompact")} onChange={(e) => void save({ autoCompact: e.target.checked })} /> Keep long chats going: summarize the oldest messages in the background</label>
        <div className="muted small">After an answer, the oldest part of a long conversation is summarized so the next message never waits for it; the summary is kept with the chat. "Summarize now" in the chat always works.</div>
      </section>
      <section id="sec-build-behavior" tabIndex={-1}>
        <h2>Limits per turn <Dot c={changed} k="turnBudget.maxCalls" /><Dot c={changed} k="turnBudget.maxOutputTokens" /></h2>
        <p className="muted small">One cap on everything a single request of yours spends — the answer, the summaries, the reviewers, the sub-agents, the builds. A turn that reaches it stops calling the model and tells you; the parts already gathered stay on the screen.</p>
        <div className="row">
          <label className="small">Model calls per turn, at most
            <select value={tb()?.maxCalls ?? ""} onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              void save({ turnBudget: turnPair(v || null, tb()?.maxOutputTokens ?? null) });
            }}>
              <option value="">Default (120)</option>
              {[60, 120, 240, 480].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="small">Output tokens per turn, at most
            <select value={tb()?.maxOutputTokens ?? ""} onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              void save({ turnBudget: turnPair(tb()?.maxCalls ?? null, v || null) });
            }}>
              <option value="">Default (100,000)</option>
              {[50_000, 100_000, 200_000].map((n) => <option key={n} value={n}>{n.toLocaleString("en-US")}</option>)}
            </select>
          </label>
          <button type="button" className="ghost" onClick={() => void save({ turnBudget: null })}>Reset</button>
        </div>
      </section>
 </>}

 {/* ============================== Files & projects ============================== */}
 {view === "files" && <>
      <section id="sec-files-panels" tabIndex={-1}>
        <h2>Files beside the chat</h2>
        <label className="check" title="Off: a written file stays a card in the answer and opens from the Files page."><input type="checkbox" checked={readBool(settings, "openFilesBesideChat")} onChange={(e) => void save({ openFilesBesideChat: e.target.checked })} /> Files beside the chat: written files open in the panel on the right <Dot c={changed} k="openFilesBesideChat" /></label>
        <div className="muted small">Off: a written file stays a card in the answer and opens from the Files page.</div>
      </section>
      <section id="sec-files-multilingual" tabIndex={-1}>
        <h2>Search across languages</h2>
        <MultilingualSearch />
      </section>
      <section id="sec-build-check" tabIndex={-1}>
        <h2>Code check</h2>
        <p className="muted small">Written pages and scripts are run and fixed before you see them.</p>
        <label className="check"><input type="checkbox" checked={settings.autoCheck} onChange={(e) => void save({ autoCheck: e.target.checked })} /> Run and check the code the model writes <Dot c={changed} k="autoCheck" /></label>
        <div className="row">
          <label className="small">Review model <Dot c={changed} k="reviewerModelId" />
            <select disabled={!settings.autoCheck} value={readSetting(settings, "reviewerModelId") ?? ""} onChange={(e) => void save({ reviewerModelId: e.target.value || null })}>
              <option value="">None: the writing model fixes its own errors</option>
              {installed.map((i) => <option key={i.entry.id} value={i.entry.id}>{i.entry.name} ({i.entry.sizeGB} GB)</option>)}
            </select>
          </label>
          <label className="small">Fix rounds at most <Dot c={changed} k="reviewRounds" />
            <select disabled={!settings.autoCheck} value={readNum(settings, "reviewRounds")} onChange={(e) => void save({ reviewRounds: parseInt(e.target.value, 10) })}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <div className="muted small">A bigger model fixes the code after it is written. Pick one that fits the NPU memory on its own.</div>
      </section>
      <section id="sec-build-improve" tabIndex={-1}>
        <h2>Auto-improve <Dot c={changed} k="agentLoop" /></h2>
        <label className="check"><input type="checkbox" checked={settings.agentLoop} onChange={(e) => void save({ agentLoop: e.target.checked })} /> After an answer with files, keep improving them round after round <Dot c={changed} k="agentLoop" /></label>
        {settings.agentLoop && (
          <div className="row">
            <label className="small">Rounds at most <Dot c={changed} k="agentRounds" />
              <select value={readNum(settings, "agentRounds")} onChange={(e) => void save({ agentRounds: parseInt(e.target.value, 10) })}>{[2, 4, 6, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
            <label className="small">Time at most <Dot c={changed} k="agentMinutes" />
              <select value={readNum(settings, "agentMinutes")} onChange={(e) => void save({ agentMinutes: parseInt(e.target.value, 10) })}>
                {[10, 30, 60, 120, 240, 480].map((n) => <option key={n} value={n}>{n < 60 ? `${n} min` : `${n / 60} h`}</option>)}
              </select>
            </label>
            <label className="small" style={{ flex: 1, minWidth: 220 }}>Direction <Dot c={changed} k="agentGoal" />
              <TextCommit value={settings.agentGoal} onSave={(t) => void save({ agentGoal: t })} ariaLabel="Auto-improve direction" placeholder="e.g. add 3D graphics (empty: better in every way)" />
            </label>
          </div>
        )}
        <div className="muted small">Each round runs the result and keeps it only if it works. Stop ends the loop.</div>
        <label className="check" title="Skips the vision check of screenshots, redraws a slide at most once a second while it is written, and fixes only slides the app's own layout check finds too tight."><input type="checkbox" checked={readBool(settings, "deckLowPower")} onChange={(e) => void save({ deckLowPower: e.target.checked })} /> Low-power slides: keep the slide count; skip the extra checks <Dot c={changed} k="deckLowPower" /></label>
      </section>
      {/* The group's folded Advanced: the sections that hold only advanced keys. */}
      <details className="set-adv">
        <summary className="small"><strong>Advanced</strong> <span className="muted">· a model per writing role</span></summary>
      <section id="sec-build-writers" tabIndex={-1}>
        <h2>Which model writes what <Dot c={changed} k="writers" /></h2>
        <p className="muted small">Give each job to the model that is best at it. "Chat model" uses the model you chat with.</p>
        <div className="row">
          {([["plan", "Planning"], ["html", "HTML pages"], ["css", "CSS"], ["js", "JavaScript"]] as const).map(([role, label]) => (
            <label key={role} className="small">{label}
              <select value={readObj<Partial<Record<string, string>>>(settings, "writers")[role] ?? ""} onChange={(e) => { const next = { ...readObj<Partial<Record<string, string>>>(settings, "writers") }; if (e.target.value) next[role] = e.target.value; else delete next[role]; void save({ writers: next }); }}>
                <option value="">Chat model</option>
                {installed.map((i) => <option key={i.entry.id} value={i.entry.id}>{i.entry.name} ({i.entry.sizeGB} GB)</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="muted small">Files are written page, stylesheet, script; each model must fit the NPU memory on its own.</div>
      </section>
      </details>
 </>}

 {/* ============================== HUMAIN ============================== */}
 {(view === "web" || view === "fuse" || view === "node") && (
   <HumainSettings key={view} settings={settings} save={save} provider={view === "web" ? undefined : view}
     onOpenProvider={(provider) => selectTab(provider)}
     onOpenChatLocation={() => goto({ tab: "chats", section: "sec-chats-location" })} />
 )}

 {/* ============================== Developer ============================== */}
 {view === "developer" && <>
      {/* What the host's last repair of the settings file did, if it ever did one:
          the person is told what happened and where the old bytes are kept. */}
      {repairNotice && (
        <div className="warn small" role="alert" style={{ marginBottom: 10 }}>
          <strong>Your settings file was repaired{typeof repairNotice.at === "number" ? ` on ${new Date(repairNotice.at).toLocaleString()}` : ""}.</strong>{" "}
          {Array.isArray(repairNotice.salvaged) && repairNotice.salvaged.length > 0 && (
            <div>These keys did not pass their check and were set back to the default: {repairNotice.salvaged.join(", ")}.</div>
          )}
          {typeof repairNotice.moved_aside === "string" && <div>The damaged file was kept as <code>{repairNotice.moved_aside}</code>.</div>}
          {typeof repairNotice.backed_up === "string" && <div>The file as it was before the repair was kept as <code>{repairNotice.backed_up}</code>.</div>}
          {typeof repairNotice.error === "string" && <div>{repairNotice.error}</div>}
        </div>
      )}

      <section id="sec-sys-devtools" tabIndex={-1}>
        <h2>Developer tools</h2>
        <label className="check">
          <input type="checkbox" checked={developer} onChange={(e) => void save({ developer: e.target.checked })} />
          <span> Show the developer diagnostics: model routing, load tests, benchmarks, engines, prompt lab</span>
        </label>
      </section>

      <SubHead>Runtime</SubHead>
      <section id="sec-rt-requirements" tabIndex={-1}>
        <h2>What MKMN needs on this PC</h2>
        <Requirements />
      </section>

      <section id="sec-rt-genies" tabIndex={-1}>
        <h2>GenieX runtime</h2>
        <table className="kv"><tbody>
          <tr><td>Location</td><td>{info.geniexPath ?? "not found"}</td></tr>
          <tr><td>Version</td><td>{info.geniexVersion ?? "unknown"}</td></tr>
        </tbody></table>
        {info.geniexVersionWarning && <div className="warn small">{info.geniexVersionWarning}</div>}
        <div className="row">
          <button type="button" className="primary" onClick={() => void api().openGeniexDownload()}>{info.geniexPath ? "Reinstall GenieX" : "Install GenieX"}</button>
          <button type="button" className="ghost" onClick={async () => { await api().pickGeniex(); await onSave({ geniexPath: info.geniexPath ?? null }); }}>Locate geniex.exe…</button>
        </div>
        <div className="muted small">MKMN can download GenieX from Qualcomm on first launch (it is not bundled; its libraries are under Qualcomm's terms) and runs Qualcomm's installer. Adjust compute and model retention in {tabLabel("models")}.</div>

        <h3 style={{ marginTop: 14 }}>Runtime options <Dot c={changed} k="qairtLib" /><Dot c={changed} k="geniexLog" /><Dot c={changed} k="geniexUpdateCheck" /></h3>
        <div className="row">
          <label className="small" style={{ maxWidth: 420 }}>
            <span>Runtime libraries folder</span>
            <input
              type="text"
              value={readSetting(settings, "qairtLib")}
              placeholder="empty = the bundled copy"
              onChange={(e) => void save({ qairtLib: e.target.value })}
            />
          </label>
          <label className="small" style={{ maxWidth: 220 }}>
            <span>Runtime log level</span>
            <select
              value={readSetting(settings, "geniexLog")}
              onChange={(e) => void save({ geniexLog: e.target.value as Settings["geniexLog"] })}
            >
              <option value="none">None (default)</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
              <option value="trace">Trace</option>
            </select>
          </label>
          <label className="small">
            <input
              type="checkbox"
              checked={readBool(settings, "geniexUpdateCheck")}
              onChange={(e) => void save({ geniexUpdateCheck: e.target.checked })}
            />
            <span>Let the runtime look for updates when it starts</span>
          </label>
        </div>
        <p className="muted small">
          The libraries folder points the NPU engine at a different runtime copy installed on this PC (leave empty for the one GenieX ships with).
          A higher log level makes the runtime itself write more detail into the server log under Last error — useful for support.
          Both take effect the next time a model loads.
        </p>

        <h3 style={{ marginTop: 14 }}>Cached model records</h3>
        <div className="row">
          <label className="small" style={{ maxWidth: 380 }}>
            <span>Installed model</span>
            <select value={typeModel} onChange={(e) => { setTypeModel(e.target.value); setTypeNote(null); }}>
              <option value="">Choose a model…</option>
              {installed.map((i) => <option key={i.entry.id} value={i.ref}>{i.entry.name}</option>)}
            </select>
          </label>
          <label className="small" style={{ maxWidth: 200 }}>
            <span>Loads as</span>
            <select
              value=""
              disabled={!typeModel || typeBusy}
              onChange={(e) => {
                const type = e.target.value as "llm" | "vlm";
                if (!type || !typeModel) return;
                setTypeBusy(true);
                setTypeNote(null);
                void api().geniexSetType({ name: typeModel, type })
                  .then((r) => setTypeNote({ tone: r.ok ? "ok" : "warn", text: r.message || (r.ok ? "Done." : "geniex refused the change.") }))
                  .catch((err) => setTypeNote({ tone: "warn", text: String((err as Error)?.message ?? err) }))
                  .finally(() => setTypeBusy(false));
              }}
            >
              <option value="">Set type…</option>
              <option value="llm">Text only (LLM)</option>
              <option value="vlm">Text and images (VLM)</option>
            </select>
          </label>
        </div>
        {typeNote && <div className={typeNote.tone === "ok" ? "small" : "warn small"} role="status">{typeNote.text}</div>}
        <p className="muted small">
          Tells the runtime which path a cached model takes: a vision model (VLM) loads its image reader, a text model (LLM) runs text only.
          GenieX detects this itself for known models; use this when a model was imported from a folder and came out wrong.
        </p>

        <div className="row">
          <button
            type="button"
            className="ghost"
            disabled={geniexConfig.state === "loading"}
            onClick={() => {
              setGeniexConfig({ state: "loading", text: geniexConfig.text });
              void api().geniexConfigList()
                .then((r) => setGeniexConfig(r.ok && typeof r.text === "string" ? { state: "ready", text: r.text } : { state: "error", text: r.error ?? "geniex config list failed" }))
                .catch((e) => setGeniexConfig({ state: "error", text: String((e as Error)?.message ?? e) }));
            }}
          >{geniexConfig.state === "loading" ? "Reading…" : "Show runtime configuration"}</button>
          <button
            type="button"
            className={cleanArmed ? "danger" : "ghost"}
            disabled={cleanBusy}
            onClick={() => (cleanArmed ? runClean() : armClean())}
          >{cleanBusy ? "Removing…" : cleanArmed ? "Really remove ALL cached models?" : "Remove all models…"}</button>
        </div>
        {geniexConfig.state === "ready" && <pre className="small" style={{ maxHeight: 240, overflow: "auto" }}>{geniexConfig.text}</pre>}
        {geniexConfig.state === "error" && <div className="warn small" role="alert">{geniexConfig.text}</div>}
        {cleanNote && <div className="small" role="status">{cleanNote}</div>}
        <p className="muted small">
          The configuration is what the runtime's own command line reports (the detected chipset and its stored choices) — read-only.
          Removing all models empties the runtime's whole cache, including anything installed outside MKMN; each model can also be
          removed one by one in {tabLabel("library")}.
        </p>
      </section>

      <section id="sec-rt-endpoint" tabIndex={-1}>
        <h2>Local endpoint</h2>
        <p className="muted small">OpenAI-compatible. Point Cherry Studio, VS Code or any client at it while a model is loaded.</p>
        <div className="row">
          <code className="endpoint">{endpoint}</code>
          <button type="button" className="ghost" onClick={() => void copyEndpoint()}>{copied ? "Copied" : "Copy"}</button>
          {server?.state === "ready" && <button type="button" className="ghost" onClick={() => void api().stopServer()}>Stop server</button>}
        </div>
        {copyErr && <div className="warn small" role="alert">The clipboard refused the copy. Select the address above and copy it by hand.</div>}
        <div className="muted small">Stopping the server unloads the current model. A chat that needs it starts it again.</div>
      </section>

      <SubHead>This PC</SubHead>
      <section id="sec-sys-hardware" tabIndex={-1}>
        <h2>This machine</h2>
        <table className="kv"><tbody>
          <tr><td>Chip</td><td>{hw.chipName}</td></tr>
          <tr><td>RAM</td><td>{hw.ramGB} GB</td></tr>
          <tr><td>NPU</td><td>{hw.npuDetected || server?.hardwareVerification?.verifiedNpu ? "Hexagon NPU found" : "Not detected"}{hw.npuDriverVersion ? ` · driver ${hw.npuDriverVersion}` : ""}</td></tr>
          <tr><td>NPU memory limit</td><td>{hw.npuBudgetGB} GB <span className="muted">({hw.npuBudgetSource === "estimated" ? "estimated: about half of RAM" : hw.npuBudgetSource === "user" ? "set by you" : "measured"})</span></td></tr>
          <tr><td>App build</td><td>{info.arch}{hw.emulated ? " (emulated: install the ARM64 build)" : " (native)"} · v{info.version}</td></tr>
        </tbody></table>
        <div className="muted small">The memory override lives next to the memory estimate, in Speed &amp; memory → Memory use.</div>
      </section>

      <section id="sec-sys-execution" tabIndex={-1}>
        <h2>Execution verification</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className={`tag ${exec.tone === "ok" ? "status-ok" : exec.tone === "warn" ? "status-warn" : ""}`}>{exec.label}</span>
        </div>
        <p className="muted small" role="status">{exec.detail}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginTop: 8 }}>
          <div className="stat">
            <div className="muted small">Requested device</div>
            <div style={{ fontWeight: 600 }}>{inAuto ? "Auto (decided per request)" : requested}</div>
          </div>
          <div className="stat">
            <div className="muted small">Observed execution</div>
            <div style={{ fontWeight: 600 }}>{observed ?? "Not reported yet"}</div>
          </div>
          <div className="stat">
            <div className="muted small">Active power mode</div>
            <div style={{ fontWeight: 600, textTransform: "capitalize" }}>
              {server?.hardwareVerification?.powerModeActive ?? "Not reported"}{(() => { const requested = readSetting(settings, "powerProfile"); return requested !== "auto" && (server?.hardwareVerification?.powerModeActive ?? "") !== requested ? ` (requested: ${requested})` : ""; })()}
            </div>
          </div>
          <div className="stat">
            <div className="muted small">Power supply</div>
            <div style={{ fontWeight: 600 }}>
              {powerInfo === null ? "Checking…" : powerInfo?.onAcPower ? "AC connected" : `Battery (${powerInfo?.batteryPercent ?? "--"}%)`}
            </div>
          </div>
          <div className="stat">
            <div className="muted small">Windows EcoQoS tier</div>
            <div style={{ fontWeight: 600 }}>{server?.hardwareVerification?.qosTier ?? "Not reported"}</div>
          </div>
        </div>
        {server?.hardwareVerification?.lastTelemetryLog && (
          <div style={{ marginTop: 8 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>Last driver telemetry:</div>
            <pre className="telemetry-log">{server.hardwareVerification.lastTelemetryLog}</pre>
          </div>
        )}
      </section>

      <section id="sec-sys-errors" tabIndex={-1}>
        <h2>Last error</h2>
        {server?.lastError ? <div className="error-box"><strong>{server.lastError.title}</strong><div>{server.lastError.fix}</div></div>
          : voice?.error ? <div className="error-box"><strong>{voice.error.title}</strong><div>{voice.error.fix}</div></div>
          : <div className="muted">None.</div>}
        {log.length > 0 && <details><summary className="small">Server log</summary><pre>{log.join("\n")}</pre></details>}
      </section>

      <SubHead>Recovery</SubHead>
      {/* A recovery action of its own, not a footnote of a test: what a failed load can need
          instead of restarting the PC, reachable without the developer tools. */}
      <section id="sec-sys-recovery" tabIndex={-1}>
        <h2>Reset the NPU</h2>
        <div className="muted small">After a failed load the NPU can stay in a bad state until Windows restarts. This stops geniex and restarts the NPU's driver. Windows asks for permission once; after that the reset runs without a prompt. If models still fail afterwards, restart the PC.</div>
        <div style={{ marginTop: 8 }}><ResetNpuButton /></div>
        {/* Nothing in this build acts on the automatic reset (an accepted degradation of the desktop build):
            the switch is shown off and disabled, saying so, rather than promising a reset that never comes. */}
        <label className="check small" title="The stored choice is kept for when the automatic reset is back."><input type="checkbox" checked={false} disabled /> Reset the NPU by itself when it is stuck <span className="muted">· not active in this build: use Reset the NPU above{readBool(settings, "autoResetNpu") ? "" : " (your choice: off)"}</span></label>
      </section>

      {/* Routing and the diagnostic tools exist only while the developer tools are on. */}
      {settings.developer && <>
      <SubHead>Model routing</SubHead>
      <section id="sec-route-dynamic" tabIndex={-1}>
        <h2>The Dynamic model</h2>
        <DynamicEditor settings={settings} installed={installed} onSave={async (p) => { await save(p); }} />
      </section>
      </>}

      {/* ============================== Diagnostics (developer) ============================== */}
      {settings.developer && <>
      <SubHead>Measure and compare</SubHead>
      <section id="sec-diag-bench" tabIndex={-1}>
        <h2>Single-model benchmark</h2>
        <p className="muted small">Measures one installed model (decode speed, first-token time) on the NPU or its hybrid path, under a chosen power mode. The result is saved with the model on this PC: its model card shows it (Measured here), and the automatic performance mode reads it.</p>
        <div className="bench-form">
          <div>
            <label className="small">
              <span>Model to benchmark</span>
              <select value={benchModel} onChange={(e) => setBenchModel(e.target.value)} disabled={benchRunning}>
                {installed.map((item) => (
                  <option key={item.ref} value={item.ref} title={item.ref}>{benchOptionLabel(item)}</option>
                ))}
              </select>
            </label>
            {/* the selected model's long ref, once, under the list of names */}
            {benchSelRef && <div className="muted small" style={{ marginTop: 4 }}>{benchSelRef}</div>}
          </div>
          <div>
            <label className="small">
              <span>Compute target</span>
              <select value={benchEffective} onChange={(e) => setBenchCompute(e.target.value)} disabled={benchRunning}>
                {benchTargets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            {/* The effective target, restated ONLY when it differs from the pick (a compiled
                bundle's stale hybrid choice): what Run will submit, and why. */}
            {benchNote && <div className="muted small" style={{ marginTop: 4 }}>{benchNote}</div>}
          </div>
          <label className="small">
            <span>Power mode</span>
            <select value={benchPowerMode} onChange={(e) => setBenchPowerMode(e.target.value)} disabled={benchRunning}>
              <option value="burst">Burst</option>
              <option value="sustained_high_performance">Sustained</option>
              <option value="power_saver">Power Saver</option>
            </select>
          </label>
          <div className="bench-actions">
            {/* No installed card behind the selection (every model was removed while
                this page was mounted): the run could only fail server-side. */}
            <button type="button" className="primary" onClick={() => void runBenchmark()} disabled={benchRunning || !benchModel || !installed.some((i) => i.ref === benchModel)} aria-busy={benchRunning}>
              {benchRunning ? "Benchmarking…" : "Run benchmark"}
            </button>
            {benchRunning && <button type="button" onClick={() => void api().cancelBenchmark()}>Stop</button>}
            <span className="muted small">Unloads the chat model while it runs (the next message loads it again). Refused while an answer is being written.</span>
          </div>
        </div>
        {benchMsg && (
          <div className={`small ${benchMsg.startsWith("✓") ? "ok" : "warn"}`} role="status" aria-live="polite" style={{ marginTop: 8 }}>{benchMsg}</div>
        )}
        {benchResult && (
          <div style={{ marginTop: 12, background: "var(--code-bg)", padding: 12, borderRadius: 6, border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <strong>Benchmark results: {installed.find((i) => i.ref === benchResult.modelRef)?.entry.name ?? benchResult.modelRef}</strong>
              <span className={`tag ${benchResult.verifiedNpu ? "status-ok" : ""}`}>
                {benchResult.verifiedNpu ? "⚡ Hexagon HTP verified" : "NPU not verified (no counters or device line)"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
              {/* what a person asks first: how soon it answers, how fast it writes, where it ran */}
              <div><div className="muted small">First token time (TTFT)</div><div style={{ fontSize: 18, fontWeight: 700 }}>{benchResult.ttftMs === null ? "not measured" : `${benchResult.ttftMs} ms`}</div></div>
              <div><div className="muted small">Generation speed</div><div style={{ fontSize: 18, fontWeight: 700 }} className="ok">{benchResult.decodeTokPerSec} tok/s</div></div>
              <div><div className="muted small">Where it ran</div><div style={{ fontSize: 18, fontWeight: 700 }}>{benchWhere(benchResult)}</div></div>
              <div><div className="muted small">Prefill speed</div><div style={{ fontSize: 18, fontWeight: 700 }}>{benchResult.prefillTokPerSec ?? "--"} tok/s</div></div>
              <div><div className="muted small">Load time</div><div style={{ fontSize: 18, fontWeight: 700 }}>{benchResult.loadTimeMs} ms</div></div>
              <div><div className="muted small">System RAM in use (all processes, not the model alone)</div><div style={{ fontSize: 18, fontWeight: 700 }}>{benchResult.ramUsedMB} MB</div></div>
              {typeof benchResult.childPrivateMemMB === "number" && (
                <div><div className="muted small">Model process memory (measured, private)</div><div style={{ fontSize: 18, fontWeight: 700 }}>{benchResult.childPrivateMemMB} MB</div></div>
              )}
              {typeof benchResult.firstOutputMs === "number" && (
                <div><div className="muted small">First output (observed)</div><div style={{ fontSize: 18, fontWeight: 700 }}>{benchResult.firstOutputMs} ms</div></div>
              )}
            </div>
            {benchResult.outputSnippet && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
                Output: <em>"{benchResult.outputSnippet}"</em>
              </div>
            )}
            {/* Where the result went: the same run feeds the model card (the Measured here
                chip and badge) and the automatic performance mode's choice — one measurement,
                shown wherever the model is talked about. */}
            <div className="muted small" style={{ marginTop: 8 }}>
              Saved with the model on this PC: the model card in the Models list now shows this measurement, and the automatic performance mode uses it.
            </div>
          </div>
        )}
      </section>

      <section id="sec-diag-suite" tabIndex={-1}>
        <h2>Benchmark suite</h2>
        <Benchmark />
      </section>
      <section id="sec-diag-npu" tabIndex={-1}>
        <h2>NPU load test</h2>
        <NpuLoadTest settings={settings} onSave={(p) => void save(p)} />
      </section>
      <section id="sec-diag-engines" tabIndex={-1}>
        <h2>Engines: GenieX and Microsoft Foundry Local</h2>
        <EngineCompare />
      </section>
      <section id="sec-diag-foundry" tabIndex={-1}>
        <h2>Microsoft Foundry Local settings</h2>
        <FoundryPanel />
      </section>
      <section id="sec-diag-providers" tabIndex={-1}>
        <h2>Providers and artifact sources</h2>
        <ProviderMatrix />
      </section>
      <section id="sec-diag-battery" tabIndex={-1}>
        <h2>Battery draw</h2>
        <BatteryProbe />
      </section>
      <section id="sec-diag-lab" tabIndex={-1}>
        <h2>Prompt lab</h2>
        <PromptLab />
      </section>
      </>}
 </>}
        </div>
      </div>
    </div>
  );
}
