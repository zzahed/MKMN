import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry, ChatEvent, ChatMessage, ChatOptions, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { Q } from "../src/core/router";
import { readJournal } from "../src/core/harness/journal";
import { foldOffloadName } from "../src/core/harness/offload";

/**
 * Auto-compact: a long conversation is folded into a summary before the window is
 * full — before a send when it is already too big, and in the background right after an
 * answer otherwise, so the next send never waits. The summary is checked before it is kept,
 * the folded turns are kept whole in the offload store, and a message that asks for something
 * from them recalls the parts that answer it (Q.recall). The regression here fails on the earlier code
 * there: no fold is kept for recall and no background fold runs after an answer.
 */

const ENTRY: CatalogEntry = {
  id: "test-1b", name: "Test 1B", repo: "org/test-1b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};

const HW: HardwareProfile = { chipName: "Test Chip", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8 };
const baseSettings = (): Settings => ({ selectedModelId: "test-1b", webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false } as unknown as Settings);
const NCTX = 2048;

const sse = (text: string): Response => {
  const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } })}`, "data: [DONE]", ""];
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); }
  }), { status: 200 });
};

const SUMMARY_SYS = "You keep the memory of a long conversation";
const SUMMARY_TEXT = "Goal: the household budget.\n- Decisions: the plan was approved.";

/** A scripted server: summaries come from `summaries` in order (a null hangs until its request is aborted), everything else is one streamed answer. */
function scriptedFetch(bodies: { messages: { role: string; content: unknown }[] }[], summaries: (string | null)[], answer: string) {
  let summaryCalls = 0;
  return vi.fn(async (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const sys = (body.messages ?? []).find((m: { role: string }) => m.role === "system")?.content ?? "";
    if (typeof sys === "string" && sys.startsWith(SUMMARY_SYS)) {
      const s = summaries[Math.min(summaryCalls, summaries.length - 1)];
      summaryCalls++;
      if (s === null) return new Promise<Response>((_, rej) => {
        const f = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        const sig = (init?.signal ?? null) as AbortSignal | null;
        if (sig?.aborted) f(); else sig?.addEventListener("abort", f);
      }) as unknown as Response;
      return sse(s);
    }
    return sse(answer);
  });
}

function fakeHost(o: {
  events: ChatEvent[];
  journalFile: string | null;
  settings: Settings;
  bodies: { messages: { role: string; content: unknown }[] }[];
  fetch: ReturnType<typeof scriptedFetch>;
}): ChatHost {
  return {
    settings: () => o.settings,
    patchSettings: () => {},
    allEntries: () => [ENTRY],
    entryById: (id) => (id === ENTRY.id ? ENTRY : undefined),
    installedEntries: async () => [ENTRY],
    chatHardware: async () => HW,
    lastLoaded: () => null,
    setLastLoaded: () => {},
    benchRunning: () => false,
    ensureServer: async (): Promise<Served> => ({ endpoint: "http://127.0.0.1:9/v1", status: () => ({ nctx: NCTX }) }),
    servedName: (e) => `${e.repo}:${e.quant}`,
    send: (ev) => o.events.push(ev),
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
    harnessJournalFile: () => o.journalFile,
    router: {
      sort: async () => null,
      yesNo: async (_t, ask) => (ask === Q.recall ? true : false), // the recall question is answered yes, every other one no
      query: async () => null,
      fileKind: async () => null,
    },
  };
}

const OPTS = (convId?: string): ChatOptions => ({ effort: null, subagents: false, convId });

/** A long conversation: `n` turns, the third one holds the fact only the fold keeps. */
const longConv = (n: number): ChatMessage[] => [
  { role: "system", content: "You are helpful." },
  ...Array.from({ length: n }, (_, i) => [
    { role: "user" as const, content: i === 2 ? "Question 3: the xylophone budget is 1997 dinars, remember it" : `Question ${i}: some planning detail number ${i} for the household` },
    { role: "assistant" as const, content: `Answer ${i}. Noted, and written down.` }
  ]).flat(),
  { role: "user", content: "remind me the amount we agreed on for the xylophone budget" }
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auto-compact", () => {
  it("a 150-turn conversation is folded before the send, the fold is kept, and the question recalls the fact the fold covers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-compact-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const fetchFn = scriptedFetch(bodies, [`${SUMMARY_TEXT}\n- Work done: the plan was written.`], "The amount we agreed on was 1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), bodies, fetchFn }), "t-1", ENTRY.id, longConv(150), OPTS("c-1"));

    // the fold happened before the answer, and the summary is what the request carries instead of the 150 turns
    const answerReq = bodies.at(-1)!;
    const texts = answerReq.messages.map((m) => String(m.content)).join("\n");
    expect(texts).toContain("[Summary of the earlier conversation");
    expect(texts).toContain("xylophone"); // recalled from the fold for this very question
    expect(texts).toContain("<recalled from the earlier conversation>");
    expect(texts).not.toContain("Question 80:"); // folded away, and not asked about
    expect(events.some((e) => e.type === "memo" && e.turns > 0)).toBe(true);

    // the folded turns are kept whole in the offload store, under the conversation's name
    const foldFile = path.join(dir, "offload", foldOffloadName("c-1"));
    expect(fs.existsSync(foldFile)).toBe(true);
    const kept = fs.readFileSync(foldFile, "utf8");
    expect(kept).toContain("the xylophone budget is 1997 dinars");
    expect(kept).toContain("Question 0:"); // the whole folded stretch, not just the summary
    expect(kept).not.toContain("Question 149:"); // the latest turns are still read word for word

    // the recall is a step of the turn's run, like every retrieval
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; status: string }[];
    expect(steps.some((s) => s.id.endsWith(":recall") && s.status === "ok")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the fold that the next send needs is made in the background after the answer: the answer is sent first, the summary arrives after", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-compact-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    // a small conversation (under the fold point) with a very long answer: the answer itself pushes it past the point
    const conv: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      ...Array.from({ length: 4 }, (_, i) => [
        { role: "user" as const, content: `Question ${i}: planning the house budget in detail, part ${i}` },
        { role: "assistant" as const, content: `Answer ${i}. The part ${i} of the plan is settled and written.` }
      ]).flat(),
      { role: "user", content: "go on with the plan" }
    ];
    const answer = "The plan continues with the garage. ".repeat(320); // far over the fold point once added
    const fetchFn = scriptedFetch(bodies, ["Goal: the house budget.\n- Decisions: parts 0 to 3 settled."], answer);
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), bodies, fetchFn }), "t-2", ENTRY.id, conv, OPTS("c-2"));

    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event (the run view trails it)
    const doneAt = events.findIndex((e) => e.type === "done");
    // the background fold runs after the turn: the summary arrives as the conversation's own event
    await vi.waitFor(() => expect(events.some((e) => e.type === "memo" && e.conv === "c-2")).toBe(true));
    expect(events.findIndex((e) => e.type === "memo" && e.conv === "c-2")).toBeGreaterThan(doneAt);
    expect(fs.existsSync(path.join(dir, "offload", foldOffloadName("c-2")))).toBe(true);

    // the background fold is a run of its own in the journal
    const j = readJournal(file);
    expect(j.entries.some((e) => e.type === "run" && e.pipeline === "compaction")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a send that arrives while the background fold is running interrupts it, and the parts that finished are kept", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-compact-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const conv: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      // each turn is big enough that the folded head needs two summary calls: the second one hangs
      ...Array.from({ length: 4 }, (_, i) => [
        { role: "user" as const, content: `Question ${i}: planning the house budget in detail, part ${i}. ${"more planning detail. ".repeat(16)}` },
        { role: "assistant" as const, content: `Answer ${i}. The part ${i} of the plan is settled and written. ${"noted detail. ".repeat(16)}` }
      ]).flat(),
      { role: "user", content: "go on with the plan" }
    ];
    const answer = "The plan continues with the garage. ".repeat(320);
    // the first summary stretch resolves, the second hangs until the abort
    const fetchFn = scriptedFetch(bodies, ["- Work done: the early parts of the plan are settled.", null], answer);
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), bodies, fetchFn }), "t-3", ENTRY.id, conv, OPTS("c-3"));
    expect(events.every((e) => e.type !== "memo")).toBe(true); // nothing finished yet: no summary handed over

    // the second summary call is in flight (hanging) before the next send takes the NPU back
    await vi.waitFor(() => expect(bodies.filter((b) => String(b.messages[0]?.content ?? "").startsWith(SUMMARY_SYS)).length).toBeGreaterThanOrEqual(2));

    // the next send takes the NPU back: the fold is interrupted with its finished part kept
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), bodies, fetchFn }), "t-4", ENTRY.id, [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "a short new question" }
    ], OPTS("c-3"));

    await vi.waitFor(() => expect(events.some((e) => e.type === "memo" && e.conv === "c-3")).toBe(true));
    const memo = events.find((e) => e.type === "memo" && e.conv === "c-3") as { text: string; turns: number };
    expect(memo.text).toContain("the early parts of the plan are settled"); // the part that had finished
    expect(memo.turns).toBeGreaterThan(0);
    // the interrupted step is in the journal as interrupted, not failed
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; status: string }[];
    expect(steps.some((s) => s.id.endsWith(":memo") && s.status === "interrupted")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("with the setting off, nothing folds on its own: not before a send, not after an answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-compact-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const fetchFn = scriptedFetch(bodies, ["should never be asked"], "A plain answer.");
    vi.stubGlobal("fetch", fetchFn);
    const settings = { ...baseSettings(), autoCompact: false };
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings, bodies, fetchFn }), "t-5", ENTRY.id, longConv(150), OPTS("c-5"));

    expect(events.every((e) => e.type !== "memo")).toBe(true);
    expect(bodies.some((b) => String(b.messages[0]?.content ?? "").startsWith(SUMMARY_SYS))).toBe(false); // no summary call, ever
    expect(fs.existsSync(path.join(dir, "offload", foldOffloadName("c-5")))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a summary that is empty, over its share, or a refusal is made once more; if it is still not usable, a recap made without a model stands in", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-compact-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const fetchFn = scriptedFetch(bodies, ["I cannot summarize this conversation.", "I am unable to help with that."], "A plain answer.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), bodies, fetchFn }), "t-6", ENTRY.id, longConv(150), OPTS("c-6"));

    // both tries refused; the fold still happened, with the model-free recap standing in
    const summaryCalls = bodies.filter((b) => String(b.messages[0]?.content ?? "").startsWith(SUMMARY_SYS)).length;
    expect(summaryCalls).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "memo" && e.text.startsWith("Also mentioned:"))).toBe(true);
    const answerReq = bodies.at(-1)!;
    expect(answerReq.messages.map((m) => String(m.content)).join("\n")).toContain("Also mentioned:");
    expect(answerReq.messages.map((m) => String(m.content)).join("\n")).not.toContain("Question 80:");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
