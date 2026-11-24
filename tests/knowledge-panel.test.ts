// The Files panel's truth and the background index:
//  - C1: the panel's one line about size is the truth — under the budget the files ride
//    whole; over it, the question is searched and only the matching parts ride (the
//    orchestrator's own trigger, knowledgeBudget). No warning colour: search covers it.
//  - C2: adding or removing a file starts the index build in the background (the
//    knowledgeIndex machine, extended with the recovery event a dead build needs), with
//    progress (n of m), ready, and failed + reason + Retry.
//  - C3: each file's token size beside its pages/sections.
//  - C4: an overlap note decided by code from the SECTIONS (never the file names).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { knowledgeIndexStatus, buildKnowledgeIndexNow } from "../src/core/knowledge/store";
import { overlappingFilePairs } from "../src/core/knowledge/index";
import { nextState, isMachineState } from "../src/shared/stateMachines";
import type { KnowledgeFileLike } from "../src/core/knowledge/index";

const read = (p: string) => readFileSync(p, "utf8");
const proj = read("src/renderer/Projects.tsx");
const api = read("src/shared/api.ts");

const file = (id: string, name: string, content: string): KnowledgeFileLike => ({ id, name, content });

describe("the machine can recover a build that died indexing (the extension C2 needs)", () => {
  it("indexing --restart--> indexing is legal; the old machine threw there", () => {
    expect(nextState("knowledgeIndex", "indexing", "restart")).toBe("indexing");
    expect(isMachineState("knowledgeIndex", "indexing")).toBe(true);
  });
});

describe("buildKnowledgeIndexNow — the background build the Files panel starts", () => {
  it("builds in the background and lands on ready; the status poll sees indexing with n-of-m on the way", async () => {
    const files = [
      file("f1", "a.txt", "The xylophone budget is 3000 dinars. ".repeat(40)),
      file("f2", "b.txt", "The renovators meet on Tuesdays in the annex. ".repeat(40)),
    ];
    const seen: Array<{ state: string; progress?: { done: number; of: number } }> = [];
    const job = buildKnowledgeIndexNow(null, "bg-1", files, {
      onProgress: () => {
        const s = knowledgeIndexStatus(null, "bg-1", "");
        seen.push({ state: s.state, ...(s.progress ? { progress: s.progress } : {}) });
      },
    });
    const r = await job;
    expect(r.state).toBe("ready");
    expect(seen.length).toBeGreaterThanOrEqual(2); // one per file
    expect(seen[0].state).toBe("indexing"); // the poll DURING the build sees indexing
    expect(seen[0].progress).toEqual({ done: 1, of: 2 });
    // a fresh observer (the panel) reads the built index as ready for these files
    const after = knowledgeIndexStatus(null, "bg-1", "");
    expect(["ready", "stale", "queued"]).toContain(after.state); // hash here differs (no store in memory mode); the store test pins ready
  });

  it("a second call while a build runs waits for the SAME build, never two", async () => {
    const files = [file("f1", "a.txt", "word word word. ".repeat(200))];
    let progressCalls = 0; // one per file, per BUILD: two builds would make it two
    const opts = { onProgress: () => { progressCalls++; } };
    const [a, b] = await Promise.all([
      buildKnowledgeIndexNow(null, "bg-2", files, opts),
      buildKnowledgeIndexNow(null, "bg-2", files, opts),
    ]);
    expect(a.state).toBe("ready");
    expect(b.state).toBe("ready");
    expect(progressCalls).toBe(1);
  });

  it("a build that fails is said, with its reason, and Retry (the same call) succeeds", async () => {
    // a file whose sections explode: the failure path is driven through the machine and named
    const bad = [{ ...file("f1", "a.txt", "fine words"), content: null } as unknown as KnowledgeFileLike];
    const r1 = await buildKnowledgeIndexNow(null, "bg-3", bad);
    expect(r1.state).toBe("failed");
    expect(r1.error).toBeTruthy();
    expect(knowledgeIndexStatus(null, "bg-3", "").state).toBe("failed");
    const r2 = await buildKnowledgeIndexNow(null, "bg-3", [file("f1", "a.txt", "fine words here")]);
    expect(r2.state).toBe("ready");
    expect(knowledgeIndexStatus(null, "bg-3", "").state).not.toBe("failed");
  });

  it("the first chat after an add finds the index READY: openKnowledgeIndex loads, never rebuilds", async () => {
    const { openKnowledgeIndex } = await import("../src/core/knowledge/store");
    const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "knowledge-panel-"));
    const files = [file("f1", "a.txt", "The xylophone budget is 3000 dinars. ".repeat(30))];
    const r = await buildKnowledgeIndexNow(dir, "bg-4", files);
    expect(r.state).toBe("ready");
    // the chat's own path, on the same files: a load, not a rebuild — the store matches
    const atChat = openKnowledgeIndex(dir, "bg-4", files);
    expect(atChat.rebuilt).toBe(false);
    expect(atChat.search("xylophone budget", 3).length).toBeGreaterThan(0);
  });
});

