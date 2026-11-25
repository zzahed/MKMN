import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { featureInventory, missingFromMatrix } from "../scripts/feature-matrix.mjs";
import { matrixText } from "../scripts/generate-feature-matrix.mjs";

/**
 * The release matrix is only useful if it is exhaustive. Every command, sidecar
 * method, Settings row, screen and script is read from the
 * source and must have its own row; adding one without a row fails here.
 */
describe("the v0.0.3-rc.3 feature test matrix", () => {
  const matrix = readFileSync("docs/MKMN_FEATURE_TEST_MATRIX_0.0.3-rc.3.md", "utf8").replace(/\r\n/g, "\n");
  const inventory = featureInventory(process.cwd());

  it("lists every feature the source exposes, in every group", () => {
    expect(missingFromMatrix(matrix, inventory)).toEqual([]);
  });

  it("is generated from the same inventory, with no hand edit left behind", () => {
    expect(matrix).toBe(matrixText(process.cwd()));
  });

  it("keeps one row per feature and no empty result", () => {
    const ids = [...matrix.matchAll(/^\| ([A-Z]{1,3}\d{3}) \|/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(300);
    expect(new Set(ids).size, "duplicate matrix ID").toBe(ids.length);
    expect(matrix).not.toMatch(/\|\s*\|\s*$/m);
  });

  it("prints no missing value in place of a result", () => {
    expect(matrix).not.toContain("undefined");
  });

  it("states the release and the test commands it summarises", () => {
    expect(matrix).toContain("0.0.3-rc.3");
    expect(matrix).toContain("pnpm exec vitest run");
    expect(matrix).toContain("cargo test");
    expect(matrix).toContain("node scripts/check-language.mjs");
    expect(matrix).toContain("node scripts/generate-state-machines.mjs --check");
  });
});
