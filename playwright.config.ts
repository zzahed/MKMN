// Browser end-to-end tests (QE-2.3): the real React app, in a real Chromium, against the
// stand-in bridge of the browser preview (src/renderer/mock.html, src/renderer/mock.ts).
// No host, sidecar, GenieX or NPU is involved and nothing leaves the PC: the page talks
// only to the local Vite server.
//
// CI installs Playwright's Chromium. On a PC without it, set PLAYWRIGHT_CHANNEL=msedge to
// use the installed Edge (Windows 11 has it).
import { defineConfig, devices } from "@playwright/test";

const PORT = 5179;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["junit", { outputFile: "reports/e2e-junit.xml" }]] : "list",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1400, height: 900 },
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/mock.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
