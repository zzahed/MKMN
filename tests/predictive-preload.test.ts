import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPreloadController, isModifierOrNavKey, type PreloadController } from "../src/renderer/preloadController";
import type { ServerStatus } from "../src/shared/types";

// The Tauri bridge tests below import the real tauriBridge with invoke intercepted.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

/**
 * Tests of the production preload lifecycle controller (src/renderer/preloadController.ts,
 * used by Chat.tsx) with an injected API, so every assertion runs the real idempotency,
 * coalescing, idle-unload and cleanup logic — not a private copy of it.
 */

const status = (model: string, state: ServerStatus["state"], pid: number | null = 1234): ServerStatus => ({
  state,
  endpoint: "http://127.0.0.1:18181/v1",
  nctx: 4096,
  compute: "npu",
  restarts: 0,
  lastError: null,
  pid,
  model,
});

/** A controller wired to a controllable fake of the application API. */
function harness() {
  const preloadCalls: string[] = [];
  const stopCalls: number[] = [];
  const pending: { model: string; resolve: (s: ServerStatus) => void; reject: (e: unknown) => void }[] = [];
  let server: ServerStatus | null = null;
  let strategy: string = "demand";
  const selectedModel = "qwen3-4b-thinking-2507";

  const api = {
    preloadModel: (req: { model: string }): Promise<ServerStatus> => {
      preloadCalls.push(req.model);
      return new Promise<ServerStatus>((resolve, reject) => {
        pending.push({ model: req.model, resolve, reject });
      });
    },
    stopServer: async (): Promise<unknown> => {
      stopCalls.push(stopCalls.length);
      return undefined;
    },
  };

  const controller = createPreloadController({
    api,
    getServer: () => server,
    getLoadingStrategy: () => strategy,
    getModel: () => selectedModel,
  });

  return {
    controller,
    preloadCalls,
    stopCalls,
    /** The preload request currently in flight (oldest first). */
    pending,
    resolvePreload: async (model: string, s: ServerStatus) => {
      const i = pending.findIndex((p) => p.model === model);
      if (i >= 0) pending.splice(i, 1)[0].resolve(s);
      await drainMicrotasks();
    },
    rejectPreload: async (model: string, err: unknown = new Error("preload failed")) => {
      const i = pending.findIndex((p) => p.model === model);
      if (i >= 0) pending.splice(i, 1)[0].reject(err);
      await drainMicrotasks();
    },
    setServer: (s: ServerStatus | null) => { server = s; },
    setStrategy: (s: string) => { strategy = s; },
    selectedModel,
  };
}

/** Drain the promise chain of a preload (.then/.catch/.finally) without advancing timers. */
const drainMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

function phases(controller: PreloadController): { phase: () => string | null } {
  const seen: (string | null)[] = [];
  controller.onPhase((p) => seen.push(p));
  return { phase: () => (seen.length ? seen[seen.length - 1] : controller.phase()) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Keystroke & Input Intent Detection (production isModifierOrNavKey)", () => {
  it("filters out modifier, navigation, and control keys", () => {
    const modifierKeys = [
      "Shift", "Control", "Alt", "Meta", "CapsLock",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Escape", "Tab", "Home", "End", "PageUp", "PageDown",
      "Insert", "ContextMenu", "F1", "F5", "F12"
    ];

    for (const key of modifierKeys) {
      expect(isModifierOrNavKey(key), `Expected ${key} to be filtered`).toBe(true);
    }

    // Also combination with ctrl/alt/meta
    expect(isModifierOrNavKey("c", true, false, false)).toBe(true);
    expect(isModifierOrNavKey("v", true, false, false)).toBe(true);
  });

  it("identifies printable character keystrokes for zero-latency trigger", () => {
    const printableKeys = ["H", "e", "l", "l", "o", "1", "م", "ك", "م", "ن", "?", " "];
    for (const key of printableKeys) {
      expect(isModifierOrNavKey(key, false, false, false), `Expected ${key} to be allowed`).toBe(false);
    }
  });

  it("the composer preload trigger fires only when input transitions from empty to non-empty", () => {
    const h = harness();
    // An empty draft arms the idle-unload timer but preloads nothing.
    h.controller.draftChanged("");
    expect(h.preloadCalls).toEqual([]);
    // The first keystroke preloads the selected model, exactly once.
    h.controller.draftChanged("H");
    expect(h.preloadCalls).toEqual([h.selectedModel]);
    h.controller.draftChanged("He");
    h.controller.draftChanged("Hel");
    h.controller.draftChanged("Hello");
    expect(h.preloadCalls).toEqual([h.selectedModel]);
  });
});

