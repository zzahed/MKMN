import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry, ChatEvent, ChatMessage, ChatOptions, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, abortChat, foldOldMessages, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { ModelStartError } from "../src/core/errors";
import { ServerLostError } from "../src/core/chat";
import { readJournal } from "../src/core/harness/journal";
import { runtimeLease } from "../src/core/lease";
import { turnBudgetOf } from "../src/core/harness/turn";

/**
 * The chat orchestrator (src/core/chatOrchestrator.ts) against a fake host: the same
 * function the Node sidecar runs. No HTTP server is needed —
 * the model's completions come from a stubbed fetch.
 */

const ENTRY: CatalogEntry = {
  id: "test-1b",
  name: "Test 1B",
  repo: "org/test-1b",
  quant: "Q4_0",
  engine: "qairt",
  role: "chat",
  architecture: "llama",
  sizeGB: 1,
  recommendedContext: 4096,
  sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};

const HW: HardwareProfile = {
  chipName: "Test Chip",
  chipFamily: "x2",
  isSnapdragon: true,
  ramGB: 16,
  npuDetected: true,
  npuDriverVersion: "1.0.0",
  npuBudgetGB: 8
};

const SETTINGS: Settings = { selectedModelId: "test-1b", webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false } as unknown as Settings;

const sse = (chunks: object[]): Response => {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]", ""];
  return new Response(new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`));
      c.close();
    }
  }), { status: 200 });
};

const DELTA = (content: string) => ({ choices: [{ delta: { content } }] });
const STOP = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } };

/** A host that answers everything from memory; the requests are read off the fetch mock. */
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

const OPTS: ChatOptions = { effort: null, subagents: false };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the chat orchestrator (core, fake host)", () => {
  it("ends an unrecoverable model stall with one terminal error and allows the same request to be retried", async () => {
    const events: ChatEvent[] = [];
    const host = fakeHost(events);
    const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
    vi.stubGlobal("fetch", async () => { throw new ServerLostError("The server sent nothing for 45 s."); });
    await runChatOrchestrator(host, "stalled-turn", ENTRY.id, messages, OPTS);
    expect(events.filter((e) => e.type === "error" || e.type === "done")).toEqual([
      expect.objectContaining({ type: "error", error: expect.objectContaining({ id: "model-server-lost", fix: expect.stringContaining("Try again") }) }),
    ]);
    vi.stubGlobal("fetch", async () => sse([DELTA("Hello"), STOP]));
    await runChatOrchestrator(host, "stalled-retry", ENTRY.id, messages, { ...OPTS, retryModelLoad: true });
    expect(events.filter((e) => e.id === "stalled-retry" && e.type === "done")).toHaveLength(1);
  });

  it("preserves the failed model and runtime error, and forwards an explicit retry", async () => {
    const events: ChatEvent[] = [];
    const host = fakeHost(events);
    const details = {
      id: "model-load",
      title: "GenieX failed to load org/test-1b:Q4_0",
      raw: "Requested compute: npu\nHTTP 500 (-100201)\nCould not create context from binary: err 1002",
      fix: "Use Try again."
    };
    let explicitRetry = false;
    host.ensureServer = async (_entry, options) => {
      explicitRetry = options?.retryModelLoad === true;
      throw new ModelStartError(details);
    };
    host.npuRecovery = async () => ({
      external: ["external.exe (PID 456)"],
      canReset: false,
      reset: async () => { throw new Error("model-load errors must never reset the NPU"); }
    });
    await runChatOrchestrator(host, "model-load-retry", ENTRY.id, [{ role: "user", content: "hi" }], { ...OPTS, retryModelLoad: true });
    expect(explicitRetry).toBe(true);
    const failure = events.find((event) => event.type === "error");
    expect(failure?.error).toMatchObject({ id: details.id, title: details.title, raw: details.raw });
    expect(failure?.error.fix).toContain("Windows measured NPU activity from external.exe (PID 456)");
    expect(failure?.error.fix).not.toContain("Task Manager");
  });

  it("a busy NPU (another task holds the runtime lease) answers with an npu-busy error and starts no server", async () => {
    const lease = runtimeLease.acquire("bench", "A benchmark");
    expect(lease).not.toBeNull();
    const events: ChatEvent[] = [];
    const host = fakeHost(events);
    const ensure = vi.spyOn(host, "ensureServer");
    try {
      await runChatOrchestrator(host, "c1", ENTRY.id, [{ role: "user", content: "hi" }], OPTS);
    } finally {
      lease!.release();
    }
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect((errs[0] as { error: { id: string } }).error.id).toBe("npu-busy");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("a plain question is answered in one stream: the events end with a done, and the request goes to the served name", async () => {
    const fetchMock = vi.fn(async () => sse([DELTA("Hello"), DELTA(" there"), STOP]));
    vi.stubGlobal("fetch", fetchMock);
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events), "c2", ENTRY.id, [{ role: "user", content: "Say hello." }], OPTS);
    const types = events.map((e) => e.type);
    expect(types).toContain("answer");
    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event the UI clears busy on (the run view trails it)
    const answer = events.filter((e) => e.type === "answer").map((e) => (e as { text: string }).text).join("");
    expect(answer).toBe("Hello there");
    // the request went to the model server, named as the host serves it
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("org/test-1b:Q4_0");
    // the build steps wrap the request (the same "Request: ..." framing the desktop build sends)
    expect(String(body.messages.at(-1).content)).toContain("Say hello.");
  });

  it("an aborted turn ends with a zeroed done, not an error", async () => {
    let die: ((e: Error) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      die = rej;
      init?.signal?.addEventListener("abort", () => rej(new Error("The turn was stopped.")), { once: true });
    })));
    const events: ChatEvent[] = [];
    const run = runChatOrchestrator(fakeHost(events), "c3", ENTRY.id, [{ role: "user", content: "hi" }], OPTS);
    await vi.waitFor(() => expect(die).not.toBeNull());
    abortChat("c3");
    await run;
    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event the UI clears busy on (the run view trails it)
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("a stopped turn's call settles interrupted in the journal, not failed (stopped turns in on-device test runs journaled 'failed / This operation was aborted' — a person's stop read as a hard failure)", async () => {
    const file = path.join(os.tmpdir(), `orch-abort-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
    let die: ((e: Error) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      die = rej;
      init?.signal?.addEventListener("abort", () => rej(new Error("The turn was stopped.")), { once: true });
    })));
    const events: ChatEvent[] = [];
    const run = runChatOrchestrator({ ...fakeHost(events), harnessJournalFile: () => file }, "c4", ENTRY.id, [{ role: "user", content: "hi" }], OPTS);
    await vi.waitFor(() => expect(die).not.toBeNull());
    abortChat("c4"); // the person pressed stop (the driver's timeout takes the same path)
    await run;
    const steps = readJournal(file).entries.filter((e) => e.type === "step");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.at(-1)!.status).toBe("interrupted"); // the person stopped it; it did not fail
    fs.rmSync(file, { force: true });
  });

  it("a summarizer that runs out of time is not asked again: the recap stands in (the records' second try never once completed — it inherited the spent budget)", async () => {
    let asks = 0;
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => {
      asks++;
      const signal = init?.signal;
      // undici semantics: a fetch called on an already-aborted signal rejects at once
      if (signal?.aborted) return Promise.reject(new Error("The operation was aborted."));
      if (asks > 1) return Promise.resolve(sse([DELTA("The earlier conversation covered the spare key kept in the reading room cabinet."), STOP]));
      return new Promise<Response>((_res, rej) => signal?.addEventListener("abort", () => rej(new Error("The operation was aborted.")), { once: true }));
    }));
    const msgs: ChatMessage[] = Array.from({ length: 6 }, (_, i) => [
      { role: "user" as const, content: `Question ${i}: the reading room keeps its seats numbered and the annex holds the copy cards beside the sorter.` },
      { role: "assistant" as const, content: `Answer ${i}: noted, the spare key is signed out at the desk.` }
    ]).flat();
    msgs.push({ role: "user", content: "where is the spare key?" });
    const srv: Served = { endpoint: "http://127.0.0.1:9/v1", status: () => ({ nctx: 1024 }) };
    const r = await foldOldMessages(fakeHost([]), "f1", ENTRY, srv, msgs, 0, new AbortController().signal, false, { timeoutMs: 150 });
    expect(r && "text" in r && r.text.startsWith("Also mentioned:")).toBe(true); // the recap, not a model summary
    expect(asks).toBe(1); // the spent budget is not retried
  });

  it("an oversized question ends with one error event, its content is never dispatched, and the next message is answered", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: any) => {
      bodies.push(String(init?.body ?? ""));
      return sse([DELTA("yes"), STOP]);
    }));
    const events: ChatEvent[] = [];
    const oversized = `Please answer this: ${"content ".repeat(3000)}`; // about 8.6k tokens against a 3.6k budget
    await runChatOrchestrator(fakeHost(events), "c4", ENTRY.id, [{ role: "user", content: oversized }], OPTS);
    for (const b of bodies) expect(b.length, "no inference request may carry the oversized content").toBeLessThan(oversized.length / 4); // only the small truncated intent call may run
    expect(events.some((e) => e.type === "answer")).toBe(false); // no successful empty answer
    const terms = events.filter((e) => e.type === "done" || e.type === "error");
    expect(terms).toHaveLength(1); // the terminal event the UI clears busy on
    expect(terms[0].type).toBe("error");
    expect((terms[0] as { error: { fix: string } }).error.fix).toMatch(/bigger window|new chat|part of the documents/);
    // the chat is not stuck: a normal question right after is answered and ends with a done
    const after: ChatEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("Hi there"), STOP])));
    await runChatOrchestrator(fakeHost(after), "c5", ENTRY.id, [{ role: "user", content: "hello" }], OPTS);
    expect(after.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event (the run view trails it)
    expect(after.some((e) => e.type === "answer" && (e as { text: string }).text.includes("Hi there"))).toBe(true);
  });

  it("a turn's budget account is open while its calls run (charged from the first) and closed when the turn ends", async () => {
    const seen: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      // the main answer's call id IS the turn's id (orchestrate streams with o.id):
      // the account must be open and this call already counted (prepare charges before sending)
      const b = turnBudgetOf("cb");
      expect(b).toBeDefined();
      seen.push(b!.calls);
      return sse([DELTA("Hi there"), STOP]);
    }));
    const events: ChatEvent[] = [];
    await runChatOrchestrator(fakeHost(events), "cb", ENTRY.id, [{ role: "user", content: "hello" }], OPTS);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(1); // the first call of the turn is the first charge
    expect(events.filter((e) => e.type !== "run").at(-1)?.type).toBe("done"); // the terminal event (the run view trails it)
    // closed: no account leaks after the turn (the next turn with a new id starts at zero)
    expect(turnBudgetOf("cb")).toBeUndefined();
    expect(turnBudgetOf("cb:anything")).toBeUndefined();
  });
});
