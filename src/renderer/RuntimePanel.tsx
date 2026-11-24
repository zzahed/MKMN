import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { RadioSeg } from "./RadioSeg";
import { RUNTIME_FIELD_RANGES, parseRuntimeInt, type RuntimeField } from "../core/settingsUi";
import type { RuntimeInfo, AdaptiveStatusView } from "../shared/api";
import type { SetupState } from "../core/setup";
import type { ComputeTarget, RuntimeSettings, Settings } from "../shared/types";
import { readObj } from "../shared/settingsSchema";
import { AUTO_GOALS, COMPUTE_LABEL, type AutoGoal } from "../core/adaptiveCompute";

function suggestGpuLayers(modelGB: number, layers: number, vramGB: number, reserveGB = 1.2): number {
  if (!(modelGB > 0) || !(layers > 0) || !(vramGB > 0)) return -1;
  const perLayer = modelGB / layers;
  const fit = Math.floor((vramGB - reserveGB) / perLayer);
  if (fit >= layers) return -1;
  return Math.max(0, fit);
}

const TARGETS: { id: ComputeTarget; label: string }[] = [{ id: "npu", label: "NPU" }, { id: "hybrid", label: "CPU + NPU" }, { id: "gpu", label: "GPU" }, { id: "cpu", label: "CPU" }];
const PLACE: Record<string, string> = { npu: "the NPU", hybrid: "the NPU and the processor", gpu: "the graphics card", cpu: "the processor" };

/** The last automatic choice in one plain line, from the decision's own facts. The raw
 *  label, reasons and refused options stay one click away under Technical details. */
export function plainLastChoice(last: { config: { compute: string } | null; reason: string[]; provisional: boolean }): { where: string; why: string } {
  const where = last.config ? `Ran on ${PLACE[last.config.compute] ?? last.config.compute}` : "No choice made yet";
  const said = last.reason.join(" ");
  const why = last.provisional ? "Not tested on this PC yet, so MKMN used the usual choice."
    : /already resident/i.test(said) ? "Already loaded, so nothing changed."
    : /staying resident/i.test(said) ? "Stayed where it was: switching would not have been noticeably faster."
    : "Chosen from how this PC has performed.";
  return { where, why };
}

/** RuntimeInfo.choices only knows npu/gpu/cpu: hybrid rides on geniex's availability (it is geniex's own -c hybrid). */
const choiceFor = (id: ComputeTarget, info: RuntimeInfo | null) => (id === "hybrid" ? info?.choices.find((c) => c.id === "npu") : info?.choices.find((c) => c.id === id));

/** An optional whole number: empty = not set (llama.cpp decides). The draft stays in
 *  the field when invalid (with an inline error) so it can be corrected — it is never
 *  silently cleared, and nothing non-finite can reach the settings. */
function Num({ value, onSave, field, placeholder, wide }: { value: number | undefined; onSave: (n: number | undefined) => void; field: RuntimeField; placeholder?: string; wide?: boolean }) {
  const spec = RUNTIME_FIELD_RANGES[field];
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [err, setErr] = useState<string | null>(null);
  // an outside change (save round-trip, reset) refreshes the draft; an invalid one is
  // only kept while it IS the draft
  useEffect(() => { setDraft(value === undefined ? "" : String(value)); }, [value]);
  const commit = () => {
    const r = parseRuntimeInt(draft, field);
    if (!r.ok) { setErr(r.error); return; } // invalid: keep the draft for correction, save nothing
    setErr(null);
    if (r.value !== value) onSave(r.value);
  };
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <input
        type="number" style={wide ? { width: 110 } : { width: 90 }} value={draft} placeholder={placeholder}
        aria-label={spec.label} aria-invalid={err ? true : undefined} aria-describedby={err ? `rt-err-${field}` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      />
      {err && <span className="warn small" role="alert" id={`rt-err-${field}`}>{err}</span>}
    </span>
  );
}

