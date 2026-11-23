// Deleting a project used to leave its knowledge on disk: the index (<id>.json), the search
// vectors (<id>.vectors) and the full knowledge text the chat offloads (knowledge-<id>.txt).
// removeKnowledgeFiles takes all three away, inside the two folders only, and forgets the
// project's indexes held in memory.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildKnowledgeIndexNow, knowledgeIndexStatus, openKnowledgeIndex, prepareProjectVectors, removeKnowledgeFiles, safeIdOf } from "../src/core/knowledge/store";
import { openVectorIndex } from "../src/core/knowledge/vectors";
import type { Embedder } from "../src/core/knowledge/embed";
import { offloadPayload } from "../src/core/harness/offload";
import type { KnowledgeFileLike } from "../src/core/knowledge/index";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A knowledge folder and an offload folder side by side, as the sidecar keeps them. */
function folders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "know-forget-"));
  roots.push(root);
  const knowledge = path.join(root, "knowledge");
  const offload = path.join(root, "offload");
  fs.mkdirSync(knowledge, { recursive: true });
  fs.mkdirSync(offload, { recursive: true });
  return { root, knowledge, offload };
}

const files: KnowledgeFileLike[] = [{ id: "f1", name: "notes.md", content: "# Notes\nThe heron count is 41." }];

/** All three files a project leaves: the index the store writes, its vectors, its offloaded text. */
function leave(d: ReturnType<typeof folders>, projectId: string) {
  openKnowledgeIndex(d.knowledge, projectId, files);
  fs.writeFileSync(path.join(d.knowledge, `${safeIdOf(projectId)}.vectors`), "vectors");
  offloadPayload(d.offload, `knowledge-${safeIdOf(projectId)}`, "- notes.md — Notes");
}

describe("deleting a project removes its knowledge files", () => {
  it("removes the index, the vectors and the offloaded knowledge text, and names them", () => {
    const d = folders();
    leave(d, "p1");
    expect(fs.readdirSync(d.knowledge).sort()).toEqual(["p1.json", "p1.vectors"]);
    expect(removeKnowledgeFiles(d.knowledge, d.offload, "p1")).toEqual(["p1.json", "p1.vectors", "knowledge-p1.txt"]);
    expect(fs.readdirSync(d.knowledge)).toEqual([]);
    expect(fs.readdirSync(d.offload)).toEqual([]);
  });

  it("an id with a path in it removes only its own sanitised files inside the two folders", () => {
    const d = folders();
    const id = "../x y";
    expect(safeIdOf(id)).toBe(".._x_y");
    leave(d, id);
    // what a raw join of the id would have reached: next to the folders, never ours to delete
    const outside = path.join(d.root, "x y.json");
    fs.writeFileSync(outside, "not knowledge");
    expect(removeKnowledgeFiles(d.knowledge, d.offload, id)).toEqual([".._x_y.json", ".._x_y.vectors", "knowledge-.._x_y.txt"]);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readdirSync(d.knowledge)).toEqual([]);
  });

  it("a project that left no files gives an empty list and does not throw", () => {
    const d = folders();
    expect(removeKnowledgeFiles(d.knowledge, d.offload, "never-indexed")).toEqual([]);
    expect(removeKnowledgeFiles(path.join(d.root, "missing"), path.join(d.root, "also-missing"), "p1")).toEqual([]);
  });

  it("another project's files are untouched", () => {
    const d = folders();
    leave(d, "p1");
    leave(d, "p2");
    removeKnowledgeFiles(d.knowledge, d.offload, "p1");
    expect(fs.readdirSync(d.knowledge).sort()).toEqual(["p2.json", "p2.vectors"]);
    expect(fs.readdirSync(d.offload)).toEqual(["knowledge-p2.txt"]);
  });

  it("afterwards the project's index is reported as not built, and is not answered from memory", () => {
    const d = folders();
    leave(d, "p1");
    removeKnowledgeFiles(d.knowledge, d.offload, "p1");
    expect(knowledgeIndexStatus(d.knowledge, "p1", "any").state).toBe("queued");
    expect(knowledgeIndexStatus(d.knowledge, "p1", "any").fileIds).toEqual([]);
    expect(openKnowledgeIndex(d.knowledge, "p1", files).source).toBe("built");
  });
});

