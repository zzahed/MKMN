import { rowAction } from "./rowAction";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Project, ProjectFile, ScheduledTask } from "../shared/types";
import { classifyFile, noPdfText } from "../core/attachments";
import { describePdfError } from "../core/pdf";
import { knowledgeBudget, knowledgeSize } from "../core/projects";
import { filesHashOf, fileKnowledgeStats, overlappingFilePairs } from "../core/knowledge/index";
import { isMachineState } from "../shared/stateMachines";
import { describeSchedule } from "../core/schedule";
import type { Conversation } from "./store";
import { api } from "./api";
import { ICONS, Icon } from "./Icon";
import { PinIcon } from "./Icons";
import { kindLabel } from "./ArtifactView";

const MAX_FILE = 1_000_000;

/** One line beside the two starting actions: how many files, and whether they are
 *  ready to be read with the next question (sent whole, or searched once indexed). */
export function filesReadiness(count: number, indexState: string | null, overBudget: boolean, hasFolder = false): string {
  if (count === 0) return hasFolder ? "No reference files yet · linked folder available" : "No reference files yet";
  const n = `${count} reference file${count === 1 ? "" : "s"}`;
  if (!overBudget) return `${n} · ready. The assistant reads all of it in every chat.`;
  if (indexState === "ready") return `${n} · ready. The assistant looks up the parts that match each question.`;
  if (indexState === "failed") return `${n} · could not be prepared. See Reference files.`;
  // no status to read (not reported yet, or the store is out of reach): say what will happen, claim nothing
  if (indexState === null) return `${n} · the assistant looks up the parts that match each question.`;
  return `${n} · preparing them. You can start a chat now.`;
}

/** An untitled note is named by its first words, so several notes can be told apart. */
export function noteTitleFrom(text: string): string {
  const words = text.trim().split(/\s+/);
  return words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
}

export function newProject(): Project {
  const now = Date.now();
  return { id: crypto.randomUUID(), name: "Untitled project", description: "", instructions: "", files: [], created: now, updated: now };
}

const PAGE = 12;

/** About how many words a text holds: a size people can picture, unlike characters or tokens. */
export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** Why preparing failed, in plain words. The raw error is never shown: it can carry internal terms. */
export function preparingFailure(error: string | null): string {
  const most = error?.match(/at most (\d+)/);
  if (most) return `Your files could not be prepared because this project has more than ${most[1]} files. Remove some, or split them across projects.`;
  return "Your files could not be prepared. Try again. If it keeps failing, remove the file you added last.";
}

/** The one message for a file that cannot be added to a project. */
export const cannotAdd = (name: string) => `“${name}” can't be added. You can add PDFs, Word, Excel and PowerPoint files, and text files such as .txt or .csv.`;

