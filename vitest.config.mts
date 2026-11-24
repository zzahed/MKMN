import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  // .tsx tests are component interaction tests: each declares `@vitest-environment jsdom`
  // (the node environment stays the default for the pure-logic tests).
  // setup-model-guard fails any test that opens a real connection: model requests
  // in tests go to a FakeModel (src/core/harness/testing.ts) or a stubbed fetch.
  // An unhandled rejection fails the run: it can hide a failing assertion.
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    dangerouslyIgnoreUnhandledErrors: false,
    testTimeout: 20000,
    setupFiles: ["tests/setup-model-guard.ts", "tests/setup-journal-key.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.generated.ts", "src/renderer/mock*.ts", "src/renderer/vite-env.d.ts"],
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      // A ratchet: each number is the measured baseline less 1 (full suite on Windows ARM64,
      // 2026-11-23: statements 73.18, branches 63.75, functions 64.71, lines 78.46). Raise a
      // number when coverage rises; never lower one to let a change in. A critical file has a
      // floor only for the measures its baseline already meets. The security-critical files
      // below all meet the quality plan's floors (lines 95, branches 90) since 2026-11-23.
      thresholds: {
        statements: 72, branches: 62, functions: 63, lines: 77,
        "src/core/approval.ts": { lines: 95, branches: 90 },
        "src/core/installerTrust.ts": { lines: 95, branches: 90 },
        "src/core/isolate.ts": { lines: 95, branches: 90 },
        "src/core/netGuard.ts": { lines: 95, branches: 90 },
        "src/core/settingsWriter.ts": { lines: 95, branches: 90 },
        "src/core/zip.ts": { lines: 95, branches: 90 },
      },
    },
  }
});
