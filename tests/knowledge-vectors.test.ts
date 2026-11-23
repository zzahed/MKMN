import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ChatEvent, ChatMessage, ChatOptions } from "../src/shared/types";
import { runChatOrchestrator } from "../src/core/chatOrchestrator";
import { buildSystemPrompt, knowledgeBudget } from "../src/core/projects";
import { promptTokens } from "../src/core/context";
import { readJournal } from "../src/core/harness/journal";
import { forgetKnowledgeIndexes, openKnowledgeIndex } from "../src/core/knowledge/store";
import { filesHashOf, type KnowledgeFileLike } from "../src/core/knowledge/index";
import { UnigramTokenizer, meanPoolNormalize, type Embedder } from "../src/core/knowledge/embed";
import { forgetVectorIndexes, openVectorIndex } from "../src/core/knowledge/vectors";
import { installVectorModel, removeVectorModel, vectorModelInstalled, type VectorModelSpec } from "../src/core/knowledge/vectorModel";
import { mkmnPaths } from "../src/shared/paths";
import { BENCH_ENTRY, benchHost, northwindReport } from "./knowledgeBench";

/**
 * The multilingual vector path of the knowledge retrieval (measured in
 * docs/research/knowledge-retrieval-benchmark.md): a question BM25 does not
 * match strongly is searched by meaning; the model-written rewrite is not asked; the
 * locator's picks count only inside the vector top five (the installed 4B answered
 * "22, 23, 24, ..." and filled the budget with a disclaimer page). The embedder here is
 * a fake that maps English and Arabic words to shared concepts: what is tested is the
 * wiring, the store and the install; the real model's recall is the benchmark's.
 */

const CONCEPTS: string[][] = [
  ["employees", "staff", "people", "موظفي", "موظفين", "الموظفين", "عدد"],
  ["revenue", "sales", "ايرادات", "إيرادات"],
  ["dividend", "توزيعات", "ارباح", "أرباح"],
  ["capital", "expenditure", "investment", "استثمار"],
  ["borrowings", "debt", "ديون"],
  ["northwind", "نورثويند"],
  ["third", "q3", "الثالث"],
  ["second", "q2", "الثاني"],
  ["disclaimer", "notice"],
];
let embedCalls = 0;
const fakeEmbedder = (id = "fake-concepts-1"): Embedder => ({
  id, dim: CONCEPTS.length + 1,
  async embed(texts) {
    embedCalls += texts.length;
    return texts.map((t) => {
      const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u);
      const v = new Float32Array(CONCEPTS.length + 1);
      for (const w of words) CONCEPTS.forEach((c, i) => { if (c.includes(w)) v[i] += 1; });
      v[CONCEPTS.length] = 0.05; // never a zero vector
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
      return v.map((x) => x / n);
    });
  },
});

