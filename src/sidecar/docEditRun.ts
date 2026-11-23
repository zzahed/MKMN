/*
 * Edit a copy: the read → propose → validate → apply → verify loop, on the
 * sidecar, over a saved Word file (docs/design/doc-edit-copy.md). The same
 * shape as computerUse.ts, with one structural difference: there is NO driver
 * and NO window grant. The loop never touches a process — it reads the source
 * file, asks the model for text edits, validates every one of them against the
 * document, writes the edited COPY beside the source, reopens the copy from
 * disk and verifies it before any verdict of done.
 *
 * Everything is dependency-injected (an fs-shaped object, the model, emit,
 * signal) so the tests drive it with fakes; the real wiring lives in main.ts,
 * where the fs is node's and the model is the same NPU-first local path chat
 * uses. The run reuses the `agentRun` machine's verdicts and event shapes, so
 * the strip UI, onAgentRun and Stop work unchanged.
 */
import type { ChatMessage } from "../shared/types";
import type { AgentRunEvent } from "../shared/agent";
import { MAX_OFFICE_BYTES } from "../core/office";
import { readZip, fromBytes } from "../core/zip";
import {
  DOC_EDIT_MAX_OPS,
  DOC_EDIT_PART,
  DocEditFault,
  applyDocEdits,
  buildEditedCopy,
  docxModelView,
  verifyEdit,
  type DocEditOp,
} from "../core/docEdit";
import { escapeControlsInStrings } from "./computerUse";

/** The part of the fs the loop needs. Never a directory walk, never a delete of the source. */
export interface DocEditFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** sha256 hex of a file's bytes, so the run can prove the source is untouched. */
  hash(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
}

/** The model is the same bounded, abortable completion the window loop uses. */
export interface DocEditModel {
  propose(messages: ChatMessage[], signal: AbortSignal): Promise<string>;
}

export type DocEditRunDeps = {
  runId: string;
  sourcePath: string;
  task: string;
  fs: DocEditFs;
  model: DocEditModel;
  emit: (ev: AgentRunEvent) => void;
  signal: AbortSignal;
  /**
   * The review gate, when the app offers one: the loop emits the exact
   * proposed change and the destination name, then waits. true = save the
   * edited copy; false = the person cancelled (nothing is written). Absent in
   * the tests that drive the loop directly — the run then behaves exactly as
   * before the gate existed.
   */
  review?: { waitFor(runId: string, signal: AbortSignal): Promise<boolean> };
};

// ---------------------------------------------------------------- the prompt

/**
 * The proposal prompt. A closed JSON answer: text edits, or unsupported. The
 * one-paragraph-one-match rule is spelled out because a small model will
 * otherwise quote a fragment that appears twice.
 */
export const DOC_EDIT_PROPOSE_PROMPT = `You are MKMN's document editor. You propose text edits for ONE saved Word file, from its text, and MKMN applies them to a COPY beside the original.

You see the document as one line per paragraph, in document order.

Reply with EXACTLY ONE JSON object and nothing else. Choose from:
{"kind":"edits","ops":[{"find":"<exact text from one line>","replace":"<new text>"}],"summary":"<what the edits do>"}
{"kind":"unsupported","reason":"<why this edit cannot be made by replacing text inside paragraphs>"}

Rules:
- 0 to 8 edits. If the document already satisfies the task, use 0 edits and say so in the summary.
- Each "find" is quoted EXACTLY as the document shows it and must appear EXACTLY ONCE in the whole document: quote enough surrounding text to make it unique.
- An edit changes text INSIDE one paragraph. "find" never contains a line break and "replace" never contains a line break; a find never crosses a tab either.
- To delete text, use "" as "replace".
- To add or remove paragraphs, split or join lines, or change tables, pictures, headings, lists or formatting, reply unsupported honestly instead of forcing an edit.
- Quote the document's own text exactly as you read it.`;

// ---------------------------------------------------------------- the reply

export type DocEditProposal =
  | { kind: "edits"; ops: DocEditOp[]; summary: string }
  | { kind: "unsupported"; reason: string };

