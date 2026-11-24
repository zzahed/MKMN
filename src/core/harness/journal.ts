/**
 * The append-only JSONL journal of harness runs, in the workspace
 * (`mkmnPaths().workspaceDir / harness / <runId>.jsonl`).
 *
 * Every settled step is one line: the prompt sections it saw (names and sizes,
 * never the full text), the reply, the validation results, the retries, the
 * tokens (measured or marked estimated), the seconds and the error. A run opens
 * with one `run` line; a step that was started and never settled is closed with
 * an `interrupted` line when the run resumes.
 *
 * The journal is append-only: there is no API here that truncates or rewrites a
 * file, and the tests pin that. "Copy full log" and the build progress views read
 * these lines.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { mkmnPaths } from "../../shared/paths";

/** The name and byte size of one prompt section, never its text. */
export interface PromptSectionRef {
  name: string;
  bytes: number;
}

export interface ValidationRecord {
  validator: string;
  verdict: "schema" | "ok" | "retry" | "fail";
  reason?: string;
}

/** Tokens are the measured usage when the server reported it, and estimated otherwise; the flag says which. */
export interface StepUsage {
  prompt: number;
  output: number;
  measured: boolean;
}

export type StepStatus = "ok" | "failed" | "retry_exhausted" | "interrupted";

/** One settled step, as the journal holds it and the UI reads it. */
export interface JournalStep {
  type: "step";
  runId: string;
  seq: number;
  id: string;
  kind: string;
  status: StepStatus;
  startedAt: string;
  endedAt: string;
  seconds: number;
  attempts: number;
  outputRetriesUsed: number;
  transportRetriesUsed: number;
  promptSections?: PromptSectionRef[];
  reply?: string;
  validations: ValidationRecord[];
  tokens: StepUsage;
  error?: string;
  /** The step's input: a run journals the whole settled record, and a resume checks it against the plan. */
  input?: unknown;
}

export interface JournalRun {
  type: "run";
  runId: string;
  pipeline: string;
  startedAt: string;
  resumed: boolean;
  /** The chat the run served, when it served one: deleting that chat deletes this journal (harness/forget.ts). */
  conversationId?: string;
}

/** Written when a run resumes and finds a step that was started and never settled. */
export interface JournalInterrupted {
  type: "interrupted";
  runId: string;
  seq: number;
  id: string;
  at: string;
  reason: string;
}

export interface JournalStepStarted {
  type: "step_started";
  runId: string;
  seq: number;
  id: string;
  startedAt: string;
}

/**
 * Written when the person pressed skip or go-back-a-step while the run worked
 * The press is an appended fact — the step it landed on is
 * named, and the steps of the redo follow it in the file. The superseded step's
 * own record stays (the journal is append-only); this entry is how a reader
 * tells the run's real course from the work the press threw away.
 */
export interface JournalRewind {
  type: "rewind";
  runId: string;
  /** The step the press landed on: the one in flight (its work was thrown away), or the last issued one when the press landed between steps. */
  seq: number;
  action: "skip" | "back";
  at: string;
  reason: string;
}

export type JournalEntry = JournalRun | JournalStepStarted | JournalStep | JournalInterrupted | JournalRewind;

/** The harness folder of the workspace; every run's journal lives here. */
export function journalDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mkmnPaths(env).workspaceDir, "harness");
}

export function journalPath(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(journalDir(env), `${runId}.jsonl`);
}

/** Append one line. Creates the folder on first write; never touches existing bytes. */
export function appendEntry(file: string, entry: JournalEntry): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Read every well-formed line. A malformed line is skipped and counted, never rewritten.
 *  `torn` says the LAST line is one of them: what a process that died mid-write leaves. */
export function readJournal(file: string): { entries: JournalEntry[]; malformed: number; torn: boolean } {
  if (!existsSync(file)) return { entries: [], malformed: 0, torn: false };
  const entries: JournalEntry[] = [];
  let malformed = 0;
  let torn = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      entries.push(JSON.parse(text) as JournalEntry);
      torn = false;
    } catch {
      malformed++;
      torn = true;
    }
  }
  return { entries, malformed, torn };
}

/** The settled step records of a journal, in order. */
export function settledSteps(file: string): JournalStep[] {
  return readJournal(file).entries.filter((e): e is JournalStep => e.type === "step" && e.status !== "interrupted");
}

/**
 * What a resume needs: the settled steps to replay, and the steps that were started
 * and never settled (their process died mid-step), which the resuming run marks
 * interrupted before executing them again. Also what the resume must refuse on: `corrupt`, the
 * unreadable lines before the journal's end (a torn last line is not one), and `foreign`, the
 * entries that belong to another run than `runId` (left out of settled and dangling).
 */
export function resumeReplay(file: string, runId?: string): { settled: JournalStep[]; dangling: { seq: number; id: string }[]; corrupt: number; foreign: number } {
  const { entries: all, malformed, torn } = readJournal(file);
  const entries = runId === undefined ? all : all.filter((e) => e.runId === runId);
  const settled = new Map<number, JournalStep>();
  const started = new Map<number, string>();
  for (const e of entries) {
    if (e.type === "step_started") started.set(e.seq, e.id);
    else if (e.type === "step") {
      settled.set(e.seq, e);
      started.delete(e.seq);
    } else if (e.type === "interrupted") started.delete(e.seq);
  }
  const dangling = [...started]
    .map(([seq, id]) => ({ seq, id }))
    .sort((a, b) => a.seq - b.seq);
  return {
    settled: [...settled.values()].sort((a, b) => a.seq - b.seq),
    dangling,
    corrupt: malformed - (torn ? 1 : 0),
    foreign: all.length - entries.length,
  };
}
