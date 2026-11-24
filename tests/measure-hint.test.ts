import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { measureHint } from "../src/core/modelList";

/**
 * The measure hint: a model nobody measured on this PC must say where a
 * measurement COMES FROM — the NPU load test or the single-model benchmark, both in
 * Settings → Developer — instead of leaving the user with an unexplained
 * "Not measured here" badge. The hint is on the model card, only while unmeasured.
 */

const models = readFileSync("src/renderer/Models.tsx", "utf8");

describe("the measure hint on an unmeasured model's card", () => {
  it("names the two places that produce a measurement, and where they live", () => {
    const h = measureHint();
    expect(h).toContain("NPU load test");
    expect(h).toContain("Single-model benchmark");
    expect(h).toContain("Settings → Developer");
  });

  it("is rendered on the card ONLY while the model is unmeasured (source pin)", () => {
    // a plain line first; where a measurement comes from is one click away, still only while unmeasured
    expect(models).toMatch(/!\s*bp\.on[^>]*><summary>Not tried on this PC yet<\/summary>\{measureHint\(\)\}/);
  });
});
