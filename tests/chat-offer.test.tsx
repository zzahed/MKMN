// @vitest-environment jsdom
/**
 * When the build votes split (the router says no or does not answer, the chat
 * model says yes), the request is answered in the chat and ONE action is offered under
 * the answer, "Build it instead". Clicking it sends the SAME request through the build
 * path — the chat call carries `buildWanted`, and the click is the yes (no vote is
 * asked again). This pins the renderer half: the offer renders from the turn, and the
 * click reaches the chat API with the request and the flag.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";
import type { ChatEvent, ChatMessage } from "../src/shared/types";

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

const OFFER_REQUEST = "where is the spare key?";

function boot(chatCalls: { id: string; messages: ChatMessage[]; opts: Record<string, unknown> }[]) {
  const api: Record<string, any> = {
    appInfo: async () => ({ version: "0.0.1", arch: "arm64", platform: "win32", geniexPath: null, geniexVersion: null, geniexVersionWarning: null, problems: [] }),
    hardware: async () => ({ chipName: "Snapdragon X Elite", chipFamily: "x1", isSnapdragon: true, ramGB: 32, npuDetected: true, npuDriverVersion: "1.0", npuBudgetGB: 20, npuBudgetSource: "measured", cpuThreads: 12 }),
    settings: async () => ({ ...API_SETTINGS }),
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
    saveSettings: async (p: any) => ({ ...API_SETTINGS, ...p }),
    selectModel: async () => undefined,
    dynamicInfo: async () => ({ data: {}, speeds: {}, profile: "16", autoProfile: "16", installedRefs: [], runsOn: {}, engines: {}, missing: {} }),
    modelEvidence: async () => ({ manifest: [], records: [] }),
    routerFileKind: async () => undefined,
    chat: async (id: string, _modelId: string, messages: ChatMessage[], opts: Record<string, unknown>) => { chatCalls.push({ id, messages, opts }); },
    onChat: (_cb: (e: ChatEvent) => void) => () => {},
  };
  (window as any).mkmn = new Proxy(api, {
    get: (t, p) => (p in t ? t[p as string] : (p as string).startsWith("on") ? () => () => {} : () => Promise.resolve(undefined)),
  });
  window.localStorage.setItem("opennpu.conversations", JSON.stringify([
    {
      id: "c1", title: "Chat one", updated: 10,
      turns: [
        { role: "user", content: OFFER_REQUEST },
        // the split-vote answer: answered in the chat, with the build offered under it
        { role: "assistant", content: "The spare key to the reading room is kept in drawer C-12, by the front desk.", offer: { action: "build", request: OFFER_REQUEST } },
      ],
    },
  ]));
  return render(createElement(App));
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
});

describe("the offered build action", () => {
  it("clicking 'Build it instead' sends the same request through the build path (buildWanted)", async () => {
    const chatCalls: { id: string; messages: ChatMessage[]; opts: Record<string, unknown> }[] = [];
    boot(chatCalls);
    fireEvent.click(await screen.findByText("Chat one"));
    const button = await screen.findByRole("button", { name: "Build it instead" });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    const call = chatCalls[0];
    expect(call.opts.buildWanted).toBe(true);
    const lastUser = [...call.messages].reverse().find((m) => m.role === "user");
    expect(typeof lastUser?.content === "string" && lastUser.content.includes(OFFER_REQUEST)).toBe(true);
  });
});