describe("Strict Idempotency & Reuse (production controller)", () => {
  it("is an instant no-op if the requested model is already ready in NPU memory", () => {
    const h = harness();
    h.setServer(status(h.selectedModel, "ready", 9942));

    const marks = phases(h.controller);
    h.controller.trigger();

    expect(h.preloadCalls).toEqual([]);
    expect(marks.phase()).toBe("ready");
  });

  it("requests the native preload command once per distinct model", async () => {
    const h = harness();
    h.setServer(status("another-model", "ready", 9942));

    h.controller.trigger();
    expect(h.preloadCalls).toEqual([h.selectedModel]);

    // Typing more while the same preload is in flight does not duplicate the IPC call.
    h.controller.trigger();
    h.controller.trigger();
    expect(h.preloadCalls).toEqual([h.selectedModel]);
    expect(h.controller.isPreloading(h.selectedModel)).toBe(true);

    await h.resolvePreload(h.selectedModel, status(h.selectedModel, "ready"));
    expect(h.controller.phase()).toBe("ready");
  });

  it("a preload that answers 'starting' keeps the warming phase; other answers clear it", async () => {
    const h = harness();
    h.controller.trigger();
    await h.resolvePreload(h.selectedModel, status(h.selectedModel, "starting"));
    expect(h.controller.phase()).toBe("warming");

    h.controller.trigger();
    await h.resolvePreload(h.selectedModel, status(h.selectedModel, "stopped"));
    expect(h.controller.phase()).toBe(null);
  });

  it("a failed preload clears the phase and releases the in-flight guard so it can be retried", async () => {
    const h = harness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    h.controller.trigger();
    await h.rejectPreload(h.selectedModel);
    expect(h.controller.phase()).toBe(null);

    h.controller.trigger();
    expect(h.preloadCalls).toEqual([h.selectedModel, h.selectedModel]);
  });

  it("a repeatedly failing preload is retried on a bounded backoff, not on every keystroke", async () => {
    const h = harness();

    // First failure: one immediate retry is still allowed (a transient failure should not wait).
    h.controller.trigger();
    await h.rejectPreload(h.selectedModel);
    h.controller.trigger();
    expect(h.preloadCalls).toEqual([h.selectedModel, h.selectedModel]);
    await h.rejectPreload(h.selectedModel);

    // Second failure: retries are pushed apart. Typing does not relaunch the load.
    h.controller.trigger();
    h.controller.trigger();
    expect(h.preloadCalls).toHaveLength(2);

    // The backoff window passes: the next attempt goes through.
    vi.advanceTimersByTime(30_000);
    h.controller.trigger();
    expect(h.preloadCalls).toHaveLength(3);
    await h.rejectPreload(h.selectedModel);

    // After more failures the window grows (60s now), and it is capped from there.
    vi.advanceTimersByTime(30_000);
    h.controller.trigger();
    expect(h.preloadCalls).toHaveLength(3);
    vi.advanceTimersByTime(30_000);
    h.controller.trigger();
    expect(h.preloadCalls).toHaveLength(4);
  });

  it("an explicit model switch clears the backoff: the user's own choice is the retry", async () => {
    const h = harness();
    h.controller.trigger();
    await h.rejectPreload(h.selectedModel);
    h.controller.trigger();
    await h.rejectPreload(h.selectedModel);

    // Still inside the backoff window: typing does nothing.
    h.controller.trigger();
    expect(h.preloadCalls).toHaveLength(2);

    // The user picks the model again (or another one and back): it warms immediately.
    h.controller.modelSwitched(h.selectedModel);
    expect(h.preloadCalls).toHaveLength(3);
  });
});

describe("Model Switching & Race Condition Handling (production controller)", () => {
  it("a model switch preloads the new model even while the old preload is in flight", () => {
    const h = harness();
    h.controller.trigger("model-a-4b");
    expect(h.preloadCalls).toEqual(["model-a-4b"]);

    // User switches to Model B in the dropdown.
    h.controller.modelSwitched("model-b-8b");
    expect(h.preloadCalls).toEqual(["model-a-4b", "model-b-8b"]);
  });

  it("a stale preload resolution does not override the phase of the newer model", async () => {
    const h = harness();
    h.controller.trigger("model-a-4b");
    h.controller.modelSwitched("model-b-8b");

    // The old preload for model A finally answers "ready" — it must be ignored.
    await h.resolvePreload("model-a-4b", status("model-a-4b", "ready"));
    expect(h.controller.phase()).toBe("warming");

    await h.resolvePreload("model-b-8b", status("model-b-8b", "ready"));
    expect(h.controller.phase()).toBe("ready");
  });
});

