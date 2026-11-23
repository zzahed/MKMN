// @vitest-environment jsdom
/**
 * The sub-agents bug: "hi friend" started six sub-agents and gave a strange
 * answer. A missing "subagents" setting was read as ON where the chat is sent and as OFF
 * in every menu, and the delegation instructions went out with every request, even a
 * greeting, so a small model reacted to them and invented tasks. Here: sub-agents are off
 * unless the person turned them on, every menu reads the same value the chat sends, and
 * the instructions go out (and <subagent> blocks run) only when a closed question says the
 * request needs them — never on a greeting, and never when no model answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { SUBAGENT_INSTRUCTIONS, WORKER_INSTRUCTIONS } from "../src/core/agents";
import { readJournal } from "../src/core/harness/journal";
import type { CatalogEntry, ChatEvent, HardwareProfile, Settings } from "../src/shared/types";

// ------------------------------------------------------------------ core side (the same fake host the core tests use)

const ENTRY: CatalogEntry = {
  id: "test-1b", name: "Test 1B", repo: "org/test-1b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};
const HW: HardwareProfile = { chipName: "Test Chip", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8 };
const SETTINGS: Settings = { selectedModelId: "test-1b", webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false } as unknown as Settings;
const COMMAND_SETTINGS: Settings = { ...SETTINGS, toolsOnCommand: true } as unknown as Settings;

const sse = (chunks: object[]): Response => {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]", ""];
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); }
  }), { status: 200 });
};
const DELTA = (content: string) => ({ choices: [{ delta: { content } }] });
const STOP = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } };

/** A host that answers everything from memory; the requests are read off the fetch mock. */
function fakeHost(events: ChatEvent[], settings = SETTINGS): ChatHost {
  return {
    settings: () => settings,
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

/** Is this completion one of the closed yes/no questions (the sub-agents gate among them)? */
const isQuestion = (init?: RequestInit): boolean => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const messages = body.messages as { content?: string }[];
  return Array.isArray(messages) && messages.some((m) => typeof m.content === "string" && m.content.startsWith("You answer yes/no questions"));
};

const bodiesOf = (fetchMock: { mock: { calls: unknown[] } }): string[] =>
  fetchMock.mock.calls.map((c) => String((c as [string, RequestInit])[1]?.body ?? ""));

/** The answer events as the turn wrote them. */
const answerOf = (events: ChatEvent[]): string =>
  events.filter((e) => e.type === "answer").map((e) => (e as { text: string }).text).join("");

async function run(opts: { subagents: boolean }, messages: { role: string; content: string }[], impl?: (init?: RequestInit) => Promise<Response>): Promise<{ events: ChatEvent[]; fetchMock: ReturnType<typeof vi.fn> }> {
  const events: ChatEvent[] = [];
  const fetchMock = vi.fn(impl ?? (async () => sse([DELTA("Plain answer."), STOP])));
  vi.stubGlobal("fetch", fetchMock);
  await runChatOrchestrator(fakeHost(events), "subagents", ENTRY.id, messages as never, opts as never);
  return { events, fetchMock };
}

describe("sub-agents are gated by the settings value and a closed question (core)", () => {
  it("with the option on, a greeting ('hi friend') gets no delegation instructions and <subagent> blocks in its answer do not run", async () => {
    const { events, fetchMock } = await run({ effort: null, subagents: true }, [{ role: "user", content: "hi friend" }],
      async (init?: RequestInit) => {
        if (isQuestion(init)) return sse([DELTA("no"), STOP]);
        return sse([DELTA("Hi friend! "), DELTA('<subagent name="a">do a thing</subagent>'), STOP]);
      });
    const bodies = bodiesOf(fetchMock);
    // the closed question WAS asked (the gate is a question, not the words) and answered no
    expect(bodies.some((b) => b.includes("You answer yes/no questions"))).toBe(true);
    // no request carries the delegation rules
    for (const b of bodies) expect(b.includes("You can delegate work to sub-agents")).toBe(false);
    // and the <subagent> block the model wrote anyway did not run: no agent event, no worker request
    expect(answerOf(events)).toContain("Hi friend!");
    expect(events.some((e) => e.type === "agent")).toBe(false);
    expect(bodies.some((b) => b.includes("You are a sub-agent."))).toBe(false);
  });

  it("with the option on, a multi-part job gets the instructions and its sub-agents run", async () => {
    const events: ChatEvent[] = [];
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const first = (body.messages as { content?: string }[])[0]?.content ?? "";
      if (first.startsWith("You answer yes/no questions")) return sse([DELTA("yes"), STOP]);
      if (first.startsWith("You are a sub-agent.")) return sse([DELTA("Found it."), STOP]);
      if ((body.messages as unknown[]).length > 2) return sse([DELTA("Here is everything, put together."), STOP]); // the round after the results
      return sse([DELTA('<subagent name="Research A">find A</subagent>'), DELTA('<subagent name="Research B">find B</subagent>'), STOP]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await runChatOrchestrator(fakeHost(events), "subagents", ENTRY.id, [{ role: "user", content: "Research A and B and compare them." } as never], { effort: null, subagents: true } as never);
    const bodies = bodiesOf(fetchMock);
    expect(bodies.some((b) => b.includes("You can delegate work to sub-agents"))).toBe(true);
    expect(bodies.some((b) => b.includes("You are a sub-agent."))).toBe(true);
    const agents = events.filter((e) => e.type === "agent").map((e) => (e as { agent: { name: string; status: string } }).agent);
    expect(agents.map((a) => a.name)).toContain("Research A");
    expect(agents.map((a) => a.name)).toContain("Research B");
    for (const name of ["Research A", "Research B"]) expect(agents.filter((a) => a.name === name).at(-1)?.status).toBe("done");
    expect(answerOf(events)).toContain("Here is everything, put together.");
  });

  it("with the option on and no model answering the question, sub-agents stay off", async () => {
    const { events, fetchMock } = await run({ effort: null, subagents: true }, [{ role: "user", content: "Research A and B and compare them." }],
      async (init?: RequestInit) => {
        if (isQuestion(init)) throw new Error("no model answered");
        return sse([DELTA("Plain answer."), STOP]);
      });
    const bodies = bodiesOf(fetchMock);
    // the question went out and no model could answer it (the request itself fails)
    expect(bodies.some((b) => b.includes("You answer yes/no questions"))).toBe(true);
    // no delegation rules anywhere, no sub-agent ran, the answer still completes
    for (const b of bodies) expect(b.includes("You can delegate work to sub-agents")).toBe(false);
    expect(events.some((e) => e.type === "agent")).toBe(false);
    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event (the run view trails it)
    expect(answerOf(events)).toContain("Plain answer.");
  });

  it("an explicit /agents command skips the question and still runs the sub-agents", async () => {
    const events: ChatEvent[] = [];
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const first = (body.messages as { content?: string }[])[0]?.content ?? "";
      if (first.startsWith("You are a sub-agent.")) return sse([DELTA("Found it."), STOP]);
      if ((body.messages as unknown[]).length > 2) return sse([DELTA("Here is everything, put together."), STOP]);
      return sse([DELTA('<subagent name="Research A">find A</subagent>'), STOP]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await runChatOrchestrator(fakeHost(events, COMMAND_SETTINGS), "subagents", ENTRY.id, [{ role: "user", content: "/agents Research A for me." } as never], { effort: null, subagents: true } as never);
    const bodies = bodiesOf(fetchMock);
    // no closed question: the command itself is the answer
    expect(bodies.some((b) => b.includes("You answer yes/no questions"))).toBe(false);
    expect(bodies.some((b) => b.includes("You can delegate work to sub-agents"))).toBe(true);
    const agents = events.filter((e) => e.type === "agent").map((e) => (e as { agent: { name: string; status: string } }).agent);
    expect(agents.filter((a) => a.name === "Research A").at(-1)?.status).toBe("done");
  });
});

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
/** NO "subagents" key: what the settings file of a person who never chose holds. */
const API_SETTINGS: Record<string, unknown> = {
  selectedModelId: "m1", effort: "auto", developer: false, showKQuants: false,
  appearance: "dark", closeAction: "quit", closeNoticeOff: false,
  computeMode: "auto", compute: "npu", idleReleaseSec: 0, keepaliveSec: 0, startupTimeoutSec: 90,
  nctxMode: "auto", kvType: "auto", npuBudgetOverrideGB: null,
  braveKey: "", searchProvider: "brave", searxngUrl: "",
  voice: { sttModelId: null, ttsModelId: null, ttsSid: 0, sttCompute: "cpu", ttsCompute: "cpu", sttLanguage: "", autoSend: false, readAloud: false },
};

function boot(chatCalls: unknown[][]) {
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
    saveMedia: async () => ({ mediaId: "m1" }),
    dynamicInfo: async () => ({ data: {}, speeds: {}, profile: "16", autoProfile: "16", installedRefs: [], runsOn: {}, engines: {}, missing: {} }),
    modelEvidence: async () => ({ manifest: [], records: [] }),
    chat: async (...args: unknown[]) => { chatCalls.push(args); },
    onChat: (cb: (e: ChatEvent) => void) => { void cb; return () => {}; },
  };
  (window as any).mkmn = new Proxy(api, {
    get: (t, p) => (p in t ? t[p as string] : (p as string).startsWith("on") ? () => () => {} : () => Promise.resolve(undefined)),
  });
  window.localStorage.setItem("opennpu.conversations", JSON.stringify([
    { id: "c1", title: "Chat one", updated: 10, turns: [{ role: "user", content: "hello" }] },
  ]));
  return render(createElement(App));
}

/** The Sub-agents row of an open menu, by its label text. */
const subAgentsRow = (): HTMLElement | undefined =>
  screen.getAllByRole("menuitemcheckbox").find((el) => (el.textContent ?? "").includes("Sub-agents"));

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

describe("each sub-agent works on a run of its own", () => {
  it("the agent's stream journals into its own agent run, the turn's run does not carry the agent's step, and the events are unchanged", async () => {
    const scratch = fs.mkdtempSync(nodePath.join(os.tmpdir(), "subagent-run-"));
    try {
      let main = 0;
      const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
        const first = ((JSON.parse(String(init?.body ?? "{}")).messages as { content?: string }[])[0]?.content ?? "");
        if (first.startsWith("You answer yes/no questions")) return sse([DELTA("yes"), STOP]);
        if (first.startsWith("You are a sub-agent.")) return sse([DELTA("Found it."), STOP]);
        main++;
        return main === 1
          ? sse([DELTA('<subagent name="Research A">find A</subagent>'), STOP])
          : sse([DELTA("Here is everything, put together."), STOP]);
      });
      vi.stubGlobal("fetch", fetchMock);
      const events: ChatEvent[] = [];
      const file = nodePath.join(scratch, "harness.jsonl");
      const host = { ...fakeHost(events), harnessJournalFile: () => file } as ChatHost;
      await runChatOrchestrator(host, "subrun", ENTRY.id, [{ role: "user", content: "Research A." } as never], { effort: null, subagents: true } as never);
      // the event flow is unchanged: the agent card ran to done with the worker's words, the final answer stands
      const agents = events.filter((e) => e.type === "agent").map((e) => (e as { agent: { name: string; status: string; output: string; index: number } }).agent);
      expect(agents.filter((a) => a.name === "Research A").at(-1)?.status).toBe("done");
      expect(agents.filter((a) => a.name === "Research A").at(-1)?.output).toBe("Found it.");
      expect(answerOf(events)).toContain("Here is everything, put together.");
      // the agent worked on a run of its own: its own journal header (pipeline agent) carrying ITS model-call step,
      // while the turn's run header does not carry the agent's step
      const entries = readJournal(file).entries;
      const runHeader = (e: (typeof entries)[number]) => (e.type === "run" ? (e as { runId: string; pipeline: string }) : null);
      const agentHeader = entries.map(runHeader).find((h) => h && h.runId.startsWith("agent-subrun-0-"));
      expect(agentHeader?.pipeline).toBe("agent");
      const agentSteps = entries.filter((e) => e.type === "step" && (e as { runId: string }).runId.startsWith("agent-")) as { id: string; status: string }[];
      expect(agentSteps.map((s) => s.id)).toContain("subrun:agent:0");
      const turnSteps = entries.filter((e) => e.type === "step" && (e as { runId: string }).runId.startsWith("chat-")) as { id: string }[];
      expect(turnSteps.map((s) => s.id)).not.toContain("subrun:agent:0");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("with no saved value, the chat sends sub-agents off and the tools menu shows off", () => {
  it("the chat request carries subagents false, the tools menu shows off, the model menu has no such row, and the header icon agrees", async () => {
    const chatCalls: unknown[][] = [];
    boot(chatCalls);
    fireEvent.click(await screen.findByText("Chat one"));
    const ta = (await waitFor(() => document.querySelector("textarea[aria-label='Message']"))) as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    fireEvent.change(ta, { target: { value: "hi friend" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", keyCode: 13 }); });
    await waitFor(() => expect(chatCalls.length).toBe(1));
    const opts = chatCalls[0][3] as { subagents: boolean };
    expect(opts.subagents).toBe(false);

    // the tools menu shows off
    fireEvent.click(screen.getByRole("button", { name: "This chat" }));
    await waitFor(() => expect(subAgentsRow()).toBeTruthy());
    expect(subAgentsRow()!.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "This chat" }));

    // the model menu no longer carries the switch: sub-agents live in the tools menu only
    fireEvent.click(screen.getByTitle("Model and thinking"));
    await waitFor(() => expect(screen.queryByText("More models")).toBeTruthy());
    expect(screen.queryAllByRole("menuitemcheckbox").some((el) => (el.textContent ?? "").includes("Sub-agents"))).toBe(false);

    // and the composer shows no "Sub-agents on" mark
    expect(screen.queryByTitle("Sub-agents on")).toBeNull();
  });
});
