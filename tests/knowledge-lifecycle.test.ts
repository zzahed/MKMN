import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openKnowledgeIndex, knowledgeIndexStatus } from "../src/core/knowledge/store";
import { filesHashOf, fileKnowledgeStats } from "../src/core/knowledge/index";
import { machineDefinition, canTransition, nextState, isMachineState } from "../src/shared/stateMachines";

/**
 * The knowledge index's lifecycle: one machine in the shared
 * registry says what the index of a project's knowledge can be — queued, then
 * indexing, then ready or failed, and stale when the files changed after the
 * index was built. The build in the store drives the machine's events; the
 * status the Project knowledge screen shows is derived from the store and the
 * machine's names, never invented beside it.
 */

describe("the knowledgeIndex machine in the registry", () => {
  const machine = machineDefinition("knowledgeIndex");

  it("is queued, indexing, ready, failed and stale, and starts queued", () => {
    expect(machine.initial).toBe("queued");
    expect(machine.states.map((s) => s.id).sort()).toEqual(["failed", "indexing", "queued", "ready", "stale"]);
  });

  it("walks queued -> indexing -> ready, allows a failure and its retry, and goes through stale on a change", () => {
    expect(nextState("knowledgeIndex", "queued", "indexing")).toBe("indexing");
    expect(nextState("knowledgeIndex", "indexing", "indexed")).toBe("ready");
    expect(nextState("knowledgeIndex", "indexing", "failed")).toBe("failed");
    expect(nextState("knowledgeIndex", "failed", "retry")).toBe("indexing");
    expect(nextState("knowledgeIndex", "ready", "files_changed")).toBe("stale");
    expect(nextState("knowledgeIndex", "stale", "reindex")).toBe("indexing");
  });

  it("refuses the shortcuts: no ready from queued, no rebuild straight from ready, no ready from failed", () => {
    expect(canTransition("knowledgeIndex", "queued", "ready")).toBe(false);
    expect(canTransition("knowledgeIndex", "ready", "indexing")).toBe(false);
    expect(canTransition("knowledgeIndex", "failed", "ready")).toBe(false);
    expect(canTransition("knowledgeIndex", "failed", "stale")).toBe(false);
    expect(canTransition("knowledgeIndex", "stale", "ready")).toBe(false);
  });

  it("every state name is one the screens can validate", () => {
    for (const s of ["queued", "indexing", "ready", "failed", "stale"]) expect(isMachineState("knowledgeIndex", s)).toBe(true);
    expect(isMachineState("knowledgeIndex", "broken")).toBe(false);
  });
});

// ---------------------------------------------------------------- the build drives the machine

const files = (xylophoneAt = "1997"): { id: string; name: string; content: string }[] => [
  { id: "f1", name: "a.txt", content: `The xylophone budget is ${xylophoneAt} dinars.` },
  { id: "f2", name: "notes.md", content: "# Supplies\n\nThe library opens at nine." },
];

const tmpStore = (): { dir: string; clean: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-life-"));
  return { dir, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

describe("the index build in the store drives the machine", () => {
  it("nothing built yet: the status is queued", () => {
    const { dir, clean } = tmpStore();
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files())).state).toBe("queued");
    clean();
  });

  it("a first build lands ready; opening again with the same files is no rebuild", () => {
    const { dir, clean } = tmpStore();
    const first = openKnowledgeIndex(dir, "p", files());
    expect(first.rebuilt).toBe(true);
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files())).state).toBe("ready");
    const again = openKnowledgeIndex(dir, "p", files());
    expect(again.rebuilt).toBe(false);
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files())).state).toBe("ready");
    clean();
  });

  it("changed files: the stored index is stale by its hash, and the next build lands ready again", () => {
    const { dir, clean } = tmpStore();
    openKnowledgeIndex(dir, "p", files("1997"));
    // the files changed and no request ran yet: the screen says stale
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files("2003"))).state).toBe("stale");
    const rebuilt = openKnowledgeIndex(dir, "p", files("2003"));
    expect(rebuilt.rebuilt).toBe(true);
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files("2003"))).state).toBe("ready");
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files("1997"))).state).toBe("stale");
    expect(rebuilt.search("2003").length).toBe(1);
    clean();
  });

  it("a build that fails says failed, names its cause, and the next open retries", () => {
    const { dir, clean } = tmpStore();
    // a file whose content the sectioning cannot read: the build fails, the error is said, not swallowed
    const broken = [{ id: "f1", name: "broken.txt", content: null as unknown as string }];
    expect(() => openKnowledgeIndex(dir, "p", broken)).toThrow();
    const status = knowledgeIndexStatus(dir, "p", filesHashOf(broken));
    expect(status.state).toBe("failed");
    expect(status.error).toBeTruthy();
    const retried = openKnowledgeIndex(dir, "p", files());
    expect(retried.rebuilt).toBe(true);
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files())).state).toBe("ready");
    clean();
  });

  it("the status names which files the built index holds", () => {
    const { dir, clean } = tmpStore();
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files())).fileIds).toEqual([]);
    openKnowledgeIndex(dir, "p", files());
    expect(knowledgeIndexStatus(dir, "p", filesHashOf(files())).fileIds.sort()).toEqual(["f1", "f2"]);
    clean();
  });
});

// ---------------------------------------------------------------- what the screen shows per file

describe("the per-file knowledge stats the Project screen shows", () => {
  it("counts the sections, the pages, and the pages that were read from scans", () => {
    const pdf = "[page 1]\nA typed page.\n\n[page 2]\n[scanned text]\nWords from the picture.\n\n[page 3]\n[scanned text]\nMore picture words.";
    const s = fileKnowledgeStats({ id: "f1", name: "scan.pdf", content: pdf });
    expect(s.sections).toBe(3);
    expect(s.pages).toBe(3);
    expect(s.scannedPages).toBe(2);

    const md = "# Supplies\n\nThe library opens at nine.\n\n# Hours\n\nNine to five.";
    const m = fileKnowledgeStats({ id: "f2", name: "notes.md", content: md });
    expect(m.sections).toBe(2);
    expect(m.pages).toBe(0);
    expect(m.scannedPages).toBe(0);

    expect(fileKnowledgeStats({ id: "f3", name: "empty.txt", content: "" })).toEqual({ sections: 0, pages: 0, scannedPages: 0 });
  });
});
