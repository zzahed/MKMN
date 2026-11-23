import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry, ChatEvent, ChatOptions, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { withAnswer } from "../src/core/chat";
import { toSpeechText } from "../src/core/speechText";
import { forVoice } from "../src/core/speakNumbers";
import { readJournal } from "../src/core/harness/journal";

/**
 * The identity guard rides every streamed answer of a turn: the chat
 * events the person sees and hears are the guarded ones. A model that names
 * itself with another product's name — here "I am Qwen, made by Alibaba." —
 * reaches the event stream and the spoken text as "I am MKMN AI", with the name
 * split across stream chunks and in Arabic. The regression fails on the earlier code
 * where the raw words reached the events untouched.
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

/** The answer text in small pieces, as a real stream arrives: 5 to 8 characters at a time. */
const chunked = (text: string): object[] => {
  const out: object[] = [];
  for (let i = 0; i < text.length; i += 6) out.push(DELTA(text.slice(i, i + 6)));
  out.push(STOP);
  return out;
};

/** The answer as the screen holds it: the forwarded events, with the take-backs applied. */
const screenOf = (events: ChatEvent[]): string =>
  events.reduce((t, ev) => (ev.type === "answer" || ev.type === "retract" ? withAnswer(t, ev) : t), "");

const FORBIDDEN = ["Qwen", "Alibaba"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the identity guard rides the turn's streamed answer", () => {
  it("a self-naming answer is guarded in the events and in the journal, across chunk boundaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-identity-"));
    const file = path.join(dir, "turn.jsonl");
    vi.stubGlobal("fetch", vi.fn(async () => sse(chunked("I am Qwen, made by Alibaba. What can I do for you?"))));
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events, file), "c-id-1", ENTRY.id, [{ role: "user", content: "Who are you?" }], OPTS);

    const screen = screenOf(events);
    expect(screen).toContain("I am MKMN AI.");
    expect(screen).toContain("What can I do for you?");
    expect(FORBIDDEN.filter((n) => screen.includes(n))).toEqual([]);
    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event (the run view trails it)

    // the run's journal holds the guarded reply: the step record is what was seen, not the raw words
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { reply?: string }[];
    const answer = steps.map((s) => s.reply ?? "").find((r) => r.includes("MKMN AI"));
    expect(answer).toBeTruthy();
    expect(FORBIDDEN.filter((n) => steps.some((s) => (s.reply ?? "").includes(n)))).toEqual([]);

    // the spoken text derives from the same events: it is guarded by the same take
    const spoken = forVoice(toSpeechText(screen), "en");
    expect(FORBIDDEN.filter((n) => spoken.includes(n))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the same in Arabic, the name kept in Latin letters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-identity-"));
    const file = path.join(dir, "turn.jsonl");
    vi.stubGlobal("fetch", vi.fn(async () => sse(chunked("أنا Qwen، تم تطويري بواسطة علي بابا. كيف أساعدك؟"))));
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events, file), "c-id-2", ENTRY.id, [{ role: "user", content: "من أنت؟" }], OPTS);

    const screen = screenOf(events);
    expect(screen).toContain("أنا MKMN AI.");
    expect(screen).toContain("كيف أساعدك؟");
    expect(FORBIDDEN.filter((n) => screen.includes(n))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
