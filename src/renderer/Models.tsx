import { isDynamicId } from "../core/dynamic";
import { DynamicSection } from "./DynamicCard";
import { useEffect, useState } from "react";
import { api } from "./api";
import { ICONS, IconButton } from "./Icon";
import type { CatalogItem } from "../shared/api";
import { COMPUTE_LABEL } from "../core/adaptiveCompute";
import { CapBadges } from "./Capabilities";
import { RunsBadge } from "./RunsBadge";
import { EvidenceBadges } from "./EvidenceBadges";
import { ScoreChip } from "./ScoreChip";
import { scoreOf } from "../core/scores";
import { recommendedDefault, tierChoices, TIERS, type ArtifactManifestEntry, type EvidenceContext, type EvidenceRecord } from "../core/manifest";
import { arrangeModels, badgePlacement, isNativeNpu, measureHint, placementOf, recommendedModels, type EngineFilter, type SortBy } from "../core/modelList";
import { Seg } from "./Seg";
import { SkeletonRows } from "./Skeleton";
import { Explore } from "./Explore";
import type { CatalogEntry, HardwareProfile, HfInspection, InstallProgress } from "../shared/types";
import { benchDetailLines, benchHeadline, benchOutdatedReasons, benchProfileFor, benchRefsFor, relatedVariantRun, selectBenchRun, type BenchProfile, type BenchSelection } from "../core/benchStore";

const isFoundry = (e: CatalogEntry) => e.id.startsWith("foundry:");

/** Which engine runs the model: the one thing the two kinds of cards must not be mistaken for. */
function EngineBadge({ foundry, installed }: { foundry: boolean; installed?: boolean }) {
  return foundry
    ? <span className="badge engine foundry" title={installed === false ? "Runs with Microsoft Foundry Local, which needs to be installed first" : "Runs with Microsoft Foundry Local"}>Foundry Local</span>
    : <span className="badge engine geniex" title="Runs with Qualcomm's NPU engine (GenieX)">GenieX</span>;
}

/** The other engine's build of the same model, in words a second like the speed column beside it. */
function altLine(shown: CatalogItem, other: CatalogItem): string {
  const a = scoreOf(shown.entry)?.tokPerSec, b = scoreOf(other.entry)?.tokPerSec;
  const name = isFoundry(other.entry) ? "Foundry Local" : "Qualcomm's NPU engine";
  return a && b ? `Faster here than with ${name} (about ${wordsPerSec(a)} against ${wordsPerSec(b)} words/s)` : `Also tested with ${name}`;
}

/** A speed people can picture: words a second, from the engine's tokens a second (about ¾ of a word each). */
export const wordsPerSec = (tokPerSec: number): number => Math.max(1, Math.round(tokPerSec * 0.75));

function Badge({ level, foundry }: { level: "green" | "amber" | "red"; foundry?: boolean }) {
  // a Foundry Local model is not judged by the NPU fit rules: where it runs is the badge next to this one.
  // "Fits NPU" is a size/compatibility ESTIMATE from the fit rules — where the model was
  // actually seen to run is the RunsBadge next to it, and an unmeasured model says so.
  const label = foundry ? (level === "green" ? "Should fit" : "Large") : level === "green" ? "Should fit" : level === "amber" ? "Might not fit" : "Too large";
  const hint = foundry
    ? (level === "green" ? "Expected to fit on this PC, judged from its size." : "Larger than usual for this PC. It may still work, but slowly.")
    : level === "green"
      ? "Expected to fit on this PC's NPU, judged from its size. It has not necessarily been tried here: the badge beside it shows where it actually ran."
      : level === "amber"
        ? "Might fit. MKMN may shorten the conversation length so that it does."
        : "Too large for this PC's NPU.";
  return <span className={`badge ${level}`} title={hint}>{label}</span>;
}