describe("which files overlap (C4): decided from the sections, never the names", () => {
  const big = "The field trip meets at the museum gate at nine, and the coach leaves at half past nine sharp. ";
  it("two files whose sections say the same thing are named as a pair", () => {
    const a = file("1", "Completely Different Name A.txt", big.repeat(3));
    const b = file("2", "Another Unrelated Title.txt", big.repeat(3));
    expect(overlappingFilePairs([a, b])).toEqual([["Completely Different Name A.txt", "Another Unrelated Title.txt"]]);
  });
  it("files that merely share a word, or a name, are not an overlap", () => {
    const a = file("1", "handbook.txt", "The budget for the field trip is 300 dinars per student. ".repeat(5));
    const b = file("2", "handbook.txt", "The renovation of the east wing finishes in March, weather permitting. ".repeat(5));
    expect(overlappingFilePairs([a, b])).toEqual([]);
  });
  it("identical files are one pair, named once", () => {
    const t = big.repeat(3);
    expect(overlappingFilePairs([file("1", "a.txt", t), file("2", "b.txt", t), file("3", "c.txt", t)])).toEqual([["a.txt", "b.txt"], ["a.txt", "c.txt"], ["b.txt", "c.txt"]]);
  });
  it("short sections (a stray heading, a number) are never an overlap", () => {
    expect(overlappingFilePairs([file("1", "a.txt", "Budget"), file("2", "b.txt", "Budget")])).toEqual([]);
  });
});

describe("the panel speaks the truth (source pins on Projects.tsx and the api)", () => {
  it("the orange lie is gone; both truths are here, derived from the app's own budget", () => {
    expect(proj).not.toContain("The rest will be cut");
    expect(proj).toContain("Too long to read all at once");
    expect(proj).toContain("reads all of it in every chat"); // under budget: the files go whole
    expect(proj).toContain("knowledgeBudget(contextTokens)"); // the threshold is the app's own, never a private number
  });

  it("no warning colour on the size line: search covers it", () => {
    // the meter's fill and the number stay neutral; the warn class is not on the truth lines
    expect(proj).not.toMatch(/fill \$\{[^}]*warn/);
    expect(proj).not.toContain('>The rest will be cut');
  });

  it("adding or removing a file starts the background build, and the panel watches it", () => {
    expect(api).toContain("knowledgeBuild");
    expect(proj).toContain("knowledgeBuild(");
    expect(proj).toContain("indexProgress"); // the n-of-m progress the status poll brings
    expect(proj).toMatch(/Preparing your files/);
    expect(proj).toMatch(/retryIndex}>Try again</); // a failed build offers the retry
  });

  it("each file's line carries its size in pages and words, never tokens (C3)", () => {
    expect(proj).toContain("describeFileSize(s.words, s.pages, s.scannedPages)");
    expect(proj).not.toMatch(/~\{tokens\} tokens/);
  });

  it("the meter shows a percentage only while everything fits, never a raw count over the limit", () => {
    expect(proj).not.toMatch(/Math\.round\(used \/ 1000\)\}k \//);
    expect(proj).toContain("of what the assistant can read at once");
    expect(proj).toContain('role="progressbar"');
  });

  it("the overlap note is drawn from the code's pair list (C4)", () => {
    expect(proj).toContain("overlappingFilePairs");
    expect(proj).toMatch(/overlap/);
  });
});
