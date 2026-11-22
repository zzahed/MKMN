/**
 * The vector side of a project's knowledge index: one unit vector per
 * section of the BM25 index, made by the multilingual embedder (embed.ts), kept on
 * disk next to the BM25 store and in memory for the projects asked most recently.
 *
 * Keyed like the BM25 store: by the files' own fingerprint AND the embedder's id, so
 * an edited, added or removed file, or another model, never answers from old vectors.
 * The sections are the BM25 index's own, in its order, so a vector's position IS the
 * section's `doc` number and the two searches name the same sections.
 *
 * Node only (it reads and writes the store).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { dot, type Embedder } from "./embed";
import { placeOf } from "./retrieve";
import { safeIdOf } from "./ids";

type SectionLike = { name: string; title: string; text: string; page?: number; slide?: number; sheet?: string; rowFrom?: number; rowTo?: number; scanned?: boolean };

/** How much of a section the embedder reads: the model reads at most 512 tokens, and the benchmark measured this cut. */
export const EMBED_CHARS = 1500;

/**
 * The text a section is embedded as: its file and its place as a citation names it
 * (`placeOf`: "p. 5", "Equipment rows 1-7"), then its words: the form the benchmark
 * measured. The nearest sections' scores lie close together, so this first line
 * matters: a sheet labelled only "Equipment" fell out of the top eight.
 */
export const sectionText = (s: SectionLike): string => `${s.name} ${placeOf(s)}\n${s.text.slice(0, EMBED_CHARS)}`;

export interface VectorIndex {
  /** Where this open came from: this process's memory, the store file, or a fresh embedding. */
  source: "memory" | "store" | "built";
  count: number;
  /** The sections nearest the query vector, best first: `doc` is the BM25 index's position. */
  search(query: Float32Array, limit?: number): { doc: number; score: number }[];
}

interface Stored {
  version: 1;
  hash: string;
  model: string;
  dim: number;
  count: number;
}

const fileOf = (dir: string, projectId: string): string => path.join(dir, `${safeIdOf(projectId)}.vectors`);

/** The most recently asked projects' vectors, as the BM25 store keeps its postings. */
const MEMO_PROJECTS = 4;
const memo = new Map<string, { hash: string; model: string; vectors: Float32Array[]; stamp: string }>();
const keyOf = (dir: string | null, projectId: string) => `${dir ?? "memory"}\u0000${projectId}`;
const stampOf = (file: string | null): string => {
  if (!file) return "";
  try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return "missing"; }
};

export function forgetVectorIndexes(): void {
  memo.clear();
}

/** Forget one project's vectors held in this process (its file is removed by removeKnowledgeFiles). */
export function forgetVectorProject(dir: string | null, projectId: string): void {
  memo.delete(keyOf(dir, projectId));
}

function over(vectors: Float32Array[], source: VectorIndex["source"]): VectorIndex {
  return {
    source,
    count: vectors.length,
    search: (q, limit = 12) => vectors.map((v, doc) => ({ doc, score: dot(q, v) })).sort((a, b) => b.score - a.score).slice(0, limit),
  };
}

/** The store file: one JSON header line, then the vectors as little-endian float32, in section order. */
function readStore(file: string, hash: string, model: string): Float32Array[] | null {
  try {
    if (!existsSync(file)) return null;
    const buf = readFileSync(file);
    const nl = buf.indexOf(10);
    if (nl < 0) return null;
    const head = JSON.parse(buf.subarray(0, nl).toString("utf8")) as Stored;
    if (head.version !== 1 || head.hash !== hash || head.model !== model) return null;
    const body = buf.subarray(nl + 1);
    if (body.length !== head.count * head.dim * 4) return null; // a cut file is a file that does not exist
    const all = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length));
    return Array.from({ length: head.count }, (_, i) => all.slice(i * head.dim, (i + 1) * head.dim));
  } catch {
    return null;
  }
}

function writeStore(file: string, hash: string, model: string, vectors: Float32Array[]): void {
  const dim = vectors[0]?.length ?? 0;
  const head: Stored = { version: 1, hash, model, dim, count: vectors.length };
  const body = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => body.set(v, i * dim));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, Buffer.concat([Buffer.from(`${JSON.stringify(head)}\n`, "utf8"), Buffer.from(body.buffer)]));
  renameSync(tmp, file);
}

/**
 * Opens (and keeps current) a project's vectors for the given sections. Same files
 * and model as last time: memory, else the store. Otherwise every section is
 * embedded again and the store rewritten whole. `dir` null keeps them in memory only.
 */
export async function openVectorIndex(
  dir: string | null, projectId: string, filesHash: string, sections: SectionLike[], embedder: Embedder,
): Promise<VectorIndex> {
  const key = keyOf(dir, projectId);
  const file = dir ? fileOf(dir, projectId) : null;
  const cached = memo.get(key);
  if (cached && cached.hash === filesHash && cached.model === embedder.id && cached.stamp === stampOf(file) && cached.vectors.length === sections.length) {
    memo.delete(key); memo.set(key, cached);
    return over(cached.vectors, "memory");
  }
  let vectors = file ? readStore(file, filesHash, embedder.id) : null;
  let source: VectorIndex["source"] = "store";
  if (!vectors || vectors.length !== sections.length) {
    vectors = await embedder.embed(sections.map(sectionText));
    source = "built";
    if (file) try {
      mkdirSync(dir!, { recursive: true });
      writeStore(file, filesHash, embedder.id, vectors);
    } catch (e) {
      console.error(`[knowledge] the vectors could not be kept: ${(e as Error).message}`);
    }
  }
  memo.delete(key);
  memo.set(key, { hash: filesHash, model: embedder.id, vectors, stamp: stampOf(file) });
  while (memo.size > MEMO_PROJECTS) memo.delete(memo.keys().next().value as string);
  return over(vectors, source);
}
