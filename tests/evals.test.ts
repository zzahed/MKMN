// The eval runs: the three frozen datasets (tests/fixtures/evals/)
// scored through the app's own code paths with the fake models in place of a
// server — no live call anywhere. The run records are APPENDED to a scratch
// file (one JSON object per line), proving the append-only writer; the real
// runs through the sidecar append their records the same way.
//
// Targets checked here:
//  - identity: 100% (the block rides, the guard corrects the wrong name, the
//    voice says no markers, the block rides after a compaction too);
//  - long conversations: the old behaviour overflows every one of the ten
//    (the baseline), compaction and compaction+recall overflow none, and the
//    recall brings the early fact back in at least 85%;
//  - knowledge: hit@4 at least 85% overall and 70% across the language line,
//    the answer's citations all checked against what rode, no invented
//    citation left standing in any final text.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { datasetHashOf, evaluateIdentityCase, evaluateKnowledgeCase, evaluateLongConversationCase, appendRunRecord, summarizeRun, type EvalDataset } from "../src/core/harness/evals";
import { openKnowledgeIndex } from "../src/core/knowledge/store";
import { readOffice } from "../src/core/office";
import { extractPdfText } from "../src/core/pdf";

const HERE = join(fileURLToPath(import.meta.url), "..");
const FIXTURES = join(HERE, "fixtures", "evals");

const loadDataset = (name: string): EvalDataset => {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as EvalDataset;
  // the frozen fingerprint: a hand-edited dataset refuses to run
  expect(datasetHashOf(parsed.cases), name).toBe(parsed.hash);
  return parsed;
};

const identityDataset = loadDataset("identity.json");
const longDataset = loadDataset("long-conversations.json");
const knowledgeDataset = loadDataset("knowledge.json");

const NCTX = 2048;
const MAX_TOKENS = 512;

// ---------------------------------------------------------------- the identity runs

describe("the identity eval run", () => {
  it("every case passes: the block rides, the guard corrects, the voice is clean, the compaction keeps the block", async () => {
    const results = [];
    for (const c of identityDataset.cases) results.push(await evaluateIdentityCase(c, { nctx: NCTX, maxTokens: MAX_TOKENS }));
    const summary = summarizeRun(results);
    expect(summary.passed).toBe(summary.cases);
    expect(summary.identityRode).toBe(1);
    expect(summary.wrongGone).toBe(1);
    expect(summary.namesSelf).toBe(1);
    expect(summary.voiceClean).toBe(1);
    expect(summary.rodeAfterCompaction).toBe(1);
  });
});

// ---------------------------------------------------------------- the long-conversation runs

describe("the long-conversation eval run", () => {
  const cases = longDataset.cases;

  it("the old behaviour overflows every conversation (the baseline fixes)", async () => {
    const results = [];
    for (const c of cases) results.push(await evaluateLongConversationCase(c, "old", { nctx: NCTX, maxTokens: MAX_TOKENS }));
    expect(results.every((r) => r.metrics.overflow === 1), results.filter((r) => !r.pass).map((r) => r.id).join(",")).toBe(true);
  });

  it("compaction alone: no overflow anywhere", async () => {
    const results = [];
    for (const c of cases) results.push(await evaluateLongConversationCase(c, "compaction", { nctx: NCTX, maxTokens: MAX_TOKENS }));
    expect(results.every((r) => r.metrics.overflow === 0), results.filter((r) => !r.pass).map((r) => r.id).join(",")).toBe(true);
  });

  it("compaction with recall: no overflow, and the early fact is recalled in at least 85% of the conversations", async () => {
    const results = [];
    for (const c of cases) results.push(await evaluateLongConversationCase(c, "compaction+recall", { nctx: NCTX, maxTokens: MAX_TOKENS }));
    const summary = summarizeRun(results);
    expect(summary.overflow).toBe(0);
    expect(summary.factRecalled, results.filter((r) => !r.metrics.factRecalled).map((r) => r.id).join(",")).toBeGreaterThanOrEqual(0.85);
  });
});

// ---------------------------------------------------------------- the knowledge runs

