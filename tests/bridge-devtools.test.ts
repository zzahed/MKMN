import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CatalogEntry } from "../src/shared/types";

// The real Tauri bridge, with invoke intercepted and the sidecar-event source faked
// (the same harness as bridge-setup.test.ts).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * Contract tests of the dev-tools bridge (src/renderer/tauriBridge.ts): the benchmark, the
 * NPU load test, the prompt lab, the battery reading and the NPU reset are answered by the
 * sidecar, and their progress arrives as `bench` / `benchLive` / `npuTest` / `modelCheck` /
 * `lab` sidecar events. The engine comparison (Foundry Local) stays honestly unavailable.
 */

let eventHandler: ((e: { payload: { name: string; payload: unknown } }) => void) | null = null;

beforeEach(async () => {
  const core = await import("@tauri-apps/api/core");
  (core.invoke as unknown as ReturnType<typeof vi.fn>).mockReset();
  const ev = await import("@tauri-apps/api/event");
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockReset();
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_name: string, handler: typeof eventHandler) => {
    eventHandler = handler;
    return () => {};
  });
});

async function api() {
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  const a = createTauriApi();
  await new Promise((r) => setTimeout(r, 0));
  return a;
}

async function mockSidecar(handlers: Record<string, (args: unknown[]) => unknown>) {
  const core = await import("@tauri-apps/api/core");
  const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
  invoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd !== "sidecar_call") return {};
    const h = handlers[args.method];
    if (!h) throw new Error(`unexpected sidecar method ${args.method}`);
    return h(args.args ?? []);
  });
  return invoke;
}

const ENTRY: CatalogEntry = {
  id: "qwen3-1.7b-native", name: "Qwen3-1.7B", repo: "ai-hub-models/Qwen3-1.7B", quant: null,
  engine: "qairt", role: "chat", architecture: "qwen3", sizeGB: 1.1, recommendedContext: 4096,
  sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};