/** Where the chat model runs: an automatic goal (this device's measurements decide per request) or a manual device pick. */
export function RuntimePanel({ settings, onSave, changed }: { settings: Settings; onSave: (p: Partial<Settings>) => Promise<void> | void; changed?: ReadonlySet<string> }) {
  /** The Changed dot, passed down from the Settings page: the stored value differs
   *  from the schema default (settingsSchema.changedKeys is the one authority). */
  const dot = (k: string) => (changed?.has(k) ? <span className="changed-dot" title="Changed from the default" /> : null);
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [adaptive, setAdaptive] = useState<AdaptiveStatusView | null>(null);
  const [step, setStep] = useState<SetupState["steps"][number] | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [vram, setVram] = useState("");
  const [layers, setLayers] = useState("");
  const [size, setSize] = useState("");
  const rt: RuntimeSettings = readObj<RuntimeSettings>(settings, "runtime");
  const auto = settings.computeMode === "auto";
  const goal: AutoGoal = AUTO_GOALS.some((g) => g.id === settings.autoGoal) ? (settings.autoGoal as AutoGoal) : "balanced";
  const target: ComputeTarget = settings.compute;
  const off = target === "gpu" || target === "cpu";

  const refresh = useCallback(() => {
    void api().runtimeInfo().then(setInfo).catch(() => undefined);
    void api().adaptiveStatus().then(setAdaptive).catch(() => setAdaptive(null));
  }, []);
  useEffect(() => { refresh(); }, [refresh, settings.compute, settings.computeMode, settings.autoGoal, settings.runtime]);
  useEffect(() => api().onSetup((s) => { const l = s.steps.find((x) => x.id === "llama") ?? null; setStep(l); if (l?.state === "done") refresh(); }), [refresh]);

  const save = (patch: Partial<RuntimeSettings>) => {
    const next: RuntimeSettings = { ...rt, ...patch };
    for (const k of Object.keys(next) as (keyof RuntimeSettings)[]) if (next[k] === undefined) delete next[k];
    void onSave({ runtime: next });
  };
  const pick = (id: ComputeTarget) => { void onSave({ compute: id, computeMode: "manual" }); };

  const gpuVram = info?.gpus.find((g) => g.vramGB)?.vramGB ?? null;
  const installing = step?.state === "running" || step?.state === "pending";
  const choice = TARGETS.find((t) => t.id === target) ?? TARGETS[0];
  const cur = choiceFor(choice.id, info);

  return (
    <section>
      <h2>Where the chat model runs</h2>
      <p className="muted small">Auto chooses where the model runs (the NPU, the processor or the graphics card) for each message, based on how this PC has performed. Manual lets you choose.</p>

      <div className="role-row">
        <div><strong>Mode</strong>{dot("computeMode")}</div>
        <RadioSeg
          ariaLabel="Performance mode"
          value={auto ? "auto" : "manual"}
          onChange={(m) => void onSave({ computeMode: m })}
          options={[{ id: "auto", label: "Auto" }, { id: "manual", label: "Manual" }]}
        />
      </div>

      {auto && (
        <>
          <div className="role-row">
            <div><strong>Goal</strong>{dot("autoGoal")}</div>
            <RadioSeg
              ariaLabel="Automatic goal"
              value={goal}
              onChange={(g) => void onSave({ autoGoal: g })}
              options={AUTO_GOALS.map((g) => ({ id: g.id, label: g.label, why: g.why }))}
            />
          </div>
          <div className="muted small">{AUTO_GOALS.find((g) => g.id === goal)?.why}</div>
          <div className="card-lite" style={{ marginTop: 8 }}>
            <strong className="small">Last choice</strong>
            {adaptive?.last ? (
              <div className="small" style={{ marginTop: 4 }}>
                {(() => { const p = plainLastChoice(adaptive.last); return <><div>{p.where}</div><div className="muted small">{p.why}</div></>; })()}
                <details className="small" style={{ marginTop: 4 }}>
                  <summary className="muted">Technical details</summary>
                  <div className="muted small">{adaptive.last.label}</div>
                  {adaptive.last.reason.map((r, i) => <div key={i} className="muted small">{r}</div>)}
                  {adaptive.last.gatedOut.map((g) => <div key={g.id} className="muted small">Not available: {COMPUTE_LABEL[g.compute as keyof typeof COMPUTE_LABEL] ?? g.compute}. {g.why}</div>)}
                </details>
              </div>
            ) : (
              <div className="muted small" style={{ marginTop: 4 }}>No message sent in Auto yet. After your next message, the choice appears here.</div>
            )}
          </div>
        </>
      )}

      {!auto && (
        <>
          <div className="role-row">
            <div><strong>Chat model</strong>{dot("compute")}<div className="muted small">{settings.selectedModelId ? "Selected in Models" : "none selected"}</div></div>
            <RadioSeg
              ariaLabel="Chat model device"
              value={choice.id}
              onChange={pick}
              options={TARGETS.map((t) => {
                const c = choiceFor(t.id, info);
                const unavailable = c && !c.available;
                return { id: t.id, label: t.label + (unavailable ? " (not available)" : ""), why: c?.note };
              })}
            />
          </div>
          {/* the NPU card below says what the NPU is: its engine notes would only repeat it */}
          {cur && !cur.available && <div className="warn small">{cur.note} You can still choose it.</div>}
          {cur && cur.available && off && <div className="muted small">{cur.note}</div>}
          {choice.id === "hybrid" && <div className="muted small">CPU + NPU splits the model between the two: most of it on the NPU, the rest on the CPU. It works with most downloaded models, but not with models built only for the NPU.</div>}
          {info && off && <div className="muted small">{info.note}</div>}
        </>
      )}

      {!off && (
        <div className="card-lite npu-note" style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong className="npu-note-title">⚡ Runs on the NPU</strong>
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            The NPU is the part of this PC's chip made for AI. It answers quickly and uses little power. MKMN prefers model versions built for it.
          </div>
        </div>
      )}

      {off && info && (
        <div className="card-lite" style={{ marginTop: 10 }}>
          {info.llamaAvailable === false ? (
            // this build serves everything through GenieX: the llama controls would do
            // nothing, so their absence is stated instead of shown as dead buttons
            <div className="role-row">
              <div>
                <strong>Engine for the processor and graphics card</strong>
                <div className="muted small">Nothing to install: this version of MKMN runs models on the processor and graphics card by itself.</div>
              </div>
            </div>
          ) : (
            <div className="role-row">
              <div>
                <strong>Engine for the processor and graphics card</strong>
                <div className="muted small" title={info.llamaPath ? `llama.cpp ${info.llamaVersion ?? ""} · ${info.llamaPath}` : "llama.cpp"}>{info.llamaPath ? `Installed${info.llamaVersion ? ` (version ${info.llamaVersion})` : ""}` : "Not installed yet. It is a free engine that runs the model on the graphics card or processor."}</div>
              </div>
              <div className="row" style={{ margin: 0 }}>
                <button className="primary" disabled={installing} onClick={() => void api().installLlamaServer().catch((e) => setInstallError((e as Error).message))}>{installing ? "Installing…" : info.llamaPath ? "Update engine" : "Install engine"}</button>
                <button className="ghost" onClick={async () => { try { await api().pickLlamaServer(); } catch (e) { setInstallError((e as Error).message); } refresh(); }}>Find engine on this PC…</button>
              </div>
            </div>
          )}
          {installError && <div className="error-box">{installError}</div>}
          {step && (installing || step.state === "error") && (
            <div className={step.state === "error" ? "error-box" : "muted small"}>{step.state === "error" ? step.error : `${step.message ?? "Working"}${step.percent !== null ? ` ${step.percent}%` : ""}`}</div>
          )}
        </div>
      )}

      {/* Every knob in the "Advanced load options" block is llama.cpp-only: when this
          build has no llama.cpp (info.llamaAvailable === false) none of them may render
          as dead controls — the block says its absence instead (the card above). */}
      {off && info?.llamaAvailable !== false && (
        <details style={{ marginTop: 10 }} open={false}>
          <summary className="small"><strong>Advanced load options</strong> <span className="muted">· {info?.cpuThreads ?? "?"} threads, {info?.ramGB ?? "?"} GB RAM{info?.gpus.length ? `, ${info.gpus.map((g) => g.name).join(" + ")}` : ""}</span></summary>
          <div className="row">
            <label className="small">CPU threads
              <Num value={rt.threads} field="threads" placeholder={`auto (${info?.cpuThreads ?? "?"})`} onSave={(n) => save({ threads: n })} wide />
            </label>
            <label className="small">Prompt threads
              <Num value={rt.threadsBatch} field="threadsBatch" placeholder="same" onSave={(n) => save({ threadsBatch: n })} />
            </label>
            <label className="small">Context window override (llama.cpp only)
              <Num value={rt.ctx} field="ctx" placeholder="Conversation length setting" onSave={(n) => save({ ctx: n })} wide />
            </label>
          </div>
          <div className="muted small">Empty: the Conversation length setting in this page is used, then the model's own recommendation. A number here applies to llama.cpp only.</div>

          {target === "gpu" && (
            <>
              <div className="row">
                <label className="small">Layers on the GPU (-1 = all, 0 = none)
                  <Num value={rt.gpuLayers} field="gpuLayers" placeholder="all" onSave={(n) => save({ gpuLayers: n })} wide />
                </label>
                <label className="small">Video memory (GB), to suggest a number
                  <input type="number" min="1" step="0.5" style={{ width: 90 }} value={vram} placeholder={gpuVram ? String(gpuVram) : "e.g. 8"} onChange={(e) => setVram(e.target.value)} />
                </label>
                <label className="small">Model file (GB)
                  <input type="number" min="0.1" step="0.1" style={{ width: 80 }} value={size} placeholder="e.g. 4.5" onChange={(e) => setSize(e.target.value)} />
                </label>
                <label className="small">Model layers
                  <input type="number" min="1" style={{ width: 80 }} value={layers} placeholder="e.g. 32" onChange={(e) => setLayers(e.target.value)} />
                </label>
                <button className="ghost" disabled={!(Number(vram || gpuVram) > 0) || !(Number(layers) > 0) || !(Number(size) > 0)} onClick={() => save({ gpuLayers: suggestGpuLayers(Number(size), Number(layers), Number(vram || gpuVram)) })}>Suggest</button>
              </div>
              <div className="muted small">Layers that do not fit on the card stay in RAM and run on the processor, so a model bigger than the video memory still loads (slower).</div>
              {/* The cache's RAM/GPU placement lives in ONE place: Performance →
                  Conversation length & cache (settings.kvInRam). The duplicate here edited
                  a second key the runtime never read. */}
            </>
          )}

          <div className="row">
            <label className="small">Flash attention
              <select value={rt.flashAttn ?? "auto"} onChange={(e) => save({ flashAttn: e.target.value as RuntimeSettings["flashAttn"] })}>
                <option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option>
              </select>
            </label>
            {/* Cache precision is edited ONCE, in Performance → Conversation length
                & cache (settings.kvType): the duplicate here edited runtime.kvType, which
                nothing read any more. This panel keeps only llama.cpp-specific knobs. */}
            <label className="small">Batch size
              <Num value={rt.batch} field="batch" placeholder="2048" onSave={(n) => save({ batch: n })} />
            </label>
            <label className="small">Micro-batch
              <Num value={rt.ubatch} field="ubatch" placeholder="512" onSave={(n) => save({ ubatch: n })} />
            </label>
          </div>

          <label className="check small"><input type="checkbox" checked={rt.mmap !== false} onChange={(e) => save({ mmap: e.target.checked ? undefined : false })} /> Let the model spill into RAM and disk (memory-map the file): a model bigger than the free RAM still starts, and loads faster</label>
          <label className="check small"><input type="checkbox" checked={!!rt.mlock} onChange={(e) => save({ mlock: e.target.checked || undefined })} /> Keep the model in RAM (never swapped to disk; needs the whole model to fit)</label>

          <div className="row">
            <label className="small" style={{ flex: 1 }}>Other llama-server options
              <input key={rt.extraArgs ?? ""} type="text" style={{ width: "100%" }} defaultValue={rt.extraArgs ?? ""} placeholder="e.g. --rope-scaling yarn --main-gpu 1" onBlur={(e) => save({ extraArgs: e.target.value.trim() || undefined })} />
            </label>
            <button className="ghost" onClick={() => void onSave({ runtime: { serverPath: rt.serverPath } })}>Reset to defaults</button>
          </div>
          {info && info.problems.length > 0 && <div className="warn small">{info.problems.join(" ")}</div>}
          <div className="muted small">The change applies the next time a model loads. Stop the server in Developer settings to reload now.</div>
        </details>
      )}
    </section>
  );
}