/** The corpus as the app reads it: the fixtures through the real extractors (pdf.js, the office readers), the scanned pages through the frozen OCR words. */
async function evalCorpus(): Promise<{ id: string; name: string; content: string }[]> {
  const dir = join(HERE, "fixtures", "knowledge");
  const files: { id: string; name: string; content: string }[] = [];
  const pdfjsDoc = async (bytes: Uint8Array) => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
  };
  const bytesOf = (name: string): Uint8Array => {
    const buf = readFileSync(join(dir, name));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };
  const ocrPages = knowledgeDataset.ocr?.find((o) => o.file === "scanned-notices.pdf")?.pages ?? [];
  for (const [name, withOcr] of [["handbook-en.pdf", false], ["dalil-ar.pdf", false], ["scanned-notices.pdf", true]] as const) {
    const doc = await pdfjsDoc(bytesOf(name));
    const text = await extractPdfText(doc as never, 2_000_000, withOcr ? { ocr: async (n: number) => ocrPages[n - 1] ?? "" } : undefined);
    files.push({ id: name, name, content: text });
  }
  for (const [name, kind] of [["staff-handbook.docx", "docx"], ["equipment.xlsx", "xlsx"], ["renovation-plan.pptx", "pptx"]] as const) {
    files.push({ id: name, name, content: await readOffice(kind, readFileSync(join(dir, name))) });
  }
  return files;
}

describe("the knowledge eval run", () => {
  it("hit@4, citations and answers, over the real fixture index", async () => {
    const corpus = await evalCorpus();
    expect(corpus.find((f) => f.name === "scanned-notices.pdf")!.content).toContain("[scanned text]");
    const index = openKnowledgeIndex(null, "evals", corpus);
    expect(index.count).toBeGreaterThan(200); // the handbook's 200 pages ride as sections

    const results: ReturnType<typeof evaluateKnowledgeCase>[] = [];
    for (const c of knowledgeDataset.cases) results.push(evaluateKnowledgeCase(c, index, { nctx: NCTX }));
    const summary = summarizeRun(results);

    // the targets
    expect(summary.hitAt4, results.filter((r) => !r.metrics.hitAt4).map((r) => r.id).join(",")).toBeGreaterThanOrEqual(0.85);
    const cross = results.filter((r) => r.metrics.crossLanguage);
    // The cross-language gate was 0.7; the rewrite seam (per-file script
    // crossing, the scripts named to the rewrite model, the merged search) measured
    // 3/4 on the fixture corpus, so the gate holds it (the real runs lost 0/4).
    expect(cross.reduce((n, r) => n + r.metrics.hitAt4, 0) / cross.length, cross.filter((r) => !r.metrics.hitAt4).map((r) => r.id).join(",")).toBeGreaterThanOrEqual(0.75);
    expect(summary.inventedLeft, results.filter((r) => r.metrics.inventedLeft > 0).map((r) => r.id).join(",")).toBe(0);
    // where the fact was found among the top 4, it rides the pack, the answer holds it, and the citation stands
    for (const r of results.filter((x) => x.metrics.hitAt4 === 1)) {
      expect(r.metrics.retrievalRide, r.id).toBe(1);
      expect(r.metrics.answerAccuracy, r.id).toBe(1);
      expect(r.metrics.citedCorrectly, r.id).toBe(1);
    }
  });
});

// ---------------------------------------------------------------- the append-only record

describe("the eval run records", () => {
  it("append to the results file, never rewrite it", async () => {
    const file = path.join(os.tmpdir(), `mkmn-eval-records-${process.pid}.jsonl`);
    try {
      const c = identityDataset.cases[0];
      const r1 = await evaluateIdentityCase(c, { nctx: NCTX, maxTokens: MAX_TOKENS });
      appendRunRecord(file, { dataset: "identity", datasetHash: identityDataset.hash, started: "t0", finished: "t1", results: [r1], summary: summarizeRun([r1]) });
      const first = readFileSync(file, "utf8");
      expect(first.split("\n").filter((l) => l.trim()).length).toBe(1);
      // a second run appends a second line; the first stands untouched
      const r2 = await evaluateIdentityCase(identityDataset.cases[1], { nctx: NCTX, maxTokens: MAX_TOKENS });
      appendRunRecord(file, { dataset: "identity", datasetHash: identityDataset.hash, started: "t2", finished: "t3", results: [r2], summary: summarizeRun([r2]) });
      const both = readFileSync(file, "utf8");
      expect(both.startsWith(first)).toBe(true);
      expect(both.split("\n").filter((l) => l.trim()).length).toBe(2);
      const parsed = both.trim().split("\n").map((l) => JSON.parse(l) as { dataset: string; results: { id: string }[] });
      expect(parsed[0].results[0].id).toBe(identityDataset.cases[0].id);
      expect(parsed[1].results[0].id).toBe(identityDataset.cases[1].id);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
