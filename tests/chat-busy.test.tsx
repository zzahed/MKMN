// @vitest-environment jsdom
/**
 * Renderer half of the terminal-event contract (Round 3, problem 1): the events the REAL
 * chat orchestrator emits for an oversized request — notices plus one terminal `error`,
 * never a bare stop — are fed through the bridge exactly as the sidecar would stream them.
 * The chat must clear its busy state, show the failure on the turn, and let the person
 * send another message right away. Before the fix the orchestrator stopped on a notice
 * alone, and these events left the composer stuck on Stop with sending locked out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import type { CatalogEntry, ChatEvent, HardwareProfile, Settings } from "../src/shared/types";

// ------------------------------------------------------------------ orchestrator side (the same fake host the core tests use)

const ENTRY: CatalogEntry = {
  id: "test-1b", name: "Test 1B", repo: "org/test-1b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};
const HW: HardwareProfile = { chipName: "Test Chip", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8 };
const SETTINGS: Settings = { selectedModelId: "test-1b", webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false } as unknown as Settings;

const sse = (chunks: object[]): Response => {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]", ""];
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); }
  }), { status: 200 });
};
const DELTA = (content: string) => ({ choices: [{ delta: { content } }] });
const STOP = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } };

function fakeHost(events: ChatEvent[]): ChatHost {
  return {
    settings: () => SETTINGS,
    patchSettings: () => {},
    allEntries: () => [ENTRY],
    entryById: (id) => (id === ENTRY.id ? ENTRY : undefined),
    installedEntries: async () => [ENTRY],
    chatHardware: async () => HW,
    lastLoaded: () => null,
    setLastLoaded: () => {},
    benchRunning: () => false,
    ensureServer: async (): Promise<Served> => ({ endpoint: "http://127.0.0.1:9/v1", status: () => ({ nctx: null }) }),
    servedName: (e) => `${e.repo}:${e.quant}`,
    send: (ev) => events.push(ev),
    recordSpeed: () => {},
    runSearch: async () => ({ text: "", display: "", sources: 0 }),
    searchImages: async () => ({ text: "", display: "", files: [] }),
    commonsJson: async () => ({}),
    wikiPicture: async () => null,
    folderOf: () => null,
    figure: async () => null,
    renderSlide: async () => ({ problems: [] }),
    lookAtShot: async () => null,
    checkArtifact: async () => ({ ran: "none", errors: [] })
  };
}

/** The events a real oversized turn produces: the oversized question must never be
    dispatched to inference (the small intent-classification call is fine — it is
    truncated), and the stream must end with exactly one terminal event. */
async function oversizedTurnEvents(): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: any) => {
    bodies.push(String(init?.body ?? ""));
    return sse([DELTA("yes"), STOP]);
  }));
  const oversized = `Please answer this: ${"content ".repeat(3000)}`; // far beyond the model's window
  await runChatOrchestrator(fakeHost(events), "gen", ENTRY.id, [{ role: "user", content: oversized }], { effort: null, subagents: false });
  for (const b of bodies) expect(b.length, "no inference request may carry the oversized content").toBeLessThan(oversized.length / 4);
  expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("error"); // the terminal event the UI clears busy on (the run view trails it)
  return events;
}

// ------------------------------------------------------------------ renderer side (the real App against a stubbed bridge)

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