const LOCATOR_SYS = "You locate information in a long document.";
const REWRITE_SYS = "You write search words.";
const PART_SYS = "You summarize one part of a longer document";
type Msg = { role: string; content: unknown };
const sysOf = (ms: Msg[]): string => String(ms.find((m) => m.role === "system")?.content ?? "");
const sse = (text: string): Response => {
  const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } })}`, "data: [DONE]", ""];
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); } }), { status: 200 });
};

const NW: KnowledgeFileLike = { id: "nw", name: "northwind.pdf", content: northwindReport() };
/** Another report whose first pages are long disclaimers: the page the installed locator's count landed on. */
const OTHER: KnowledgeFileLike = {
  id: "ot", name: "other-report.pdf",
  content: Array.from({ length: 30 }, (_, i) => `[page ${i + 1}]\n${i === 21 ? `Disclaimer notice. ${"This report contains forward looking statements. ".repeat(80)}` : `Page ${i + 1} of the other company's report on its operations.`}`).join("\n"),
};

async function turn(question: string, o: { embedder?: Embedder | null; locator?: string; journal?: string; dir?: string | null } = {}) {
  const requests: Msg[][] = [];
  vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Msg[] };
    requests.push(body.messages);
    const sys = sysOf(body.messages);
    if (sys.startsWith(LOCATOR_SYS)) return sse(o.locator ?? "none");
    if (sys.startsWith(REWRITE_SYS)) return sse("3000000000000000");
    if (sys.startsWith(PART_SYS) || sys.startsWith("You write the summary")) return sse("A summary.");
    return sse("MODEL-ANSWER");
  });
  const files = [NW, OTHER];
  const events: ChatEvent[] = [];
  const history: ChatMessage[] = [{ role: "user", content: question }];
  const project = { id: "p-vec", name: "Reports", description: "", instructions: "", files, created: 0, updated: 0 };
  // a 4,096-token window, as on the device: the knowledge budget is 4,778 characters
  const nctx = 4096;
  const system = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(nctx), contextTokens: nctx, conversationTokens: promptTokens(history) });
  const base = benchHost(events, o.dir ?? null, null);
  const host = { ...base, ensureServer: async () => ({ endpoint: "http://127.0.0.1:9/v1", status: () => ({ nctx }) }), harnessJournalFile: () => o.journal ?? null, embedder: async () => (o.embedder === undefined ? fakeEmbedder() : o.embedder) };
  const opts: ChatOptions = { effort: null, subagents: false, projectId: project.id, knowledge: files };
  await runChatOrchestrator(host, `vec-${Math.random().toString(36).slice(2)}`, BENCH_ENTRY.id, [{ role: "system", content: system }, ...history], opts);
  const answer = requests.filter((ms) => ![LOCATOR_SYS, REWRITE_SYS, PART_SYS, "You write the summary"].some((p) => sysOf(ms).startsWith(p))).at(-1);
  const answerText = answer ? answer.map((m) => String(m.content)).join("\n") : "";
  return {
    events, requests, answerText,
    rode: [...answerText.matchAll(/<section source="\d+" file="([^"]*)" place="([^"]*)">/g)].map((m) => `${m[1]} (${m[2]})`),
    rewriteCalls: requests.filter((ms) => sysOf(ms).startsWith(REWRITE_SYS)).length,
    locatorCalls: requests.filter((ms) => sysOf(ms).startsWith(LOCATOR_SYS)).length,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetKnowledgeIndexes();
  forgetVectorIndexes();
  embedCalls = 0;
});

describe("the vector path of the retrieval", () => {
  it("REGRESSION (installed build): an Arabic question over English files finds its page by meaning; the junk rewrite is not asked and a counting locator reply cannot push it out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-vec-"));
    const journal = path.join(dir, "turn.jsonl");
    const r = await turn("كم عدد موظفي نورثويند؟", { locator: "22, 23, 24, 25, 26, 27,", journal, dir });
    expect(r.rewriteCalls).toBe(0);
    expect(r.rode[0]).toBe("northwind.pdf (p. 33)");
    expect(r.answerText).toContain("18,240 employees");
    expect(r.answerText).not.toContain("forward looking statements");
    const step = readJournal(journal).entries.find((e) => e.type === "step" && (e as { id: string }).id.endsWith(":know")) as { input?: Record<string, unknown> } | undefined;
    expect(step?.input?.rewrite).toBe("vectors");
    expect(step?.input?.vectors).toMatchObject({ model: "fake-concepts-1", source: "built" });
    expect((step?.input?.timings as Record<string, number>).vectorMs).toEqual(expect.any(Number));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a locator pick inside the vector top five rides first; whole-material requests still go map-reduce", async () => {
    const picked = await turn("How many people work at Northwind?", { locator: "2" });
    expect(picked.locatorCalls).toBe(1);
    expect(picked.rode.length).toBeGreaterThan(1);
    const all = await turn("Give me an overview of the documents.", { locator: "all" });
    expect(all.answerText).toContain("<summary of the files, made part by part>");
  });

  it("a strong keyword match never asks the embedder", async () => {
    const r = await turn("How many employees did Northwind Energy have across its upstream and downstream segments?");
    expect(embedCalls).toBe(0);
    expect(r.rode[0]).toBe("northwind.pdf (p. 33)");
  });

  it("without the model (no embedder) the rewrite path runs as before", async () => {
    const r = await turn("كم عدد موظفي نورثويند؟", { embedder: null, locator: "none" });
    expect(r.rewriteCalls).toBe(1);
  });
});

describe("the vector store", () => {
  const sectionsOf = (files: KnowledgeFileLike[]) => openKnowledgeIndex(null, "vs", files).sections();

  it("embeds once, then serves memory and the store; an edit, a removal or another model embeds again", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-vecstore-"));
    const files = [NW];
    const emb = fakeEmbedder();
    expect((await openVectorIndex(dir, "p", filesHashOf(files), sectionsOf(files), emb)).source).toBe("built");
    const firstCalls = embedCalls;
    expect((await openVectorIndex(dir, "p", filesHashOf(files), sectionsOf(files), emb)).source).toBe("memory");
    forgetVectorIndexes();
    expect((await openVectorIndex(dir, "p", filesHashOf(files), sectionsOf(files), emb)).source).toBe("store");
    expect(embedCalls).toBe(firstCalls);
    const edited = [{ ...NW, content: NW.content.replace("18,240 employees", "19,105 employees") }];
    expect((await openVectorIndex(dir, "p", filesHashOf(edited), sectionsOf(edited), emb)).source).toBe("built");
    const two = [NW, OTHER];
    const v2 = await openVectorIndex(dir, "p", filesHashOf(two), sectionsOf(two), emb);
    expect(v2.count).toBe(sectionsOf(two).length);
    const removed = await openVectorIndex(dir, "p", filesHashOf([NW]), sectionsOf([NW]), emb);
    expect(removed.count).toBe(sectionsOf([NW]).length);
    expect((await openVectorIndex(dir, "p", filesHashOf([NW]), sectionsOf([NW]), fakeEmbedder("fake-concepts-2"))).source).toBe("built");
    // a damaged store is a store that does not exist
    forgetVectorIndexes();
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".vectors"))!;
    fs.writeFileSync(path.join(dir, file), fs.readFileSync(path.join(dir, file)).subarray(0, 100));
    expect((await openVectorIndex(dir, "p", filesHashOf([NW]), sectionsOf([NW]), fakeEmbedder("fake-concepts-2"))).source).toBe("built");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the multilingual model's install", () => {
  const bytesA = Buffer.from("onnx model bytes for the test");
  const bytesB = Buffer.from(JSON.stringify({ model: { type: "Unigram", unk_id: 0, vocab: [["<unk>", 0]] } }));
  const spec = (sha: string): VectorModelSpec => ({
    id: "test-model", label: "Test model", license: "Apache-2.0",
    files: [
      { name: "model_quantized.onnx", url: "https://example.test/model", sha256: createHash("sha256").update(bytesA).digest("hex"), bytes: bytesA.length },
      { name: "tokenizer.json", url: "https://example.test/tok", sha256: sha, bytes: bytesB.length },
    ],
  });
  const fakeFetch = (async (url: string) => new Response(url.endsWith("/model") ? bytesA : bytesB, { status: 200 })) as unknown as typeof fetch;

  it("installs only files that match their pinned SHA-256, and removes them on request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vecmodel-"));
    const good = spec(createHash("sha256").update(bytesB).digest("hex"));
    const st = await installVectorModel(dir, good, fakeFetch);
    expect(st.error).toBeUndefined();
    expect(vectorModelInstalled(dir, good)).toBe(true);
    expect(removeVectorModel(dir, good).installed).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a file that does not match is refused by name, and nothing is left behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vecmodel-"));
    const bad = spec("0".repeat(64));
    const st = await installVectorModel(dir, bad, fakeFetch);
    expect(st.error).toMatch(/tokenizer\.json did not match its published fingerprint/);
    expect(st.installed).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lives in the one path layout", () => {
    expect(mkmnPaths({ LOCALAPPDATA: "C:\\L" } as NodeJS.ProcessEnv).embeddingsDir).toBe(path.join("C:\\L", "MKMN", "Embeddings"));
  });
});

describe("the tokenizer and the pooling", () => {
  const tok = new UnigramTokenizer({
    model: {
      type: "Unigram", unk_id: 3,
      vocab: [["<s>", 0], ["<pad>", 0], ["</s>", 0], ["<unk>", 0], ["\u2581", -2], ["\u2581re", -3], ["venue", -3], ["\u2581revenue", -4], ["\u2581r", -5], ["e", -5], ["v", -5], ["n", -5], ["u", -5], ["\u2581q", -4], ["3", -4]],
    },
    added_tokens: [{ id: 0, content: "<s>" }, { id: 1, content: "<pad>" }, { id: 2, content: "</s>" }, { id: 3, content: "<unk>" }],
  }, 8);

  it("splits each word into the pieces whose scores add up highest, marks unknown characters, and wraps <s> ... </s>", () => {
    expect(tok.encode("revenue")).toEqual([0, 7, 2]); // one piece (-4) beats "▁re" + "venue" (-6)
    // NFKC keeps case: "Q" has no piece, so it is the unknown token between the metaspace and "3"
    expect(tok.encode("  Q3\t")).toEqual([0, 4, 3, 14, 2]);
  });

  it("cuts at the token limit, keeping the closing token", () => {
    const ids = tok.encode("revenue revenue revenue revenue revenue revenue revenue revenue revenue");
    expect(ids.length).toBe(8);
    expect(ids[0]).toBe(0);
    expect(ids.at(-1)).toBe(2);
  });

  it("averages only the real tokens and returns unit vectors", () => {
    const hidden = Float32Array.from([1, 0, 3, 0, 99, 99]); // [1 batch, 3 tokens, 2 dims], the last is padding
    const [v] = meanPoolNormalize(hidden, [[1, 1, 0]], 2);
    expect(v[0]).toBeCloseTo(1);
    expect(v[1]).toBeCloseTo(0);
  });
});
