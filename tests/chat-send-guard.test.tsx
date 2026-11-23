// @vitest-environment jsdom
/**
 * Two Enter presses are one request, and a router question that never answers cannot swallow
 * the message (seen on an installed build). `send` awaited `routerFileKind` before it cleared the input or
 * raised the busy state: the composer still showed the text and the Send button, so a second
 * Enter started a second chat. A pending router call also hid the Stop button, so the only
 * visible action was to type again. The guard must be synchronous (a ref, not React state),
 * the router call bounded, and Stop must cancel a request that has not reached the chat yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";
import type { ChatEvent, Turn } from "../src/shared/types";

const CATALOG = [{
  entry: { id: "m1", name: "Qwen3 1.7B", repo: "q/repo", quant: "W4A16", engine: "qairt", role: "chat", architecture: "Qwen3", sizeGB: 1.2, recommendedContext: 4096, sampling: { max_tokens: 2048 } },
  ref: "q/repo:W4A16", installed: true, hidden: false, custom: false,
  verdict: { estNpuGB: 1.2, contextTokens: 4096 },
}];
const SERVER = {
  state: "ready", endpoint: "http://127.0.0.1:18181/v1", nctx: 4096, compute: "npu",
  restarts: 0, lastError: null, pid: 42, model: "q/repo:W4A16",
  hardwareVerification: { verifiedNpu: true, cpuFallbackDetected: false, executionTarget: "npu" },
};
const API_SETTINGS = {
  selectedModelId: "m1", effort: "auto", subagents: false, developer: false, showKQuants: false,
  appearance: "dark", closeAction: "quit", closeNoticeOff: false,
  computeMode: "auto", compute: "npu", idleReleaseSec: 0, keepaliveSec: 0, startupTimeoutSec: 90,
  nctxMode: "auto", kvType: "auto", npuBudgetOverrideGB: null,
  braveKey: "", searchProvider: "brave", searxngUrl: "",
  voice: { sttModelId: null, ttsModelId: null, ttsSid: 0, sttCompute: "cpu", ttsCompute: "cpu", sttLanguage: "", autoSend: false, readAloud: false },
};

interface RouterGate {
  promise: Promise<string | null | undefined>;
  resolve(value: string | null | undefined): void;
  reject(error: Error): void;
}

function gate(): RouterGate {
  let resolve!: (value: string | null | undefined) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null | undefined>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function boot(chatCalls: { id: string; modelId?: string }[], chatEvents: { id: string; event: ChatEvent }[], router: () => Promise<string | null | undefined>, cloud = false, rejectSave = false, turns: Turn[] = [{ role: "user", content: "hello" }]) {
  const api: Record<string, any> = {
    appInfo: async () => ({ version: "0.0.1", arch: "arm64", platform: "win32", geniexPath: null, geniexVersion: null, geniexVersionWarning: null, problems: [] }),
    hardware: async () => ({ chipName: "Snapdragon X Elite", chipFamily: "x1", isSnapdragon: true, ramGB: 32, npuDetected: true, npuDriverVersion: "1.0", npuBudgetGB: 20, npuBudgetSource: "measured", cpuThreads: 12 }),
    settings: async () => ({ ...API_SETTINGS, ...(cloud ? { selectedModelId: null, humainMode: "node" } : {}) }),
    server: async () => ({ ...SERVER }),
    voiceModels: async () => [],
    voiceStatus: async () => ({ worker: "off", stt: null, tts: null, sttProvider: null, ttsProvider: null, notice: null, ttsSampleRate: null, error: null }),
    projects: async () => [],
    artifacts: async () => [],
    tasks: async () => [],
    setupState: async () => ({ active: false }),
    conversations: async () => [],
    catalog: async () => cloud ? [] : CATALOG,
    meters: async () => null,
    saveConversations: async () => undefined,
    saveSettings: async (p: any) => {
      if (rejectSave) throw new Error("Could not write settings");
      return { ...API_SETTINGS, ...p };
    },
    selectModel: async () => undefined,
    saveMedia: async () => ({ mediaId: "m1" }),
    dynamicInfo: async () => ({ data: {}, speeds: {}, profile: "16", autoProfile: "16", installedRefs: [], runsOn: {}, engines: {}, missing: {} }),
    modelEvidence: async () => ({ manifest: [], records: [] }),
    routerFileKind: (_text: string) => router(),
    chat: async (id: string, modelId: string) => { chatCalls.push({ id, modelId }); },
    onChat: (cb: (e: ChatEvent) => void) => { chatEvents.push({ id: "", event: cb as any }); return () => {}; },
  };
  (window as any).mkmn = new Proxy(api, {
    get: (t, p) => (p in t ? t[p as string] : (p as string).startsWith("on") ? () => () => {} : () => Promise.resolve(undefined)),
  });
  window.localStorage.setItem("opennpu.conversations", JSON.stringify([
    { id: "c1", title: "Chat one", updated: 10, turns },
  ]));
  return render(createElement(App));
}

async function openChat(): Promise<HTMLTextAreaElement> {
  fireEvent.click(await screen.findByText("Chat one"));
  return (await waitFor(() => document.querySelector("textarea[aria-label='Message']"))) as HTMLTextAreaElement;
}

beforeEach(() => {
  (window as any).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (window as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("connects cloud setup, chat location, and the local model library", async () => {
  boot([], [], async () => null);
  fireEvent.click(await screen.findByRole("button", { name: "Settings", exact: true }));
  const dialog = within(await screen.findByRole("dialog", { name: "Settings" }));
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  fireEvent.change(search, { target: { value: "chat provider" } });
  fireEvent.keyDown(search, { key: "Enter" });
  const location = dialog.getByRole<HTMLSelectElement>("combobox", { name: "Chat location" });
  expect(location.value).toBe("local");
  fireEvent.change(location, { target: { value: "node" } });
  await waitFor(() => expect(location.value).toBe("node"));
  fireEvent.click(dialog.getByRole("button", { name: "Set up a cloud provider" }));
  expect(dialog.getByText(/Current chat location: HUMAIN Node/)).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Change chat location" }));
  fireEvent.click(dialog.getByRole("button", { name: "Manage local models" }));
  expect(dialog.getByText(/Chat is using a cloud provider/)).toBeTruthy();
});

it("disables the Settings chat location while a reply is in progress", async () => {
  const router = gate();
  boot([], [], () => router.promise);
  const message = await openChat();
  fireEvent.change(message, { target: { value: "Write a short program" } });
  fireEvent.keyDown(message, { key: "Enter", keyCode: 13 });
  await screen.findByRole("button", { name: "Stop" });
  fireEvent.click(screen.getByRole("button", { name: "Settings", exact: true }));
  const dialog = within(await screen.findByRole("dialog", { name: "Settings" }));
  fireEvent.click(dialog.getByRole("button", { name: "Chats & answers" }));
  expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: "Chat location" }).disabled).toBe(true);
});

describe("one message, one request", () => {
  it("explains high estimated context with a large PDF and no eligible history", async () => {
    const content = Array.from({ length: 40 }, (_, i) => `[page ${i + 1}]\n${"Background and records for this planning topic. ".repeat(100)}`).join("\n");
    boot([], [], async () => null, false, false, [
      { role: "user", content: "Tell me about the planning topic", attachments: [{ name: "report.pdf", kind: "text", size: content.length, text: content }] },
      { role: "assistant", content: "This is the recent exchange." },
      { role: "user", content: "Read this. " + "Additional background about the planning priorities. ".repeat(46) },
    ]);
    await openChat();
    const ring = await screen.findByRole("button", { name: /Context ([789]\d|100)% full/ });
    fireEvent.click(ring);
    const context = within(screen.getByRole("dialog", { name: "Context breakdown" }));
    expect(context.getByRole<HTMLButtonElement>("button", { name: /compact/i }).disabled).toBe(true);
    expect(context.getByText(/Compacting cannot reduce documents/)).toBeTruthy();
  });

  it("retries a terminal failure once and releases the composer when Stop cannot reach the chat", async () => {
    const calls: { id: string }[] = [];
    const events: { id: string; event: ChatEvent }[] = [];
    boot(calls, events, async () => null);
    const ta = await openChat();
    const emit = (event: ChatEvent) => act(() => { for (const sub of events) (sub.event as unknown as (ev: ChatEvent) => void)(event); });
    fireEvent.change(ta, { target: { value: "Explain the result" } });
    fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(calls).toHaveLength(1));
    const error = { id: "model-server-lost", title: "The model server stopped", fix: "Try again.", raw: "Connection closed" };
    emit({ id: calls[0].id, type: "error", error });
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(calls).toHaveLength(2));
    (window as any).mkmn.abortChat = async () => { throw new Error("Sidecar disconnected"); };
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Couldn't confirm the response stopped.", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    emit({ id: calls[1].id, type: "answer", text: "Late reply" });
    expect(screen.queryByText("Late reply")).toBeNull();
    expect(screen.getAllByText("Explain the result")).toHaveLength(1);
  });
  it("a second Enter while the file question is pending does not send the same message twice", async () => {
    const calls: { id: string }[] = [];
    const events: { id: string; event: ChatEvent }[] = [];
    const router = gate();
    boot(calls, events, () => router.promise);
    const ta = await openChat();
    fireEvent.change(ta, { target: { value: "write me a python program that prints hello world" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 });
      fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 });
    });
    // The question is still open: no request has gone out, but the composer is already busy.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(calls).toHaveLength(0);
    await act(async () => { router.resolve(undefined); });
    await waitFor(() => expect(calls).toHaveLength(1));
    // Give a duplicate send all the time it needs to surface.
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(calls).toHaveLength(1);
  });

  it("Stop cancels a message whose file question has not answered yet", async () => {
    const calls: { id: string }[] = [];
    const events: { id: string; event: ChatEvent }[] = [];
    const router = gate();
    boot(calls, events, () => router.promise);
    const ta = await openChat();
    fireEvent.change(ta, { target: { value: "write me a python program that prints hello world" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 }); });
    const stop = await screen.findByRole("button", { name: "Stop" });
    await act(async () => { fireEvent.click(stop); });
    await act(async () => { router.resolve(undefined); });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("a router that never answers is bounded: the message is sent with no file answer", async () => {
    const calls: { id: string }[] = [];
    const events: { id: string; event: ChatEvent }[] = [];
    boot(calls, events, () => new Promise(() => {}));
    const ta = await openChat();
    fireEvent.change(ta, { target: { value: "write me a python program that prints hello world" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 }); });
    await waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000 });
  });

  it("a refused file question still sends the message", async () => {
    const calls: { id: string }[] = [];
    const events: { id: string; event: ChatEvent }[] = [];
    boot(calls, events, () => Promise.reject(new Error("router is not installed")));
    const ta = await openChat();
    fireEvent.change(ta, { target: { value: "write me a python program that prints hello world" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 }); });
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});

it("sends a HUMAIN chat without an installed local model or a local router call", async () => {
  const calls: { id: string; modelId?: string }[] = [];
  const events: { id: string; event: ChatEvent }[] = [];
  const router = vi.fn(async () => undefined);
  boot(calls, events, router, true);
  const input = await openChat();
  fireEvent.change(input, { target: { value: "Write a short program" } });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
  await waitFor(() => expect(calls).toEqual([{ id: expect.any(String), modelId: "humain:chat" }]));
  expect(router).not.toHaveBeenCalled();
});
it("switches between local and cloud from the main chat window", async () => {
  boot([], [], async () => undefined);
  await openChat();
  expect(screen.queryByRole("combobox", { name: "Chat location" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /On-device AI/i }));
  const location = screen.getByRole("combobox", { name: "Chat location" }) as HTMLSelectElement;
  expect(location.value).toBe("local");
  fireEvent.change(location, { target: { value: "fuse" } });
  await waitFor(() => expect(location.value).toBe("fuse"));
  expect(screen.getByRole("region", { name: "HUMAIN Fuse status" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "HUMAIN API keys" })).toBeTruthy();
  fireEvent.change(location, { target: { value: "local" } });
  await waitFor(() => expect(location.value).toBe("local"));
  expect(screen.getByRole("button", { name: /Qwen3 1.7B/ })).toBeTruthy();
});

it("keeps local chat selected and reports a failed routing save", async () => {
  boot([], [], async () => undefined, false, true);
  await openChat();
  expect(screen.queryByRole("combobox", { name: "Chat location" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /On-device AI/i }));
  const location = screen.getByRole("combobox", { name: "Chat location" }) as HTMLSelectElement;
  fireEvent.change(location, { target: { value: "fuse" } });
  await screen.findByText("Couldn't save the chat location. Try again.");
  expect(location.value).toBe("local");
  expect(location.disabled).toBe(false);
});
