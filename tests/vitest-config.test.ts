import { describe, expect, it } from "vitest";
import config from "../vitest.config";

/**
 * An unhandled rejection can hide a failing assertion, so a run with one is a failed run.
 * Shelved code is not part of the product and is not tested with it.
 */
describe("the test runner settings", () => {
  const test = (config as { test?: { dangerouslyIgnoreUnhandledErrors?: boolean; exclude?: string[] } }).test ?? {};

  it("fails the run on an unhandled error", () => {
    expect(test.dangerouslyIgnoreUnhandledErrors).toBe(false);
  });

  it("leaves shelved tests and dependencies out", () => {
    expect(test.exclude).toEqual(expect.arrayContaining(["tests/shelved/**", "node_modules/**"]));
  });
});