/** Parses the model's reply into a proposal, or names the exact fault. */
export function parseDocEditReply(reply: string): { proposal: DocEditProposal } | { fault: string } {
  const stripped = reply.replace(new RegExp("<" + "think[\\s\\S]*?<" + "/think>", "g"), "").trim();
  const m = /\{[\s\S]*\}/.exec(stripped);
  if (!m) return { fault: "the answer contained no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    // The same one bounded repair as the window loop: raw control characters
    // inside string literals (a small model's habit), nothing else touched.
    try {
      raw = JSON.parse(escapeControlsInStrings(m[0]));
    } catch {
      return { fault: "the JSON did not parse" };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { fault: "the answer was not a JSON object" };
  const o = raw as Record<string, unknown>;
  if (o.kind === "unsupported") {
    return typeof o.reason === "string" && o.reason.trim()
      ? { proposal: { kind: "unsupported", reason: o.reason.trim() } }
      : { fault: 'an "unsupported" answer needs a non-empty "reason"' };
  }
  if (o.kind !== "edits") return { fault: 'the answer must be {"kind":"edits",...} or {"kind":"unsupported",...}' };
  const ops = o.ops;
  if (!Array.isArray(ops)) return { fault: 'an "edits" answer needs an "ops" array' };
  if (ops.length > DOC_EDIT_MAX_OPS) return { fault: `the answer has ${ops.length} edits; at most ${DOC_EDIT_MAX_OPS} are accepted` };
  const clean: DocEditOp[] = [];
  for (let i = 0; i < ops.length; i++) {
    const one = ops[i] as Record<string, unknown>;
    if (!one || typeof one !== "object" || Array.isArray(one)) return { fault: "every edit is an object with find and replace" };
    const find = typeof one.find === "string" ? one.find : undefined;
    const replace = typeof one.replace === "string" ? one.replace : undefined;
    if (find !== undefined && replace !== undefined) { clean.push({ find, replace }); continue; }
    // One bounded repair for a small model's habit with thinking switched off:
    // one edit split into {"find":...},{"replace":...} as two array items.
    // Merged ONLY when each half carries exactly its own key; anything else
    // stays refused — and the merged edit still faces the full validation and
    // the review gate before anything is written.
    if (find !== undefined && !("replace" in one) && i + 1 < ops.length) {
      const next = ops[i + 1] as Record<string, unknown>;
      if (next && typeof next === "object" && !Array.isArray(next) && typeof next.replace === "string" && !("find" in next)) {
        clean.push({ find, replace: next.replace });
        i++;
        continue;
      }
    }
    return { fault: "every edit needs a find string and a replace string" };
  }
  if (typeof o.summary !== "string" || !o.summary.trim()) return { fault: 'an "edits" answer needs a non-empty "summary"' };
  return { proposal: { kind: "edits", ops: clean, summary: o.summary.trim() } };
}

// ---------------------------------------------------------------- the copy name

/** `<base> (edited).docx` beside the source, ` (edited 2)` on collision, never overwriting. */
export async function nextCopyPath(fs: DocEditFs, sourcePath: string): Promise<string> {
  const m = /(\.docx|\.docm)$/i.exec(sourcePath);
  const ext = m ? m[1] : ".docx";
  const base = sourcePath.slice(0, sourcePath.length - ext.length);
  for (let n = 1; n <= 99; n++) {
    const cand = n === 1 ? `${base} (edited)${ext}` : `${base} (edited ${n})${ext}`;
    if (!(await fs.exists(cand))) return cand;
  }
  throw new DocEditFault("the folder already holds too many edited copies of this file.");
}

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

// ---------------------------------------------------------------- the loop

/**
 * The loop. Verdicts: done (the copy verified, or nothing needed changing),
 * unresolved (unsupported, or a verification fault — the copy path is named),
 * failed (a refused proposal twice, a bad file, an unexpected error),
 * cancelled (Stop or a Cancel on the review gate; nothing was written — or the
 * copy already is, and the person is told where). When the app passes a review
 * gate, the validated change is shown to the person (exact find/replace pairs
 * and the destination file name) and nothing is written before they approve;
 * the source is re-hashed at that moment and a moved source faults the run.
 * The source's bytes are never modified; the run re-hashes the source after
 * the write and refuses done if it moved.
 */
export async function runDocEdit(deps: DocEditRunDeps): Promise<void> {
  const { runId, sourcePath, task, fs, model, emit, signal } = deps;
  const name = baseName(sourcePath);
  let step = 0;
  const running = (phase: AgentRunEvent["phase"], line: string, extra: Partial<AgentRunEvent> = {}) =>
    emit({ runId, status: "running", step: ++step, phase, line, actions: [], at: Date.now(), ...extra });
  const settle = (status: AgentRunEvent["status"], line: string, extra: Partial<AgentRunEvent> = {}) =>
    emit({ runId, status, step, phase: "settled", line, actions: [], at: Date.now(), ...extra });
  const fail = (message: string) => settle("failed", `Failed: ${message}`);
  let tmpPath: string | null = null;
  let copyPath: string | null;
  let wrote = false;
  try {
    // ---- read
    running("observe", `Reading ${name}.`);
    if (!sourcePath.trim() || !task.trim()) throw new DocEditFault("the run was asked without a document or a task.");
    if (!/\.(docx|docm)$/i.test(sourcePath)) {
      if (/\.(doc|dot)$/i.test(sourcePath)) {
        throw new DocEditFault(`${name}: this is an old Word format (.doc) that the app cannot edit; save it as .docx first.`);
      }
      throw new DocEditFault(`${name}: this is not a Word document (.docx or .docm).`);
    }
    if (!(await fs.exists(sourcePath))) throw new DocEditFault(`${name}: the file was not found; it may have been moved, renamed or deleted.`);
    const source = await fs.readFile(sourcePath);
    if (source.length === 0) throw new DocEditFault(`${name}: the file is empty.`);
    if (source.length > MAX_OFFICE_BYTES) throw new DocEditFault(`${name}: the file is larger than 30 MB; Edit a copy reads smaller documents.`);
    const files = await readZip(source);
    const part = files[DOC_EDIT_PART];
    if (!part) throw new DocEditFault(`${name}: this Word file has no document part; it may be damaged.`);
    const srcDoc = fromBytes(part);
    const view = docxModelView(srcDoc);
    const sourceHash = await fs.hash(sourcePath);

    // ---- propose (and validate, so a re-ask carries the EXACT fault)
    running("propose", "Asking the model for the edit.");
    let messages: ChatMessage[] = [
      { role: "system", content: DOC_EDIT_PROPOSE_PROMPT },
      { role: "user", content: `The document:\n\n${view}\n\nThe edit the person asked for: ${task}` },
    ];
    let ops: DocEditOp[] | null = null;
    let summary = "";
    for (let attempt = 0; ; attempt++) {
      const reply = await model.propose(messages, signal);
      const parsed = parseDocEditReply(reply);
      if ("fault" in parsed) {
        if (attempt >= 1) throw new DocEditFault(`the model's proposal was refused twice (${parsed.fault}); nothing was changed.`);
        running("propose", `The proposal was not valid (${parsed.fault}); asking again.`);
        messages = [...messages, { role: "assistant", content: reply }, { role: "user", content: `That answer was refused: ${parsed.fault}. Answer again with exactly one JSON object in the schema.` }];
        continue;
      }
      if (parsed.proposal.kind === "unsupported") {
        settle("unresolved", `Not done: this edit cannot be made by replacing text in the document: ${parsed.proposal.reason}`, { reason: parsed.proposal.reason });
        return;
      }
      try {
        applyDocEdits(srcDoc, parsed.proposal.ops); // validation only; the copy's build applies again
        ops = parsed.proposal.ops;
        summary = parsed.proposal.summary;
        break;
      } catch (e) {
        if (!(e instanceof DocEditFault)) throw e;
        if (attempt >= 1) throw new DocEditFault(`the model's proposal was refused twice (${e.message}); nothing was changed.`);
        running("propose", `The proposal was refused (${e.message}); asking again.`);
        messages = [...messages, { role: "assistant", content: reply }, { role: "user", content: `That edit was refused: ${e.message}. Answer again with exactly one JSON object in the schema.` }];
      }
    }

    // ---- review: the person sees the EXACT proposed change and the
    // destination file name BEFORE anything is written. The destination is
    // computed here (nextCopyPath only names a file, it never creates one),
    // so the gate can show the truth.
    if (ops!.length === 0) {
      settle("done", `Done: the document already satisfies the task; the original is unchanged and no copy was written.`, { summary });
      return;
    }
    copyPath = await nextCopyPath(fs, sourcePath);
    if (deps.review) {
      const reviewPhase: AgentRunEvent["phase"] = "review";
      running(reviewPhase, `The change is ready to review. On save it becomes "${baseName(copyPath)}" beside the original.`, {
        review: { ops: ops!, summary, sourceName: name, destination: baseName(copyPath) },
      });
      const approved = await deps.review.waitFor(runId, signal);
      if (!approved) {
        copyPath = null;
        settle("cancelled", "Cancelled: the proposed change was not saved; the original is untouched and nothing was written.");
        return;
      }
      // Approved: the source is revalidated at the last moment, so a file that
      // was moved or edited while the gate stood open is caught BEFORE the
      // copy is written, not after.
      if ((await fs.hash(sourcePath)) !== sourceHash) {
        copyPath = null;
        throw new DocEditFault("the source file changed while the change was under review, so the run wrote nothing; start again to edit the current file.");
      }
    }
    // The destination shown in the review may have been taken since (the
    // final rename replaces a file on Windows): refuse rather than overwrite.
    if (await fs.exists(copyPath)) {
      const taken = baseName(copyPath);
      copyPath = null;
      throw new DocEditFault(`a file named "${taken}" appeared while the change was under review, so the run wrote nothing; start again to save under a free name.`);
    }

    // ---- apply (all validation is behind us: temp file + rename, one write)
    running("act", "Writing the edited copy.");
    const copyBytes = await buildEditedCopy(source, ops!);
    tmpPath = `${copyPath}.part`;
    await fs.writeFile(tmpPath, copyBytes);
    await fs.rename(tmpPath, copyPath);
    tmpPath = null;
    wrote = true;

    // ---- verify: the copy reopened FROM DISK, the source re-hashed
    running("verify", "Reopening the edited copy to verify it.");
    const copyOnDisk = await fs.readFile(copyPath);
    let fault = await verifyEdit(source, copyOnDisk, ops!);
    if (!fault && (await fs.hash(sourcePath)) !== sourceHash) {
      fault = "the source file changed during the run, so the copy can no longer be trusted to match it.";
    }
    if (fault) {
      settle("unresolved", `Not done: the verification failed (${fault}); the copy is at "${baseName(copyPath)}" for you to check or delete.`, { reason: fault });
      return;
    }
    settle("done", `Done: the edited copy is saved as "${baseName(copyPath)}", and the original "${name}" is unchanged.`, { summary, copyPath });
  } catch (e) {
    if (signal.aborted) {
      settle("cancelled", wrote
        ? `Stopped: the run was stopped; check the folder of "${name}" for an edited copy or a .part file.`
        : "Stopped: the run was stopped; nothing was written.");
      return;
    }
    if (e instanceof DocEditFault) { fail(e.message); return; }
    fail(`the run stopped unexpectedly: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  } finally {
    if (tmpPath) { try { await fs.unlink(tmpPath); } catch { /* already gone */ } }
  }
}

/** Waits for the person's answer at the review gate. A stop that came before
 *  the wait began ends it at once, and a later stop ends it too. */
export function reviewWait(answers: Map<string, (ok: boolean) => void>, id: string, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("aborted")); return; }
    answers.set(id, resolve);
    signal.addEventListener("abort", () => {
      if (answers.get(id) === resolve) answers.delete(id);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
