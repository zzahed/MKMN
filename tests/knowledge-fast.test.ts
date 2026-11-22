import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatEvent, ChatMessage, ChatOptions } from "../src/shared/types";
import { runChatOrchestrator, shortReplyTokens } from "../src/core/chatOrchestrator";
import { buildSystemPrompt, knowledgeBudget } from "../src/core/projects";
import { promptTokens } from "../src/core/context";
import { readJournal } from "../src/core/harness/journal";
import { forgetKnowledgeIndexes, openKnowledgeIndex } from "../src/core/knowledge/store";
import { figurePassage, namesPeriod } from "../src/core/knowledge/retrieve";
import type { KnowledgeFileLike } from "../src/core/knowledge/index";
import { aramcoReport, BENCH_ENTRY, BENCH_NCTX, benchHost, northwindReport } from "./knowledgeBench";

/**
 * The retrieval's fast and exact paths, measured first on the
 * retrieval benchmark (tests/knowledgeBench.ts):
 *  - a strong keyword match skips the locator and the rewrite and carries only
 *    the matched sections;
 *  - weak, several-part and cross-script questions keep the locator and the rewrite;
 *  - the index is reused in memory while the files are the same, and never
 *    answers from files that changed or were removed;
 *  - a reported figure tied to a named period is quoted from its sentence with
 *    no model call; sentences that disagree are both quoted; no such sentence
 *    leaves the question to the model;
 *  - the diagnostic line carries numbers only.
 */

const LOCATOR_SYS = "You locate information in a long document.";
const REWRITE_SYS = "You write search words.";

type Msg = { role: string; content: unknown };
const sysOf = (ms: Msg[]): string => String(ms.find((m) => m.role === "system")?.content ?? "");

