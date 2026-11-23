/*
 * Computer Use v1: the observe → propose → validate → execute → re-observe/
 * verify loop, on the sidecar, over the host's driver capabilities.
 *
 * Everything here is dependency-injected (driver, model, emit, signal, limits)
 * so the tests drive it with fakes; the real wiring lives in main.ts, where
 * the driver is a roundtrip to the Tauri host (which owns the pinned
 * agent-desktop binary and the ONE window grant) and the model is the same
 * NPU-first local path chat uses (collect over the supervised server).
 *
 * The safety story is structural: the closed action set has no keyboard and no
 * coordinate path, so "prepare an unsent draft" is guaranteed — nothing here
 * can press Enter anywhere.
 */
import type { ChatMessage } from "../shared/types";
import { consequentialReason, consequentialWord } from "../shared/consequential";
import {
  AGENT_ACTION_KINDS,
  type ActResult,
  type AgentAction,
  type AgentRunEvent,
  type AgentRunStatus,
  type AgentStepPhase,
  type NodeInfo,
  type ObserveResult,
} from "../shared/agent";

/** The part of the driver the loop needs. Never a process handle, never stdio. */
export interface AgentDriver {
  observe(hwnd: number, maxNodes?: number): Promise<ObserveResult>;
  act(hwnd: number, action: AgentAction): Promise<ActResult>;
  /** Ends the run: the host clears the window grant. */
  endRun(): Promise<void>;
}

/** The part of the model the loop needs: one bounded, abortable completion. */
export interface AgentModel {
  propose(messages: ChatMessage[], signal: AbortSignal): Promise<string>;
}

export type AgentLimits = {
  /** The most step iterations (observe+propose+act+verify) one run may take. */
  maxSteps: number;
  /** The whole run's wall-clock ceiling. */
  runBudgetMs: number;
  /** The most nodes one observe shows the model. */
  maxNodes: number;
};

export const AGENT_DEFAULT_LIMITS: AgentLimits = { maxSteps: 12, runBudgetMs: 10 * 60_000, maxNodes: 300 };

export type AgentRunDeps = {
  runId: string;
  hwnd: number;
  task: string;
  driver: AgentDriver;
  model: AgentModel;
  emit: (ev: AgentRunEvent) => void;
  signal: AbortSignal;
  limits?: Partial<AgentLimits>;
};

export type AgentRunOutcome = {
  status: AgentRunStatus;
  reason?: string;
  summary?: string;
  actions: { action: AgentAction; verified: boolean | null; at: number }[];
  steps: number;
};

// ---------------------------------------------------------------- the prompt

/**
 * The proposal prompt. A closed JSON answer: ONE action from the closed set,
 * or done, or giveUp. No other shape is accepted, and the action set's own
 * closedness is spelled out so the model never invents a keyboard step.
 */
export const AGENT_PROPOSE_PROMPT = `You are MKMN's window agent. You work inside ONE window the person picked, one step at a time, using only what you can read from its accessibility tree.

You see the window's elements as lines like:  e7 Button "Bold" [click]
The first token is the element's reference (valid only for this snapshot), then its role and name in quotes, then its value if it has one, then its visible state (on/off, expanded/collapsed, selected) if it has one, then the actions it accepts.

Reply with EXACTLY ONE JSON object and nothing else. Choose from:
{"kind":"click","ref":"<ref>"}            press a button or link
{"kind":"setValue","ref":"<ref>","text":"<text>"}   put text into a field (replaces the field's content; it does not press Enter — nothing is sent)
{"kind":"toggle","ref":"<ref>"}           flip a checkbox or toggle
{"kind":"select","ref":"<ref>","value":"<exact name>"}  choose an item by its exact name
{"kind":"expand","ref":"<ref>"}           open a dropdown or expander
{"kind":"collapse","ref":"<ref>"}         close a dropdown or expander
{"kind":"done","summary":"<what was accomplished>"}   the task is complete
{"kind":"giveUp","reason":"<why you cannot continue>"}  the task cannot be finished

Rules:
- setValue REPLACES the field's ENTIRE content. To add, remove or change part of a text, send the WHOLE finished text: every existing line exactly as you read it, plus your change. Never send only the new fragment - that would erase the rest.
- ONE step per reply. Never describe several steps.
- Before proposing, check the snapshot: if what the task asked for is already visible in it, reply done. Never repeat a step the "WHAT HAS BEEN DONE SO FAR" list already shows as verified - doing the same write again changes nothing.
- Every ref must come from the CURRENT snapshot you were just given. Never reuse an earlier ref from memory.
- Prefer setValue into a text field over anything else when the task is to prepare a message or draft. Never press Send, Post, Delete, Pay, OK, Confirm, Yes or any control whose press cannot be taken back, and never press a control with no name: such a press is refused, and the person does it.
- If the snapshot shows the task is already complete, reply done. If you cannot see a way forward, reply giveUp honestly instead of guessing.
- Numbers, names, values: quote the window's own text exactly as you read it.`;

