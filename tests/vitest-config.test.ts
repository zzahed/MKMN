import { describe, expect, it } from "vitest";
import config from "../vitest.config";

/**
 * An unhandled rejection can hide a failing assertion, so a run with one is a failed run.
 */
describe("the test runner settings", () => {
  const test = (config as { test?: { dangerouslyIgnoreUnhandledErrors?: boolean; exclude?: string[] } }).test ?? {};

  it("fails the run on an unhandled error", () => {
    expect(test.dangerouslyIgnoreUnhandledErrors).toBe(false);
  });

  it("leaves dependencies out", () => {
    expect(test.exclude).toEqual(expect.arrayContaining(["node_modules/**"]));
  });
});
