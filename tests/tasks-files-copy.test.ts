import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { skillSize } from "../src/core/skills";

/** Tasks and Files in plain English (docs/design/usability-audit.md, phase 3). */
const tasks = readFileSync("src/renderer/Tasks.tsx", "utf8");
const files = readFileSync("src/renderer/Artifacts.tsx", "utf8");
const taskStore = readFileSync("src/sidecar/register/tasks.ts", "utf8");

describe("Tasks", () => {
  it("explains tasks without NPU or artifact words", () => {
    const intro = tasks.match(/<h1>Tasks<\/h1><p className="muted">([^<]+)<\/p>/)?.[1] ?? "";
    expect(intro).toContain("carries out by itself on a schedule");
    expect(intro).not.toMatch(/NPU|artifact|prompt/i);
  });

  it("the delete confirmation says what is lost and what stays, true to what delete does", () => {
    expect(tasks).toContain("Its past results are deleted too. Files it made stay in Files.");
    expect(tasks).toContain("This cannot be undone.");
    // delete removes the task record only; artifacts live in their own store
    expect(taskStore).toMatch(/register\("deleteTask", \(id: string\) => \{ taskStore\.remove\(String\(id\)\); return taskStore\.list\(\); \}\)/);
  });
});

describe("Files", () => {
  it("both delete confirmations say they cannot be undone", () => {
    expect(files.match(/This cannot be undone\./g)?.length).toBe(2);
  });
});

describe("skill sizes in plain words", () => {
  it("never mention tokens or context", () => {
    for (const steps of [1, 6, 14]) {
      const s = skillSize({ instructions: "x ".repeat(300 * steps), steps: [{ title: "a", prompt: "b" }], libraries: [] });
      expect(s.label + s.short).not.toMatch(/token|context|\dK/i);
    }
  });
});