function InstallButton({ item, progress, onInstall, onCancel, onUninstall, onUse, selected }: {
  item: CatalogItem; progress?: InstallProgress; selected: boolean;
  onInstall: () => void; onCancel: () => void; onUninstall: () => void; onUse: () => void;
}) {
  // Removing deletes gigabytes that take long to download again: one click asks, the second removes
  // (two models were deleted one click each, right beside a Use that seemed to do nothing).
  const [confirming, setConfirming] = useState(false);
  const busy = progress && (progress.phase === "downloading" || progress.phase === "checking");
  if (busy) {
    return (
      <div className="install-progress">
        <div className="track smooth active"><div className={`fill ${progress.percent === null ? "indet" : ""}`} style={{ ["--p" as string]: (progress.percent ?? 5) / 100 }} /></div>
        <span className="small muted">{progress.percent !== null ? `${Math.round(progress.percent)}%` : progress.line ?? "Working…"}</span>
        <IconButton d={ICONS.close} label="Cancel" onClick={onCancel} />
      </div>
    );
  }
  if (item.installed) {
    return (
      <div className="row">
        {confirming ? (
          <span className="row" role="group" aria-label={`Remove ${item.entry.name}?`}>
            <span className="small">Remove {item.entry.name}?</span>
            <button className="ghost danger" onClick={() => { setConfirming(false); onUninstall(); }}>Remove</button>
            <button className="ghost" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <>
            <button className={selected ? "ghost" : "primary"} onClick={onUse}>{selected ? "In use" : "Use"}</button>
            <IconButton d={ICONS.trash} label="Uninstall" onClick={() => setConfirming(true)} />
          </>
        )}
      </div>
    );
  }
  const warn = item.verdict.level === "red";
  return <button className={warn ? "ghost" : "primary"} onClick={onInstall}>{warn ? "Install anyway" : "Install"}</button>;
}

type Check = { phase: "testing" | "done" | "failed"; step?: string };

/** The local benchmark measurements the model cards show: the parsed hardware.json
 *  profiles plus the compute target whose run should display (the app's current one). */
export interface BenchProps { profiles: Record<string, BenchProfile>; preferredCompute?: string; /** Every listed model: a card with no measurement of its own may show its Foundry Local variant's. */ rows?: CatalogItem[] }

const benchSelOf = (bench: BenchProps | undefined, item: CatalogItem): BenchSelection | null =>
  bench ? selectBenchRun(benchProfileFor(bench.profiles, benchRefsFor(item)), bench.preferredCompute) : null;

/**
 * The LOCAL measurement beside the model name, with the full facts (TTFT, compute,
 * power mode, date, verification) in an accessible disclosure. Nothing is claimed
 * beyond the run's own evidence: the headline names the compute target, and "verified"
 * appears only in the details of a run that recorded supporting evidence. No valid
 * local result → the chip renders nothing (the neutral unmeasured state).
 */
function BenchChip({ sel, preferredCompute }: { sel: BenchSelection | null; preferredCompute?: string }) {
  if (!sel) return null;
  const reasons = benchOutdatedReasons(sel.run, { preferredCompute });
  return (
    <details className="bench-chip">
      <summary title={benchHeadline(sel.run)}>On this PC: about {wordsPerSec(sel.run.decodeTokPerSec)} words/s on {COMPUTE_LABEL[sel.run.compute as keyof typeof COMPUTE_LABEL] ?? sel.run.compute}</summary>
      <div className="muted small">{benchDetailLines(sel.run).join(" · ")}</div>
      <div className="muted small">
        {sel.basis === "current-compute"
          ? "The latest speed test on this PC for the chip in use (not the best one ever)."
          : "The latest speed test on this PC (none yet for the chip in use; not the best one ever)."}
      </div>
      {reasons.length > 0 && <div className="warn small">May be outdated: {reasons.join("; ")}.</div>}
    </details>
  );
}

/** No measurement of this build, but its Foundry Local variant was measured: shown as that variant's, never as this one's. */
function RelatedChip({ item, bench, own }: { item: CatalogItem; bench?: BenchProps; own: BenchSelection | null }) {
  if (own || !bench?.rows) return null;
  const rel = relatedVariantRun(item, bench.rows, bench.profiles);
  if (!rel) return null;
  return <span className="bench-chip related muted small" title={`Measured on this PC with the Foundry Local build of this model, not with this build. ${benchDetailLines(rel.run).join(" · ")}`}>{rel.label}</span>;
}

/** The evidence context the model cards render: the cache manifest, the per-device records and what "here" means. */
interface EvidenceProps { manifest: ArtifactManifestEntry[]; records: EvidenceRecord[]; ctx: EvidenceContext }