// The final review found a race: the index build yields between files and the vectors wait for
// the embedder, so a project deleted while either was still running had its text written back
// afterwards, by a job nobody would ever clean up.
describe("deleting a project while its knowledge is still being built", () => {
  const many = (tag: string): KnowledgeFileLike[] =>
    Array.from({ length: 12 }, (_, i) => ({ id: `${tag}${i}`, name: `${tag}${i}.md`, content: `# Part ${i}
The ${tag} heron count is ${i}.` }));

  it("an index build that is still running writes nothing back", async () => {
    const d = folders();
    const job = buildKnowledgeIndexNow(d.knowledge, "p1", many("a"));
    removeKnowledgeFiles(d.knowledge, d.offload, "p1");
    await job;
    expect(fs.readdirSync(d.knowledge)).toEqual([]);
    expect(knowledgeIndexStatus(d.knowledge, "p1", "any").state).toBe("queued");
  });

  it("a build queued behind the running one is dropped too", async () => {
    const d = folders();
    const first = buildKnowledgeIndexNow(d.knowledge, "p1", many("a"));
    const second = buildKnowledgeIndexNow(d.knowledge, "p1", many("b"));
    removeKnowledgeFiles(d.knowledge, d.offload, "p1");
    await Promise.all([first, second]);
    expect(fs.readdirSync(d.knowledge)).toEqual([]);
  });

  it("vectors still being made are not kept", async () => {
    const d = folders();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const embedder: Embedder = { id: "fake-1", dim: 2, embed: async (texts) => { await gate; return texts.map(() => new Float32Array([1, 0])); } };
    const job = openVectorIndex(d.knowledge, "p1", "hash", [{ name: "a.md", title: "A", text: "heron" }], embedder);
    removeKnowledgeFiles(d.knowledge, d.offload, "p1");
    release();
    await job;
    expect(fs.readdirSync(d.knowledge)).toEqual([]);
  });

  it("a project built after the delete is kept as usual", async () => {
    const d = folders();
    await buildKnowledgeIndexNow(d.knowledge, "p1", many("a"));
    removeKnowledgeFiles(d.knowledge, d.offload, "p1");
    await buildKnowledgeIndexNow(d.knowledge, "p1", many("b"));
    expect(fs.readdirSync(d.knowledge)).toEqual(["p1.json"]);
  });

  it("a project deleted while the search model is still loading gets neither its index nor its vectors back", async () => {
    // the sidecar makes a project's vectors right after its index is built: it waits for the model
    // first (seconds on the first use), then reads the index again, which would write it back
    const d = folders();
    await buildKnowledgeIndexNow(d.knowledge, "p1", many("a"));
    let release!: () => void;
    const loading = new Promise<void>((r) => { release = r; });
    const embedder: Embedder = { id: "fake-1", dim: 2, embed: async (texts) => texts.map(() => new Float32Array([1, 0])) };
    const job = prepareProjectVectors(d.knowledge, "p1", many("a"), async () => { await loading; return embedder; });
    removeKnowledgeFiles(d.knowledge, d.offload, "p1");
    release();
    expect(await job).toBeNull();
    expect(fs.readdirSync(d.knowledge)).toEqual([]);
  });

  it("with no deletion, the vectors are made and kept next to the index", async () => {
    const d = folders();
    await buildKnowledgeIndexNow(d.knowledge, "p1", many("a"));
    const embedder: Embedder = { id: "fake-1", dim: 2, embed: async (texts) => texts.map(() => new Float32Array([1, 0])) };
    const v = await prepareProjectVectors(d.knowledge, "p1", many("a"), async () => embedder);
    expect(v?.source).toBe("built");
    expect(fs.readdirSync(d.knowledge).sort()).toEqual(["p1.json", "p1.vectors"]);
    expect(await prepareProjectVectors(d.knowledge, "p1", many("a"), async () => null)).toBeNull();
  });
});
