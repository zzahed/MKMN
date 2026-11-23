/**
 * The knowledge index: a BM25 index over a project's knowledge
 * sections, kept on disk next to the workspace's own files, so a question is
 * answered from the few sections that hold it instead of packing every file
 * into the request.
 *
 * The index belongs to ONE project and is rebuilt only when its files changed:
 * the stored file carries a hash of the files it was built from, and opening
 * it again with the same hash is a load, never a rebuild. The caller feeds the
 * files (the project store lives in the webview, so the files travel with the
 * request, like the project folder does); this module owns the scoring, the
 * store file and the read-back.
 *
 * Node only (it reads and writes the store): the renderer never imports it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** The index is written to a temp file and renamed over the old one: a crash mid-write never leaves half a file. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}
import * as path from "node:path";
import { mkmnPaths } from "../../shared/paths";
import { hashText } from "../memo";
import { filesHashOf, sectionsOf, tokenize, type KnowledgeFileLike } from "./index";
import type { Embedder } from "./embed";
import { nextState } from "../../shared/stateMachines";
import { forgetCountOf, knowledgeOffloadName, markKnowledgeForgotten, safeIdOf } from "./ids";
import { forgetVectorProject, openVectorIndex, type VectorIndex } from "./vectors";

export { safeIdOf };
import type { KnowledgeIndexState } from "../../shared/stateMachines.generated";

/** Where a project's knowledge index lives: `<workspace>/knowledge/<project>.json`. */
export function knowledgeDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mkmnPaths(env).workspaceDir, "knowledge");
}

const indexFileOf = (dir: string, projectId: string): string =>
  path.join(dir, `${safeIdOf(projectId)}.json`);

interface StoredDoc {
  fileId: string;
  name: string;
  title: string;
  text: string;
  /** Where the section sits in its file, as citations name it (D5): a PDF page, a slide, a sheet's rows. */
  page?: number;
  slide?: number;
  sheet?: string;
  rowFrom?: number;
  rowTo?: number;
  /** The words were recognized from the page's picture (a scan, D6). */
  scanned?: boolean;
}
interface StoredIndex {
  /** 3: the section records carry the scanned flag too (D6); an older store is rebuilt once. */
  version: 3;
  /** The fingerprint of the files this index was built from: a mismatch means the files changed and it is rebuilt. */
  hash: string;
  docs: StoredDoc[];
}

export interface KnowledgeHit {
  fileId: string;
  name: string;
  title: string;
  text: string;
  score: number;
  /** The section's position in the index's own list (index.sections()): the outline and the picks are named positionally. */
  doc: number;
  page?: number;
  slide?: number;
  sheet?: string;
  rowFrom?: number;
  rowTo?: number;
  /** The words were recognized from the page's picture (a scan, D6). */
  scanned?: boolean;
}

export interface KnowledgeIndex {
  /** True when the store had to be rebuilt (the files changed, or there was no store yet). */
  rebuilt: boolean;
  /** The sections the index holds. */
  count: number;
  /** The best sections for a question, best first (BM25 over the normalised words); empty when nothing matches. */
  search(query: string, limit?: number): KnowledgeHit[];
  /** Every section the index holds, in index order (the locator reads this outline when nothing matched the question's words). */
  sections(): KnowledgeHit[];
  /**
   * The share of the query's subject words a section holds, each word weighted by
   * its IDF (a rare word counts more than a common one). A word no section holds
   * counts at full weight and is never matched: a paraphrase the files do not use
   * ("earn" for "net income") makes the match weak, never strong. `skip` holds the
   * words that do not count (the question's own function words).
   */
  coverage(query: string, doc: number, skip?: ReadonlySet<string>): number;
  /** Where this open came from: the process's memory, the store file, or a fresh build. */
  source: "memory" | "store" | "built";
}

// ---------------------------------------------------------------- BM25

const K1 = 1.2;
const B = 0.75;

interface Posting {
  doc: number;
  tf: number;
}

/**
 * The scored index in memory: one postings list per term, one length per
 * document. Built when the store is opened or rebuilt; the store file itself
 * keeps only the sections (the postings derive from them in milliseconds).
 */
