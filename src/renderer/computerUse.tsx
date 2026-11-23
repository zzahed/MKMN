/*
 * Computer Use in the composer (v2 of the panel): ONE visible toggle beside the
 * chat composer switches the SAME composer into agent mode — the textarea the
 * person always types in holds the task, before or after a target is picked —
 * and a "Run task" button starts the run. The TARGET row above the composer
 * always shows what the run will work on ("No window selected" until one is
 * picked), so the run control itself stays one short, unclipped label. The
 * picker is a keyboard listbox with friendly app names and the full window
 * title reachable by mouse (tooltip) and keyboard (a detail line that follows
 * the highlight); the run strip keeps the target and Stop visible; the verdict
 * comes back beside the task. This component never talks to the driver: the
 * host owns the grant, the sidecar owns the loop (docs/design/computer-use.md).
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentRunEvent, AgentRunStatus, DocEditReview, DriverWindow } from "../shared/agent";

/** One settled run's outcome, shown beside the task until it changes. */
export type AgentOutcome = { status: AgentRunStatus; line: string; copyPath?: string };

export type ComputerUse = {
  /** Agent mode is on (the composer is the task field, the send control runs the agent). */
  mode: boolean;
  toggle: () => void;
  busy: boolean;
  /** The window the run will work in (a fresh grant is asked for every run). */
  picked: DriverWindow | null;
  /** Chooses the window the run will work in (and closes the picker). */
  pick: (w: DriverWindow) => void;
  /** The saved Word file an Edit-a-copy run will work on, beside the window pick (at most one target). */
  doc: { path: string; name: string } | null;
  /** Opens the native file dialog and picks the document it returns (null cancels). */
  openDocPicker: () => void;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  /** Starts a run when a target is picked, else opens the picker. Never clears the task. */
  runOrPick: (task: string, modelId: string) => void;
  stop: () => void;
  /** Progress lines of the live run (bounded). */
  lines: string[];
  /** The settled verdict, until the person edits the task or starts again. */
  outcome: AgentOutcome | null;
  /** The review gate while an Edit-a-copy run waits: the exact proposed change and the destination. */
  review: DocEditReview | null;
  /** Answers the review gate: true saves the edited copy, false cancels (nothing is written). */
  decideReview: (approved: boolean) => void;
  /** Errors that are not a verdict: a refused grant, a failed start, a failed Stop. */
  error: string;
  /** Stops a run this window lost track of, and releases its grant. */
  stopActive: () => void;
  clearError: () => void;
  /** The run control's label — always "Run task": the target row carries the window's name, so the label never clips. */
  runLabel: string;
  /** The run control's tooltip: what is missing while disabled, what will happen when ready. */
  runHint: (task: string, modelId: string) => string;
};

const TITLE_MAX = 34;
const trimTitle = (t: string) => (t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t);

/** Friendly names for the programs this PC actually runs; the fallback de-exes and capitalizes. */
const FRIENDLY_APPS: Record<string, string> = {
  notepad: "Notepad", winword: "Word", excel: "Excel", powerpnt: "PowerPoint", outlook: "Outlook",
  explorer: "File Explorer", msedge: "Edge", chrome: "Chrome", firefox: "Firefox", arc: "Arc",
  mspaint: "Paint", calc: "Calculator", cmd: "Command Prompt", powershell: "PowerShell",
  pwsh: "PowerShell", windowsterminal: "Terminal", conhost: "Console", devenv: "Visual Studio",
  code: "VS Code", claude: "Claude", chatgpt: "ChatGPT", opencode: "OpenCode", teams: "Teams",
  snippingtool: "Snipping Tool", taskmgr: "Task Manager", control: "Control Panel",
};
export const friendlyAppName = (process: string) => {
  const stem = process.toLowerCase().replace(/\.exe$/, "");
  return FRIENDLY_APPS[stem] ?? (stem ? stem[0].toUpperCase() + stem.slice(1) : process);
};

/** Returns focus to the task textarea — the composer is the one task field, so a
 *  closed picker or a landed pick hands the keyboard back to it. */
