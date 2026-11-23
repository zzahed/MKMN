// @vitest-environment jsdom
/**
 * Files the assistant writes open in the panel beside the chat by default. The
 * "Files beside the chat" switch turns that off: nothing opens on its own, and a
 * file card opens the Files page instead of the side panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";
import type { ChatEvent } from "../src/shared/types";

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
const PAGE = '<artifact title="page.html" type="html"><!doctype html><html><body><h1>Hello</h1></body></html></artifact>';

function boot(settingsPatch: Record<string, unknown> = {}) {
  const chatCalls: { id: string }[] = [];
  const chatListeners: ((e: ChatEvent) => void)[] = [];
  const apiSettings = {
    selectedModelId: "m1", effort: "auto", subagents: false, developer: false, showKQuants: false,
    appearance: "dark", closeAction: "quit", closeNoticeOff: false,
    computeMode: "auto", compute: "npu", idleReleaseSec: 0, keepaliveSec: 0, startupTimeoutSec: 90,
    nctxMode: "auto", kvType: "auto", npuBudgetOverrideGB: null,
    braveKey: "", searchProvider: "brave", searxngUrl: "",
    voice: { sttModelId: null, ttsModelId: null, ttsSid: 0, sttCompute: "cpu", ttsCompute: "cpu", sttLanguage: "", autoSend: false, readAloud: false },
    ...settingsPatch,
  };
  const api: Record<string, any> = {
    appInfo: async () => ({ version: "0.0.1", arch: "arm64", platform: "win32", geniexPath: null, geniexVersion: null, geniexVersionWarning: null, problems: [] }),
    hardware: async () => ({ chipName: "Snapdragon X Elite", chipFamily: "x1", isSnapdragon: true, ramGB: 32, npuDetected: true, npuDriverVersion: "1.0", npuBudgetGB: 20, npuBudgetSource: "measured", cpuThreads: 12 }),
    settings: async () => ({ ...apiSettings }),
    server: async () => ({ ...SERVER }),
    voiceStatus: async () => ({ worker: "off", stt: null, tts: null, sttProvider: null, ttsProvider: null, notice: null, ttsSampleRate: null, error: null }),
    projects: async () => [],
    artifacts: async () => [],
    tasks: async () => [],
    setupState: async () => ({ active: false }),
    conversations: async () => [],
    catalog: async () => CATALOG,
    meters: async () => null,
    saveConversations: async () => undefined,
    saveSettings: async (p: any) => ({ ...apiSettings, ...p }),
    selectModel: async () => undefined,
    saveMedia: async () => ({ mediaId: "m1" }),
    saveArtifact: async () => [],
    dynamicInfo: async () => ({ data: {}, speeds: {}, profile: "16", autoProfile: "16", installedRefs: [], runsOn: {}, engines: {}, missing: {} }),
    modelEvidence: async () => ({ manifest: [], records: [] }),
    routerFileKind: async () => undefined,
    chat: async (id: string) => { chatCalls.push({ id }); },
    onChat: (cb: (e: ChatEvent) => void) => { chatListeners.push(cb); return () => {}; },
  };
  (window as any).mkmn = new Proxy(api, {
    get: (t, p) => (p in t ? t[p as string] : (p as string).startsWith("on") ? () => () => {} : () => Promise.resolve(undefined)),
  });
  window.localStorage.setItem("opennpu.conversations", JSON.stringify([
    { id: "c1", title: "Chat one", updated: 10, turns: [{ role: "assistant", content: `Here is the page.\n${PAGE}` }] },
  ]));
  render(createElement(App));
  return { chatCalls, chatListeners };
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

describe("files beside the chat", () => {
  it("opens a file card in the side panel by default", async () => {
    boot();
    await openChat();
    fireEvent.click(screen.getByText("page.html"));
    await waitFor(() => expect(document.querySelector(".artifact-panel")).toBeTruthy());
  });

  it("opens the Files page from a file card when the switch is off", async () => {
    boot({ openFilesBesideChat: false });
    await openChat();
    fireEvent.click(screen.getByText("page.html"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Files" })).toBeTruthy());
    expect(document.querySelector(".artifact-panel")).toBeNull();
  });

  it("does not open the side panel while a file is written when the switch is off", async () => {
    const { chatCalls, chatListeners } = boot({ openFilesBesideChat: false });
    const ta = await openChat();
    fireEvent.change(ta, { target: { value: "write me a page" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 }); });
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    await act(async () => {
      chatListeners[0]({ id: chatCalls[0].id, type: "answer", text: PAGE } as ChatEvent);
    });
    expect((await screen.findAllByText("page.html")).length).toBeGreaterThan(0);
    expect(document.querySelector(".artifact-panel")).toBeNull();
  });

  it("still opens the side panel while a file is written by default", async () => {
    const { chatCalls, chatListeners } = boot();
    const ta = await openChat();
    fireEvent.change(ta, { target: { value: "write me a page" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 }); });
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    await act(async () => {
      chatListeners[0]({ id: chatCalls[0].id, type: "answer", text: PAGE } as ChatEvent);
    });
    await waitFor(() => expect(document.querySelector(".artifact-panel")).toBeTruthy());
  });
});