function buildPostings(docs: StoredDoc[]): { postings: Map<string, Posting[]>; lengths: number[] } {
  const postings = new Map<string, Posting[]>();
  const lengths: number[] = [];
  for (const [i, d] of docs.entries()) {
    const words = tokenize(d.text);
    lengths.push(words.length);
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const [w, n] of tf) {
      const list = postings.get(w) ?? [];
      list.push({ doc: i, tf: n });
      postings.set(w, list);
    }
  }
  return { postings, lengths };
}

function searchDocs(docs: StoredDoc[], postings: Map<string, Posting[]>, lengths: number[], query: string, limit: number): KnowledgeHit[] {
  const q = tokenize(query);
  if (!q.length || docs.length === 0) return [];
  const avgLen = lengths.reduce((n, l) => n + l, 0) / docs.length || 1;
  const scores = new Map<number, number>();
  for (const term of new Set(q)) {
    const list = postings.get(term);
    if (!list) continue;
    const idf = Math.log(1 + (docs.length - list.length + 0.5) / (list.length + 0.5));
    for (const { doc, tf } of list) {
      const rel = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (lengths[doc] / avgLen)));
      scores.set(doc, (scores.get(doc) ?? 0) + idf * rel);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([doc, score]) => ({ ...docs[doc], doc, score }));
}

// ---------------------------------------------------------------- the store

const storedHash = (files: KnowledgeFileLike[]): string => hashText(files.map((f) => `${f.id}\u0000${f.name}\u0000${f.content}`).join("\u0001"));

/**
 * The lifecycle tracker: one project's index in one store
 * directory moves through the shared `knowledgeIndex` machine
 * (src/shared/stateMachines.json) as the store builds it — queued, indexing,
 * ready or failed, stale when the files changed after a build. Every move
 * goes through the machine's own events, so a wiring mistake is a thrown
 * error, not a wrong state. It is this process's live record: the Project
 * knowledge screen reads the OBSERVED status (`knowledgeIndexStatus`),
 * derived from the store and this tracker.
 */
const live = new Map<string, { state: KnowledgeIndexState; error?: string; progress?: { done: number; of: number } }>();

const liveKey = (dir: string | null, projectId: string): string => `${dir ?? "memory"}\u0000${projectId}`;

/** One machine-legal move, or a thrown error naming the illegal one. */
function stepState(dir: string | null, projectId: string, from: KnowledgeIndexState, event: string): KnowledgeIndexState {
  const to = nextState("knowledgeIndex", from, event);
  if (!to) throw new Error(`the knowledge index may not go from "${from}" on "${event}"`);
  live.set(liveKey(dir, projectId), { state: to });
  return to;
}

/**
 * What the Project knowledge screen shows of one project's index, from what
 * can be OBSERVED (the store file, this process's tracker) — never a rebuild:
 *
 *  - a failed build is remembered by the tracker until a retry succeeds;
 *  - no store: the index is queued (a build only ever happened in a process
 *    whose memory is gone with it);
 *  - a store whose hash matches the files: ready;
 *  - a store whose hash differs (or files the store never held): stale.
 *
 * `fileIds` names the files the built index holds, so the screen can say
 * per file whether it is in the index.
 */
export function knowledgeIndexStatus(dir: string | null, projectId: string, filesHash: string): { state: KnowledgeIndexState; error?: string; fileIds: string[] } {
  const tracked = live.get(liveKey(dir, projectId));
  if (tracked?.state === "failed") return { state: "failed", error: tracked.error, fileIds: storedFileIds(dir, projectId) };
  if (tracked?.state === "indexing") return { state: "indexing", fileIds: storedFileIds(dir, projectId), ...(tracked.progress ? { progress: tracked.progress } : {}) };
  let stored: StoredIndex | null = null;
  try {
    const file = dir ? indexFileOf(dir, projectId) : null;
    if (file && existsSync(file)) stored = JSON.parse(readFileSync(file, "utf8")) as StoredIndex;
  } catch {
    stored = null; // a damaged store is a store that does not exist
  }
  if (!stored) return { state: "queued", fileIds: [] };
  return { state: stored.hash === filesHash ? "ready" : "stale", fileIds: storedFileIds(dir, projectId) };
}

