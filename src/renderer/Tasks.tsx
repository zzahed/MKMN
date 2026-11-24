import { useState, useEffect } from "react";
import type { Artifact, Project, Schedule, ScheduledTask } from "../shared/types";
import { describeSchedule, nextRun, validateSchedule } from "../core/schedule";
import { stripArtifacts } from "../core/artifacts";
import { Markdown } from "./Markdown";
import type { CatalogItem } from "../shared/api";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toLocalInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

/** What the task will do once saved, said before it is saved: when it next runs,
 *  with which model, with which project, and that MKMN must be running. */
export function taskSummary(t: ScheduledTask, now: number, projects: Project[], models: CatalogItem[], selectedModelName: string | null): { when: string; model: string; project: string } {
  const at = t.enabled && !validateSchedule(t.schedule, now) ? nextRun(t.schedule, now) : null;
  const when = !t.enabled ? "Paused: it will not run until you turn it on" : at ? `Next run: ${new Date(at).toLocaleString()}` : "It will not run: the time is in the past";
  const own = t.modelId ? models.find((m) => m.entry.id === t.modelId)?.entry.name ?? t.modelId : null;
  const model = own ? `Model: ${own}` : selectedModelName ? `Model: the one chosen in Local Models (now ${selectedModelName})` : "Model: the one chosen in Local Models (none chosen yet)";
  const proj = projects.find((p) => p.id === t.projectId);
  const project = proj ? `Project: ${proj.name} (uses its latest instructions and files)` : "Project: none";
  return { when, model, project };
}

function blank(): ScheduledTask {
  return { id: crypto.randomUUID(), name: "", prompt: "", projectId: null, modelId: null, schedule: { kind: "daily", time: "08:00" }, enabled: true, created: 0, nextRun: null, running: false, runs: [] };
}

