import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnowledgeIndexNow, knowledgeIndexStatus } from "../src/core/knowledge/store";
import { filesHashOf, type KnowledgeFileLike } from "../src/core/knowledge/index";

/**
 * A build asked for while another runs for an OLDER version of the files used to
 * get the old build back: the newer files were never indexed, and the panel had
 * already marked that version as attempted. The newest files now win: they are
 * built once the running build ends.
 */

const file = (id: string, content: string): KnowledgeFileLike => ({ id, name: `${id}.txt`, content });

describe("the background build indexes the newest files", () => {
  it("a build for new files during a running one is not swallowed by it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mkmn-know-"));
    try {
      const a = [file("f1", "The annex opens at nine. ".repeat(80))];
      const b = [...a, file("f2", "The library closes at five. ".repeat(80))];
      const [ra, rb] = await Promise.all([
        buildKnowledgeIndexNow(dir, "p1", a),
        buildKnowledgeIndexNow(dir, "p1", b),
      ]);
      expect(ra.state).toBe("ready");
      expect(rb.state).toBe("ready");
      expect(knowledgeIndexStatus(dir, "p1", filesHashOf(b)).state).toBe("ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a project with more files than the index takes", () => {
  it("fails by name instead of indexing a silent subset that never matches the files", async () => {
    const many = Array.from({ length: 201 }, (_, i) => file(`f${i}`, `Note number ${i}. `.repeat(5)));
    const r = await buildKnowledgeIndexNow(null, "p-many", many);
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/201 files/);
    expect(knowledgeIndexStatus(null, "p-many", "").state).toBe("failed");
  });

  it("the sidecar passes every file, never a silent slice (source pin)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/sidecar/register/knowledge.ts", "utf8");
    const at = src.indexOf('dispatcher.register("knowledgeBuild"');
    expect(at, "the knowledgeBuild registration is where this pin reads").toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).not.toMatch(/\.slice\(0, 200\)/);
  });
});
