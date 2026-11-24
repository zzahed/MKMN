import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createPreloadController } from "../src/renderer/preloadController";
import { settingDefault, settingDecl } from "../src/shared/settingsSchema";
import type { ServerStatus } from "../src/shared/types";

/**
 * "Warm up model while typing" (Settings → Speed & memory, off by default). With it on, the first
 * non-whitespace character of a draft starts loading the chat's model; Send during that load waits for the same
 * load and then sends once; a failed load is not restarted by more typing (Retry is the person's); a model change
 * during the load keeps the old answer from touching the new model. The draft never reaches the runtime before Send.
 */

const status = (model: string, state: ServerStatus["state"]): ServerStatus => ({
  state, endpoint: "http://127.0.0.1:18181/v1", nctx: 4096, compute: "npu", restarts: 0, lastError: null, pid: 1, model,
});
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(enabled = true) {
  const calls: unknown[] = [];
  const pending: { model: string; resolve: (s: ServerStatus) => void; reject: (e: unknown) => void }[] = [];
  let on = enabled;
  let model = "org/model-a:Q4_0";
  let server: ServerStatus | null = null;
  const controller = createPreloadController({
    api: {
      preloadModel: (req) => { calls.push(req); return new Promise((resolve, reject) => pending.push({ model: req.model, resolve, reject })); },
      stopServer: async () => undefined,
    },
    getServer: () => server,
    getLoadingStrategy: () => "demand",
    getModel: () => model,
    isEnabled: () => on,
  });
  return {
    controller, calls, pending,
    setEnabled: (v: boolean) => { on = v; },
    setModel: (m: string) => { model = m; },
    setServer: (st: ServerStatus | null) => { server = st; },
    resolve: async (m: string, s: ServerStatus) => { const i = pending.findIndex((p) => p.model === m); pending.splice(i, 1)[0].resolve(s); await drain(); },
    reject: async (m: string, e: unknown) => { const i = pending.findIndex((p) => p.model === m); pending.splice(i, 1)[0].reject(e); await drain(); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the setting", () => {
  it("is on by default, in Speed & memory, and the same default in the host", () => {
    expect(settingDefault("warmUpWhileTyping")).toBe(true);
    const decl = settingDecl("warmUpWhileTyping");
    expect(decl?.group).toBe("models");
    expect(decl?.type).toBe("boolean");
    const rust = readFileSync("src-tauri/src/settings_defaults.rs", "utf8");
    expect(rust).toMatch(/key: "warmUpWhileTyping", kind: "boolean"/);
    expect(rust).toMatch(/"warmUpWhileTyping": true/);
  });

  it("off: typing loads nothing", () => {
    const h = harness(false);
    h.controller.draftChanged("Hello");
    h.controller.draftChanged("Hello there");
    expect(h.calls).toEqual([]);
    expect(h.controller.phase()).toBe(null);
  });
});

describe("the first keystroke", () => {
  it("whitespace does not start it; the first real character does, once per draft, and never with the draft's text", () => {
    const h = harness();
    h.controller.draftChanged(" ");
    h.controller.draftChanged("  \n");
    expect(h.calls).toEqual([]);
    h.controller.draftChanged("  H");
    h.controller.draftChanged("  He");
    h.controller.draftChanged("  Hello");
    expect(h.calls).toEqual([{ model: "org/model-a:Q4_0" }]); // the model only: the draft never leaves before Send
    expect(h.controller.phase()).toBe("warming");
  });

  it("a ready model is reused, and a new draft after a sent one does not load twice", async () => {
    const h = harness();
    h.controller.draftChanged("Hi");
    await h.resolve("org/model-a:Q4_0", status("org/model-a:Q4_0", "ready"));
    expect(h.controller.phase()).toBe("ready");
    h.setServer(status("org/model-a:Q4_0", "ready")); // what the host reports once the model is loaded
    h.controller.endDraft();
    h.controller.draftChanged("Again");
    // the same model was warmed by this controller and nothing says it left: no second load
    expect(h.calls).toHaveLength(1);
  });
});

describe("Send during warm-up", () => {
  it("waits for the same load, then lets the message go once", async () => {
    const h = harness();
    h.controller.draftChanged("Explain the NPU");
    let sent = 0;
    const send = h.controller.settled("org/model-a:Q4_0").then(() => { sent++; });
    await drain();
    expect(sent).toBe(0); // still loading
    expect(h.calls).toHaveLength(1);
    await h.resolve("org/model-a:Q4_0", status("org/model-a:Q4_0", "ready"));
    await send;
    expect(sent).toBe(1);
    expect(h.calls).toHaveLength(1); // the send started no second load
  });

  it("a failed load still lets Send go (the chat then reports the load itself)", async () => {
    const h = harness();
    h.controller.draftChanged("Hi");
    const send = h.controller.settled("org/model-a:Q4_0");
    await h.reject("org/model-a:Q4_0", new Error("GenieX failed to load org/model-a:Q4_0"));
    await expect(send).resolves.toBeUndefined();
  });

  it("with nothing loading, Send does not wait", async () => {
    const h = harness();
    await expect(h.controller.settled("org/model-a:Q4_0")).resolves.toBeUndefined();
  });
});

describe("a failed warm-up", () => {
  it("is reported, is not restarted by more typing, and Retry starts it again", async () => {
    const h = harness();
    h.controller.draftChanged("H");
    await h.reject("org/model-a:Q4_0", new Error("GenieX failed to load org/model-a:Q4_0"));
    expect(h.controller.lastError()?.raw).toMatch(/failed to load/);
    h.controller.draftChanged("He");
    h.controller.draftChanged("");
    h.controller.draftChanged("A new draft");
    vi.advanceTimersByTime(10 * 60_000);
    h.controller.draftChanged("A new draft, longer");
    expect(h.calls).toHaveLength(1);
    h.controller.retry();
    expect(h.calls).toHaveLength(2);
  });
});

describe("a model change during warm-up", () => {
  it("the old load's answer does not touch the new model, and Send waits for the new one", async () => {
    const h = harness();
    h.controller.draftChanged("Hi");
    h.setModel("org/model-b:Q4_0");
    h.controller.modelSwitched("org/model-b:Q4_0");
    expect(h.calls.map((c: any) => c.model)).toEqual(["org/model-a:Q4_0", "org/model-b:Q4_0"]);
    let sent = false;
    const send = h.controller.settled("org/model-b:Q4_0").then(() => { sent = true; });
    // the old model answers first: ready for A is not ready for B
    await h.resolve("org/model-a:Q4_0", status("org/model-a:Q4_0", "ready"));
    expect(h.controller.phase()).toBe("warming");
    expect(h.controller.lastPreloadedModel()).not.toBe("org/model-a:Q4_0");
    expect(sent).toBe(false);
    await h.resolve("org/model-b:Q4_0", status("org/model-b:Q4_0", "ready"));
    await send;
    expect(sent).toBe(true);
    expect(h.controller.phase()).toBe("ready");
  });

  it("an old load that fails after the change does not report a failure for the new model", async () => {
    const h = harness();
    h.controller.draftChanged("Hi");
    h.controller.modelSwitched("org/model-b:Q4_0");
    await h.reject("org/model-a:Q4_0", new Error("old model failed"));
    expect(h.controller.lastError()).toBe(null);
    expect(h.controller.phase()).toBe("warming");
  });

  it("off: a model change during a draft loads nothing either", () => {
    const h = harness(false);
    h.controller.draftChanged("Hi");
    h.controller.modelSwitched("org/model-b:Q4_0");
    expect(h.calls).toEqual([]);
  });
});

describe("the chat composer", () => {
  const chat = readFileSync("src/renderer/Chat.tsx", "utf8");
  it("reads the setting, waits for the same warm-up before the chat request, and offers Retry", () => {
    expect(chat).toMatch(/isEnabled: \(\) => readBool\(settingsRef\.current, "warmUpWhileTyping"\)/);
    const send = chat.indexOf("const send = async");
    const wait = chat.indexOf("await preloadController.settled(", send);
    const request = chat.indexOf("await api().chat(", send);
    expect(wait).toBeGreaterThan(send);
    expect(wait).toBeLessThan(request);
    expect(chat).toMatch(/preloadController\.retry\(\)/);
    // a keydown no longer starts a load by itself (a space did): the first real character does, through draftChanged
    expect(chat).not.toMatch(/triggerPreload\(\);/);
  });
});
