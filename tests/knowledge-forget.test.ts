// Deleting a project used to leave its knowledge on disk: the index (<id>.json), the search
// vectors (<id>.vectors) and the full knowledge text the chat offloads (knowledge-<id>.txt).
// removeKnowledgeFiles takes all three away, inside the two folders only, and forgets the
// project's indexes held in memory.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { knowledgeIndexStatus, openKnowledgeIndex, removeKnowledgeFiles, safeIdOf } from "../src/core/knowledge/store";
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