function boot(chatCalls: { id: string }[], chatEvents: ChatEvent[], over?: { catalog?: typeof CATALOG; server?: Partial<typeof SERVER> }) {
  const api: Record<string, any> = {
    appInfo: async () => ({ version: "0.0.1", arch: "arm64", platform: "win32", geniexPath: null, geniexVersion: null, geniexVersionWarning: null, problems: [] }),
    hardware: async () => ({ chipName: "Snapdragon X Elite", chipFamily: "x1", isSnapdragon: true, ramGB: 32, npuDetected: true, npuDriverVersion: "1.0", npuBudgetGB: 20, npuBudgetSource: "measured", cpuThreads: 12 }),
    settings: async () => ({ ...API_SETTINGS }),
    server: async () => ({ ...SERVER, ...(over?.server ?? {}) }),
    voiceStatus: async () => ({ worker: "off", stt: null, tts: null, sttProvider: null, ttsProvider: null, notice: null, ttsSampleRate: null, error: null }),
    projects: async () => [],
    artifacts: async () => [],
    tasks: async () => [],
    setupState: async () => ({ active: false }),
    conversations: async () => [],
    catalog: async () => over?.catalog ?? CATALOG,
    meters: async () => null,
    saveConversations: async () => undefined,
    saveSettings: async (p: any) => ({ ...API_SETTINGS, ...p }),
    selectModel: async () => undefined,
    saveMedia: async () => ({ mediaId: "m1" }),
    dynamicInfo: async () => ({ data: {}, speeds: {}, profile: "16", autoProfile: "16", installedRefs: [], runsOn: {}, engines: {}, missing: {} }),
    modelEvidence: async () => ({ manifest: [], records: [] }),
    // the turn's request and the event stream it is answered with
    chat: async (id: string) => { chatCalls.push({ id }); },
    onChat: (cb: (e: ChatEvent) => void) => { chatEvents.push(cb); return () => {}; },
  };
  (window as any).mkmn = new Proxy(api, {
    get: (t, p) => (p in t ? t[p as string] : (p as string).startsWith("on") ? () => () => {} : () => Promise.resolve(undefined)),
  });
  window.localStorage.setItem("opennpu.conversations", JSON.stringify([
    { id: "c1", title: "Chat one", updated: 10, turns: [{ role: "user", content: "hello" }] },
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an oversized request leaves the chat usable (renderer, real orchestrator events)", () => {
  it("the terminal error clears busy: Stop goes away and the next message is sent", async () => {
    const events = await oversizedTurnEvents();
    const chatCalls: { id: string }[] = [];
    const sinks: ((e: ChatEvent) => void)[] = [];
    boot(chatCalls, sinks);
    // open the seeded chat
    fireEvent.click(await screen.findByText("Chat one"));
    const ta = (await waitFor(() => document.querySelector("textarea[aria-label='Message']"))) as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    // the first (oversized) message goes out
    fireEvent.change(ta, { target: { value: "Summarize the attached report in full." } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 }); });
    await waitFor(() => expect(chatCalls.length).toBe(1));
    // while it runs the composer shows Stop and refuses a second send
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    // the orchestrator's events arrive exactly as the sidecar would stream them: notices, then ONE error
    const id = chatCalls[0].id;
    for (const ev of events) await act(async () => { sinks.forEach((cb) => cb({ ...ev, id })); });
    // busy is cleared: no Stop button, and the failure is on the turn
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.queryByText(/Answer finished/)).toBeNull();
    const errText = (events.filter((e) => e.type !== "run").at(-1) as { error: { title: string } }).error.title; // the terminal error event (the run view trails it)
    expect(await screen.findByText(errText)).toBeTruthy();
    // the person can immediately send another message
    const ta2 = document.querySelector("textarea[aria-label='Message']") as HTMLTextAreaElement;
    fireEvent.change(ta2, { target: { value: "Thanks — now just the headline." } });
    await act(async () => { fireEvent.keyDown(ta2, { key: "Enter", keyCode: 13 }); });
    await waitFor(() => expect(chatCalls.length).toBe(2)); // a second request goes out right away
  });
});

describe("the context meter is sized by the artifact's real limit, not the 4096 fallback", () => {
  it("the Effective context row shows the catalog verdict's 2048 when no server serves the selection", async () => {
    // the installed bundle compiled to 2048 (its evidence reached the verdict over the IPC);
    // the server status left over names ANOTHER model, so it must not size the meter
    const catalog = CATALOG.map((i) => ({ ...i, verdict: { ...i.verdict, contextTokens: 2048 } }));
    boot([], [], { catalog, server: { model: "other/model:Q4_0" } });
    fireEvent.click(await screen.findByText("Chat one"));
    fireEvent.click(await screen.findByRole("button", { name: /show breakdown/ }));
    const row = (await screen.findByText("Effective context")).closest(".ctx-line");
    expect(row?.textContent).toContain("2,048"); // the measured artifact window
    expect(row?.textContent).not.toContain("4,096"); // never the fallback estimate
  });
});
