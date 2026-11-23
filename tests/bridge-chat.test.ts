import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatEvent, ChatMessage } from "../src/shared/types";

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
 * Contract tests of the chat bridge (src/renderer/tauriBridge.ts, createTauriApi().chat):
 * the orchestrator runs in the Node sidecar — the bridge fires the `chat` call, streams the
 * `chat` sidecar events to the onChat listeners, keeps the machine awake from the call until
 * the turn's terminal event, and hands the project's folder over with the request. The model
 * server is never started here: that is the Rust host's job, on the orchestrator's ask
 * (the `startChatServer` host capability).
 */

/** The sidecar-event handler the bridge subscribed to (captured from the listen mock). */
let eventHandler: ((e: { payload: { name: string; payload: unknown } }) => void) | null = null;

/** A localStorage stand-in (getLocalJson falls back gracefully when there is none). */
function localStorageStub(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; }
  } as unknown as Storage;
}

beforeEach(async () => {
  const core = await import("@tauri-apps/api/core");
  (core.invoke as unknown as ReturnType<typeof vi.fn>).mockReset();
  const ev = await import("@tauri-apps/api/event");
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockReset();
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_name: string, handler: typeof eventHandler) => {
    eventHandler = handler;
    return () => {};
  });
  vi.stubGlobal("localStorage", localStorageStub());
});

async function api() {
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  const a = createTauriApi();
  await new Promise((r) => setTimeout(r, 0)); // let the listen() promise settle
  return a;
}

/** The sidecar_call mock: answers by method name, records every call. */
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

/** A sidecar `chat` event, the way the Rust host re-emits it to the webview. */
const emitChat = (ev: ChatEvent) => eventHandler?.({ payload: { name: "chat", payload: ev } });

const DONE = (id: string): ChatEvent => ({ id, type: "done", stats: { tokens: 3, tokPerSec: 9, ttftSec: 0.1, totalSec: 1, finish: "stop", prepSec: null, answerSec: null, prep: [] } });
const MSGS: ChatMessage[] = [{ role: "user", content: "Say hello." }];

