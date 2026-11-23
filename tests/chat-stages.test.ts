// The stage boundaries of runChatOrchestrator, pinned through the whole turn before the stages
// are taken out of it (src/core/chatOrchestrator.ts): what the prepare stage does to the message
// and the tools, what the route stage decides about thinking, and the retrieve stage's answers
// quoted straight from the documents. A fake host and a stubbed fetch; no model runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, ChatEvent, ChatMessage, ChatOptions, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";

const PLAIN: CatalogEntry = {
  id: "test-1b", name: "Test 1B", repo: "org/test-1b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 },
};
/** A model that can think when asked (thinkingSupport "toggle"). */
const THINKER: CatalogEntry = { ...PLAIN, id: "qwen3-4b", name: "Qwen3 4B", repo: "org/qwen3-4b" };

const HW: HardwareProfile = {
  chipName: "Test Chip", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8,
};
const BASE = { webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false, autoCompact: false };

const sse = (text: string): Response => {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } })}`,
    "data: [DONE]", "",
  ];
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); } }), { status: 200 });
};

/** The bodies of every model request, and a host that answers from memory. */
function setup(settings: Record<string, unknown>, entries: CatalogEntry[] = [PLAIN]) {
  const events: ChatEvent[] = [];
  const bodies: any[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return sse("Fine."); });
  const host: ChatHost = {
    settings: () => ({ ...BASE, ...settings }) as unknown as Settings,
    patchSettings: () => {},
    allEntries: () => entries,
    entryById: (id) => entries.find((e) => e.id === id),
    installedEntries: async () => entries,
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
    checkArtifact: async () => ({ ran: "none", errors: [] }),
  };
  return { host, events, bodies };
}

const OPTS: ChatOptions = { effort: null, subagents: false };
/** The text of the last user message the model was sent. */
const lastUserText = (body: any): string => {
  const m = [...body.messages].reverse().find((x: any) => x.role === "user");
  return typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("");
};
const notices = (events: ChatEvent[]) => events.filter((e) => e.type === "notice").map((e) => (e as { text: string }).text);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("prepare: the '/' tool words of a message", () => {
  it("with tools on command, the words are taken off a text message before the model reads it", async () => {
    const { host, bodies } = setup({ toolsOnCommand: true });
    await runChatOrchestrator(host, "prep-text", PLAIN.id, [{ role: "user", content: "/check /agents Say hello." }], OPTS);
    const sent = lastUserText(bodies.at(-1));
    expect(sent).toContain("Say hello.");
    expect(sent).not.toMatch(/\/check|\/agents/);
  });

  it("with tools on command, the words are taken off the first text part of a message in parts", async () => {
    const { host, bodies } = setup({ toolsOnCommand: true });
    await runChatOrchestrator(host, "prep-parts", PLAIN.id, [{ role: "user", content: [{ type: "text", text: "/agents Say hello." }] } as ChatMessage], OPTS);
    const sent = lastUserText(bodies.at(-1));
    expect(sent).toContain("Say hello.");
    expect(sent).not.toContain("/agents");
  });

  it("with tools on command off, the message reaches the model as typed", async () => {
    const { host, bodies } = setup({ toolsOnCommand: false });
    await runChatOrchestrator(host, "prep-off", PLAIN.id, [{ role: "user", content: "/check Say hello." }], OPTS);
    expect(bodies.some((b) => lastUserText(b).includes("/check Say hello."))).toBe(true);
  });
});

describe("route: how much the model thinks", () => {
  it("Auto names the level it chose, for a model that can think", async () => {
    const { host, events } = setup({ toolsOnCommand: true }, [THINKER]);
    await runChatOrchestrator(host, "route-auto", THINKER.id, [{ role: "user", content: "Prove that the square root of 2 is irrational." }], { ...OPTS, effort: "auto" });
    expect(notices(events).filter((t) => t.startsWith("Thinking: "))).toHaveLength(1);
  });

  it("Auto says nothing for a model that cannot think", async () => {
    const { host, events } = setup({ toolsOnCommand: true });
    await runChatOrchestrator(host, "route-auto-none", PLAIN.id, [{ role: "user", content: "Prove that the square root of 2 is irrational." }], { ...OPTS, effort: "auto" });
    expect(notices(events).filter((t) => t.startsWith("Thinking: "))).toHaveLength(0);
  });

  it("Medium on a plain request to a model that can think is answered without thinking, and says so", async () => {
    const { host, events } = setup({ toolsOnCommand: true }, [THINKER]);
    await runChatOrchestrator(host, "route-medium", THINKER.id, [{ role: "user", content: "Translate 'good morning' into French." }], { ...OPTS, effort: "medium" });
    expect(notices(events)).toContain("A plain request: answered without thinking first (choose High to make it think).");
  });

  it("High is the person's own choice and stays", async () => {
    const { host, events } = setup({ toolsOnCommand: true }, [THINKER]);
    await runChatOrchestrator(host, "route-high", THINKER.id, [{ role: "user", content: "Translate 'good morning' into French." }], { ...OPTS, effort: "high" });
    expect(notices(events).filter((t) => t.startsWith("A plain request") || t.startsWith("Thinking: "))).toHaveLength(0);
  });
});

describe("retrieve: answers quoted from the documents, with no model call", () => {
  const knowledge = (content: string) => [{ id: "k1", name: "deal.txt", content }];

  it("an ownership question is answered from the passage that names the stake", async () => {
    const { host, events, bodies } = setup({ toolsOnCommand: true });
    const passage = "Northstar acquired a 60% stake in Acme, with Harbor retaining 40% ownership.";
    await runChatOrchestrator(host, "ret-own", PLAIN.id, [{ role: "user", content: "How much does Northstar own in Acme?" }],
      { ...OPTS, knowledge: knowledge(`Company history.\n\n${passage}\n\nOther notes.`) } as ChatOptions);
    const answer = events.find((e) => e.type === "answer") as { text: string } | undefined;
    expect(answer?.text).toContain(passage);
    expect(answer?.text).toContain("deal.txt");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(bodies).toHaveLength(0);
  });

  it("an ownership question the documents cannot settle is declined, not guessed", async () => {
    const { host, events, bodies } = setup({ toolsOnCommand: true });
    await runChatOrchestrator(host, "ret-own-none", PLAIN.id, [{ role: "user", content: "How much does Aramco own in HUMAIN?" }],
      { ...OPTS, knowledge: knowledge("The survey found that 49% of readers recognized the name HUMAIN. Aramco is a shareholder.") } as ChatOptions);
    expect((events.find((e) => e.type === "answer") as { text: string } | undefined)?.text).toMatch(/couldn't verify/i);
    expect(bodies).toHaveLength(0);
  });

  it("a reported figure for a named period is quoted from the sentence that holds it", async () => {
    const { host, events, bodies } = setup({ toolsOnCommand: true });
    const sentence = "Acme reported net income of 12.4 million dollars for Q2 2026.";
    await runChatOrchestrator(host, "ret-figure", PLAIN.id, [{ role: "user", content: "What was Acme's net income for Q2 2026?" }],
      { ...OPTS, knowledge: knowledge(`Quarterly report.\n\n${sentence}\n\nOutlook unchanged.`) } as ChatOptions);
    const answer = events.find((e) => e.type === "answer") as { text: string } | undefined;
    expect(answer?.text).toContain(sentence);
    expect(bodies).toHaveLength(0);
  });

  it("a question with no documents goes to the model", async () => {
    const { host, bodies } = setup({ toolsOnCommand: true });
    await runChatOrchestrator(host, "ret-none", PLAIN.id, [{ role: "user", content: "How much does Northstar own in Acme?" }], OPTS);
    expect(bodies.length).toBeGreaterThan(0);
  });
});
