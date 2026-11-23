import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  // .tsx tests are component interaction tests: each declares `@vitest-environment jsdom`
  // (the node environment stays the default for the pure-logic tests).
  // setup-model-guard fails any test that opens a real connection: model requests
  // in tests go to a FakeModel (src/core/harness/testing.ts) or a stubbed fetch.
  // An unhandled rejection fails the run: it can hide a failing assertion.
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    dangerouslyIgnoreUnhandledErrors: false,
    testTimeout: 20000,
    setupFiles: ["tests/setup-model-guard.ts"],
  }
});