describe("dev-tools bridge contract (sidecar-backed)", () => {
  it("the benchmark calls go to the sidecar by name, with the arguments through", async () => {
    const invoke = await mockSidecar({
      benchRoster: () => ({ targets: [{ key: "k1", name: ENTRY.name }], tests: { launch: 8 }, costs: {}, freeGB: 42.5, folder: "C:\\bench" }),
      benchState: () => ({ running: false, rows: [] }),
      benchStart: () => ({ ok: true }),
      benchStop: () => undefined,
      benchResults: () => [{ name: ENTRY.name, tests: [{ answer: "x", thinking: "y" }] }],
      benchExport: () => ({ ok: true, dir: "C:\\bench\\r", report: "", html: "C:\\bench\\r\\a.html" }),
      benchReveal: () => true
    });
    const a = await api();
    const roster = await a.benchRoster();
    expect(roster.freeGB).toBe(42.5);
    await expect(a.benchStart({ keys: ["k1"], mode: "express" })).resolves.toEqual({ ok: true });
    await a.benchStop();
    const results = await a.benchResults();
    expect(results[0].tests[0].answer).toBe("x"); // pass-through: the sidecar strips the texts
    await expect(a.benchExport()).resolves.toMatchObject({ ok: true });
    await expect(a.benchReveal("C:\\bench\\r\\a.html")).resolves.toBe(true);
    const methods = invoke.mock.calls.filter((c) => c[0] === "sidecar_call").map((c) => c[1].method);
    expect(methods).toEqual(["benchRoster", "benchStart", "benchStop", "benchResults", "benchExport", "benchReveal"]);
  });

  it("bench progress arrives as bench/benchLive events and reaches onBench/onBenchLive", async () => {
    await mockSidecar({});
    const a = await api();
    const states: any[] = [], live: any[] = [];
    const off1 = a.onBench((s) => states.push(s));
    const off2 = a.onBenchLive((l) => live.push(l));
    eventHandler?.({ payload: { name: "bench", payload: { running: true, phase: "testing" } } });
    eventHandler?.({ payload: { name: "benchLive", payload: { model: "Q", testId: "t1", answer: "he" } } });
    expect(states).toEqual([{ running: true, phase: "testing" }]);
    expect(live).toHaveLength(1);
    off1(); off2();
    eventHandler?.({ payload: { name: "bench", payload: { running: false } } });
    expect(states).toHaveLength(1);
  });

  it("the NPU load test names its methods and streams npuTest events; the stop is a best-effort call", async () => {
    const invoke = await mockSidecar({
      npuTestRoster: () => [{ id: ENTRY.id, name: ENTRY.name, sizeGB: ENTRY.sizeGB, failedBefore: false }],
      npuTestState: () => ({ running: true, lines: ["a"], results: [] }),
      npuTestStart: () => ({ ok: true }),
      npuTestStop: () => undefined
    });
    const a = await api();
    const events: any[] = [];
    const off = a.onNpuTest((s) => events.push(s));
    await expect(a.npuTestRoster()).resolves.toHaveLength(1);
    await expect(a.npuTestStart([ENTRY.id], false, true)).resolves.toEqual({ ok: true });
    await a.npuTestStop();
    eventHandler?.({ payload: { name: "npuTest", payload: { running: false, lines: [], results: [] } } });
    expect(events).toHaveLength(1);
    const methods = invoke.mock.calls.filter((c) => c[0] === "sidecar_call").map((c) => [c[1].method, c[1].args]);
    expect(methods).toEqual([
      ["npuTestRoster", []],
      ["npuTestStart", [[ENTRY.id], false, true]],
      ["npuTestStop", []]
    ]);
    off();
  });

  it("the model-check badge events reach onModelCheck", async () => {
    await mockSidecar({});
    const a = await api();
    const got: any[] = [];
    const off = a.onModelCheck((e) => got.push(e));
    eventHandler?.({ payload: { name: "modelCheck", payload: { ref: ENTRY.repo, phase: "done", badge: "npu" } } });
    expect(got).toEqual([{ ref: ENTRY.repo, phase: "done", badge: "npu" }]);
    off();
  });

  it("batteryRead and npuResetStatus ask the sidecar; npuReset goes through too", async () => {
    const invoke = await mockSidecar({
      batteryRead: () => ({ present: true, percent: 66, onMains: false }),
      npuResetStatus: () => ({ ready: true, auto: false }),
      npuReset: () => ({ ok: true, message: "The NPU device was restarted." })
    });
    const a = await api();
    await expect(a.batteryRead()).resolves.toMatchObject({ percent: 66 });
    await expect(a.npuResetStatus()).resolves.toEqual({ ready: true, auto: false });
    await expect(a.npuReset()).resolves.toMatchObject({ ok: true });
    const methods = invoke.mock.calls.filter((c) => c[0] === "sidecar_call").map((c) => c[1].method);
    expect(methods).toEqual(["batteryRead", "npuResetStatus", "npuReset"]);
  });

  it("the prompt lab starts, stops and streams lab states; the engine comparison stays honestly closed", async () => {
    await mockSidecar({
      labStart: () => ({ ok: true }),
      labStop: () => true,
      labState: () => ({ running: false, phase: "done", runs: [] })
    });
    const a = await api();
    const states: any[] = [];
    const off = a.onLab((s) => states.push(s));
    await expect(a.labStart({ md: "# Prompts\n...", modelIds: [ENTRY.id] })).resolves.toEqual({ ok: true });
    await expect(a.labStop()).resolves.toBe(true);
    await expect(a.labState()).resolves.toMatchObject({ phase: "done" });
    eventHandler?.({ payload: { name: "lab", payload: { running: true, phase: "loading" } } });
    expect(states).toEqual([{ running: true, phase: "loading" }]);
    // the Foundry Local comparison never pretends to work
    await expect(a.engineCompareStart({ mode: "express", maxPairs: 2 })).resolves.toMatchObject({ ok: false });
    off();
  });
});