describe("chat bridge contract (real createTauriApi, sidecar calls and events intercepted)", () => {
  it("chat asks the sidecar (never starting a server itself), inhibits sleep, and the turn's done releases it", async () => {
    const invoke = await mockSidecar({ chat: () => undefined });
    const a = await api();
    await expect(a.chat("c1", "qwen3-1.7b-native", MSGS, { effort: null, subagents: false })).resolves.toBeUndefined();

    // the Dynamic ref travels unchanged: the sidecar's orchestrator resolves the team
    const chatCall = invoke.mock.calls.find((c) => c[0] === "sidecar_call" && c[1].method === "chat");
    expect(chatCall[1].args[0]).toBe("c1");
    expect(chatCall[1].args[1]).toBe("qwen3-1.7b-native");
    expect(chatCall[1].args[2]).toEqual(MSGS);
    // the bridge never starts the model server itself any more
    expect(invoke.mock.calls.filter((c) => c[0] === "start_server")).toHaveLength(0);

    const inhibits = invoke.mock.calls.filter((c) => c[0] === "inhibit_sleep");
    expect(inhibits).toEqual([["inhibit_sleep", { enable: true }]]);

    // the sidecar's terminal done releases the sleep-inhibit
    emitChat(DONE("c1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke.mock.calls.filter((c) => c[0] === "inhibit_sleep")).toHaveLength(2);
    expect(invoke.mock.calls.at(-1)).toEqual(["inhibit_sleep", { enable: false }]);
  });

  it("the project's folder travels with the request (the project store lives in the webview)", async () => {
    const invoke = await mockSidecar({ chat: () => undefined });
    const a = await api();
    localStorage.setItem("mkmn.projects", JSON.stringify([{ id: "p1", name: "Demo", folder: "C:\\proj" }]));
    await a.chat("c2", "lfm2.5-8b-a1b", MSGS, { effort: null, subagents: false, projectId: "p1" });
    const chatCall = invoke.mock.calls.find((c) => c[0] === "sidecar_call" && c[1].method === "chat");
    expect(chatCall[1].args[3]).toMatchObject({ projectId: "p1", projectFolder: "C:\\proj" });
  });

  it("a chat without a project passes no folder", async () => {
    const invoke = await mockSidecar({ chat: () => undefined });
    const a = await api();
    await a.chat("c3", "lfm2.5-8b-a1b", MSGS, { effort: null, subagents: false });
    const chatCall = invoke.mock.calls.find((c) => c[0] === "sidecar_call" && c[1].method === "chat");
    expect(chatCall[1].args[3].projectFolder).toBeNull();
  });

  it("a sidecar that cannot be reached ends the turn: a terminal error event, and sleep released", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === "sidecar_call") throw new Error("sidecar is not running");
      if (cmd === "inhibit_sleep") return undefined;
      throw new Error(`unexpected command ${cmd}`);
    });
    const { createTauriApi } = await import("../src/renderer/tauriBridge");
    const a = createTauriApi();
    await new Promise((r) => setTimeout(r, 0));
    const events: ChatEvent[] = [];
    const off = a.onChat((e) => events.push(e));
    await expect(a.chat("c4", "lfm2.5-8b-a1b", MSGS, { effort: null, subagents: false })).resolves.toBeUndefined();
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect((errs[0] as { error: { id: string } }).error.id).toBe("chat-init-error");
    expect(invoke.mock.calls.filter((c) => c[0] === "inhibit_sleep" && c[1].enable === false)).toHaveLength(1);
    off();
  });

  it("the sidecar's chat events stream to the onChat listeners in order", async () => {
    await mockSidecar({ chat: () => undefined });
    const a = await api();
    const events: ChatEvent[] = [];
    const off = a.onChat((e) => events.push(e));
    emitChat({ id: "c5", type: "notice", text: "Dynamic M · chat → Qwen3-1.7B" });
    emitChat({ id: "c5", type: "answer", text: "Hello" } as ChatEvent);
    emitChat(DONE("c5"));
    expect(events.map((e) => e.type)).toEqual(["notice", "answer", "done"]);
    off();
  });

  it("abortChat, skipStep, compactChat and fixBlock name their sidecar methods and pass the arguments through", async () => {
    const invoke = await mockSidecar({
      abortChat: () => undefined,
      skipStep: () => undefined,
      compactChat: () => ({ text: "summary", turns: 2 }),
      fixBlock: () => "{}"
    });
    const a = await api();
    await a.abortChat("c9");
    await a.skipStep("c9", true);
    await expect(a.compactChat("c9", "lfm2.5-8b-a1b", MSGS, 2, "conversation-9")).resolves.toEqual({ text: "summary", turns: 2 });
    await expect(a.fixBlock("chart", "{}", "bad JSON")).resolves.toBe("{}");
    const methods = invoke.mock.calls.filter((c) => c[0] === "sidecar_call").map((c) => c[1].method);
    expect(methods).toEqual(["abortChat", "skipStep", "compactChat", "fixBlock"]);
    expect(invoke.mock.calls.find((c) => c[1].method === "skipStep")[1].args).toEqual(["c9", true]);
    expect(invoke.mock.calls.find((c) => c[1].method === "compactChat")[1].args).toEqual(["c9", "lfm2.5-8b-a1b", MSGS, 2, "conversation-9"]);
    expect(invoke.mock.calls.find((c) => c[1].method === "fixBlock")[1].args).toEqual(["chart", "{}", "bad JSON"]);
  });

  it("orders a concurrent Stop after sidecar chat registration", async () => {
    let release!: () => void;
    const sleepGate = new Promise<void>((resolve) => { release = resolve; });
    const methods: string[] = [];
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "inhibit_sleep" && args?.enable) await sleepGate;
      if (cmd === "sidecar_call") methods.push(String(args?.method));
      return undefined as never;
    });
    const a = await api();
    const started = a.chat("startup-stop", "m1", MSGS, { effort: null, subagents: false });
    const stopped = a.abortChat("startup-stop");
    await Promise.resolve();
    expect(methods).toEqual([]);
    release();
    await Promise.all([started, stopped]);
    expect(methods).toEqual(["chat", "abortChat"]);
    emitChat(DONE("startup-stop"));
  });

  it("an abort with no answer running still resolves (the sidecar answers, nothing is emitted locally)", async () => {
    const invoke = await mockSidecar({ abortChat: () => undefined });
    const a = await api();
    const events: ChatEvent[] = [];
    const off = a.onChat((e) => events.push(e));
    await expect(a.abortChat("nothing")).resolves.toBeUndefined();
    expect(events).toHaveLength(0); // no local done: the sidecar owns the turn
    expect(invoke.mock.calls.some((c) => c[1]?.method === "abortChat")).toBe(true);
    off();
  });
});