// ---------------------------------------------------------------- helpers

const REF_RE = /^e(\d+)\.(\d+)$/;

/** Line endings are a field's own business: a compare sees CR, CRLF and LF as the same lines. */
function normLines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Splits a driver reference into its generation and index. */
function refParts(ref: string): { gen: number; idx: number } | null {
  const m = REF_RE.exec(ref);
  return m ? { gen: Number(m[1]), idx: Number(m[2]) } : null;
}

/** Strips a model's reasoning block, then reads the ONE JSON object it answered. */
export type Proposal =
  | { kind: "done"; summary: string }
  | { kind: "giveUp"; reason: string }
  | AgentAction;

/**
 * Escapes RAW control characters inside JSON string literals only: an 8 B model
 * writes multiline text with real newlines, and strict JSON refuses every raw
 * control character inside a string ("Bad control character in string literal" —
 * the live Notepad draft died twice on exactly that before any action).
 * A raw newline inside a string literal means \n unambiguously; a raw tab means
 * \t; anything else is spelled \u00XX. Quotes, backslashes and structure
 * outside strings are left untouched, and the repair runs only after the
 * strict parse failed, so well-formed replies are untouched.
 */
export function escapeControlsInStrings(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") { out += c + (s[i + 1] ?? ""); i++; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      if (c < " ") {
        out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

/** Parses the model's reply into a proposal, or names the exact fault. */
export function parseProposal(reply: string): { proposal: Proposal } | { fault: string } {
  const stripped = reply.replace(new RegExp("<" + "think[\\s\\S]*?<" + "/think>", "g"), "").trim();
  const m = /\{[\s\S]*\}/.exec(stripped);
  if (!m) return { fault: "the answer contained no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch (e) {
    // The one bounded repair: raw control characters inside string literals.
    try {
      raw = JSON.parse(escapeControlsInStrings(m[0]));
    } catch {
      return { fault: `the JSON did not parse: ${(e as Error).message.slice(0, 120)}` };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { fault: "the answer was not a JSON object" };
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : null;
  if (kind === "done") {
    return typeof o.summary === "string" && o.summary.trim()
      ? { proposal: { kind: "done", summary: o.summary.trim() } }
      : { fault: 'a "done" answer needs a non-empty "summary"' };
  }
  if (kind === "giveUp") {
    return typeof o.reason === "string" && o.reason.trim()
      ? { proposal: { kind: "giveUp", reason: o.reason.trim() } }
      : { fault: 'a "giveUp" answer needs a non-empty "reason"' };
  }
  if (kind === null || !AGENT_ACTION_KINDS.includes(kind as (typeof AGENT_ACTION_KINDS)[number])) {
    return {
      fault: `"${String(kind)}" is not one of the window's actions (click, setValue, toggle, select, expand, collapse, done, giveUp)`,
    };
  }
  if (typeof o.ref !== "string" || !REF_RE.test(o.ref)) {
    return { fault: `the reference "${String(o.ref)}" is not a driver reference like "e4.12"` };
  }
  const ref = o.ref;
  if (kind === "setValue") {
    return typeof o.text === "string" && o.text.length > 0
      ? { proposal: { kind: "setValue", ref, text: o.text } }
      : { fault: "a setValue action needs the text to put into the field" };
  }
  if (kind === "select") {
    return typeof o.value === "string" && o.value.trim().length > 0
      ? { proposal: { kind: "select", ref, value: o.value.trim() } }
      : { fault: "a select action needs the exact name of the item to choose" };
  }
  return { proposal: { kind, ref } as AgentAction };
}

/** Renders an observe snapshot as the element lines the prompt describes. */
export function renderObserve(obs: ObserveResult): string {
  const lines: string[] = [];
  for (const n of obs.nodes) {
    const parts = [n.ref, n.role];
    if (n.name) parts.push(`"${n.name}"`);
    if (n.value !== undefined) parts.push(`value="${displayValue(n.value)}"`);
    if (n.state) parts.push(n.state);
    // `patterns` is absent on the wire when the element accepts nothing
    // (agent_wire.rs skips an empty vec); a container node usually does.
    if (n.patterns?.length) parts.push(`[${n.patterns.join(",")}]`);
    if (!n.enabled) parts.push("(disabled)");
    if (n.offscreen) parts.push("(off-screen)");
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

/**
 * The value the MODEL sees. The wire carries the field's full value (up to the
 * driver's 8192-character bound) so verify can compare honestly; the model's
 * context gets a bounded view with a visible marker when it was cut, so the
 * model knows the text continues and verify still reads the real field.
 */
const VALUE_DISPLAY_CAP = 2048;
export function displayValue(v: string): string {
  if (v.length <= VALUE_DISPLAY_CAP) return v;
  const cut = v.slice(0, VALUE_DISPLAY_CAP);
  return `${cut}…(+${v.length - VALUE_DISPLAY_CAP} characters not shown)`;
}

/** The action kinds an element accepts, from its snapshot record. */
function patternsOf(node: NodeInfo): string[] {
  return node.patterns ?? [];
}

/** The capability-mismatch fault validateAgainstSnapshot returns, by prefix. */
const CAP_FAULT = "the element accepts only [";

/** The line ends with exactly one period, whatever the reason carried in. */
function endsDot(s: string): string {
  return s.endsWith(".") ? s : `${s}.`;
}

/**
 * The snapshot's elements that accept the action kind: refs and names, so a
 * refused proposal is steered to a target that can actually take it (an 8 B
 * model that was only told "not this element" proposed the same canvas again).
 * At most five; disabled and off-screen elements never count.
 */
export function writableTargets(obs: ObserveResult, kind: string): string {
  return obs.nodes
    .filter((n) => n.enabled && !n.offscreen && patternsOf(n).includes(kind))
    .slice(0, 5)
    .map((n) => `${n.ref} (${(n.name ?? "").trim().slice(0, 40) || "unnamed"})`)
    .join(", ");
}

/** The steering sentence for a capability refusal, or "" for other faults. */
export function capabilitySteer(obs: ObserveResult, kind: string, invalid: string): string {
  if (!invalid.startsWith(CAP_FAULT)) return "";
  const targets = writableTargets(obs, kind);
  const base = targets
    ? ` Elements that accept ${kind} in this snapshot: ${targets}. If none of them can serve the task, reply giveUp and say what the window lacks.`
    : ` Nothing in this snapshot accepts ${kind}: if the task needs it, this window cannot serve it — reply giveUp and say what the window lacks.`;
  // Word's canvas exposes no Value pattern: the honest exit names the road that
  // DOES exist — the saved file, edited as a copy (docs/design/doc-edit-copy.md).
  if (!targets && kind === "setValue" && /^winword(\.exe)?$/i.test(obs.window?.process ?? "")) {
    return `${base} To change this document's text, save it as a .docx and use the picker's "Edit a Word copy": MKMN edits a copy of the saved file and the original stays untouched.`;
  }
  return base;
}

/**
 * Finds the element an action acted on in a FRESH snapshot: refs are
 * single-observe, so the new snapshot names it differently. The traversal
 * order is deterministic, so the same index is tried first, then role+name.
 */
function findAfterAct(fresh: ObserveResult, target: NodeInfo): NodeInfo | null {
  const idx = refParts(target.ref)?.idx;
  if (idx !== undefined) {
    const at = fresh.nodes[idx];
    if (at && at.role === target.role) return at;
  }
  return fresh.nodes.find((n) => n.role === target.role && (n.name ?? null) === (target.name ?? null)) ?? null;
}

/** True when `next` would redo the write that was already executed and verified:
 *  the same write kind on the same element (role and name identify an element
 *  across snapshots; its ref does not survive one) with the same payload. A
 *  verified identical write is a no-op, and a model that repeats it needs the
 *  nudge toward done, not another execution (the live 8B pass looped on one). */
function repeatsVerifiedStep(prev: { action: AgentAction; target: NodeInfo }, next: AgentAction, target: NodeInfo): boolean {
  if (next.kind === "setValue" && prev.action.kind === "setValue") {
    return prev.target.role === target.role
      && (prev.target.name ?? null) === (target.name ?? null)
      && next.text === prev.action.text;
  }
  if (next.kind === "select" && prev.action.kind === "select") {
    return prev.target.role === target.role
      && (prev.target.name ?? null) === (target.name ?? null)
      && next.value === prev.action.value;
  }
  return false;
}

/** How a driver error reads: stale references recover, a gone window fails, the rest are faults to report. */
function classifyErr(e: unknown): "stale" | "gone" | "other" {
  const m = String((e as Error)?.message ?? e);
  if (/^staleRef:/i.test(m)) return "stale";
  if (/^WINDOWGONE$/.test(m) || /^windowGone:/i.test(m)) return "gone";
  return "other";
}

/** Races a driver call against the stop signal: cancellation lands in seconds, not after the timeout. */
function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

// ---------------------------------------------------------------- the loop

/**
 * One bounded run against one granted window. Returns the verdict; the caller
 * renders it. `settle` is the ONLY writer of the final status, and it always
 * emits the terminal event exactly once.
 */
export async function runAgentLoop(deps: AgentRunDeps): Promise<AgentRunOutcome> {
  const limits: AgentLimits = { ...AGENT_DEFAULT_LIMITS, ...deps.limits };
  const { runId, hwnd, task, driver, model, emit, signal } = deps;
  const actions: AgentRunOutcome["actions"] = [];
  const deadline = Date.now() + limits.runBudgetMs;

  let step = 0;
  // The note carried into the next proposal: why the last proposal was refused,
  // or that the window's focus moved (the grant never moves with it).
  let note = "";
  let consecutiveInvalid = 0;
  let settled = false;
  /** The last write that executed and verified: a model that proposes it again needs the done nudge, not a re-execution. */
  let lastVerified: { action: AgentAction; target: NodeInfo } | null = null;

  const emitNow = (status: AgentRunStatus, s: number, phase: AgentStepPhase, line: string, extra?: Partial<AgentRunEvent>) => {
    emit({ runId, status, step: s, phase, line, actions: [...actions], at: Date.now(), ...extra });
  };

  const settle = (status: AgentRunStatus, reason?: string, summary?: string): AgentRunOutcome => {
    if (settled) return { status, reason, summary, actions, steps: step };
    settled = true;
    const phase: AgentStepPhase = "settled";
    const line =
      status === "done" ? `Done: ${endsDot(summary ?? "the task is complete")}`
      : status === "cancelled" ? "Stopped."
      : status === "unresolved" ? `Unresolved: ${endsDot(reason ?? "the run ended without proving success")}`
      : `Failed: ${endsDot(reason ?? "the run could not continue")}`;
    emitNow(status, step, phase, line, { reason, summary });
    return { status, reason, summary, actions, steps: step };
  };

  const isAborted = () => signal.aborted;

  try {
    while (true) {
      if (isAborted()) return settle("cancelled", "the person stopped the run");
      if (Date.now() > deadline) {
        return settle(actions.length ? "unresolved" : "failed", "the run's time budget ran out");
      }
      if (step >= limits.maxSteps) {
        return settle("unresolved", `the step limit (${limits.maxSteps}) was reached`);
      }
      step++;

      // ---- 1. observe: a fresh, window-scoped snapshot
      emitNow("running", step, "observe", `Reading the window (step ${step})`);
      let obs: ObserveResult;
      try {
        obs = await withSignal(driver.observe(hwnd, limits.maxNodes), signal);
      } catch (e) {
        if (isAborted()) return settle("cancelled", "the person stopped the run");
        const kind = classifyErr(e);
        if (kind === "gone") return settle("failed", "the window is gone");
        return settle("failed", `the window could not be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
      const focusNote = obs.focused ? "" : " (the window is not focused; the grant stays)";
      emitNow("running", step, "observe", `Read ${obs.nodes.length} element${obs.nodes.length === 1 ? "" : "s"} of "${obs.window.title}"${obs.truncated ? " (the tree was cut to fit)" : ""}${focusNote}`);

      // ---- 2. propose ONE action
      emitNow("running", step, "propose", "Thinking about the next step");
      const tree = renderObserve(obs);
      const did = actions.length
        ? actions.map((a, i) => `${i + 1}. ${describeAction(a.action)} — ${a.verified === true ? "verified" : a.verified === false ? "did not hold" : "could not be verified"}`).join("\n")
        : "Nothing has been done yet.";
      const user = [
        `THE TASK: ${task}`,
        `THE WINDOW: "${obs.window.title}" (${obs.window.process})`,
        `THE WINDOW'S CONTENT (the current snapshot; refs are valid only for it):`,
        tree,
        `WHAT HAS BEEN DONE SO FAR:\n${did}`,
        note ? `NOTES:\n${note}` : "",
        `Reply with the ONE JSON object for the next step.`,
      ].filter(Boolean).join("\n\n");

      let proposal: Proposal | null = null;
      let fault = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages: ChatMessage[] = [
          { role: "system", content: AGENT_PROPOSE_PROMPT },
          { role: "user", content: attempt === 0 ? user : `${user}\n\nYour last answer was refused: ${fault}. Answer again with exactly one valid JSON object.` },
        ];
        let reply: string;
        try {
          reply = await model.propose(messages, signal);
        } catch (e) {
          if (isAborted()) return settle("cancelled", "the person stopped the run");
          const why = String((e as Error)?.message ?? e).slice(0, 200);
          return actions.length
            ? settle("unresolved", `the model stopped answering after changes were made: ${why}`)
            : settle("failed", `the model did not answer: ${why}`);
        }
        const parsed = parseProposal(reply);
        if ("proposal" in parsed) { proposal = parsed.proposal; break; }
        fault = parsed.fault;
      }
      if (!proposal) {
        // ONE re-ask already happened; settle honestly.
        return actions.length
          ? settle("unresolved", `the model's answer was unusable twice (${fault}); ${actions.length} change${actions.length === 1 ? " was" : "s were"} made and not all were proven`)
          : settle("failed", `the model's answer was unusable twice before anything was executed: ${fault}`);
      }

      // ---- done / giveUp
      if (proposal.kind === "done") {
        const unproven = actions.filter((a) => a.verified !== true).length;
        return unproven === 0
          ? settle("done", undefined, proposal.summary)
          : settle("unresolved", `the model said the task is done, but ${unproven} change${unproven === 1 ? " was" : "s were"} never verified on the window`, proposal.summary);
      }
      if (proposal.kind === "giveUp") {
        return actions.length
          ? settle("unresolved", `the model gave up after ${actions.length} change${actions.length === 1 ? "" : "s"} were made: ${proposal.reason}`)
          : settle("failed", `the model gave up before doing anything: ${proposal.reason}`);
      }

      // ---- 3. validate against the CURRENT snapshot (schema already held)
      const target = obs.nodes.find((n) => n.ref === proposal.ref) ?? null;
      const invalid = validateAgainstSnapshot(target, proposal);
      if (invalid) {
        consecutiveInvalid++;
        const steer = capabilitySteer(obs, proposal.kind, invalid);
        if (consecutiveInvalid >= 2 && actions.length === 0) {
          return settle(
            "failed",
            `the proposal was unusable twice before anything was executed: ${invalid}${steer}`,
          );
        }
        note = `Your last proposal was NOT executed: ${invalid}.${steer} Read the snapshot again and propose a different step.`;
        continue;
      }
      consecutiveInvalid = 0;
      const acted = target as NodeInfo;

      // A verified write repeated identically is a no-op: nudge toward done
      // instead of re-executing, or a small model can loop here to the step
      // limit (the live 8B pass did exactly that).
      if (lastVerified && repeatsVerifiedStep(lastVerified, proposal, acted)) {
        note = `Your last proposal would repeat the write that was already executed and verified. Read the snapshot: if what the task asked for is already on the window, reply done; only a DIFFERENT step needs doing.`;
        continue;
      }

      // ---- 4. execute
      emitNow("running", step, "act", describeAction(proposal));
      try {
        await withSignal(driver.act(hwnd, proposal), signal);
      } catch (e) {
        if (isAborted()) return settle("cancelled", "the person stopped the run");
        const kind = classifyErr(e);
        if (kind === "gone") return settle("failed", "the window is gone");
        if (kind === "stale") {
          // The window changed under us: re-observe and re-propose, without
          // executing. The step limit bounds how often this may repeat.
          note = "Your reference was stale (the window changed between the snapshot and the action). Use a ref from the NEWEST snapshot below.";
          continue;
        }
        note = `The action was refused: ${String((e as Error)?.message ?? e).slice(0, 200)}. Propose a different step.`;
        continue;
      }

      // ---- 5. re-observe and verify
      emitNow("running", step, "verify", `Checking what ${describeAction(proposal)} did`);
      let fresh: ObserveResult;
      try {
        fresh = await withSignal(driver.observe(hwnd, limits.maxNodes), signal);
      } catch (e) {
        if (isAborted()) return settle("cancelled", "the person stopped the run");
        if (classifyErr(e) === "gone") return settle("failed", "the window is gone");
        // The act may have happened; an unverified change is an unresolved run, never a done one.
        actions.push({ action: proposal, verified: null, at: Date.now() });
        return settle("unresolved", `the window could not be re-read after the action: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
      const verified = verifyAction(proposal, acted, fresh);
      actions.push({ action: proposal, verified, at: Date.now() });
      if (verified === true) lastVerified = { action: proposal, target: acted };
      emitNow("running", step, "verify",
        verified === true
          ? `Verified: ${describeAction(proposal)} held.`
          : `Could not verify: ${describeAction(proposal)}.`,
        { reason: verified === true ? undefined : `${describeAction(proposal)} could not be verified on the re-observe` });

      // ---- 6. repeat (focus changes are reported, never acted on)
      note = fresh.focused === obs.focused ? "" : "The window's focus changed between steps. The grant stays on the same window; do not try to act on another window.";
    }
  } finally {
    // The grant dies with the run, however it settles.
    try { await driver.endRun(); } catch { /* the host clears it on shutdown anyway */ }
  }
}

/** Controls whose press cannot be taken back (send, confirm, delete, pay...), in English and Arabic.
 * The agent prepares drafts and never presses one: the closed action set has no Enter, and the
 * one list of src/shared/consequentialControls.json closes the same door for a click, a toggle
 * and a select. The native driver checks the element's live name against the same list. */
export function irreversibleControl(target: Pick<NodeInfo, "name">): boolean {
  return consequentialWord(target.name ?? "") !== null;
}

/** Why the proposal cannot run against this snapshot, or null when it can. */
export function validateAgainstSnapshot(target: NodeInfo | null, action: AgentAction): string | null {
  if (!target) return `the reference "${action.ref}" is not in the current snapshot`;
  if (!target.enabled) return `the element is disabled`;
  if (target.offscreen) return `the element is off-screen`;
  const consequential = consequentialReason(action.kind, target.name, action.kind === "select" ? action.value : undefined);
  if (consequential) return consequential;
  if (!patternsOf(target).includes(action.kind)) {
    return `the element accepts only [${patternsOf(target).join(",") || "nothing"}], not ${action.kind}`;
  }
  return null;
}

/** The verify rule for the action, judged against the fresh snapshot. (Exported for the tests; the loop's only writer of `verified`.) */
export function verifyAction(action: AgentAction, before: NodeInfo, fresh: ObserveResult): boolean | null {
  const after = findAfterAct(fresh, before);
  switch (action.kind) {
    case "setValue": {
      if (!after || after.value === undefined) return null;
      // The field's value reads back equal to the text we set, compared
      // line-content-wise: a field (Notepad's edit control, for one) reads a
      // written "\n" back as "\r" or "\r\n", and a strict compare would fail
      // every write and burn the whole step budget on a job that held.
      return normLines(after.value) === normLines(action.text);
    }
    case "toggle": {
      if (!after || !after.state || !before.state) return null;
      return after.state !== before.state;
    }
    case "select": {
      // The chosen item now reports selected (looked up by exact name).
      const item = fresh.nodes.find((n) => n.name === action.value && n.state === "selected");
      return !!item;
    }
    case "expand":
    case "collapse": {
      if (!after || !after.state || !before.state) return null;
      return after.state !== before.state;
    }
    case "click": {
      // The element is still there; it verifies only when something visible
      // actually changed (its state, its value, or where it sits).
      if (!after) return null;
      const stateChanged = (!!after.state || !!before.state) && after.state !== before.state;
      const valueChanged = after.value !== before.value;
      const moved = (after.rect?.[0] !== before.rect?.[0]) || (after.rect?.[1] !== before.rect?.[1]);
      return stateChanged || valueChanged || moved;
    }
  }
}

/** The human line for an action ("Setting "To" to …"). */
export function describeAction(a: AgentAction): string {
  switch (a.kind) {
    case "click": return `Pressing ${a.ref}`;
    case "setValue": return `Setting ${a.ref} to "${a.text.slice(0, 60)}${a.text.length > 60 ? "…" : ""}"`;
    case "toggle": return `Toggling ${a.ref}`;
    case "select": return `Selecting "${a.value}" in ${a.ref}`;
    case "expand": return `Expanding ${a.ref}`;
    case "collapse": return `Collapsing ${a.ref}`;
  }
}