/** The files the stored index holds, [] when there is none. */
function storedFileIds(dir: string | null, projectId: string): string[] {
  try {
    const file = dir ? indexFileOf(dir, projectId) : null;
    if (!file || !existsSync(file)) return [];
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredIndex;
    return Array.isArray(stored.docs) ? [...new Set(stored.docs.map((d) => d.fileId))] : [];
  } catch {
    return [];
  }
}

/**
 * Open (and keep current) a project's knowledge index in `dir`. Same files as
 * last time: the store is loaded. Changed files or no store: the sections are
 * cut again and the store is rewritten whole. A store that cannot be read is
 * treated as absent — the index is rebuilt, never trusted half. `dir` null
 * builds the index in memory only (a host that keeps no store — tests): the
 * search works the same, nothing is written.
 */
export function openKnowledgeIndex(dir: string | null, projectId: string, files: KnowledgeFileLike[]): KnowledgeIndex {
  const file = dir ? indexFileOf(dir, projectId) : null;
  const hash = storedHash(files);
  // The same files as the last open in this process: the index is served from memory
  // (no store read, no postings rebuilt). The key is the files' own fingerprint, so an
  // edited, added or removed file can never be answered from an older index; and the
  // store file stays the authority: one that was rewritten, replaced or removed since
  // (another process, an older version) sends the open down the usual read-or-rebuild way.
  const key = liveKey(dir, projectId);
  const cached = memo.get(key);
  if (cached && cached.hash === hash && cached.stamp === stampOf(file) && !rewrittenInTick(cached, file)) {
    memo.delete(key);
    memo.set(key, cached); // most recently used last
    if (live.get(key)?.state === "indexing") stepState(dir, projectId, "indexing", "indexed");
    return indexOver(cached, false, "memory");
  }
  let docs: StoredDoc[] = [];
  let rebuilt = true;
  let hadStored = false;
  let storeText: string | null = null; // the store file's text as this open read or wrote it
  try {
    if (file && existsSync(file)) {
      const text = readFileSync(file, "utf8");
      const stored = JSON.parse(text) as StoredIndex;
      storeText = text;
      if (stored?.version === 3 && stored.hash === hash && Array.isArray(stored.docs)) {
        docs = stored.docs;
        rebuilt = false;
        hadStored = true;
      } else hadStored = true;
    }
  } catch {
    docs = []; // a damaged store is a store that does not exist
  }
  // the lifecycle (D7): where the build sits, as the shared machine names it
  const tracked = live.get(liveKey(dir, projectId))?.state ?? "queued";
  if (rebuilt) {
    // the stored index does not match the files: a built one goes through
    // "stale", a first build starts from "queued", a failed one retries
    let state: KnowledgeIndexState = tracked;
    if (state === "ready") state = stepState(dir, projectId, state, "files_changed");
    // from a tracked "indexing" (a build that died mid-way: the machine has no legal
    // exit from there to a fresh build), the restart event — the machine's own
    // recovery, added when the Files panel's builds started running in the background
    state = stepState(dir, projectId, state, state === "queued" ? "indexing" : state === "stale" ? "reindex" : state === "indexing" ? "restart" : "retry");
    try {
      docs = files.flatMap((f) =>
        sectionsOf(f).map((s) => ({
          fileId: f.id,
          name: f.name,
          title: s.title,
          text: s.text,
          ...(s.page !== undefined ? { page: s.page } : {}),
          ...(s.slide !== undefined ? { slide: s.slide } : {}),
          ...(s.sheet !== undefined ? { sheet: s.sheet } : {}),
          ...(s.rowFrom !== undefined ? { rowFrom: s.rowFrom } : {}),
          ...(s.rowTo !== undefined ? { rowTo: s.rowTo } : {}),
          ...(s.scanned ? { scanned: true } : {}),
        })),
      );
      stepState(dir, projectId, state, "indexed");
    } catch (e) {
      // the build failed: the machine says failed and names the cause, and the
      // caller sees the error too — a question answered without its files'
      // index would look like an answer from nothing
      live.set(liveKey(dir, projectId), { state: "failed", error: (e as Error).message });
      throw e;
    }
    if (file) try {
      mkdirSync(dir!, { recursive: true });
      const stored: StoredIndex = { version: 3, hash, docs };
      const text = JSON.stringify(stored);
      storeText = null;
      writeAtomic(file, text);
      storeText = text;
    } catch (e) {
      // the index still works from memory this session; the next open rebuilds
      console.error(`[knowledge] the index could not be kept: ${(e as Error).message}`);
    }
  } else if (tracked === "indexing") {
    // a build finished between two opens of the same files (never in practice —
    // the build is synchronous): the machine lands on ready
    stepState(dir, projectId, tracked, "indexed");
  }
  const { postings, lengths } = buildPostings(docs);
  const entry: Built = {
    hash, docs, postings, lengths, stamp: stampOf(file),
    mtimeMs: mtimeOf(file), madeAt: Date.now(), storeHash: storeText === null ? null : hashText(storeText),
  };
  memo.delete(key);
  memo.set(key, entry);
  while (memo.size > 1 && (memo.size > MEMO_PROJECTS || [...memo.values()].reduce((n, b) => n + charsOf(b), 0) > MEMO_CHARS)) memo.delete(memo.keys().next().value as string);
  return indexOver(entry, rebuilt, rebuilt ? "built" : "store");
}

