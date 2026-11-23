import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry, ChatEvent, ChatMessage, ChatOptions, HardwareProfile, Project, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { buildSystemPrompt, knowledgeBudget } from "../src/core/projects";
import { appendInstructions, type Relevance } from "../src/core/prompts";
import { citeAnswer, citationGuardStep, spokenOf, unsupportedFigures, unsupportedNotice, type CitedSection } from "../src/core/cite";
import { packSections, type RetrSection } from "../src/core/knowledge/retrieve";
import { identityGuardStep } from "../src/core/harness/identity";
import { promptTokens } from "../src/core/context";
import { readJournal } from "../src/core/harness/journal";

/**
 * Citations for the knowledge sections: the sections ride the
 * request as `<section source="N">` blocks, the model cites them as [source N],
 * and the number is checked against the sections actually provided — an
 * invented number is dropped, the Sources line names what stands. The check
 * rides the turn's run as the caller's afterStep hook (after the identity
 * guard), and neither the voice nor the screen reads a citation aloud.
 */

const ENTRY: CatalogEntry = {
  id: "test-1b", name: "Test 1B", repo: "org/test-1b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};

const HW: HardwareProfile = { chipName: "Test Chip", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8 };
const baseSettings = (): Settings => ({ selectedModelId: "test-1b", webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false } as unknown as Settings);
const NCTX = 2048;

// ------------------------------------------------------------------ core units

const LOADED: CitedSection[] = [
  { file: "report.pdf", place: "p. 150" },
  { file: "notes.docx", place: "p. 3" },
  { file: "plan.xlsx", place: "Budget rows 41-80" },
];

describe("the citation instruction rides only with loaded sections", () => {
  const base: Relevance = { artifacts: false, office: false, drawn: false, visual: null, web: false, images: false, agents: false };

  it("rides when the request carries retrieved sections (citations: true)", () => {
    const appends = appendInstructions({ ...base, citations: true }, NCTX, 0);
    expect(appends.text).toContain("[source N]");
    expect(appends.text).toContain("never invent a source");
  });

  it("never rides when the flag is unset or false (the deliberate opt-in: no loaded sections, no citation rules)", () => {
    expect(appendInstructions(base, NCTX, 0).text).not.toContain("[source N]");
    expect(appendInstructions({ ...base, citations: false }, NCTX, 0).text).not.toContain("[source N]");
  });
});

describe("citeAnswer", () => {
  it("keeps valid markers, drops invented ones, and the invented list names what was dropped", () => {
    const r = citeAnswer("The budget is 1997 dinars [source 1]. The gardens cost 5 dinars [source 9].", LOADED);
    expect(r.text).toContain("[source 1]");
    expect(r.text).not.toContain("[source 9]");
    expect(r.invented).toEqual([9]);
    expect(r.cited).toEqual([1]);
    // the prose around a dropped marker is not left tattered
    expect(r.text).toContain("5 dinars.");
  });

  it("the Sources line lists the cited sections as [N] file (place), numbered so the screen's chips can read it back", () => {
    const r = citeAnswer("One [source 2] and two [source 1] and again one [source 1].", LOADED);
    expect(r.cited).toEqual([2, 1]); // first use order
    expect(r.text.trimEnd().endsWith("Sources: [2] notes.docx (p. 3), [1] report.pdf (p. 150)")).toBe(true);
  });

  it("no markers, no Sources line — the answer is returned unchanged", () => {
    const r = citeAnswer("A plain answer with no citations.", LOADED);
    expect(r.text).toBe("A plain answer with no citations.");
    expect(r.cited).toEqual([]);
    expect(r.invented).toEqual([]);
  });

  it("nothing loaded: every marker is invented and dropped", () => {
    const r = citeAnswer("Claimed [source 1] and [source 2].", []);
    expect(r.text).toBe("Claimed and.");
    expect(r.invented).toEqual([1, 2]);
  });

  it("running twice adds the Sources line once (the hook corrects the step, the turn corrects the screen answer)", () => {
    const once = citeAnswer("Said [source 1].", LOADED).text;
    const twice = citeAnswer(once, LOADED).text;
    expect(twice).toBe(once);
  });

  it("markers inside words or a code sample are left alone unless invented", () => {
    const r = citeAnswer("`[source 1]` in code stays [source 1].", LOADED);
    expect(r.cited).toEqual([1]);
  });
});

describe("the citation hook on the turn's steps", () => {
  it("corrects reply and output of an ok step that carries markers; steps without markers pass untouched", () => {
    const hook = citationGuardStep(LOADED);
    const step = { status: "ok", reply: "Said [source 1] and [source 7].", output: "Said [source 1] and [source 7]." };
    const fixed = hook(step);
    expect(fixed.reply).not.toContain("[source 7]");
    expect(fixed.reply).toContain("[source 1]");
    expect(fixed.output).toBe(fixed.reply);
    // the locator's "1, 2" reply and the retrieval body carry no markers: untouched
    const locator = { status: "ok", reply: "1, 2", output: "1, 2" };
    expect(hook(locator)).toBe(locator);
    const section = { status: "ok", reply: '<section source="1" file="a">text</section>', output: "x" };
    expect(hook(section)).toBe(section);
  });

  it("a step that did not settle ok has no answer to correct", () => {
    const hook = citationGuardStep(LOADED);
    const step = { status: "failed", reply: "Said [source 7].", output: "Said [source 7]." };
    expect(hook(step)).toBe(step);
  });
});

describe("the identity guard and the citation hook compose", () => {
  it("each does its own work on the same step, in the run's order (identity first, citations second), neither disturbing the other", () => {
    const reply = "I'm Qwen, made by Meta. The budget is 1997 dinars [source 1], the gardens cost 5 dinars [source 9].";
    const step = { status: "ok", reply, output: reply };
    // runHooks' order: identityGuardStep first, then the caller's hook
    const fixed = citationGuardStep(LOADED)(identityGuardStep(step));
    expect(fixed.reply).toContain("I'm MKMN AI");
    expect(fixed.reply).not.toContain("Meta");
    expect(fixed.reply).toContain("[source 1]");
    expect(fixed.reply).not.toContain("[source 9]");
    // the sentence that needed no guard is byte-identical
    expect(fixed.reply).toContain("The budget is 1997 dinars [source 1], the gardens cost 5 dinars.");
  });

  it("the identity guard's untouched output passes through the citation hook unchanged when it has no markers", () => {
    const step = { status: "ok", reply: "I am MKMN AI.", output: "I am MKMN AI." };
    expect(citationGuardStep(LOADED)(identityGuardStep(step))).toBe(step);
  });
});

describe("spokenOf", () => {
  it("strips the markers and the Sources line; what is left is what is said", () => {
    const answered = citeAnswer("The budget is 1997 dinars [source 1]. Nothing else [source 9].", LOADED).text;
    expect(spokenOf(answered)).toBe("The budget is 1997 dinars. Nothing else.");
  });

  it("a sentence that is only a marker is not spoken at all", () => {
    expect(spokenOf("[source 1]")).toBe("");
    expect(spokenOf("Sources: [1] report.pdf (p. 150)")).toBe("");
  });
});

describe("the packed sections carry the citation's shape", () => {
  const sec = (n: number): RetrSection => ({ doc: n, fileId: `f${n}`, file: `book.pdf`, title: `Part ${n}`, text: `Text of part ${n}, long enough to matter. `.repeat(2), page: n });

  it("packSections returns the loaded sections in source order with their places (the orchestrator fills its citation list from this)", () => {
    const packed = packSections([sec(1), sec(2), sec(3)], [2, 0], 10_000);
    expect(packed.loaded).toMatchObject([
      { file: "book.pdf", place: "p. 3", text: sec(3).text },
      { file: "book.pdf", place: "p. 1", text: sec(1).text },
    ]);
    // and the body numbers them in the same order
    expect(packed.body.indexOf('source="1"')).toBeLessThan(packed.body.indexOf('source="2"'));
    expect(packed.body).toContain('place="p. 3"');
  });

  it("a section that does not fit is not in the loaded list (a source that never rode cannot be cited)", () => {
    const big: RetrSection = { ...sec(9), text: "X".repeat(5_000) };
    const packed = packSections([sec(1), big], [1, 0], 300);
    expect(packed.loaded).toMatchObject([{ file: "book.pdf", place: "p. 1" }]);
    expect(packed.loaded).toHaveLength(1); // the small section rode, the big one was left out
    expect(packed.leftOut).toBe(1);
  });
});

// ------------------------------------------------------------------ the turn's wiring

const sse = (text: string): Response => {
  const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } })}`, "data: [DONE]", ""];
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); }
  }), { status: 200 });
};

type Body = { messages: { role: string; content: unknown }[] };

const sysOf = (b: Body): string => String((b.messages ?? []).find((m: { role: string }) => m.role === "system")?.content ?? "");

function scriptedFetch(bodies: Body[], bySystem: { starts: string; reply: string }[], answer: string) {
  return vi.fn(async (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const sys = sysOf(body);
    for (const r of bySystem) if (sys.startsWith(r.starts)) return sse(r.reply);
    return sse(answer);
  });
}

function fakeHost(o: {
  events: ChatEvent[];
  journalFile: string | null;
  settings: Settings;
  fetch: ReturnType<typeof scriptedFetch>;
  knowledgeDir?: string | null;
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
    ...(o.knowledgeDir !== undefined ? { knowledgeDir: () => o.knowledgeDir } : {}),
    router: { sort: async () => null, yesNo: async () => false, query: async () => null, fileKind: async () => null },
  };
}

const LOCATOR_SYS = "You locate information in a long document.";

const longPdf = (fact: boolean): string =>
  Array.from({ length: 200 }, (_, i) =>
    `[page ${i + 1}]\nPage ${i + 1} talks about topic ${i}. It carries planning detail for the year and nothing more.` +
    (fact && i === 149 ? " The xylophone budget is 1997 dinars." : "")
  ).join("\n");

const packedProject = (content: string): Project => ({
  id: "p-1", name: "Household", description: "", instructions: "",
  files: [{ id: "f1", name: "report.pdf", content }],
  created: 0, updated: 0
});
const packedSystem = (content: string): string =>
  buildSystemPrompt({ project: packedProject(content), knowledgeChars: knowledgeBudget(NCTX), contextTokens: NCTX, conversationTokens: promptTokens([{ role: "user", content: "What is the xylophone budget?" }]) });
const OPTS = (content: string): ChatOptions => ({
  effort: null, subagents: false, projectId: "p-1",
  knowledge: [{ id: "f1", name: "report.pdf", content }],
});
const MSGS = (sys: string, question: string): ChatMessage[] => [
  { role: "system", content: sys },
  { role: "user", content: question }
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a cited sentence's figures are checked against what its sources hold", () => {
  // 2026-11-17 review: the guard proved a [source N] marker named a section that rode, not that
  // the section says what the sentence says. The figures of a cited sentence are now compared
  // with the cited passage's text, and a figure it does not hold is reported (never removed).
  const loaded: CitedSection[] = [
    { file: "budget.xlsx", place: "Sheet1", text: "The xylophone budget is 1,997 dinars. Growth was 12.50% over 2025." },
    { file: "plan.pdf", place: "p. 2", text: "The garden budget is ٣١٠٠٠ dinars." },
  ];

  it("passes figures the cited passage holds, written with or without separators, zeros or Arabic digits", () => {
    expect(unsupportedFigures("The budget is 1997 dinars [source 1]. Growth was 12.5% [source 1].", loaded)).toEqual([]);
    expect(unsupportedFigures("The garden needs 31,000 dinars [source 2].", loaded)).toEqual([]);
  });

  it("names a figure the cited passage does not hold, with the sources it cites", () => {
    expect(unsupportedFigures("The budget is 1998 dinars [source 1]. The garden needs 31000 [source 2].", loaded)).toEqual([{ figure: "1998", sources: [1] }]);
    expect(unsupportedFigures("Both cost 5000 [source 1][source 2].", loaded)).toEqual([{ figure: "5000", sources: [1, 2] }]);
  });

  it("does not judge uncited sentences, small counts, or sections whose text is unknown", () => {
    expect(unsupportedFigures("I found 3 parts. The total is 777.", loaded)).toEqual([]);
    expect(unsupportedFigures("It has 3 rooms [source 1].", loaded)).toEqual([]);
    expect(unsupportedFigures("The quote says 4242 [source 1].", [{ file: "q", place: "p" }])).toEqual([]);
  });

  it("the notice names the figures and asks the person to check them", () => {
    expect(unsupportedNotice([])).toBeNull();
    expect(unsupportedNotice([{ figure: "1998", sources: [1] }])).toBe("A figure in this answer is not written that way in the passage it cites: 1998 [source 1]. Check it against the source.");
  });
});

describe("citations on the turn", () => {
  it("the answer's request carries the citation rules when sections were loaded, and an invented marker is corrected on the screen", async () => {
    const content = longPdf(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cite-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }], "The xylophone budget is 1997 dinars [source 1]. The gardens cost 5 dinars [source 999].");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-1", ENTRY.id, MSGS(sys, "What is the xylophone budget?"), OPTS(content));

    // the answer request rides the citation rules (sections were loaded)
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(sysOf(answerReq)).toContain("never invent a source");

    // the screen is corrected: the invented [source 999] is gone, the real [source 1] stands, the Sources line names the section
    const replace = events.find((e) => e.type === "replace") as { type: string; text: string } | undefined;
    expect(replace).toBeDefined();
    expect(replace!.text).toContain("[source 1]");
    expect(replace!.text).not.toContain("[source 999]");
    expect(replace!.text.trimEnd().endsWith("Sources: [1] report.pdf (p. 150)")).toBe(true);

    // the step's journaled reply was corrected by the hook too (the invented marker never lands in the journal as an answer)
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; reply?: string }[];
    const answer = steps.filter((s) => s.id === "t-1").at(-1); // the streamed answer is the turn's own step
    expect(answer?.reply).not.toContain("[source 999]");
    expect(answer?.reply).toContain("[source 1]");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a cited figure the section does not hold is named in a notice, and a held one is not", async () => {
    const content = longPdf(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cite-"));
    for (const [reply, flagged] of [["The xylophone budget is 1998 dinars [source 1].", true], ["The xylophone budget is 1997 dinars [source 1].", false]] as const) {
      const events: ChatEvent[] = [];
      const bodies: Body[] = [];
      const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }], reply);
      vi.stubGlobal("fetch", fetchFn);
      await runChatOrchestrator(fakeHost({ events, journalFile: path.join(dir, `t-${flagged}.jsonl`), settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-f", ENTRY.id, MSGS(sys, "What is the xylophone budget?"), OPTS(content));
      const notices = events.filter((e) => e.type === "notice").map((e) => (e as { text: string }).text).filter((t) => /not written that way/.test(t));
      expect(notices, reply).toHaveLength(flagged ? 1 : 0);
      if (flagged) expect(notices[0]).toContain("1998 [source 1]");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a stray invented marker above what rode is still dropped from what the person sees (sections ride now even on a none locator)", async () => {
    const content = longPdf(false);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cite-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "none" }], "Nothing in the files says that [source 999].");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-2", ENTRY.id, MSGS(sys, "What is the xylophone budget?"), OPTS(content));

    // The BM25 order fills the budget whatever the locator answers, so sections
    // rode and the citation rules ride with them
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(sysOf(answerReq)).toContain("never invent a source");

    const replace = events.find((e) => e.type === "replace") as { type: string; text: string } | undefined;
    expect(replace).toBeDefined();
    expect(replace!.text).not.toContain("[source 999]");
    expect(replace!.text).not.toContain("Sources:"); // nothing real was cited: no Sources line
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