const focusTaskField = () => (document.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();

export function useComputerUse(): ComputerUse {
  const [mode, setMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<DriverWindow | null>(null);
  const [doc, setDoc] = useState<{ path: string; name: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<AgentOutcome | null>(null);
  const [review, setReview] = useState<DocEditReview | null>(null);
  const [error, setError] = useState("");
  const runIdRef = useRef<string | null>(null);

  // The run's progress, streamed from the sidecar. Only a run this composer
  // started is shown; the terminal event becomes the outcome beside the task.
  useEffect(() => {
    const off = api().onAgentRun((ev: AgentRunEvent) => {
      if (ev.runId !== runIdRef.current) return;
      setLines((v) => [...v.slice(-40), ev.line]);
      if (ev.review) setReview(ev.review); // the gate opens: nothing is written yet
      else setReview(null); // a normal step (or the gate was just answered)
      if (ev.status !== "running") {
        runIdRef.current = null;
        setBusy(false);
        setReview(null);
        setOutcome({ status: ev.status, line: ev.line, copyPath: ev.copyPath });
      }
    });
    return off;
  }, []);

  const listWindows = async () => {
    setError("");
    try {
      const list = await api().agentListWindows();
      if (list.length === 0) setError("No other program's window is showing right now.");
      return list;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const openPicker = () => { void listWindows(); setPickerOpen(true); };

  /** The native file dialog: only SAVED files are listed, because an unsaved
   *  Document1 has no file to copy. Picking a document clears the window. */
  const openDocPicker = () => {
    setError("");
    void (async () => {
      try {
        const path = await api().docPickSource();
        if (!path) return;
        setPicked(null);
        setPickerOpen(false);
        setDoc({ path, name: path.split(/[\\/]/).pop() || path });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  };

  const runOrPick = (task: string, modelId: string) => {
    if (busy) return;
    if (!task.trim()) return;
    if (!modelId) { setError("Pick a model first — the run thinks with the chat's model, on this PC."); return; }
    if (!picked && !doc) { openPicker(); return; }
    setError("");
    setOutcome(null);
    if (doc) {
      // Edit a copy: no grant is asked and none exists — the run works on the
      // FILE, and the sidecar writes the edited copy beside the source.
      const id = `agent-${Date.now().toString(36)}`;
      runIdRef.current = id;
      setBusy(true);
      setLines([`Editing a copy of "${doc.name}".`]);
      setPickerOpen(false);
      void api().docEditStart(id, doc.path, task.trim(), modelId).catch((e) => {
        runIdRef.current = null;
        setBusy(false);
        setError((e as Error).message);
      });
      return;
    }
    // A fresh host grant for every run: the grant of a finished run is gone,
    // and begin is the only way one exists again.
    void (async () => {
      let granted = false;
      const id = `agent-${Date.now().toString(36)}`;
      try {
        const grant = await api().agentBeginRun(picked!.hwnd);
        granted = true;
        runIdRef.current = id;
        setBusy(true);
        setLines([`Working in "${grant.title}".`]);
        setPickerOpen(false);
        await api().agentStartRun(id, grant.hwnd, task.trim(), modelId);
      } catch (e) {
        runIdRef.current = null;
        setBusy(false);
        // a grant taken for a run that did not start is released at once: held, it refused every later run
        if (granted) void api().agentStopRun(id).catch(() => undefined);
        // The task stays in the composer; the reason stands beside it.
        setError((e as Error).message);
      }
    })();
  };

  /** A run the window lost track of (reopened, redrawn): "" stops every run and releases the grant. */
  const stopActive = () => {
    setError("");
    void api().agentStopRun("").catch((e) => setError(`Stop failed: ${(e as Error).message}`));
  };

  const stop = () => {
    const id = runIdRef.current;
    if (!id) return;
    void api().agentStopRun(id).catch((e) => {
      // A Stop that failed is surfaced beside the target, never swallowed:
      // the person must know the run is still going.
      setError(`Stop failed: ${(e as Error).message}. The run is still going — try again.`);
    });
  };

  const decideReview = (approved: boolean) => {
    const id = runIdRef.current;
    if (!id) return;
    // The gate closes at once; the loop's next event (writing, or cancelled)
    // continues the strip. The answer itself is fire-and-forget: the run only
    // ends on its own terminal event.
    setReview(null);
    void api().docEditDecide(id, approved);
  };

  const toggle = () => {
    setMode((v) => !v);
    setPickerOpen(false);
    setError("");
  };

  const pick = (w: DriverWindow) => {
    setPicked(w);
    setDoc(null);
    setPickerOpen(false);
    setError("");
    focusTaskField(); // the keyboard comes back to the task after a landed pick
  };

  return {
    mode, toggle, busy, picked, pick, doc, openDocPicker,
    pickerOpen,
    openPicker,
    closePicker: () => { setPickerOpen(false); focusTaskField(); },
    runOrPick, stop, lines, outcome, review, decideReview,
    error, clearError: () => setError(""), stopActive,
    runLabel: "Run task",
    runHint: (task: string, modelId: string) => {
      const missing: string[] = [];
      if (!task.trim()) missing.push("type the task first");
      if (!picked && !doc) missing.push('choose a target — "Choose window" above, or "Edit a Word copy" in the picker');
      if (!modelId) missing.push("pick a model first — the run thinks with the chat's model, on this PC");
      if (missing.length) return `To run, ${missing.join(" and ")}.`;
      return doc
        ? `Edit a copy of "${doc.name}" (the original stays untouched)`
        : `Start the run in "${picked!.title}" (the window grant is asked fresh for every run)`;
    },
  };
}

/** The visible toggle in the composer bar. */
export function ComputerUseChip({ agent }: { agent: ComputerUse }) {
  return (
    <button
      type="button"
      className={`agent-toggle ${agent.mode ? "on" : ""}`}
      onClick={agent.toggle}
      aria-pressed={agent.mode}
      disabled={agent.busy}
      title="Let MKMN work in one window you pick, on this PC: the composer becomes the task, nothing is sent from it"
    >
      <span className={`agent-dot ${agent.busy ? "busy" : ""}`} /> Computer Use
    </button>
  );
}

/**
 * The keyboard window picker, above the composer. Friendly app name, full
 * title, and a suffix that distinguishes duplicate titles; the full title is
 * reachable by mouse (the option's tooltip) and by keyboard (the detail line
 * under the list follows the highlight); Refresh re-lists; the picked window
 * carries the selected state.
 */
export function WindowPicker({ agent }: { agent: ComputerUse }) {
  const [windows, setWindows] = useState<DriverWindow[] | null>(null);
  const [at, setAt] = useState(0);
  const [listing, setListing] = useState(false);

  const refresh = async () => {
    setListing(true);
    const list = await api().agentListWindows();
    setWindows(list ?? []);
    setAt(0);
    setListing(false);
  };

  useEffect(() => { void refresh(); }, []);
  // The keyboard contract lives or dies with focus: once the list is in, the
  // picker takes it, so Down/Up/Enter/Escape operate the list, not the task
  // textarea beneath.
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (windows !== null) boxRef.current?.focus(); }, [windows]);

  if (windows === null) return null;
  // Duplicate titles (same process, same title) are distinguishable: the second
  // "Untitled - Notepad" says so instead of pretending it is the only one.
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const w of windows) {
    const key = `${w.process}\u0000${w.title}`;
    total.set(key, (total.get(key) ?? 0) + 1);
  }
  const options = windows.map((w) => {
    const key = `${w.process}\u0000${w.title}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    return { window: w, dup: (total.get(key) ?? 1) > 1 ? ` · window ${nth} of ${total.get(key)}` : "" };
  });

  const pick = (w: DriverWindow) => {
    agent.pick(w);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((v) => (v + 1) % options.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((v) => (v - 1 + options.length) % options.length); }
    else if (e.key === "Enter") { e.preventDefault(); if (options[at]) pick(options[at].window); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); agent.closePicker(); }
  };
  const current = options[at];

  return (
    <div className="agent-picklist">
      <div className="agent-picklist-head">
        <span className="agent-picklist-title">Choose a window</span>
        <button type="button" className="agent-refresh" onClick={agent.openDocPicker} title="Pick a saved Word document (.docx) and edit a COPY of it — the original stays untouched">Edit a Word copy</button>
        <button type="button" className="agent-refresh" onClick={() => void refresh()} disabled={listing} title="List the windows again">
          {listing ? "Listing…" : "Refresh"}
        </button>
      </div>
      {options.length === 0 ? (
        <div className="agent-line">No other program's window is showing right now.</div>
      ) : (
        <>
          <div ref={boxRef} className="agent-windows" role="listbox" aria-label="Windows" tabIndex={0} onKeyDown={onKeyDown}>
            {options.map(({ window: w, dup }, i) => (
              <button
                key={w.hwnd}
                type="button"
                role="option"
                aria-selected={agent.picked?.hwnd === w.hwnd || i === at}
                className={`agent-window ${agent.picked?.hwnd === w.hwnd || i === at ? "on" : ""}`}
                onClick={() => pick(w)}
                onMouseEnter={() => setAt(i)}
                title={`${w.title}${dup}`}
                aria-label={`${friendlyAppName(w.process)} — ${w.title}${dup}`}
              >
                <span className="agent-window-title">{w.title}{dup}</span>
                <span className="agent-window-sub" title={w.process}>{friendlyAppName(w.process)}</span>
              </button>
            ))}
          </div>
          {/* The highlighted option's FULL title, for the keyboard: the option itself
              ellipsizes in a narrow composer, this line does not hide any of it. */}
          <div className="agent-picklist-detail" aria-live="polite">
            {current ? `${friendlyAppName(current.window.process)}: ${current.window.title}${current.dup}` : ""}
          </div>
        </>
      )}
      <div className="agent-picklist-hint">Down and Up choose, Enter picks, Escape closes.</div>
    </div>
  );
}

/** The target while idle: ALWAYS visible in agent mode, so "what will the run
 *  work on" is answered before the person asks it. With no target it says so
 *  and offers Choose window; with one it names the app and the window (the
 *  full title in the tooltip) beside a way to change it. The task draft lives
 *  in the composer and is never touched here; the next run asks for its own
 *  fresh grant. */
export function AgentPickedRow({ agent }: { agent: ComputerUse }) {
  return (
    <div className="agent-row agent-picked-row">
      <span className="agent-target-label">Target:</span>
      {agent.doc ? (
        <span className="agent-target" title={agent.doc.path}>
          "{trimTitle(agent.doc.name)}" — an edited copy is saved beside the original
        </span>
      ) : agent.picked ? (
        <span className="agent-target" title={agent.picked.title}>
          {friendlyAppName(agent.picked.process)}: "{trimTitle(agent.picked.title)}"
        </span>
      ) : (
        <span className="agent-target none">No window selected</span>
      )}
      <div className="spacer" />
      {agent.doc ? (
        <button type="button" className="agent-change" onClick={agent.openDocPicker} title="Pick a different Word file (the task draft is kept)">
          Change file
        </button>
      ) : (
        <>
          {/* Edit a Word copy is discoverable WITHOUT opening the picker: the
              file dialog here does exactly what the same button in the picker
              does — it is one more road to the same target. */}
          <button type="button" className="agent-change" onClick={agent.openDocPicker} title="Pick a saved Word document (.docx) and edit a COPY of it — the original stays untouched (the task draft is kept)">
            Edit a Word copy
          </button>
          <button type="button" className="agent-change" onClick={agent.openPicker} title={agent.picked ? "Pick a different window (the task draft is kept)" : "Pick the one window the run will work in (the task draft is kept)"}>
            {agent.picked ? "Change window" : "Choose window"}
          </button>
        </>
      )}
    </div>
  );
}

/** The run strip: target and Stop stay visible for the whole run, with the progress under them. */
export function AgentRunStrip({ agent }: { agent: ComputerUse }) {
  return (
    <div className="agent-panel" role="region" aria-label="Agent run">
      <div className="agent-row">
        {agent.doc ? (
          <span className="agent-target" title={agent.doc.path}>
            Editing a copy of "{agent.doc.name}"
          </span>
        ) : (
          <span className="agent-target" title={agent.picked?.title}>
            Running in "{agent.picked ? agent.picked.title : ""}"
          </span>
        )}
        <div className="spacer" />
        <button type="button" className="agent-stop" onClick={agent.stop} title="Stop the run">■ Stop</button>
      </div>
      <div className="agent-log" aria-live="polite">
        {agent.lines.map((l, i) => <div key={i} className="agent-line">{l}</div>)}
      </div>
      {agent.error && <div className="agent-error" role="alert">{agent.error}</div>}
    </div>
  );
}

/** The review gate of Edit a copy, shown while the run WAITS: the exact
 *  proposed change (find → replace, or delete) and the file name the edited
 *  copy will be saved as. Nothing is written before Save edited copy; Cancel
 *  ends the run with nothing written. */
export function DocEditReviewCard({ agent }: { agent: ComputerUse }) {
  const r = agent.review;
  if (!r) return null;
  return (
    <div className="agent-review" role="region" aria-label="Review the proposed change">
      <div className="agent-review-head">
        <span className="agent-review-title">Review the change</span>
        <span className="agent-review-sum">{r.summary}</span>
      </div>
      <div className="agent-review-ops">
        {r.ops.map((op, i) => (
          <div key={i} className="agent-review-op">
            <div className="agent-review-row find">
              <span className="agent-review-kind">Find</span>
              <code>{op.find || "(nothing)"}</code>
            </div>
            <div className="agent-review-row repl">
              <span className="agent-review-kind">{op.replace ? "Replace with" : "Delete"}</span>
              <code>{op.replace || "\u200b"}</code>
            </div>
          </div>
        ))}
      </div>
      <div className="agent-review-dest">
        Saves the edited copy as "{r.destination}" beside the original — "{r.sourceName}" stays untouched.
      </div>
      <div className="agent-review-actions">
        <button type="button" className="agent-review-save" onClick={() => agent.decideReview(true)}>
          Save edited copy
        </button>
        <button type="button" className="agent-review-cancel" onClick={() => agent.decideReview(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The settled verdict, beside the task (above the textarea) until it changes.
 *  A done Edit-a-copy run also offers the verified copy itself — offered only
 *  after the readback passed, never while anything is unresolved. */
export function AgentOutcomeLine({ agent }: { agent: ComputerUse }) {
  if (!agent.outcome) return null;
  const o = agent.outcome;
  const cls = o.status === "done" ? "ok" : o.status === "cancelled" ? "stopped" : "warn";
  return (
    <div className={`agent-outcome ${cls}`} role="status">
      <span className="agent-outcome-line">{o.line}</span>
      {o.status === "done" && o.copyPath && (
        <button
          type="button"
          className="agent-open"
          onClick={() => { void api().openEditedCopy(o.copyPath!); }}
          title="Open the edited copy with its default app"
        >
          Open edited copy
        </button>
      )}
    </div>
  );
}
