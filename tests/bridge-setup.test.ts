import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SetupState, UpdateState } from "../src/shared/types";

// The real Tauri bridge, with invoke intercepted and the sidecar-event source faked
// (the same harness as bridge-voice.test.ts).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * Contract tests of the setup/update bridge (src/renderer/tauriBridge.ts): first-launch
 * setup and the deliberately transportless updater are answered by the sidecar, and their
 * progress arrives as `setup` / `update` sidecar events.
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

const STATE: SetupState = {
  active: true,
  awaitingConfirm: true,
  steps: [{ id: "geniex", label: "GenieX runtime", detail: "Qualcomm's runtime", state: "pending", percent: null, message: null, error: null }]
};

const UPDATE: UpdateState = {
  status: "error", version: null, percent: null,
  error: "Automatic updates are disabled. Install only a verified MKMN release.",
  checkedAt: null, installedAt: null
};

describe("setup and update bridge contract (sidecar-backed)", () => {
  it("setupState asks the sidecar and setup actions name their methods", async () => {
    const invoke = await mockSidecar({
      setupState: () => STATE,
      setupConfirm: () => undefined,
      setupDecline: () => undefined,
      setupSkip: () => undefined,
      setupRetry: () => undefined,
      setupDismiss: () => undefined
    });
    const a = await api();
    await expect(a.setupState()).resolves.toMatchObject({ active: true, awaitingConfirm: true });
    await a.setupConfirm();
    await a.setupSkip("voice-stt");
    await a.setupRetry("geniex");
    await a.setupDismiss();
    await a.setupDecline();
    const methods = invoke.mock.calls.filter((c) => c[0] === "sidecar_call").map((c) => [c[1].method, c[1].args]);
    expect(methods).toEqual([
      ["setupState", []],
      ["setupConfirm", []],
      ["setupSkip", ["voice-stt"]],
      ["setupRetry", ["geniex"]],
      ["setupDismiss", []],
      ["setupDecline", []]
    ]);
  });

  it("setup progress arrives as a `setup` sidecar event and reaches onSetup", async () => {
    await mockSidecar({ setupState: () => STATE });
    const a = await api();
    const got: SetupState[] = [];
    const off = a.onSetup((st) => got.push(st));
    eventHandler?.({ payload: { name: "setup", payload: { ...STATE, awaitingConfirm: false } } });
    expect(got).toHaveLength(1);
    expect(got[0].awaitingConfirm).toBe(false);
    off();
    eventHandler?.({ payload: { name: "setup", payload: STATE } });
    expect(got).toHaveLength(1); // unsubscribed
  });

  it.each(["setupDecline", "setupDismiss"] as const)("%s stays effective when a replacement sidecar checks setup", async (action) => {
    await mockSidecar({ setupState: () => STATE, [action]: () => undefined });
    const a = await api();
    const got: SetupState[] = [];
    const off = a.onSetup((st) => got.push(st));

    await a[action]();
    // A new sidecar has its own SetupService. Its startup check must not replace
    // the current chat with onboarding after this window already skipped it.
    eventHandler?.({ payload: { name: "setup", payload: STATE } });
    expect(got).toEqual([{ ...STATE, active: false }]);
    await expect(a.setupState()).resolves.toEqual({ ...STATE, active: false });
    off();
  });

  it.each([
    ["setupConfirm", []], ["setupRetry", ["voice-stt"]],
    ["setupRunUnsigned", ["geniex"]], ["openGeniexDownload", []]
  ] as const)("an explicit %s reopens setup after it was skipped", async (action, args) => {
    await mockSidecar({
      setupState: () => STATE, setupDecline: () => undefined,
      setupConfirm: () => undefined, setupRetry: () => undefined, setupRunUnsigned: () => undefined
    });
    const a = await api();
    await a.setupDecline();
    await expect(a.setupState()).resolves.toMatchObject({ active: false });
    await (a[action] as (...values: string[]) => Promise<void>)(...args);
    await expect(a.setupState()).resolves.toMatchObject({ active: true });
  });

  it("does not hide setup when the decline request fails", async () => {
    await mockSidecar({ setupState: () => STATE, setupDecline: () => { throw new Error("sidecar unavailable"); } });
    const a = await api();
    await expect(a.setupDecline()).rejects.toThrow("sidecar unavailable");
    await expect(a.setupState()).resolves.toMatchObject({ active: true });
  });

  it("a fresh window still offers first-launch setup", async () => {
    await mockSidecar({ setupState: () => STATE, setupDecline: () => undefined });
    const a = await api();
    await a.setupDecline();
    await expect(a.setupState()).resolves.toMatchObject({ active: false });
    const fresh = await api();
    await expect(fresh.setupState()).resolves.toMatchObject({ active: true });
  });

  it("the updater stays honest: every call answers the disabled state, update events reach onUpdate", async () => {
    const invoke = await mockSidecar({ updateState: () => UPDATE, updateCheck: () => UPDATE, updateForce: () => UPDATE, updateInstall: () => undefined });
    const a = await api();
    await expect(a.updateState()).resolves.toMatchObject({ status: "error" });
    await expect(a.updateCheck()).resolves.toMatchObject({ status: "error" });
    await expect(a.updateForce()).resolves.toMatchObject({ status: "error" });
    await expect(a.updateInstall()).resolves.toBeUndefined();
    const got: UpdateState[] = [];
    const off = a.onUpdate((st) => got.push(st));
    eventHandler?.({ payload: { name: "update", payload: UPDATE } });
    expect(got).toHaveLength(1);
    expect(invoke.mock.calls.some((c) => c[0] === "start_server" || c[0] === "check_update")).toBe(false);
    off();
  });

  it("openGeniexDownload retries the geniex setup step instead of throwing", async () => {
    const invoke = await mockSidecar({ setupRetry: () => undefined });
    const a = await api();
    await expect(a.openGeniexDownload()).resolves.toBeUndefined();
    expect(invoke.mock.calls.find((c) => c[1].method === "setupRetry")[1].args).toEqual(["geniex"]);
  });
});