/** A file's size in plain words: its pages when the file has pages, and its words. */
export function describeFileSize(words: number, pages: number, scannedPages: number): string {
  const parts: string[] = [];
  if (pages > 0) parts.push(`${pages.toLocaleString()} page${pages === 1 ? "" : "s"}${scannedPages > 0 ? ` (${scannedPages.toLocaleString()} read from scans)` : ""}`);
  if (words > 0) parts.push(`about ${words.toLocaleString()} word${words === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "no readable text";
}

function ProjectEditor({ project, convs, tasks, artifacts, contextTokens, onChange, onBack, onDelete, onPin, onArchive, onNewChat, onOpenChat, onPinChat, onArchiveChat, onOpenTasks, onOpenArtifact }: {
  project: Project; convs: Conversation[]; tasks: ScheduledTask[]; artifacts: Artifact[]; contextTokens: number;
  onChange: (p: Project) => void; onBack: () => void; onDelete: () => void; onPin: () => void; onArchive: () => void;
  onNewChat: (text?: string) => void; onOpenChat: (id: string) => void; onPinChat: (id: string) => void; onArchiveChat: (id: string, on: boolean) => void;
  onOpenTasks: () => void; onOpenArtifact: (id: string) => void;
}) {
  const [draft, setDraft] = useState(project);
  const [noteName, setNoteName] = useState("");
  const [noteText, setNoteText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [editInstr, setEditInstr] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);
  const first = useRef(true);
  /** An edit not saved yet: the close of the editor flushes it, and only it. */
  const dirty = useRef(false);
  /** Set once the project is deleted: nothing may save it again (a save would bring it back). */
  const gone = useRef(false);
  /** The latest pin and archive state, read at save time (never a render's stale copy). */
  const latest = useRef(project);
  latest.current = project;
  const flush = () => {
    if (!dirty.current || gone.current) return;
    dirty.current = false;
    onChange({ ...draftRef.current, pinned: latest.current.pinned, archived: latest.current.archived });
  };
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    dirty.current = true;
    const t = setTimeout(flush, 400);
    return () => clearTimeout(t);
  }, [draft]);
  // Leaving the editor saves an edit still waiting for its timer — never one already saved.
  useEffect(() => () => flush(), []);

  const patch = (p: Partial<Project>) => setDraft((d) => ({ ...d, ...p }));
  /** Reading of the PDFs of the current addFiles run; a new run stops the previous one, and leaving this project stops it too. */
  const pdfReadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { pdfReadAbort.current?.abort(); pdfReadAbort.current = null; }, []);
  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    setErr(null);
    const added: ProjectFile[] = [];
    const failed: string[] = [];
    const fail = (m: string) => { failed.push(m); };
    pdfReadAbort.current?.abort();
    const pdfAbort = new AbortController();
    pdfReadAbort.current = pdfAbort;
    for (const f of Array.from(list)) {
      if (pdfAbort.signal.aborted) break;
      if (classifyFile(f.name, f.type) === "pdf") {
        try {
          // scanned pages are recognized on the device (D6); when recognition could not
          // read the file at all, its own problem (the language pack to add) is what the
          // person reads — the generic message only stands when it also found nothing
          let ocrProblem: string | null = null;
          const text = await (await import("./pdf")).readPdf(f, { signal: pdfAbort.signal, onOcrProblem: (m) => { ocrProblem ??= m; } });
          if (pdfAbort.signal.aborted) break; // superseded mid-read: nothing of this run is kept
          if (!text.trim()) fail(ocrProblem ?? noPdfText(f.name));
          else added.push({ id: crypto.randomUUID(), name: f.name, content: text });
        } catch (e) { if (pdfAbort.signal.aborted) break; fail(describePdfError(f.name, e)); }
        continue;
      }
      if (classifyFile(f.name, f.type) === "document") {
        try { added.push({ id: crypto.randomUUID(), name: f.name, content: await (await import("./docs")).readDocument(f) }); } catch (e) { fail((e as Error).message); }
        continue;
      }
      const kind = classifyFile(f.name, f.type);
      if (kind === "unsupported" || kind === "image") { fail(cannotAdd(f.name)); continue; }
      if (f.size > MAX_FILE) { fail(`“${f.name}” is larger than 1 MB. Split it into smaller files, or paste only the part you need under “Paste text instead”.`); continue; }
      const text = await f.text();
      if (text.includes("\u0000")) { fail(cannotAdd(f.name)); continue; }
      added.push({ id: crypto.randomUUID(), name: f.name, content: text });
    }
    if (pdfReadAbort.current === pdfAbort) pdfReadAbort.current = null;
    if (pdfAbort.signal.aborted) return; // a newer run owns the notice: this one keeps nothing
    if (failed.length === 1) setErr(failed[0]);
    else if (failed.length > 1) setErr(`${failed.length} files could not be added:\n${failed.join("\n")}`);
    if (added.length) setDraft((d) => ({ ...d, files: [...d.files, ...added] }));
    if (fileRef.current) fileRef.current.value = "";
  };
  const addNote = () => {
    if (!noteText.trim()) return;
    setDraft((d) => ({ ...d, files: [...d.files, { id: crypto.randomUUID(), name: noteName.trim() || noteTitleFrom(noteText), content: noteText }] }));
    setNoteName(""); setNoteText("");
  };

  const pickFolder = async () => {
    const dir = await api().pickFolder();
    if (dir) patch({ folder: dir });
  };
  const start = () => { const t = ask.trim(); onNewChat(t || undefined); setAsk(""); };

  const budget = knowledgeBudget(contextTokens);
  const used = knowledgeSize(draft);
  const pct = Math.min(100, Math.round((used / budget) * 100));
  /** The meter shows only while everything fits: never 0% with files in it, never 100% while still under the limit. */
  const shownPct = Math.min(99, Math.max(1, pct));

  // The knowledge index (D7): what it is per file (sections, pages, pages read
  // from scans — cut the same way the index cuts them) and what the store says
  // of the whole (ready, stale, failed...). A missing or unreachable store
  // says nothing; the screen never guesses.
  const fileStats = useMemo(() => new Map(draft.files.map((f) => [f.id, { ...fileKnowledgeStats(f), words: wordCount(f.content) }])), [draft.files]);
  // C4: pairs of files whose sections say the same thing — decided by the code from
  // the sections' words, never from the names
  const overlaps = useMemo(() => overlappingFilePairs(draft.files), [draft.files]);
  const [indexState, setIndexState] = useState<string | null>(null);
  const [indexProgress, setIndexProgress] = useState<{ done: number; of: number } | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const indexHash = useMemo(() => filesHashOf(draft.files), [draft.files]);
  // The background build: adding or removing a file starts the index
  // build NOW (not at the first chat), through the knowledgeIndex machine in the
  // sidecar. One attempt per version of the files: a build that fails stays failed
  // (named, with a Retry) instead of looping behind the person's back.
  const startedBuilds = useRef<Set<string>>(new Set());
  /** Bumped by Retry: the watch starts again for the same files. */
  const [pollRound, setPollRound] = useState(0);
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // while a build is on its way, keep watching until it lands: the poll reschedules
    // ITSELF, so two answers in the same state ("indexing", "indexing") never end the watch
    const inFlight = (s: string | null): boolean => s === null || s === "queued" || s === "indexing" || s === "stale";
    const poll = async () => {
      let st: string | null = null;
      try {
        const s = await api().knowledgeStatus(draft.id, indexHash);
        if (gone) return;
        st = s && isMachineState("knowledgeIndex", s.state) ? s.state : null;
        setIndexState(st);
        setIndexProgress(s?.progress ?? null);
        setIndexError(s?.error ?? null);
        if (st && st !== "ready" && draft.files.length > 0 && !startedBuilds.current.has(indexHash)) {
          startedBuilds.current.add(indexHash);
          void api().knowledgeBuild(draft.id, draft.files.map((f) => ({ id: f.id, name: f.name, content: f.content })));
        }
      } catch { if (!gone) { setIndexState(null); setIndexProgress(null); } }
      if (!gone && inFlight(st)) timer = setTimeout(() => { void poll(); }, 1200);
    };
    void poll();
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, [draft.id, indexHash, draft.files.length, pollRound]);
  const retryIndex = () => {
    startedBuilds.current.add(indexHash); // this retry is the attempt for these files
    setIndexState("indexing");
    void api().knowledgeBuild(draft.id, draft.files.map((f) => ({ id: f.id, name: f.name, content: f.content })));
    setPollRound((n) => n + 1); // and the watch follows it to its end
  };
  const mine = convs.filter((c) => c.projectId === project.id && c.turns.length > 0 && !c.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updated - a.updated);
  const myTasks = tasks.filter((t) => t.projectId === project.id);
  const myArts = artifacts.filter((a) => a.projectId === project.id);

  return (
    <div className="page proj-page">
      <div className="proj-crumbs">
        <button className="linkbtn" onClick={onBack}>Projects</button><span className="muted">/</span><span>{draft.name || "Untitled project"}</span>
        <span className="grow" />
        {project.archived && <span className="muted small">Archived</span>}
        <button className={`linkbtn ${project.pinned ? "on" : ""}`} onClick={onPin} disabled={project.archived} title={project.archived ? "Restore the project to pin it" : project.pinned ? "Stop keeping this project at the top of your list" : "Keep this project at the top of your list"}>{project.pinned ? "Unpin" : "Pin"}</button>
        <button className="linkbtn" onClick={onArchive} title={project.archived ? "Put this project back in your list" : "Hide this project from your list. Nothing is deleted, and you can restore it later."}>{project.archived ? "Restore" : "Archive"}</button>
      </div>
      <div className="proj-cols">
        <div className="proj-main">
          <input className="title-input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Project name" />
          <input className="wide" value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="Short description (optional)" aria-label="Project description" />
          <div className="proj-ask">
            <textarea rows={3} value={ask} placeholder={`Ask anything to start a chat in ${draft.name && draft.name !== "Untitled project" ? draft.name : "this project"}`} aria-label="Start a chat in this project"
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); start(); } }} />
            <div className="proj-ask-foot">
              <span className="muted small proj-ready">{filesReadiness(draft.files.length, indexState, used > budget, !!draft.folder)}</span>
              <span className="row tight">
                <button className="ghost" onClick={() => fileRef.current?.click()}>Add files</button>
                <button className="primary" onClick={start}>Start chat</button>
              </span>
            </div>
          </div>
          <h2 className="proj-sub">Chats in this project</h2>
          <div className="list proj-chats">
            {mine.slice(0, shown).map((c) => (
              <div key={c.id} className="row-item clickable" {...rowAction(() => onOpenChat(c.id))}>
                <span className="grow">{c.title}</span>
                <span className="muted small">{new Date(c.updated).toLocaleDateString()}</span>
                <button className={`linkbtn ${c.pinned ? "on" : ""}`} title={c.pinned ? "Unpin chat" : "Pin chat"} aria-label={c.pinned ? "Unpin chat" : "Pin chat"} onClick={(e) => { e.stopPropagation(); onPinChat(c.id); }}><PinIcon /></button>
                <button className="linkbtn" title="Archive chat" aria-label="Archive chat" onClick={(e) => { e.stopPropagation(); onArchiveChat(c.id, true); }}><Icon d={ICONS.archive} size={14} /></button>
              </div>
            ))}
            {mine.length === 0 && <div className="muted small">No chats yet. Type a question above and press Start chat.</div>}
          </div>
          {mine.length > shown && <button className="show-more wide-more" onClick={() => setShown((n) => n + PAGE)}>Show more <span className="count">{Math.min(PAGE, mine.length - shown)}</span></button>}
        </div>

        <aside className="proj-side">
          <div className="side-card">
            <div className="side-card-head"><h2>Instructions</h2><button className="linkbtn" onClick={() => setEditInstr((v) => !v)} aria-label={editInstr ? "Done editing instructions" : "Edit instructions"}>{editInstr ? "Done" : "Edit"}</button></div>
            {editInstr
              ? <><textarea rows={7} autoFocus value={draft.instructions} onChange={(e) => patch({ instructions: e.target.value })} aria-label="Project instructions" placeholder="e.g. You are my Arabic tutor. Answer in Arabic first, then give the English translation." /><p className="muted small">Changes save automatically.</p></>
              : <p className="muted small clip3">{draft.instructions.trim() || "Optional. Tell the assistant how to help in this project, for example its role, tone or answer format. It follows these in every chat here."}</p>}
          </div>

          <div className="side-card">
            <div className="side-card-head"><h2>Reference files</h2>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
              <button className="linkbtn" onClick={() => fileRef.current?.click()}>Add files</button></div>
            {/* What the assistant reads with a question, from the app's own limit
                (knowledgeBudget(contextTokens)): under it, the files are read whole; over it,
                each question is searched and only the matching parts are read. Search covers
                the over-limit case, so nothing here uses a warning colour. */}
            {draft.files.length > 0 && (used > budget
              ? <p className="muted small">Too long to read all at once: the current model reads about {(Math.round(budget / 6 / 100) * 100).toLocaleString()} words at a time. For each question, the assistant looks up the parts that match.</p>
              : <>
                  <div className="meter-line">
                    <div className="track" role="progressbar" aria-label="How much of what the assistant can read at once your reference files use" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shownPct}><div className="fill" style={{ width: `${shownPct}%` }} /></div>
                    <span className="small muted">{used / budget < 0.01 ? "Less than 1%" : `${shownPct}%`} of what the assistant can read at once</span>
                  </div>
                  <p className="muted small">Short enough to read in full: the assistant reads all of it in every chat in this project.</p>
                </>)}
            {/* Preparing (the search index) matters only when the files are too long to
                read whole; under the limit it would be noise. */}
            {/* One live region, always mounted, so a screen reader announces each change. */}
            <p className={`muted small ${indexState && used > budget ? "" : "sr-only"}`} role="status" aria-live="polite">
              {indexState && used > budget && (indexState === "ready" ? "Your files are ready."
                  : indexState === "indexing" ? <>Preparing your files{indexProgress ? `: ${indexProgress.done} of ${indexProgress.of} done` : ""}…</>
                  : indexState === "stale" ? "Your files changed. Preparing them again…"
                  : indexState === "queued" ? "Waiting to prepare your files…"
                  : preparingFailure(indexError))}
            </p>
            {/* Try again only when trying again can help: never for too many files */}
            {indexState === "failed" && used > budget && !/at most \d+/.test(indexError ?? "") && <button className="linkbtn" onClick={retryIndex}>Try again</button>}
            {overlaps.length > 0 && overlaps.map(([a, b]) => (
              <p key={`${a}\u0000${b}`} className="muted small">“{a}” and “{b}” cover much of the same content, so an answer may quote either one. If one is an older copy, remove it.</p>
            ))}
            <div className="side-files">
              {draft.files.map((f) => {
                const s = fileStats.get(f.id);
                const preparing = used > budget && (indexState === "queued" || indexState === "indexing" || indexState === "stale");
                return (
                  <div key={f.id} className="side-file knowledge-file">
                    <div className="grow clip-col">
                      <span className="clip" title={f.name}>{f.name}</span>
                      <span className="muted small">
                        {s ? describeFileSize(s.words, s.pages, s.scannedPages) : ""}
                        {preparing ? " · being prepared" : ""}
                      </span>
                    </div>
                    <button className="linkbtn" aria-label={`Remove ${f.name}`} onClick={() => patch({ files: draft.files.filter((x) => x.id !== f.id) })}>Remove</button>
                  </div>
                );
              })}
              {draft.files.length === 0 && <div className="muted small">Add notes, reports or PDFs the assistant should know about. It can use them in every chat in this project. They stay on this computer.</div>}
            </div>
            {err && <div className="error-box" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}
            <details className="sysprompt"><summary className="small muted">Paste text instead</summary>
              <input className="wide" value={noteName} onChange={(e) => setNoteName(e.target.value)} placeholder="Title (optional)" aria-label="Note title" style={{ margin: "6px 0" }} />
              <textarea rows={4} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Paste text here" aria-label="Note text" />
              <div className="row"><button className="ghost" onClick={addNote} disabled={!noteText.trim()}>Add note</button></div>
            </details>
          </div>

          <div className="side-card">
            <div className="side-card-head"><h2>Linked folder</h2><button className="linkbtn" onClick={() => void pickFolder()}>{draft.folder ? "Change folder" : "Choose folder"}</button></div>
            {draft.folder
              ? <><div className="side-file"><span className="clip grow" title={draft.folder}>{draft.folder}</span><button className="linkbtn" title="Unlink this folder. Nothing in it is deleted." onClick={() => patch({ folder: undefined })}>Unlink</button></div><p className="muted small">The assistant can read this folder. It never changes or deletes anything.</p></>
              : <p className="muted small">Optional. When a question needs it, the assistant can look in a folder on this computer and read the files there. It never changes or deletes anything.</p>}
          </div>

          {(myArts.length > 0 || myTasks.length > 0) && (
            <div className="side-card">
              <div className="side-card-head"><h2>Made in this project</h2></div>
              <div className="side-files">
                {myArts.map((a) => <div key={a.id} className="side-file clickable" {...rowAction(() => onOpenArtifact(a.id))}><span className="clip grow">{a.title}</span><span className="muted small">{kindLabel(a)}</span></div>)}
                {myTasks.map((t) => <div key={t.id} className="side-file clickable" {...rowAction(onOpenTasks)}><span className="clip grow">{t.name}</span><span className="muted small">{describeSchedule(t.schedule)}</span></div>)}
              </div>
            </div>
          )}

          <button className="danger" onClick={() => { if (confirm(`Delete the project "${draft.name}"?\n\nThis deletes the project's instructions and its copies of your reference files, and unlinks the folder. The folder and your original files are not touched. Its chats, scheduled tasks and the files it made are kept, but they will no longer use this project's instructions or files.\n\nThis cannot be undone. To hide the project instead, choose Cancel and use Archive.`)) { gone.current = true; onDelete(); } }}>Delete project</button>
        </aside>
      </div>
    </div>
  );
}

export function Projects(props: {
  projects: Project[]; convs: Conversation[]; tasks: ScheduledTask[]; artifacts: Artifact[]; contextTokens: number;
  openId: string | null; onOpen: (id: string | null) => void;
  onSave: (p: Project) => void; onDelete: (id: string) => void; onPin: (p: Project) => void; onArchive: (p: Project, on: boolean) => void;
  onNewChat: (projectId: string, text?: string) => void; onOpenChat: (id: string) => void; onPinChat: (id: string) => void; onArchiveChat: (id: string, on: boolean) => void;
  onOpenTasks: () => void; onOpenArtifact: (id: string) => void;
}) {
  const { projects, convs, openId, onOpen } = props;
  const [showArchived, setShowArchived] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const open = projects.find((p) => p.id === openId);
  if (open) {
    return (
      <ProjectEditor
        key={open.id} project={open} convs={convs} tasks={props.tasks} artifacts={props.artifacts} contextTokens={props.contextTokens}
        onChange={props.onSave} onBack={() => onOpen(null)} onDelete={() => { props.onDelete(open.id); onOpen(null); }}
        onPin={() => props.onPin(open)} onArchive={() => { props.onArchive(open, !open.archived); if (!open.archived) onOpen(null); }}
        onNewChat={(text) => props.onNewChat(open.id, text)} onOpenChat={props.onOpenChat} onPinChat={props.onPinChat} onArchiveChat={props.onArchiveChat}
        onOpenTasks={props.onOpenTasks} onOpenArtifact={props.onOpenArtifact}
      />
    );
  }
  const archivedCount = projects.filter((p) => p.archived).length;
  const sorted = projects.filter((p) => !!p.archived === showArchived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updated - a.updated);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Projects</h1><p className="muted">Keep instructions and reference files together for one topic. Every chat in a project can use them.</p></div>
        <button className="primary" onClick={() => { const p = newProject(); props.onSave(p); onOpen(p.id); }}>＋ New project</button>
      </div>
      {(archivedCount > 0 || showArchived) && (
        <div className="row"><button className="ghost" onClick={() => { setShowArchived((v) => !v); setShown(PAGE); }}>{showArchived ? "Back to projects" : `Archived (${archivedCount})`}</button></div>
      )}
      {sorted.length === 0 ? (
        <div className="empty-box"><p>{showArchived ? "No archived projects." : "No projects yet. Make one for a course, a client, a piece of work or a recurring job. Add what the assistant should know, then start a chat."}</p></div>
      ) : (
        <>
          <div className="grid">
            {sorted.slice(0, shown).map((p) => {
              const n = convs.filter((c) => c.projectId === p.id && c.turns.length > 0).length;
              return (
                <div key={p.id} className="card clickable" {...rowAction(() => onOpen(p.id))}>
                  <div className="card-top">
                    <div className="card-title">{p.pinned && <span className="pin-mark" title="Pinned"><PinIcon /></span>}{p.name}</div>
                    <div className="card-actions">
                      {!p.archived && <button className={`linkbtn ${p.pinned ? "on" : ""}`} title={p.pinned ? "Unpin project" : "Pin project"} aria-label={p.pinned ? "Unpin project" : "Pin project"} onClick={(e) => { e.stopPropagation(); props.onPin(p); }}><PinIcon /></button>}
                      <button className="linkbtn" title={p.archived ? "Restore project" : "Archive project"} aria-label={p.archived ? "Restore project" : "Archive project"} onClick={(e) => { e.stopPropagation(); props.onArchive(p, !p.archived); }}><Icon d={p.archived ? ICONS.retry : ICONS.archive} size={14} /></button>
                    </div>
                  </div>
                  <div className="muted small clip2">{p.description || p.instructions || "No description"}</div>
                  <div className="muted small">{p.files.length} reference file{p.files.length === 1 ? "" : "s"}{p.folder ? " + linked folder" : ""} · {n} chat{n === 1 ? "" : "s"} · updated {new Date(p.updated).toLocaleDateString()}</div>
                </div>
              );
            })}
          </div>
          {sorted.length > shown && <button className="show-more wide-more" onClick={() => setShown((n) => n + PAGE)}>Show more <span className="count">{Math.min(PAGE, sorted.length - shown)}</span></button>}
        </>
      )}
    </div>
  );
}