const sse = (text: string): Response => {
  const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } })}`, "data: [DONE]", ""];
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); } }), { status: 200 });
};

/** One turn through the real orchestrator; every model request is recorded. */
async function turn(files: KnowledgeFileLike[], history: ChatMessage[], o: { dir?: string | null; journal?: string | null; locator?: string; rewrite?: string } = {}) {
  const requests: Msg[][] = [];
  vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Msg[] };
    requests.push(body.messages);
    const sys = sysOf(body.messages);
    if (sys.startsWith(LOCATOR_SYS)) return sse(o.locator ?? "none");
    if (sys.startsWith(REWRITE_SYS)) return sse(o.rewrite ?? "");
    return sse("MODEL-ANSWER");
  });
  const events: ChatEvent[] = [];
  const project = { id: "p-fast", name: "Reports", description: "", instructions: "", files, created: 0, updated: 0 };
  const system = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(BENCH_NCTX), contextTokens: BENCH_NCTX, conversationTokens: promptTokens(history) });
  const opts: ChatOptions = { effort: null, subagents: false, projectId: project.id, knowledge: files };
  const host = { ...benchHost(events, o.dir ?? null, null), harnessJournalFile: () => o.journal ?? null };
  await runChatOrchestrator(host, `fast-${Math.random().toString(36).slice(2)}`, BENCH_ENTRY.id, [{ role: "system", content: system }, ...history], opts);
  const visible = events.filter((e) => e.type === "answer" || e.type === "replace").map((e) => (e as { text: string }).text).join("");
  const answerReq = requests.filter((ms) => !sysOf(ms).startsWith(LOCATOR_SYS) && !sysOf(ms).startsWith(REWRITE_SYS)).at(-1);
  return {
    events, visible, requests,
    locatorCalls: requests.filter((ms) => sysOf(ms).startsWith(LOCATOR_SYS)).length,
    rewriteCalls: requests.filter((ms) => sysOf(ms).startsWith(REWRITE_SYS)).length,
    answerText: answerReq ? answerReq.map((m) => String(m.content)).join("\n") : "",
  };
}

const ask = (q: string): ChatMessage[] => [{ role: "user", content: q }];
const NW: KnowledgeFileLike = { id: "nw", name: "northwind.pdf", content: northwindReport() };
/** An Arabic guide beside the English report: a mixed-script project, where every question used to earn a rewrite. */
const AR_GUIDE: KnowledgeFileLike = {
  id: "ar", name: "dalil.pdf",
  content: Array.from({ length: 20 }, (_, i) => `[page ${i + 1}]\nالصفحة ${i + 1} من دليل الفرع تتحدث عن الخدمات والمواعيد.`).join("\n"),
};
const sectionsOfRequest = (text: string) => [...text.matchAll(/<section source="\d+" file="([^"]*)" place="([^"]*)">/g)].map((m) => `${m[1]} (${m[2]})`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetKnowledgeIndexes();
});

describe("a strong keyword match", () => {
  it("skips the locator and the rewrite, carries only the matched sections, and records its timings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-fast-"));
    const journal = path.join(dir, "turn.jsonl");
    const r = await turn([NW, AR_GUIDE], ask("How many employees did Northwind Energy have across its upstream and downstream segments?"), { dir, journal });
    expect(r.locatorCalls).toBe(0);
    expect(r.rewriteCalls).toBe(0);
    const rode = sectionsOfRequest(r.answerText);
    expect(rode[0]).toBe("northwind.pdf (p. 33)");
    expect(rode.length).toBeLessThanOrEqual(3);
    expect(r.answerText).toContain("18,240 employees");
    const step = readJournal(journal).entries.find((e) => e.type === "step" && (e as { id: string }).id.endsWith(":know")) as { input?: Record<string, unknown> } | undefined;
    expect(step?.input?.strong).toBe(true);
    expect(step?.input?.timings).toMatchObject({ indexMs: expect.any(Number), searchMs: expect.any(Number), packMs: expect.any(Number) });
    expect((step?.input?.timings as Record<string, number>).locatorMs).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a question in words the files do not use keeps the rewrite and the locator", async () => {
    const r = await turn([NW], ask("How much money went into investment projects between July and September?"), { rewrite: "capital expenditure Q3 2026", locator: "1" });
    expect(r.rewriteCalls).toBe(1);
    expect(r.locatorCalls).toBe(1);
    expect(r.answerText).toContain("SAR 9.6 billion");
  });

  it("a question that needs two sections (two quarters compared) keeps the locator", async () => {
    const r = await turn([NW], ask("Compare capital expenditure in Q2 2026 and Q3 2026."), { locator: "1, 2" });
    expect(r.locatorCalls).toBe(1);
    expect(r.answerText).toContain("SAR 9.6 billion");
    expect(r.answerText).toContain("SAR 8.7 billion");
  });

  it("REGRESSION (installed build): the locator and the rewrite ask for a short reply — the 4B looped '9,10,11,12,3,…' until the 45 s window ran out", async () => {
    const bodies: { messages: Msg[]; max_tokens?: number }[] = [];
    vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const sys = sysOf(body.messages);
      if (sys.startsWith(LOCATOR_SYS)) return sse("9,10,11,12,3,4,5,6,7,8,9,10,11,12");
      if (sys.startsWith(REWRITE_SYS)) return sse("capital expenditure Q3 2026");
      return sse("MODEL-ANSWER");
    });
    const events: ChatEvent[] = [];
    const project = { id: "p-cap", name: "Reports", description: "", instructions: "", files: [NW], created: 0, updated: 0 };
    const history = ask("How much money went into investment projects between July and September?");
    const system = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(BENCH_NCTX), contextTokens: BENCH_NCTX, conversationTokens: promptTokens(history) });
    await runChatOrchestrator(benchHost(events, null, null), "cap-1", BENCH_ENTRY.id, [{ role: "system", content: system }, ...history], { effort: null, subagents: false, projectId: project.id, knowledge: [NW] });
    const locate = bodies.find((b) => sysOf(b.messages).startsWith(LOCATOR_SYS));
    const rewrite = bodies.find((b) => sysOf(b.messages).startsWith(REWRITE_SYS));
    expect(locate?.max_tokens).toBe(24);
    expect(rewrite?.max_tokens).toBe(48);
    // the looping reply still leaves the supporting page in the request (BM25 fills after the picks)
    const answer = bodies.filter((b) => !sysOf(b.messages).startsWith(LOCATOR_SYS) && !sysOf(b.messages).startsWith(REWRITE_SYS)).at(-1)!;
    expect(answer.messages.map((m) => String(m.content)).join("\n")).toContain("SAR 9.6 billion");
  });

  it("REGRESSION (installed build): a rewrite that does not answer gives up after 45 s and the turn goes on (it streamed for 230 s)", async () => {
    vi.useFakeTimers();
    let rewriteStarted = false;
    const bodies: { messages: Msg[] }[] = [];
    vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const sys = sysOf(body.messages);
      if (sys.startsWith(REWRITE_SYS)) {
        rewriteStarted = true;
        // the recorded failure: tokens keep coming ("3000000..."), so no stall check ever fires
        let timer: ReturnType<typeof setInterval> | undefined;
        return new Response(new ReadableStream({
          start(c) {
            const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: "0" } }] })}\n\n`;
            timer = setInterval(() => c.enqueue(new TextEncoder().encode(chunk)), 1000);
            init!.signal!.addEventListener("abort", () => { clearInterval(timer); c.error(init!.signal!.reason); }, { once: true });
          },
          cancel() { clearInterval(timer); },
        }), { status: 200 });
      }
      if (sys.startsWith(LOCATOR_SYS)) return sse("1");
      return sse("MODEL-ANSWER");
    });
    const events: ChatEvent[] = [];
    const project = { id: "p-rw", name: "Reports", description: "", instructions: "", files: [NW], created: 0, updated: 0 };
    const history = ask("كم عدد موظفي نورثويند؟");
    const system = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(BENCH_NCTX), contextTokens: BENCH_NCTX, conversationTokens: promptTokens(history) });
    const t = runChatOrchestrator(benchHost(events, null, null), "rw-1", BENCH_ENTRY.id, [{ role: "system", content: system }, ...history], { effort: null, subagents: false, projectId: project.id, knowledge: [NW] });
    await vi.waitFor(() => expect(rewriteStarted).toBe(true));
    await vi.advanceTimersByTimeAsync(45_000);
    await t;
    vi.useRealTimers();
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(bodies.some((b) => sysOf(b.messages).startsWith(LOCATOR_SYS))).toBe(true);
  });

  it("a short reply never goes under Foundry Local's floor of 256 tokens (its NPU daemon dies under it)", () => {
    expect(shortReplyTokens({ id: "foundry:qwen3-4b" } as never, 24)).toBe(256);
    expect(shortReplyTokens({ id: "qwen3-4b" } as never, 24)).toBe(24);
  });

  it("an Arabic question over English files keeps the rewrite and the locator", async () => {
    const r = await turn([NW], ask("كم عدد موظفي نورثويند؟"), { rewrite: "Northwind employees", locator: "1" });
    expect(r.rewriteCalls).toBe(1);
    expect(r.locatorCalls).toBe(1);
    expect(r.answerText).toContain("18,240 employees");
  });

  it("the diagnostic line carries timings and counts, never the document's words or the question", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    await turn([NW], ask("How many employees did Northwind Energy have across its upstream and downstream segments?"));
    const know = lines.filter((l) => l.startsWith("[knowledge]"));
    expect(know.length).toBe(1);
    expect(know[0]).toMatch(/index [\d.]+ ms \((built|store|memory)\), search [\d.]+ ms, no rewrite, locator skipped \(strong match \d+%\), \d+ sections, \d+ characters; request \d+ tokens; first token .* s; turn [\d.]+ s/);
    expect(know[0]).not.toMatch(/18,240|employees|Northwind|upstream/i);
  });
});