function Card({ item, progress, selected, check, ev, bench, ...rest }: { item: CatalogItem; progress?: InstallProgress; selected: boolean; check?: Check; ev?: EvidenceProps; bench?: BenchProps; onInstall: () => void; onCancel: () => void; onUninstall: () => void; onUse: () => void }) {
  const { entry, verdict } = item;
  const benchSel = benchSelOf(bench, item);
  const bp = badgePlacement(item, benchSel?.run.compute);
  return (
    <div className={`card ${item.hidden ? "dim" : ""}`}>
      <div className="card-top">
        <div>
          <div className="card-title">{entry.name} {entry.default && <span className="tag">default</span>} <BenchChip sel={benchSel} preferredCompute={bench?.preferredCompute} /> <RelatedChip item={item} bench={bench} own={benchSel} /></div>
          <div className="muted small">{entry.role} · {entry.sizeApprox ? "about " : ""}{entry.sizeGB} GB download</div>
        </div>
        <div className="row"><EngineBadge foundry={isFoundry(entry)} installed={item.installed} /><ScoreChip score={scoreOf(entry)} /><RunsBadge on={bp.on} native={isNativeNpu(item)} here={bp.here} /><Badge level={verdict.level} foundry={isFoundry(entry)} /></div>
      </div>
      {ev && <EvidenceBadges ref={item.ref} manifest={ev.manifest} records={ev.records} ctx={ev.ctx} />}
      {check?.phase === "testing" && <div className="muted small" role="status">Testing this model on your NPU to configure it for the best performance{check.step ? `: ${check.step}` : ""}…</div>}
      {check?.phase === "failed" && <div className="warn small">This model did not load on this PC under any setting. The log is in Settings → Developer → NPU load test.</div>}
      <CapBadges entry={entry} />
      {/* A placement nobody measured must point at the things that measure it. */}
      {!bp.on && <details className="muted small"><summary>Not tried on this PC yet</summary>{measureHint()}</details>}
      {/* The fit rules' reasons and the file format are technical: one click away, not on every card. */}
      <details className="small model-details">
        <summary className="muted">Details</summary>
        <div className="muted small">Format: {isFoundry(entry) ? "Foundry Local (ONNX)" : entry.engine === "qairt" ? "native NPU bundle" : entry.quant ?? "GGUF"}</div>
        {entry.measured && <div className="muted small">On MKMN's test PC: about {wordsPerSec(entry.measured.tokPerSec)} words/s ({entry.measured.tokPerSec} tokens a second)</div>}
        {verdict.contextTokens > 0 && <div className="muted small">Conversation length: about {(Math.round(verdict.contextTokens * 0.75 / 100) * 100).toLocaleString()} words ({verdict.contextTokens} tokens)</div>}
        <ul className="reasons">{verdict.reasons.filter((r) => !r.startsWith("NPU memory limit is an estimate")).slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}</ul>
      </details>
      <div className="card-foot">
        <div className="muted small">
          {/* Local measurement vs bundled reference: the chip beside the name is THIS PC's
              own benchmark; these numbers are the app's shipped reference and an estimate. */}
          {!benchSel && <span>not measured on this PC · </span>}
          {verdict.estTokPerSec !== null && <span title={`${verdict.estTokPerSec} tokens a second, estimated`}>about {wordsPerSec(verdict.estTokPerSec)} words/s (estimate) · </span>}
          <span>needs about {verdict.estNpuGB} GB of NPU memory</span>
        </div>
        {progress?.error && <div className="error-box"><strong>{progress.error.title}</strong><div>{progress.error.fix}</div></div>}
        <InstallButton item={item} progress={progress} selected={selected} onInstall={rest.onInstall} onCancel={rest.onCancel} onUninstall={rest.onUninstall} onUse={rest.onUse} />
      </div>
      {entry.testNote && <div className="muted small note">{entry.testNote}</div>}
    </div>
  );
}

/** One model on one line: name, local measurement, engine, where it runs, score, speed, size, and the button. Small enough to scan a long list. */
function ModelRow({ item, progress, selected, check, quiet, alt, bench, ...rest }: { item: CatalogItem; progress?: InstallProgress; selected: boolean; check?: Check; quiet?: boolean; alt?: CatalogItem; bench?: BenchProps; onInstall: () => void; onCancel: () => void; onUninstall: () => void; onUse: () => void }) {
  const { entry } = item;
  const sc = scoreOf(entry);
  const bp = badgePlacement(item, benchSelOf(bench, item)?.run.compute);
  return (
    <div className={`mrow ${selected ? "selected" : ""}`}>
      <div className="mrow-name">
        <strong>{entry.name.replace(/\s*\(Foundry Local\)/i, "")}</strong>
        <BenchChip sel={benchSelOf(bench, item)} preferredCompute={bench?.preferredCompute} />
        <RelatedChip item={item} bench={bench} own={benchSelOf(bench, item)} />
        <div className="muted small">{entry.role}</div>
        {alt && <div className="small mrow-alt">{altLine(item, alt)}</div>}
      </div>
      <div className="mrow-badges">
        <EngineBadge foundry={isFoundry(entry)} installed={item.installed} />
        {!(quiet && !bp.on) && <RunsBadge on={bp.on} native={isNativeNpu(item)} here={bp.here} />}
        <ScoreChip score={sc} />
      </div>
      {/* The speed column is the BUNDLED reference (a test PC's numbers, shipped with the
          app): labeled as such, so it can never be mistaken for a measurement of this PC. */}
      <span className="mrow-speed muted small" title={sc?.tokPerSec ? `Typical speed on MKMN's own test PC, not measured on this PC (${sc.tokPerSec} tokens a second). This PC's own speed test appears beside the name once one has run.` : undefined}>
        {sc?.tokPerSec ? `test PC · about ${wordsPerSec(sc.tokPerSec)} words/s` : ""}
      </span>
      <span className="mrow-size muted small">{entry.sizeApprox ? "about " : ""}{entry.sizeGB} GB</span>
      <div className="mrow-act"><InstallButton item={item} progress={progress} selected={selected} onInstall={rest.onInstall} onCancel={rest.onCancel} onUninstall={rest.onUninstall} onUse={rest.onUse} /></div>
      {check?.phase === "testing" && <div className="mrow-note muted small" role="status">Testing this model on your NPU{check.step ? `: ${check.step}` : ""}…</div>}
      {check?.phase === "failed" && <div className="mrow-note warn small">This model did not load on this PC under any setting.</div>}
      {progress?.error && <div className="mrow-note error-box"><strong>{progress.error.title}</strong><div>{progress.error.fix}</div></div>}
    </div>
  );
}

/** The three explicit size-for-task choices, with the evidence behind each candidate. The recommendation is the SMALLEST candidate whose quality was evaluated on this device — never the biggest model the RAM allows. */
function TierChoices({ ev, items, selectedId, onUse }: { ev: EvidenceProps; items: CatalogItem[]; selectedId: string | null; onUse: (id: string) => void }) {
  const entries = items
    .filter((i) => !i.hidden && !isDynamicId(i.entry.id))
    .map((i) => {
      // The manifest entry carries the cache's own facts (size, revision, compiled
      // context): the catalog entry supplies the parameter count for tiering. The
      // candidate keeps ITS OWN selectable ref — replacing it with the
      // repository-level manifest ref made tier buttons choose whichever item the
      // collapsed identity matched first.
      const m = ev.manifest.find((x) => x.ref === manifestRefOf(i.ref, ev.manifest));
      return {
        ref: i.ref,
        name: i.entry.name,
        plugin: i.entry.engine === "qairt" ? "qairt" : "llama_cpp",
        precisions: i.entry.quant ? [i.entry.quant] : [],
        paramsB: i.entry.paramsB,
        totalBytes: m?.totalBytes ?? 0,
        revision: m?.revision ?? null,
      };
    });
  const choices = tierChoices(entries, ev.records, ev.ctx);
  const rec = recommendedDefault(entries, ev.records, ev.ctx);
  return (
    <section>
      <h2>Choices by size</h2>
      <div className="notes">
        {rec.ref !== null
          ? <div>The smallest model that meets the quality bar on this device's evaluation ({rec.tier} tier): <strong>{rec.name}</strong>. A bigger model is a choice, not a default.</div>
          : <div>The everyday default stays provisional: {rec.ref === null ? rec.reason : ""}</div>}
      </div>
      <div className="tier-grid">
        {TIERS.map((t) => {
          const choice = choices[t.id];
          return (
            <div key={t.id} className="card tier-card">
              <div className="card-title">{t.label}</div>
              <div className="muted small">{t.purpose}</div>
              {choice.candidates.length === 0 && <div className="muted small">No catalog model in this range.</div>}
              <ul className="tier-list">
                {choice.candidates.map((c) => (
                  <li key={c.ref}>
                    <button className={selectedId && items.find((i) => i.ref === c.ref)?.entry.id === selectedId ? "ghost" : "link"} onClick={() => onUse(items.find((i) => i.ref === c.ref)?.entry.id ?? "")}>
                      {c.name}
                    </button>
                    <span className="muted small"> {c.precisions.join("/") || c.plugin}{c.totalBytes > 0 ? ` · ${(c.totalBytes / 1024 ** 3).toFixed(1)} GB` : ""}</span>
                    {c.provisional && <span className="badge ev stale" title={c.provisionalReason ?? "No quality evaluation on this device backs this choice yet."}>provisional</span>}
                  </li>
                ))}
              </ul>
              {choice.provisional && <div className="muted small">Nothing in this tier has been quality-evaluated on this device yet, so the choice is provisional.</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const manifestRefOf = (ref: string, manifest: ArtifactManifestEntry[]): string | undefined => {
  // Exact identity first; a precision-less catalog ref matches the manifest's
  // ONLY build of that base. Distinct quantizations never collapse (F06).
  const canon = (s: string) => s.toLowerCase().replace(/^ai-hub-models\//, "qualcomm/");
  const base = (s: string) => canon(s).replace(/:[^:]*$/, "").replace(/-gguf$/, "");
  const want = canon(ref);
  const refs = manifest.map((m) => m.ref);
  const exact = refs.find((r) => canon(r) === want);
  if (exact) return exact;
  if (!want.includes(":")) {
    const bases = refs.filter((r) => base(r) === base(want));
    if (bases.length === 1) return bases[0];
  }
  return undefined;
};

/** The model in use and what is installed, said first: the library opens on what the
 *  person has before the catalogue of everything they could add. */
export function currentModelLine(items: CatalogItem[], selectedId: string | null): { current: string; installed: number } {
  const sel = selectedId ? items.find((i) => i.entry.id === selectedId) : undefined;
  const installed = items.filter((i) => i.installed && !i.hidden).length;
  const current = sel ? sel.entry.name : selectedId ? selectedId : installed ? "None chosen yet: press Use on one of your models" : "None installed yet: install one under Recommended";
  return { current, installed };
}

export function Models({ items, hw, onChanged, onUse, selectedId, bench: benchIn, embedded }: { items: CatalogItem[]; hw: HardwareProfile | null; onChanged: () => void; onUse: (id: string) => void; selectedId: string | null; showK: boolean; bench?: BenchProps;
  /** Drawn inside the Settings page (its Models group): the group head carries the title. */
  embedded?: boolean }) {
  // every listed model rides along, so a card with no measurement of its own can show its Foundry Local variant's
  const bench: BenchProps | undefined = benchIn ? { ...benchIn, rows: items } : undefined;
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"curated" | "explore">("curated");
  const [exploreQuery, setExploreQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [inspect, setInspect] = useState<HfInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("score");
  const [engine, setEngine] = useState<EngineFilter>("all");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [ev, setEv] = useState<EvidenceProps | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [{ manifest, records }, info] = await Promise.all([api().modelEvidence(), api().appInfo()]);
        if (!alive || !hw) return;
        // "Here" is this PC and this runtime: the two things that make evidence stale elsewhere.
        setEv({ manifest, records, ctx: { machine: `${hw.chipName}, ${hw.ramGB} GB`, runtimeVersion: info.geniexVersion ?? "" } });
      } catch { /* evidence display is best-effort: the cards still render */ }
    })();
    return () => { alive = false; };
  }, [hw]);

  const [checks, setChecks] = useState<Record<string, Check>>({});
  useEffect(() => api().onModelCheck((p) => {
    setChecks((s) => ({ ...s, [p.ref]: { phase: p.phase, step: p.step } }));
    if (p.phase !== "testing") onChanged();
  }), [onChanged]);
  useEffect(() => api().onInstall((p) => {
    setProgress((s) => ({ ...s, [p.ref]: p }));
    if (p.phase === "done") onChanged();
  }), [onChanged]);

  const doInstall = (e: CatalogEntry) => { void api().install(e).catch((err) => setErr((err as Error).message)); };
  // ---- local import (`geniex pull <name> --local-path …`): a model folder or an AI Hub .zip
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importName, setImportName] = useState("");
  const [importType, setImportType] = useState<"" | "llm" | "vlm">("");
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const pickLocal = async (kind: "folder" | "zip") => {
    setImportErr(null);
    try {
      const p = await api().geniexPickLocal(kind);
      if (!p) return;
      setImportPath(p);
      // A default name from the folder/zip: `local/<basename>`, the namespace geniex
      // treats as user-owned (never confused with a hub repo of the same shape).
      const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
      const clean = base.replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
      setImportName(`local/${clean.toLowerCase()}`);
    } catch (e) { setImportErr((e as Error).message); }
  };
  const runImport = async () => {
    if (!importPath || !importName.trim() || importBusy) return;
    setImportBusy(true);
    setImportErr(null);
    try {
      const r = await api().geniexPullLocal({ path: importPath, name: importName.trim(), type: importType || undefined });
      if (!r.ok && !r.cancelled) setImportErr(r.error ?? "The import did not finish.");
      if (r.ok) { setImportPath(null); setImportName(""); setImportType(""); onChanged(); }
    } catch (e) { setImportErr((e as Error).message); }
    setImportBusy(false);
  };
  const actions = (item: CatalogItem) => ({
    onInstall: () => doInstall(item.entry),
    onCancel: () => void api().cancelInstall(item.ref),
    onUninstall: async () => {
      setErr(null);
      try {
        const r = await api().uninstall(item.entry);
        if (!r.ok) setErr(`Could not remove ${item.entry.name}: ${r.message || "unknown error"}`);
      } catch (e) { setErr(`Could not remove ${item.entry.name}: ${(e as Error).message}`); }
      onChanged();
    },
    onUse: () => onUse(item.entry.id)
  });

  /** Whatever was typed or pasted: a model (link, command, id) is opened and judged, a name searches every source. */
  const open = async (text: string) => {
    const q = text.trim();
    setErr(null); setNote(null); setInspect(null);
    if (!q) { setExploreQuery(""); setTab("explore"); return; }
    setBusy(true);
    try {
      const r = await api().resolveModel(q);
      if (r.type === "model") { setInspect(r.inspection); onChanged(); window.scrollTo?.({ top: 0, behavior: "smooth" }); }
      else { setExploreQuery(r.query); setNote(r.note); setTab("explore"); }
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const search = () => open(query);

  // Plain words typed while exploring search as you type; links, commands and ids still wait for Enter.
  useEffect(() => {
    const q = query.trim();
    if (tab !== "explore" || /[/:\\]/.test(q)) return;
    const t = setTimeout(() => setExploreQuery(q), 350);
    return () => clearTimeout(t);
  }, [query, tab]);

  const shown = items.filter((i) => !i.hidden && !isDynamicId(i.entry.id));
  const mine = shown.filter((i) => !i.custom);
  const top = recommendedModels(mine);
  const everywhere = arrangeModels(mine, { sortBy: "score", engine: "all", installedOnly: false }).alt;
  const arranged = arrangeModels(mine, { sortBy, engine, installedOnly });
  const notTop = arranged.tested.filter((i) => !top.some((t) => t.entry.id === i.entry.id));
  // the app is built for the NPU: what was seen running partly or wholly elsewhere is kept apart, folded, never mixed in with the rest
  const elsewhere = notTop.filter((i) => { const on = placementOf(i); return !!on && on !== "npu"; });
  const rest = notTop.filter((i) => !elsewhere.includes(i));
  const hidden = items.filter((i) => i.hidden);
  const inspected = inspect?.entry ? items.find((i) => i.entry.id === inspect.entry!.id) : undefined;

  return (
    <div className={embedded ? "models-embedded" : "page"}>
      {!embedded && <h1>Models</h1>}
      {(() => { const c = currentModelLine(items, selectedId); return (
        <div className="current-model" role="status">
          <div><span className="muted small">Current model</span><div className="current-model-name">{c.current}</div></div>
          {c.installed > 0 && <button type="button" className="ghost" onClick={() => { setTab("curated"); setInstalledOnly(true); requestAnimationFrame(() => document.getElementById("models-all")?.scrollIntoView({ block: "start" })); }}>Your installed models ({c.installed})</button>}
        </div>
      ); })()}
      <p className="muted small">This library is the one place to install, remove and choose models. <strong>Use</strong> makes a model the one MKMN chats with — one selection for the whole app (new chats and every chat that has not chosen its own).</p>

      <div className="searchbar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Search every source, or paste any link, command or id" />
        <button className="primary" onClick={() => void search()} disabled={busy}>{busy ? "Checking…" : "Search"}</button>
      </div>
      {err && <div className="error-box">{err}</div>}
      <div className="notes">
        {note && <div>{note}</div>}
      </div>

      {inspect && (
        <section>
          <h2>{inspect.repo}</h2>
          {inspect.chosen && inspect.verdict && inspected && (
            <>
              <div className="notes">
                {inspect.files.length ? <>File: {inspect.chosen.path} ({inspect.chosen.sizeGB} GB){inspect.gguf ? ` · architecture ${inspect.gguf.architecture}` : ""}</>
                  : <>{inspect.chosen.quant === "native" ? "Native bundle" : `Version ${inspect.chosen.quant}`} · about {inspect.chosen.sizeGB} GB (estimated)</>}
              </div>
              {inspect.notes.length > 0 && <details className="notes"><summary>Details</summary>{inspect.notes.map((n, i) => <div key={i}>{n}</div>)}</details>}
              <Card item={inspected} ev={ev ?? undefined} bench={bench} progress={progress[inspected.ref]} check={checks[inspected.ref]} selected={selectedId === inspected.entry.id} {...actions(inspected)} />
            </>
          )}
        </section>
      )}

      <Seg role="tablist">
        <button className={tab === "curated" ? "on" : ""} onClick={() => setTab("curated")}>Curated models</button>
        <button className={tab === "explore" ? "on" : ""} onClick={() => setTab("explore")}>Explore all</button>
      </Seg>

      {tab === "explore" && <Explore query={exploreQuery} busy={busy} onOpen={(input) => void open(input)} />}

      {tab === "curated" && shown.some((i) => i.custom) && (
        <section>
          <h2>Your models</h2>
          <div className="mlist">
            {shown.filter((i) => i.custom).map((i) => <ModelRow key={i.entry.id} item={i} bench={bench} progress={progress[i.ref]} check={checks[i.ref]} selected={selectedId === i.entry.id} {...actions(i)} />)}
          </div>
        </section>
      )}
      {tab === "curated" && (
        <section id="models-import">
          <h2>Import from this PC</h2>
          <p className="muted small">A model folder already on this PC (a llama.cpp <code>.gguf</code> set) or an AI Hub model as a <code>.zip</code> file: it is copied into the runtime's cache and behaves exactly like an installed model.</p>
          <div className="row">
            <button type="button" className="ghost" onClick={() => void pickLocal("folder")} disabled={importBusy}>Choose a folder…</button>
            <button type="button" className="ghost" onClick={() => void pickLocal("zip")} disabled={importBusy}>Choose an AI Hub .zip…</button>
          </div>
          {importPath && (
            <div className="row" style={{ marginTop: 8 }}>
              <label className="small" style={{ maxWidth: 380 }}>
                <span>Install as</span>
                <input value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="local/my-model" />
              </label>
              <label className="small" style={{ maxWidth: 220 }}>
                <span>Model type</span>
                <select value={importType} onChange={(e) => setImportType(e.target.value as "" | "llm" | "vlm")}>
                  <option value="">Let the runtime detect it</option>
                  <option value="llm">Text only (LLM)</option>
                  <option value="vlm">Text and images (VLM)</option>
                </select>
              </label>
              <button type="button" className="primary" onClick={() => void runImport()} disabled={importBusy || !importName.trim()}>
                {importBusy ? (progress[importName]?.line ?? "Importing…") : "Import"}
              </button>
              <button type="button" className="ghost" onClick={() => { setImportPath(null); setImportErr(null); }} disabled={importBusy}>Cancel</button>
            </div>
          )}
          {importPath && progress[importName] && (
            <div className="install-progress" style={{ marginTop: 8 }}>
              <div className="track smooth active"><div className={`fill ${progress[importName]!.percent === null ? "indet" : ""}`} style={{ ["--p" as string]: (progress[importName]!.percent ?? 5) / 100 }} /></div>
              <span className="small muted">{progress[importName]!.percent !== null ? `${Math.round(progress[importName]!.percent!)}%` : progress[importName]!.line ?? "Working…"}</span>
            </div>
          )}
          {importPath && progress[importName]?.error && <div className="error-box" style={{ marginTop: 8 }}><strong>{progress[importName]!.error!.title}</strong><div>{progress[importName]!.error!.fix}</div></div>}
          {importErr && <div className="error-box" style={{ marginTop: 8 }}>{importErr}</div>}
        </section>
      )}
      {tab === "curated" && <><DynamicSection hw={hw} selectedId={selectedId} onUse={onUse} onChanged={onChanged} />
      <div className="notes">
        {hw?.npuBudgetSource === "estimated" && <div>NPU memory limit: {hw.npuBudgetGB} GB (estimated). Set the exact value in Settings → Speed & memory → Memory use.</div>}
      </div>

      {top.length > 0 && (
        <section>
          <h2>Recommended</h2>
          <div className="mlist">
            {top.map((i) => <ModelRow alt={everywhere[i.entry.id]} key={i.entry.id} item={i} bench={bench} progress={progress[i.ref]} check={checks[i.ref]} selected={selectedId === i.entry.id} {...actions(i)} />)}
          </div>
        </section>
      )}

      {ev && <TierChoices ev={ev} items={items} selectedId={selectedId} onUse={onUse} />}

      <section id="models-all">
        <h2>All models</h2>
        <div className="row small mlist-bar">
          <label>Sort by{" "}
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
              <option value="score">Best score</option>
              <option value="speed">Fastest</option>
              <option value="size">Smallest</option>
              <option value="name">Name</option>
            </select>
          </label>
          <div className="seg" role="group" aria-label="Engine">
            {([["all", "All"], ["geniex", "GenieX"], ["foundry", "Foundry Local"]] as const).map(([id, label]) => <button key={id} className={engine === id ? "on" : ""} onClick={() => setEngine(id)}>{label}</button>)}
          </div>
          <label className="check"><input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} /> Installed only</label>
        </div>
        {items.length === 0 && <SkeletonRows count={6} card />}
        <div className="mlist">
          {rest.map((i) => <ModelRow alt={arranged.alt[i.entry.id]} key={i.entry.id} item={i} bench={bench} progress={progress[i.ref]} check={checks[i.ref]} selected={selectedId === i.entry.id} {...actions(i)} />)}
          {items.length > 0 && rest.length === 0 && !elsewhere.length && !arranged.tested.length && <div className="muted small">No tested model matches this filter.</div>}
        </div>
        {elsewhere.length > 0 && (
          <details className="section-fold">
            <summary>Not fully on the NPU ({elsewhere.length}): hybrid, GPU or CPU</summary>
            <div className="mlist">{elsewhere.map((i) => <ModelRow alt={arranged.alt[i.entry.id]} key={i.entry.id} item={i} bench={bench} progress={progress[i.ref]} check={checks[i.ref]} selected={selectedId === i.entry.id} {...actions(i)} />)}</div>
          </details>
        )}
        {arranged.unscored.length > 0 && (
          <details className="section-fold">
            <summary>Not measured ({arranged.unscored.length}): no score yet</summary>
            <div className="mlist">{arranged.unscored.map((i) => <ModelRow quiet key={i.entry.id} item={i} bench={bench} progress={progress[i.ref]} check={checks[i.ref]} selected={selectedId === i.entry.id} {...actions(i)} />)}</div>
          </details>
        )}
      </section>


      {hidden.length > 0 && (
        <details className="section-fold">
          <summary>Known not to work ({hidden.length})</summary>
          <div className="grid">
            {hidden.map((i) => <Card key={i.entry.id} item={i} ev={ev ?? undefined} bench={bench} progress={progress[i.ref]} check={checks[i.ref]} selected={false} {...actions(i)} />)}
          </div>
        </details>
      )}</>}
    </div>
  );
}