// ---------------------------------------------------------------- the open index, in memory

interface Built {
  hash: string;
  /** The store file's size and modification time when this entry was made ("" with no store). */
  stamp: string;
  /** The store file's modification time when this entry was made; null with no store file. */
  mtimeMs: number | null;
  /** When this entry was made, or when its store's text was last found unchanged. */
  madeAt: number;
  /** A hash of the store file's text as this entry knows it; null when the store was not kept. */
  storeHash: string | null;
  docs: StoredDoc[];
  postings: Map<string, Posting[]>;
  lengths: number[];
}

/**
 * The indexes of the most recently asked projects, kept in this process: a second question
 * over the same files reads neither the store nor rebuilds postings. At most four projects
 * and `MEMO_CHARS` characters of section text in all (the retrieval benchmark measured about
 * 6 MB of heap per million characters indexed); the least recently used goes first, and the
 * project just opened always stays.
 */
const MEMO_PROJECTS = 4;
const MEMO_CHARS = 16_000_000;
const charsOf = (b: Built): number => b.docs.reduce((n, d) => n + d.text.length, 0);
const stampOf = (file: string | null): string => {
  if (!file) return "";
  try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return "missing"; }
};
const mtimeOf = (file: string | null): number | null => {
  if (!file) return null;
  try { return statSync(file).mtimeMs; } catch { return null; }
};

/**
 * Modification times move in ticks (a millisecond to two seconds, by file system), so a store
 * rewritten in the same tick as it was last written keeps its time, and its size too when only
 * a digit changed: the stamp cannot see that rewrite. While the store's time is that close to
 * when this entry was made, the store's text is compared instead (read and hashed, not parsed);
 * once it is found unchanged later than that, the stamp alone is trusted again.
 */
const TICK_MS = 2000;
function rewrittenInTick(b: Built, file: string | null): boolean {
  if (!file || b.mtimeMs === null) return false;
  if (b.mtimeMs < b.madeAt - TICK_MS) return false;
  if (b.storeHash === null) return true;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return true; }
  if (hashText(text) !== b.storeHash) return true;
  b.madeAt = Date.now();
  return false;
}

const memo = new Map<string, Built>();