describe("the index in memory", () => {
  it("a second question over the same files is served from memory; an edited or removed file is never answered from the old index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-memo-"));
    const a: KnowledgeFileLike = { id: "a", name: "a.md", content: "# Budget\nThe xylophone budget is 1997 dinars." };
    const b: KnowledgeFileLike = { id: "b", name: "b.md", content: "# Vendors\nThe marimba vendor is Harbor Music." };
    expect(openKnowledgeIndex(dir, "p", [a, b]).source).toBe("built");
    expect(openKnowledgeIndex(dir, "p", [a, b]).source).toBe("memory");
    // the store file is removed underneath: the store is the authority, the index is built and kept again
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    expect(openKnowledgeIndex(dir, "p", [a, b]).source).toBe("built");
    expect(fs.readdirSync(dir).length).toBe(1);
    // an edit: the old words are gone, the new ones are found
    const edited = { ...a, content: "# Budget\nThe xylophone budget is 2400 dinars." };
    const after = openKnowledgeIndex(dir, "p", [edited, b]);
    expect(after.source).toBe("built");
    expect(after.search("xylophone budget")[0].text).toContain("2400");
    expect(after.search("1997").length).toBe(0);
    // a removal: the removed file's sections are gone
    const removed = openKnowledgeIndex(dir, "p", [edited]);
    expect(removed.search("marimba vendor").length).toBe(0);
    expect(removed.sections().every((s) => s.fileId === "a")).toBe(true);
    // a new process (the memory forgotten) reads the store it wrote
    forgetKnowledgeIndexes();
    expect(openKnowledgeIndex(dir, "p", [edited]).source).toBe("store");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a store rewritten within the same clock tick, at the same size, is not answered from memory", () => {
    // A file's modification time moves in ticks; two writes inside one tick leave the same time.
    // The test pins both writes to one whole second so this happens on every run, as it did on CI.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-memo-"));
    const files: KnowledgeFileLike[] = [{ id: "f", name: "f.md", content: "# Notes\nThe heron count is 41." }];
    const store = path.join(dir, "p.json");
    const tick = Math.floor(Date.now() / 1000);
    expect(openKnowledgeIndex(dir, "p", files).source).toBe("built");
    fs.utimesSync(store, tick, tick);
    expect(openKnowledgeIndex(dir, "p", files).source).toBe("store"); // the memory now holds this time
    const stored = JSON.parse(fs.readFileSync(store, "utf8"));
    fs.writeFileSync(store, JSON.stringify({ ...stored, version: 2 })); // same size: one digit changed
    fs.utimesSync(store, tick, tick);
    const again = openKnowledgeIndex(dir, "p", files);
    expect(again.source).not.toBe("memory");
    expect(again.rebuilt).toBe(true);
    // and with nothing rewritten, the very next open is served from memory as before
    expect(openKnowledgeIndex(dir, "p", files).source).toBe("memory");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("holds at most four projects: the least recently asked is read from its store again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-memo-"));
    const files = (n: number): KnowledgeFileLike[] => [{ id: `f${n}`, name: `f${n}.md`, content: `# Part ${n}\nProject ${n} keeps its own notes.` }];
    for (let n = 1; n <= 5; n++) openKnowledgeIndex(dir, `p${n}`, files(n));
    expect(openKnowledgeIndex(dir, "p5", files(5)).source).toBe("memory");
    expect(openKnowledgeIndex(dir, "p1", files(1)).source).toBe("store");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("a reported figure quoted from the source", () => {
  it("names a period: the sentence that holds the entity, the period and the value is quoted and cited, with no model call", async () => {
    const r = await turn([NW], ask("What was net income for Q2 2026?"));
    expect(r.requests).toHaveLength(0);
    expect(r.visible).toContain("> Net income for Q2 2026 was SAR 6.9 billion.");
    expect(r.visible).toContain("northwind.pdf (p. 6)");
    expect(r.visible).not.toContain("7.4");
  });

  it("a date tied to a period is quoted the same way", async () => {
    const r = await turn([NW], ask("When is the Q2 2026 dividend payable?"));
    expect(r.requests).toHaveLength(0);
    expect(r.visible).toContain("payable on September 15, 2026");
    expect(r.visible).toContain("northwind.pdf (p. 20)");
  });

  it("two files that report different values for the same period are quoted side by side, never one picked silently", async () => {
    const restated: KnowledgeFileLike = { id: "r", name: "restatement.pdf", content: "[page 2]\nRestatement. Northwind Energy reported revenue of SAR 40.6 billion for Q3 2026 after the restatement." };
    const r = await turn([NW, restated], ask("What was Northwind's revenue in Q3 2026?"));
    expect(r.requests).toHaveLength(0);
    expect(r.visible).toContain("The sources do not agree on this figure");
    expect(r.visible).toContain("41.2");
    expect(r.visible).toContain("40.6");
    expect(r.visible).toContain("northwind.pdf (p. 5)");
    expect(r.visible).toContain("restatement.pdf (p. 1)");
  });

  it("no sentence ties the value to the period: the model answers, told to say when the evidence is missing or disagrees", async () => {
    const r = await turn([NW], ask("What was the operating margin in Q3 2026?"));
    expect(r.answerText).toContain("If the passages disagree, say so");
    expect(r.visible).toContain("MODEL-ANSWER");
  });

  it("a recheck after a wrong figure goes back to the source for the original question", async () => {
    const wrong = "Northwind's revenue in Q3 2026 was SAR 39.8 billion.";
    const r = await turn([NW], [
      { role: "user", content: "What was Northwind's revenue in Q3 2026?" },
      { role: "assistant", content: wrong },
      { role: "user", content: "Double check that" },
    ]);
    expect(r.requests).toHaveLength(0);
    expect(r.visible).toContain("I checked the source again.");
    expect(r.visible).toContain("revenue of SAR 41.2 billion for Q3 2026");
    expect(r.visible).toContain("northwind.pdf (p. 5)");
  });

  it("Aramco Q3 2026 note 18: the lookup and the recheck after a reversed answer cite page 43 and keep 49% and 51% for both HUMAIN entities", async () => {
    const report: KnowledgeFileLike = { id: "aramco", name: "aramco-q3-2026.pdf", content: aramcoReport() };
    const keep = (text: string) => {
      const flat = text.replace(/\s+/g, " ");
      expect(flat).toContain("acquisition of a 49% stake each in Al-Mustaqbal Lil-Thaka Al-Istinai Company and HUMAIN Limitless Fund LP");
      expect(flat).toContain("PIF retaining 51% ownership in both companies");
      expect(flat).toContain("aramco-q3-2026.pdf (p. 43)");
    };
    const first = await turn([report], ask("What is the percentage of Aramco in HUMAIN?"));
    keep(first.visible);
    const reversed = "Saudi Aramco owns 51% and PIF owns 49%.";
    const again = await turn([report], [
      { role: "user", content: "What is the percentage of Aramco in HUMAIN?" },
      { role: "assistant", content: reversed },
      { role: "user", content: "Is it the other way?" },
      { role: "assistant", content: reversed },
      { role: "user", content: "Double check and provide the correct info" },
    ]);
    keep(again.visible);
    expect(again.visible).not.toContain(reversed);
    expect(first.requests).toHaveLength(0);
    expect(again.requests).toHaveLength(0);
  });

  it("the finder's own rules: a period is a shape of the question; a value the question already names is not an answer", () => {
    expect(namesPeriod("What was revenue in Q3 2026?")).toBe(true);
    expect(namesPeriod("Free cash flow for the nine months?")).toBe(true);
    expect(namesPeriod("كم الإيرادات في الربع الثالث؟")).toBe(true);
    expect(namesPeriod("What is the xylophone budget?")).toBe(false);
    // the only number in the sentence is the question's own year: no value, no quote
    expect(figurePassage([{ id: "x", name: "x.md", content: "The annual report for 2026 was approved by the board." }], "When was the annual report for 2026 approved?")).toBeNull();
    // a heading word is not the whole subject: every subject word must sit in ONE sentence
    expect(figurePassage([NW], "What was revenue per employee in Q3 2026?")).toBeNull();
  });
});