describe("Cancelled Input & 60s Idle Cleanup (production controller)", () => {
  it("schedules graceful unload after 60 seconds if user clears prompt and does not send (On Demand mode)", async () => {
    const h = harness();
    h.controller.draftChanged("What is the Hexagon NPU architecture?");
    expect(h.stopCalls).toHaveLength(0);

    h.controller.draftChanged("");
    vi.advanceTimersByTime(30_000);
    expect(h.stopCalls).toHaveLength(0);

    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => {
      expect(h.stopCalls).toHaveLength(1);
      expect(h.controller.phase()).toBe(null);
    });
  });

  it("resumes active preload and clears the 60s timer if user starts typing again before timeout", async () => {
    const h = harness();
    h.controller.draftChanged("First thought");
    h.controller.draftChanged("");

    vi.advanceTimersByTime(45_000);
    h.controller.draftChanged("Second thought");

    vi.advanceTimersByTime(75_000);
    expect(h.stopCalls).toHaveLength(0);
  });

  it("does not unload the server in Always-on mode", async () => {
    const h = harness();
    h.setStrategy("always");
    h.controller.draftChanged("A thought");
    h.controller.draftChanged("");

    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(h.controller.phase()).toBe(null));
    expect(h.stopCalls).toHaveLength(0);
  });

  it("sending a message cancels the pending idle unload", async () => {
    const h = harness();
    h.controller.draftChanged("A thought");
    h.controller.draftChanged("");
    h.controller.cancelIdleUnload();

    vi.advanceTimersByTime(120_000);
    expect(h.stopCalls).toHaveLength(0);
  });

  it("disposing the controller (chat unmounted) clears the timer so it can never stop another chat's server", async () => {
    const h = harness();
    h.controller.draftChanged("A thought");
    h.controller.draftChanged("");
    h.controller.dispose();

    vi.advanceTimersByTime(120_000);
    expect(h.stopCalls).toHaveLength(0);
  });
});

describe("Preload failure reporting (the reason reaches the UI)", () => {
  it("a rejected preload exposes its reason via lastError instead of swallowing it", async () => {
    const h = harness();
    h.controller.trigger();
    await h.rejectPreload(h.selectedModel, new Error("GenieX failed to respond to readiness check within 90s"));

    expect(h.controller.phase()).toBe(null);
    const failure = h.controller.lastError();
    expect(failure).not.toBe(null);
    expect(failure?.raw).toContain("readiness check");
  });

  it("a status answer that is not a warm model surfaces the host's classified error", async () => {
    const h = harness();
    h.controller.trigger();
    await h.resolvePreload(h.selectedModel, {
      ...status(h.selectedModel, "failed"),
      lastError: { id: "missing-artifact", title: "The model's files are not in the GenieX cache", fix: "Install the model again from Models.", raw: "not found in local cache" },
    });

    expect(h.controller.phase()).toBe(null);
    expect(h.controller.lastError()).toMatchObject({
      id: "missing-artifact",
      title: "The model's files are not in the GenieX cache",
    });
  });

  it("a successful preload clears the failure again", async () => {
    const h = harness();
    h.controller.trigger();
    await h.rejectPreload(h.selectedModel, "boom");
    expect(h.controller.lastError()).not.toBe(null);

    h.controller.modelSwitched(h.selectedModel);
    await h.resolvePreload(h.selectedModel, status(h.selectedModel, "ready"));
    expect(h.controller.lastError()).toBe(null);
    expect(h.controller.phase()).toBe("ready");
  });

  it("a string rejection (the host's raw error text) is captured verbatim", async () => {
    const h = harness();
    h.controller.trigger();
    await h.rejectPreload(h.selectedModel, "'custom:x' is an application model id, not a cache name");
    expect(h.controller.lastError()?.raw).toContain("application model id");
  });
});

describe("New server states (loading / busy / unloaded)", () => {
  it("a 'loading' status answer keeps the warming phase", async () => {
    const h = harness();
    h.controller.trigger();
    await h.resolvePreload(h.selectedModel, status(h.selectedModel, "loading"));
    expect(h.controller.phase()).toBe("warming");
  });

  it("a 'busy' status answer counts as warm: the model is resident mid-generation", async () => {
    const h = harness();
    h.controller.trigger();
    await h.resolvePreload(h.selectedModel, status(h.selectedModel, "busy"));
    expect(h.controller.phase()).toBe("ready");
  });

  it("an 'unloaded' status answer clears the phase (the model is gone)", async () => {
    const h = harness();
    h.controller.trigger();
    await h.resolvePreload(h.selectedModel, status(h.selectedModel, "unloaded"));
    expect(h.controller.phase()).toBe(null);
  });

  it("an already-busy server with the same model is an instant no-op, like ready", () => {
    const h = harness();
    h.setServer(status(h.selectedModel, "busy", 9942));
    h.controller.trigger();
    expect(h.preloadCalls).toEqual([]);
    expect(h.controller.phase()).toBe("ready");
  });
});