function indexOver(b: Built, rebuilt: boolean, source: KnowledgeIndex["source"]): KnowledgeIndex {
  const { docs, postings, lengths } = b;
  const termsOf = new Map<number, Set<string>>();
  return {
    rebuilt,
    source,
    count: docs.length,
    search: (query, limit = 12) => searchDocs(docs, postings, lengths, query, limit),
    sections: () => docs.map((d, doc) => ({ ...d, doc, score: 0 })),
    coverage: (query, doc, skip) => {
      const words = [...new Set(tokenize(query))].filter((w) => !skip?.has(w));
      if (!words.length || !docs[doc]) return 0;
      let terms = termsOf.get(doc);
      if (!terms) { terms = new Set(tokenize(docs[doc].text)); termsOf.set(doc, terms); }
      const n = docs.length;
      let all = 0;
      let held = 0;
      for (const w of words) {
        const df = postings.get(w)?.length ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        all += idf;
        if (terms.has(w)) held += idf;
      }
      return all ? held / all : 0;
    },
  };
}

/** Forget the in-memory indexes (tests; a host that wants the store read again). */
export function forgetKnowledgeIndexes(): void {
  memo.clear();
}

/**
 * Everything a deleted project leaves for its knowledge: the index and its vectors in
 * `knowledgeDir`, and the full knowledge text the chat offloads to `offloadDir`. The file names
 * come from safeIdOf, so nothing outside the two folders is reached. The project's index and
 * vectors held in this process are forgotten too, and its build state is dropped, so the next
 * open builds afresh. Returns the names of the files removed; files that are not there are skipped.
 */
export function removeKnowledgeFiles(knowledgeDir: string, offloadDir: string, projectId: string): string[] {
  // first: a build or a vector job still running for this project now writes nothing back
  markKnowledgeForgotten(knowledgeDir, projectId);
  const id = safeIdOf(projectId);
  const targets: Array<[string, string]> = [
    [knowledgeDir, `${id}.json`],
    [knowledgeDir, `${id}.vectors`],
    [offloadDir, `${knowledgeOffloadName(projectId)}.txt`],
  ];
  const removed: string[] = [];
  for (const [dir, name] of targets) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    removed.push(name);
  }
  memo.delete(liveKey(knowledgeDir, projectId));
  live.delete(liveKey(knowledgeDir, projectId));
  forgetVectorProject(knowledgeDir, projectId);
  return removed;
}

// ---------------------------------------------------------------- the background build

/** One build at a time per project, in this process: a second call waits for the running one. */
/** The most files one project's search index takes (the build refuses more, by name). */
export const MAX_INDEX_FILES = 200;

const builds = new Map<string, { hash: string; job: Promise<{ state: KnowledgeIndexState; count?: number; error?: string }> }>();

/**
 * The background build the Files panel starts when a file is added or removed (
 * C2) — the same build a chat's retrieval would run, begun now so the FIRST chat already
 * finds the index ready. It goes through the same `knowledgeIndex` machine (queued →
 * indexing → ready, stale → reindex, failed → retry), yields to the event loop between
 * files, and reports its progress (n of m) into the tracker the status poll reads.
 * `dir` null builds in memory (tests), exactly like `openKnowledgeIndex`.
 */
export function buildKnowledgeIndexNow(
  dir: string | null,
  projectId: string,
  files: KnowledgeFileLike[],
  opts: { onProgress?: (done: number, of: number) => void } = {},
): Promise<{ state: KnowledgeIndexState; count?: number; error?: string }> {
  const key = liveKey(dir, projectId);
  const hash = storedHash(files);
  // noted when the build is asked for, so a build still queued when the project is deleted is dropped too
  const generation = forgetCountOf(dir, projectId);
  const running = builds.get(key);
  // The same files: wait for the same build, never two.
  if (running && running.hash === hash) return running.job;
  // Other (newer) files: they are built once the running build ends — never swallowed
  // by a build of an older version of the files.
  const after = running ? running.job.catch(() => undefined) : Promise.resolve();
  const job = after
    .then(() => runBackgroundBuild(dir, projectId, files, opts, generation))
    .finally(() => { if (builds.get(key)?.job === job) builds.delete(key); });
  builds.set(key, { hash, job });
  return job;
}

