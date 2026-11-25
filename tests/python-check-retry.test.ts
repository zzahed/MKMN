import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * From the windows-arm64-tests CI job: a correct FizzBuzz scored 0 with
 * "could not run: spawnSync python ETIMEDOUT" because Python had not even started
 * within the 8 s limit on a busy runner. A run that timed out before printing a
 * single line was a slow start, not slow code: it is tried once more. Code that
 * really hangs still scores 0, after exactly two tries.
 */
const spawnSync = vi.fn();
vi.mock("child_process", async (orig) => ({ ...(await orig<typeof import("child_process")>()), spawnSync: (...a: unknown[]) => spawnSync(...a) }));

const timedOut = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync python ETIMEDOUT"), { code: "ETIMEDOUT" }) });
const ran = (out: string) => ({ status: 0, stdout: out, stderr: "", error: undefined });
const isVersion = (args: unknown) => Array.isArray(args) && args[0] === "--version";

describe("pythonCheck on a busy PC", () => {
  beforeEach(() => { vi.resetModules(); spawnSync.mockReset(); });

  it("tries once more when Python timed out before printing anything, and scores the answer", async () => {
    let runs = 0;
    spawnSync.mockImplementation((_cmd: string, args: unknown) => isVersion(args) ? ran("Python 3.11") : (++runs === 1 ? timedOut() : ran("1\n2\n")));
    const { pythonCheck } = await import("../src/core/benchChecks");
    const c = pythonCheck("def f(x):\n    return x", [["f(1)", 1], ["f(2)", 2]]);
    expect(c.score).toBe(1);
    expect(runs).toBe(2);
  });

  it("code that hangs still scores 0, after exactly two tries", async () => {
    let runs = 0;
    spawnSync.mockImplementation((_cmd: string, args: unknown) => isVersion(args) ? ran("Python 3.11") : (runs++, timedOut()));
    const { pythonCheck } = await import("../src/core/benchChecks");
    const c = pythonCheck("def f(x):\n    while True: pass", [["f(1)", 1]]);
    expect(c.score).toBe(0);
    expect(c.note).toMatch(/ETIMEDOUT/);
    expect(runs).toBe(2);
  });

  it("a run that timed out after printing some answers is not tried again (the code itself is slow)", async () => {
    let runs = 0;
    spawnSync.mockImplementation((_cmd: string, args: unknown) => isVersion(args) ? ran("Python 3.11") : (runs++, { ...timedOut(), stdout: "1\n" }));
    const { pythonCheck } = await import("../src/core/benchChecks");
    pythonCheck("def f(x):\n    return x", [["f(1)", 1], ["f(2)", 2]]);
    expect(runs).toBe(1);
  });
});