describe("Native preload bridge contract", () => {
  // The real Tauri bridge, with invoke intercepted: proves the preload request reaches
  // the native "preload_model" command with the payload the Rust side expects.
  it("preloadModel enters the native preload_model command with a well-formed request", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return { loadingStrategy: "demand", powerProfile: "burst" };
      if (cmd === "preload_model") return status("qwen3-4b-thinking-2507", "ready");
      throw new Error(`unexpected command ${cmd}`);
    });

    const { createTauriApi } = await import("../src/renderer/tauriBridge");
    const api = createTauriApi();
    const result = await api.preloadModel({ model: "qwen3-4b-thinking-2507" });

    expect(result.state).toBe("ready");
    const calls = invoke.mock.calls.filter((c: unknown[]) => c[0] === "preload_model");
    expect(calls).toHaveLength(1);
    const [cmd, args] = calls[0] as [string, { req: Record<string, unknown> }];
    expect(cmd).toBe("preload_model");
    // The catalog id resolves to its concrete cache ref before the request is sent —
    // the raw application id never reaches the native command (the old `...req` spread
    // used to put it back, which is what this assertion saw before).
    expect(args.req.model).toBe("unsloth/Qwen3-4B-Thinking-2507-GGUF:Q4_0");
    expect(args.req.port).toBe(18181);
    expect(args.req.strategy).toBe("demand");
    expect(args.req.power_mode).toBe("burst");
    expect(args.req.metrics).toBe(true);
  });

  it("a native preload error propagates to the caller", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return {};
      if (cmd === "preload_model") throw new Error("model download failed");
      throw new Error(`unexpected command ${cmd}`);
    });

    const { createTauriApi } = await import("../src/renderer/tauriBridge");
    const api = createTauriApi();
    await expect(api.preloadModel({ model: "broken-model" })).rejects.toThrow("model download failed");
  });

  it("a saved custom entry's id resolves to the concrete cache ref, and req.model cannot overwrite it", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_settings") return { loadingStrategy: "demand", powerProfile: "burst" };
      if (cmd === "get_installed_models_cmd") return [{ name: "unsloth/gemma-3-1b-it-GGUF:Q4_0", ref: "unsloth/gemma-3-1b-it-GGUF:Q4_0" }];
      if (cmd === "sidecar_call") {
        if (args?.method === "customEntries") {
          return [{ id: "custom:unsloth/gemma-3-1b-it-gguf:q4_0", name: "Gemma 3 1B", repo: "unsloth/gemma-3-1b-it-GGUF", quant: "Q4_0" }];
        }
        return [];
      }
      if (cmd === "preload_model") return status("unsloth/gemma-3-1b-it-GGUF:Q4_0", "ready");
      throw new Error(`unexpected command ${cmd}`);
    });

    const { createTauriApi } = await import("../src/renderer/tauriBridge");
    const api = createTauriApi();
    // req.model deliberately carries the raw application id: the resolved ref must win.
    await api.preloadModel({ model: "custom:unsloth/gemma-3-1b-it-gguf:q4_0" });

    const calls = invoke.mock.calls.filter((c: unknown[]) => c[0] === "preload_model");
    expect(calls).toHaveLength(1);
    const [, args] = calls[0] as [string, { req: Record<string, unknown> }];
    expect(args.req.model).toBe("unsloth/gemma-3-1b-it-GGUF:Q4_0");
  });

  it("a 'custom:' id with no saved entry resolves through the cache by its repo, never as 'custom:...'", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async (cmd: string, _args: any) => {
      if (cmd === "get_settings") return {};
      if (cmd === "get_installed_models_cmd") return [{ name: "unsloth/gemma-3-1b-it-GGUF:Q4_0", ref: "unsloth/gemma-3-1b-it-GGUF:Q4_0" }];
      if (cmd === "sidecar_call") return [];
      if (cmd === "preload_model") return status("unsloth/gemma-3-1b-it-GGUF:Q4_0", "ready");
      throw new Error(`unexpected command ${cmd}`);
    });

    const { createTauriApi } = await import("../src/renderer/tauriBridge");
    const api = createTauriApi();
    // An id written by an older build, without a saved entry behind it.
    await api.preloadModel({ model: "custom:unsloth/gemma-3-1b-it-gguf" });

    const calls = invoke.mock.calls.filter((c: unknown[]) => c[0] === "preload_model");
    const [, args] = calls[0] as [string, { req: Record<string, unknown> }];
    expect(args.req.model).toBe("unsloth/gemma-3-1b-it-GGUF:Q4_0");
  });
});

describe("a Foundry Local model is never warmed through GenieX", () => {
  it("sends no preload and reports no failure for a foundry: model", async () => {
    const h = harness();
    h.controller.trigger("foundry:qwen3-0.6b");
    await drainMicrotasks();
    expect(h.preloadCalls).toEqual([]);
    expect(h.controller.lastError()).toBeNull();
    expect(h.controller.phase()).toBeNull();
  });
});