async function runBackgroundBuild(
  dir: string | null,
  projectId: string,
  files: KnowledgeFileLike[],
  opts: { onProgress?: (done: number, of: number) => void },
  generation: number,
): Promise<{ state: KnowledgeIndexState; count?: number; error?: string }> {
  const key = liveKey(dir, projectId);
  const file = dir ? indexFileOf(dir, projectId) : null;
  const hash = storedHash(files);
  // the project was deleted since this build was asked for: nothing is written, no state is kept
  const deleted = { state: "failed" as const, error: "The project was deleted before its index was built." };
  const gone = () => forgetCountOf(dir, projectId) !== generation;
  if (gone()) return deleted;
  // same files as the store already holds: the build exists, nothing to do
  if (knowledgeIndexStatus(dir, projectId, hash).state === "ready") return { state: "ready" };
  // into indexing by the event the observed state names (the machine refuses a wrong one)
  let state: KnowledgeIndexState = live.get(key)?.state ?? "queued";
  if (state === "ready") state = stepState(dir, projectId, state, "files_changed");
  state = stepState(dir, projectId, state, state === "queued" ? "indexing" : state === "stale" ? "reindex" : state === "indexing" ? "restart" : "retry");
  const sections = (f: KnowledgeFileLike) =>
    sectionsOf(f).map((s) => ({
      fileId: f.id,
      name: f.name,
      title: s.title,
      text: s.text,
      ...(s.page !== undefined ? { page: s.page } : {}),
      ...(s.slide !== undefined ? { slide: s.slide } : {}),
      ...(s.sheet !== undefined ? { sheet: s.sheet } : {}),
      ...(s.rowFrom !== undefined ? { rowFrom: s.rowFrom } : {}),
      ...(s.rowTo !== undefined ? { rowTo: s.rowTo } : {}),
      ...(s.scanned ? { scanned: true } : {}),
    }));
  const docs: StoredDoc[] = [];
  try {
    // Over the cap, the build fails BY NAME: indexing a silent subset made an index
    // that never matched the project's files, so it stayed "out of date" forever.
    if (files.length > MAX_INDEX_FILES) {
      throw new Error(`This project holds ${files.length} files; the search index takes at most ${MAX_INDEX_FILES}. Split the files into more projects, or remove some.`);
    }
    for (const [i, f] of files.entries()) {
      if (gone()) return deleted;
      docs.push(...sections(f));
      live.set(key, { state: "indexing", progress: { done: i + 1, of: files.length } });
      opts.onProgress?.(i + 1, files.length);
      await new Promise((r) => setImmediate(r)); // the status poll gets a turn between files
    }
    if (gone()) return deleted;
    stepState(dir, projectId, state, "indexed");
  } catch (e) {
    live.set(key, { state: "failed", error: (e as Error).message });
    return { state: "failed", error: (e as Error).message };
  }
  if (file) try {
    mkdirSync(dir!, { recursive: true });
    const stored: StoredIndex = { version: 3, hash, docs };
    writeAtomic(file, JSON.stringify(stored));
  } catch (e) {
    // the index still works from memory this session; the next open rebuilds
    console.error(`[knowledge] the index could not be kept: ${(e as Error).message}`);
  }
  return { state: "ready", count: docs.length };
}

/**
 * A project's vectors, made right after its index is built (the Files panel's build), so the
 * first question that needs them does not wait. `embedderOf` loads the search model, or gives
 * null when it is not installed. Null back: no model, no files, or the project was deleted
 * while the model was loading.
 */
export async function prepareProjectVectors(
  dir: string, projectId: string, files: KnowledgeFileLike[], embedderOf: () => Promise<Embedder | null>,
): Promise<VectorIndex | null> {
  const generation = forgetCountOf(dir, projectId);
  const embedder = await embedderOf();
  if (!embedder || !files.length) return null;
  // deleted while the model loaded: the index is not opened again (opening it would write it back)
  if (forgetCountOf(dir, projectId) !== generation) return null;
  return openVectorIndex(dir, projectId, filesHashOf(files), openKnowledgeIndex(dir, projectId, files).sections(), embedder);
}
