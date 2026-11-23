import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry, ChatEvent, ChatOptions, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { readJournal } from "../src/core/harness/journal";

/**
 * The chat answer is a Run (A4): every model call of the turn — the streamed
 * answer, a classifier, a summary, a locator, a sub-agent — is a step journaled
 * through the harness journal (src/core/harness/journal.ts). The events the UI
 * sees are unchanged; the journal is the run's record.
 */

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

function fakeHost(events: ChatEvent[], journalFile: string | null): ChatHost {
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
    checkArtifact: async () => ({ ran: "none", errors: [] }),
    harnessJournalFile: () => journalFile,
  };
}

const OPTS: ChatOptions = { effort: null, subagents: false };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the chat turn as a run", () => {
  it("one answered question: the journal holds the run line and one step per model call, with the reply and the usage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-run-"));
    const file = path.join(dir, "turn.jsonl");
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("Hello"), DELTA(" there"), STOP])));
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events, file), "c-run-1", ENTRY.id, [{ role: "user", content: "Say hello." }], OPTS);

    const { entries } = readJournal(file);
    const pipelines = entries.filter((e) => e.type === "run").map((e) => (e as { pipeline: string }).pipeline);
    expect(pipelines).toContain("chat"); // the turn's own run
    expect(pipelines).toContain("build"); // the closed build question ran as the build's own run
    const steps = entries.filter((e) => e.type === "step") as { type: "step"; id: string; kind: string; status: string; reply?: string; tokens: { prompt: number; output: number; measured: boolean }; startedAt: string; endedAt: string }[];
    // two model calls: the closed build question, then the streamed answer (no router here, so the chat model is asked)
    expect(steps.length).toBe(2);
    for (const step of steps) {
      expect(step.kind).toBe("model-call");
      expect(step.status).toBe("ok");
      expect(step.startedAt).toBeTruthy();
      expect(step.endedAt).toBeTruthy();
    }
    const answerStep = steps.find((s) => s.reply === "Hello there");
    expect(answerStep).toBeTruthy();
    expect(answerStep!.tokens).toEqual({ prompt: 9, output: 3, measured: true });
    expect(steps.map((s) => s.id), "the build question was a step of the BUILD's run").toEqual(["c-run-1:x:ask", "c-run-1"]);

    // the UI saw exactly what it always saw: the streamed words and a terminal done
    const answer = events.filter((e) => e.type === "answer").map((e) => (e as { text: string }).text).join("");
    expect(answer).toBe("Hello there");
    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event (the run view trails it)
  });

  it("a real build request: the build's model calls journal into the build's run, the turn's answer into the turn's", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-run-"));
    const file = path.join(dir, "turn.jsonl");
    // the stub answers every call; whatever the build decides, its calls belong to its run
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("A small snake game on a grid, arrow keys to steer."), STOP])));
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events, file), "c-build-1", ENTRY.id, [{ role: "user", content: "Write a snake game." }], OPTS);
    const { entries } = readJournal(file);
    const runs = entries.filter((e) => e.type === "run") as { pipeline: string }[];
    expect(runs.some((r) => r.pipeline === "build")).toBe(true);
    const steps = entries.filter((e) => e.type === "step") as { id: string; status: string }[];
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.every((s) => s.status === "ok" || s.status === "failed")).toBe(true);
    expect(events.filter((e) => e.type !== "run").at(-1)?.type === "done" || events.some((e) => e.type === "error")).toBe(true); // a terminal event, whatever the stub's answers led to (the run view trails it)
  });

  it("the sub-agent question is a second step of the same run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-run-"));
    const file = path.join(dir, "turn.jsonl");
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("yes"), STOP])));
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events, file), "c-run-2", ENTRY.id, [{ role: "user", content: "Plan this." }], { ...OPTS, subagents: true });

    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; status: string }[];
    expect(steps.length).toBeGreaterThanOrEqual(2); // the yes/no question, then the answer
    expect(steps.some((s) => s.id.endsWith(":agents"))).toBe(true);
    expect(steps.every((s) => s.status === "ok")).toBe(true);
    expect(events.some((e) => e.type === "answer")).toBe(true);
  });

  it("a call whose server is gone: the error event still reaches the UI, and the journal holds the failed step", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-run-"));
    const file = path.join(dir, "turn.jsonl");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events, file), "c-run-3", ENTRY.id, [{ role: "user", content: "hi" }], OPTS);

    expect(events.some((e) => e.type === "error")).toBe(true);
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; status: string; error?: string }[];
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.every((s) => s.status === "failed")).toBe(true); // every call the turn attempted failed
    expect(steps.every((s) => (s.error ?? "").includes("fetch failed"))).toBe(true);
  });

  it("a test host without a journal file runs the turn with no journal written", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("Hi"), STOP])));
    const events: ChatEvent[] = [];
    // no harnessJournalFile on the host: under the test runner the journal is off
    await runChatOrchestrator(fakeHost(events, null), "c-run-4", ENTRY.id, [{ role: "user", content: "hi" }], OPTS);
    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event (the run view trails it)
  });
});