function Editor({ task, projects, models, selectedModelName, onSave, onCancel }: { task: ScheduledTask; projects: Project[]; models: CatalogItem[]; selectedModelName: string | null; onSave: (t: ScheduledTask) => Promise<void>; onCancel: () => void }) {
  const [t, setT] = useState(task);
  const [err, setErr] = useState<string | null>(null);
  const [kindDraft] = useState<Record<string, Schedule>>({});
  /** The interval's unit is the person's choice, kept while they type: never inferred
   *  again from the minutes (60 minutes typed must not turn into "1 hours"). */
  const [unit, setUnit] = useState<"m" | "h">(() => (task.schedule.kind === "interval" && task.schedule.everyMin % 60 === 0 ? "h" : "m"));
  const s = t.schedule;
  const setS = (x: Schedule) => setT({ ...t, schedule: x });
  const changeKind = (k: Schedule["kind"]) => {
    kindDraft[s.kind] = s;
    setS(kindDraft[k] ?? (k === "once" ? { kind: "once", at: Date.now() + 3600_000 } : k === "interval" ? { kind: "interval", everyMin: 60 } : k === "daily" ? { kind: "daily", time: "08:00" } : { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" }));
  };
  const save = async () => {
    setErr(null);
    if (!t.name.trim()) return setErr("Give the task a name.");
    if (!t.prompt.trim()) return setErr("Write what the assistant should do.");
    const bad = t.enabled ? validateSchedule(s, Date.now()) : null;
    if (bad) return setErr(bad);
    try { await onSave({ ...t, name: t.name.trim() }); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card editor">
      <label>Name<input className="wide" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Morning briefing" /></label>
      <label>What should the assistant do?
        <textarea rows={4} value={t.prompt} onChange={(e) => setT({ ...t, prompt: e.target.value })} placeholder="Summarize my project notes and list the three most important things to do today. Put the list in a document file." />
      </label>
      <div className="row">
        <label>Project (optional)
          <select value={t.projectId ?? ""} onChange={(e) => setT({ ...t, projectId: e.target.value || null })}>
            <option value="">None</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="muted small">The task uses the project's instructions and reference files.</span>
        </label>
        <label>Model
          <select value={t.modelId ?? ""} onChange={(e) => setT({ ...t, modelId: e.target.value || null })}>
            <option value="">The model chosen in Local Models</option>
            {models.filter((m) => m.installed && !m.hidden).map((m) => <option key={m.entry.id} value={m.entry.id}>{m.entry.name}</option>)}
          </select>
        </label>
      </div>
      <div className="row">
        <label>When
          <select value={s.kind} onChange={(e) => changeKind(e.target.value as Schedule["kind"])}>
            <option value="daily">Every day</option><option value="weekly">On certain days</option><option value="interval">Every few minutes or hours</option><option value="once">Once</option>
          </select>
        </label>
        {(s.kind === "daily" || s.kind === "weekly") && <label>At<input type="time" value={s.time} onChange={(e) => setS({ ...s, time: e.target.value })} /></label>}
        {s.kind === "interval" && (
          <label>Every
            <span className="inline">
              <input type="number" min={1} value={unit === "h" ? Math.max(1, Math.round(s.everyMin / 60)) : s.everyMin} style={{ width: 80 }}
                onChange={(e) => setS({ ...s, everyMin: Math.max(1, Number(e.target.value) || 1) * (unit === "h" ? 60 : 1) })} />
              {/* switching the unit keeps the number shown and changes what it counts */}
              <select value={unit} onChange={(e) => {
                const next = e.target.value === "h" ? "h" : "m";
                const shown = unit === "h" ? Math.max(1, Math.round(s.everyMin / 60)) : s.everyMin;
                setUnit(next);
                setS({ ...s, everyMin: Math.max(1, shown) * (next === "h" ? 60 : 1) });
              }}>
                <option value="m">minutes</option><option value="h">hours</option>
              </select>
            </span>
          </label>
        )}
        {s.kind === "once" && <label>On<input type="datetime-local" value={toLocalInput(s.at)} onChange={(e) => { const v = new Date(e.target.value).getTime(); if (Number.isFinite(v)) setS({ kind: "once", at: v }); }} /></label>}
      </div>
      {s.kind === "weekly" && (
        <div className="seg" style={{ alignSelf: "flex-start" }}>
          {DAYS.map((d, i) => <button key={d} className={s.days.includes(i) ? "on" : ""} onClick={() => setS({ ...s, days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i] })}>{d}</button>)}
        </div>
      )}
      {(() => { const sum = taskSummary(t, Date.now(), projects, models, selectedModelName); return (
        <div className="task-summary small" aria-live="polite"><strong>{sum.when}</strong><span>{sum.model}</span><span>{sum.project}</span></div>
      ); })()}
      <p className="muted small">Tasks run only while MKMN is open. By default, closing the window quits MKMN. To keep tasks running, leave MKMN open, or in Settings › App settings set “When I close the window” to keep it in the notification area.</p>
      {err && <div className="error-box">{err}</div>}
      <div className="row"><button className="primary" onClick={() => void save()}>Save task</button><button className="ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function TaskCard({ t, projects, artifacts, onEdit, onToggle, onRun, onDelete, onOpenArtifact }: {
  t: ScheduledTask; projects: Project[]; artifacts: Artifact[]; onEdit: () => void; onToggle: () => void; onRun: () => void; onDelete: () => void; onOpenArtifact: (id: string) => void;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const last = t.runs[0];
  const proj = projects.find((p) => p.id === t.projectId);
  return (
    <div className={`card ${t.enabled ? "" : "dim"}`}>
      <div className="card-top">
        <div>
          <div className="card-title">{t.name}</div>
          <div className="muted small">{describeSchedule(t.schedule)}{proj ? ` · ${proj.name}` : ""}</div>
        </div>
        <label className="switch" title={t.enabled ? "Pause" : "Resume"}>
          <input type="checkbox" checked={t.enabled} onChange={onToggle} /><span />
        </label>
      </div>
      <div className="muted small clip2">{t.prompt}</div>
      <div className="small">
        {t.running ? <span className="warn">Running now…</span>
          : t.enabled && t.nextRun ? <span>Next run: {new Date(t.nextRun).toLocaleString()}</span>
          : <span className="muted">{t.schedule.kind === "once" && last ? "Done" : "Paused"}</span>}
        {last && <span className={last.status === "ok" ? "ok" : "warn"}> · last run {last.status === "ok" ? "succeeded" : "failed"} {new Date(last.finishedAt).toLocaleString()}</span>}
      </div>
      <div className="row tight">
        <button className="ghost" onClick={onRun} disabled={t.running}>Run now</button>
        <button className="ghost" onClick={onEdit}>Edit</button>
        {t.runs.length > 0 && <button className="ghost" onClick={() => setShowRuns(!showRuns)}>{showRuns ? "Hide results" : `Results (${t.runs.length})`}</button>}
        <div className="spacer" />
        <button className="linkbtn" onClick={() => { if (confirm(`Delete the task "${t.name}"?\n\nIts past results are deleted too. Files it made stay in Files.\n\nThis cannot be undone.`)) onDelete(); }}>Delete</button>
      </div>
      {showRuns && (
        <div className="runs">
          {t.runs.map((r) => (
            <details key={r.id} open={r === last}>
              <summary className="small">{new Date(r.startedAt).toLocaleString()} · {r.status === "ok" ? "ok" : "failed"} · {Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))}s</summary>
              {r.error && <div className="error-box">{r.error}</div>}
              {r.output && <div className="assistant run-output"><Markdown text={stripArtifacts(r.output)} /></div>}
              {r.artifactIds.map((id) => { const a = artifacts.find((x) => x.id === id); return a ? <button key={id} className="ghost" onClick={() => onOpenArtifact(id)}>Open “{a.title}”</button> : null; })}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export function Tasks({ tasks, projects, artifacts, models, hasModel, selectedModelName = null, onSave, onDelete, onRun, onOpenArtifact, openTaskId, onOpened }: {
  tasks: ScheduledTask[]; projects: Project[]; artifacts: Artifact[]; models: CatalogItem[]; hasModel: boolean;
  /** The app's selected model, named in the editor's summary for a task that uses it. */
  selectedModelName?: string | null;
  onSave: (t: ScheduledTask) => Promise<void>; onDelete: (id: string) => void; onRun: (id: string) => void; onOpenArtifact: (id: string) => void;
  /** A task to open on arrival (a search result names it), then told back as opened. */
  openTaskId?: string | null; onOpened?: () => void;
}) {
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  useEffect(() => {
    if (!openTaskId) return;
    const t = tasks.find((x) => x.id === openTaskId);
    if (t) setEditing(t);
    onOpened?.();
  }, [openTaskId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = [...tasks].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity));
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Tasks</h1><p className="muted">Instructions the assistant carries out by itself on a schedule, such as a morning summary. Results appear here, and any files it makes appear in Files.</p></div>
        {!editing && <button className="primary" onClick={() => setEditing(blank())}>＋ New task</button>}
      </div>
      {/* only tasks that use the app's selected model need one: a task with its own model runs */}
      {!hasModel && tasks.some((t) => !t.modelId) && <div className="banner soft" style={{ borderRadius: 10, margin: "8px 0" }}>No model is chosen yet, so tasks set to use the chosen model cannot run. Choose one in Local Models, or give the task its own model.</div>}
      {editing && <Editor key={editing.id} task={editing} projects={projects} models={models} selectedModelName={selectedModelName} onCancel={() => setEditing(null)} onSave={async (t) => { await onSave(t); setEditing(null); }} />}
      {sorted.length === 0 && !editing ? (
        <div className="empty-box"><p>No tasks. Examples: a daily summary of your project notes, a weekly study plan, an hourly reminder to stretch with a joke.</p></div>
      ) : (
        <div className="grid" style={{ marginTop: 14 }}>
          {sorted.map((t) => (
            <TaskCard key={t.id} t={t} projects={projects} artifacts={artifacts} onEdit={() => setEditing(t)} onRun={() => onRun(t.id)} onDelete={() => onDelete(t.id)}
              onToggle={() => void onSave({ ...t, enabled: !t.enabled }).catch((e) => alert((e as Error).message))} onOpenArtifact={onOpenArtifact} />
          ))}
        </div>
      )}
    </div>
  );
}
