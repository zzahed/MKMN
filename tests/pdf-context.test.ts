// Regression tests for the fixes: PDF errors and progress, the context meter that
// must measure what is really sent (the resolved PDF sections, not the stored text), the
// proportional answer reserve, the honest dynamic-pack context, and the deck low-power mode.
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describePdfError, extractPdfText, pdfErrorCategory } from "../src/core/pdf";
import { fitMessages, promptTokens, replyReserve, requestUse, tokensOf } from "../src/core/context";
import { streamComplete } from "../src/core/chat";
import { estimatePdfDocs, resolvePdfDocs, wrapPdfDoc } from "../src/core/pdfSections";
import { DYNAMIC_DATA } from "../src/core/dynamic-data";
import { dynamicEntry, healEntry, memberContext, packContext, packContextDetail, packParts, refitWanted, type BundleModel, type Pack } from "../src/core/dynamic";
import { compiledContextOf } from "../src/core/qairt";
import { ggufFileWindow } from "../src/core/gguf";
import { scoreEntry, scoreModel } from "../src/core/fit";
import type { CatalogEntry, ChatEvent, ChatStats } from "../src/shared/types";
import { makeDeck } from "../src/core/deckBuild";
import { changeDeck } from "../src/core/deckEdit";

const page = (items: string[]) => ({ getTextContent: async () => ({ items: items.map((str) => ({ str, hasEOL: true })) }) });

describe("pdf errors", () => {
  it("sorts failures into log categories with nothing of the file in them", () => {
    expect(pdfErrorCategory(Object.assign(new Error("wrong password given"), { name: "PasswordException" }))).toBe("password");
    expect(pdfErrorCategory(new DOMException("PDF reading was stopped", "AbortError"))).toBe("cancelled");
    expect(pdfErrorCategory(Object.assign(new Error("Invalid PDF structure"), { name: "InvalidPDFException" }))).toBe("invalid");
    expect(pdfErrorCategory(Object.assign(new Error("missing"), { name: "MissingPDFException" }))).toBe("missing");
    expect(pdfErrorCategory(new Error("Setting up fake worker failed"))).toBe("worker");
    expect(pdfErrorCategory(new Error("Loading timed out after 30000ms"))).toBe("timeout");
    expect(pdfErrorCategory(new Error("strange failure"))).toBe("other");
  });
  it("gives plain words instead of the old could not be read wall", () => {
    const e = Object.assign(new Error("No password given"), { name: "PasswordException" });
    expect(describePdfError("report.pdf", e)).toContain("protected by a password");
    expect(describePdfError("report.pdf", new DOMException("stopped", "AbortError"))).toContain("reading was stopped");
    // an unknown error names only its sanitized category: a parser message can quote the document's
    // own text, and even a cut-down message could carry a fragment of it
    const long = describePdfError("report.pdf", new Error(`Cannot use 'in' operator with page text: ${"x".repeat(400)}`));
    expect(long).not.toContain("Cannot use 'in' operator");
    expect(long).toContain("Save it again as a PDF"); // a next step first
    expect(long).toContain("Code for support: other"); // the sanitized category stays, for support
  });
});

describe("pdf reading progress and cancel", () => {
  const doc = { numPages: 4, getPage: async (n: number) => page([`page ${n} text`]) };
  it("reports each page as it is read", async () => {
    const seen: [number, number][] = [];
    const text = await extractPdfText(doc, 2_000_000, { onProgress: (p, t) => seen.push([p, t]) });
    expect(seen).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(text).toContain("[page 2]");
  });
  it("stops between pages when the signal fires", async () => {
    const ac = new AbortController();
    const run = extractPdfText(doc, 2_000_000, { onProgress: (p) => { if (p === 2) ac.abort(); }, signal: ac.signal });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("the answer reserve", () => {
  it("is proportional to a small window, never half of it", () => {
    expect(replyReserve(4096, 8192)).toBe(1228);
    expect(replyReserve(8192, 8192)).toBe(2048);
    expect(replyReserve(2048, 8192)).toBe(614);
    // the model's own cap and a floor of 512 still bound it
    expect(replyReserve(4096, 800)).toBe(800);
    expect(replyReserve(4096, 100)).toBe(100);
  });
  it("requestUse carries the window, the reserve and the estimate flag", () => {
    const r = requestUse([{ role: "user", content: "hello" }], { nctx: 4096, maxTokens: 8192 });
    expect(r.nctx).toBe(4096);
    expect(r.reserveTokens).toBe(1228);
    expect(r.budgetTokens).toBe(4096 - 1228);
    expect(r.estimated).toBe(true);
    expect(r.percent).toBe(Math.min(100, Math.round((r.usedTokens / r.budgetTokens) * 100)));
  });
});

describe("the meter measures the resolved pdf, not the stored text", () => {
  const text = [["Chapter 1 Interest", "simple interest capital"], ["Chapter 2 Sequences", "geometric sequence ratio term"], ["Chapter 3 Probability", "dice coin event"]]
    .map(([t, b], i) => `[page ${i + 1}]\n[chapter: ${t}]\n${b} ${"x ".repeat(2000)}`).join("\n\n");
  const msgs = [{ role: "user" as const, content: `${wrapPdfDoc("c.pdf", text, 4000)}\n\nWhat is a geometric sequence?` }];
  it("estimatePdfDocs matches the locator's own fallback", async () => {
    const est = estimatePdfDocs(msgs);
    const out = await resolvePdfDocs(msgs, async () => null);
    expect(est[0].content).toBe(out[0].content);
  });
  it("counts the outline and the chosen sections, never the whole stored file", () => {
    const estText = estimatePdfDocs(msgs)[0].content as string;
    expect(estText).toContain("What is a geometric sequence?");
    expect(estText).toContain("Chapter 2 Sequences");
    expect(estText.length).toBeLessThan(text.length * 0.6);
    expect(tokensOf(estText)).toBeLessThan(tokensOf(text) / 2);
  });
  it("the question survives fitting: the pdfdoc body is cut, not the question", () => {
    const big = [{ role: "user" as const, content: `${wrapPdfDoc("big.pdf", `[page 1]\n[chapter: Everything]\n${"y ".repeat(30000)}`, 8000)}\n\nWhat is the capital of France? Answer in one word.` }];
    const fit = fitMessages([{ role: "system" as const, content: "sys" }, ...big], 900);
    const last = fit.messages.at(-1)!.content as string;
    expect(fit.overflow).toBe(false);
    expect(last).toContain("What is the capital of France?");
    expect(last).toContain("the rest of this file was left out");
    expect(fit.notes.some((n) => n.includes("cut"))).toBe(true);
  });
});

describe("dynamic packs have an honest context", () => {
  it("each pack's window comes from its own artifacts, not one number for all", () => {
    for (const pack of Object.values(DYNAMIC_DATA.packs)) {
      const e = dynamicEntry(pack);
      const qairt = pack.models.some((m) => /^ai-hub-models\//i.test(m.repo));
      // a pack with a native QAIRT bundle serves its compiled 4096; a GGUF-only pack is configured at serve time (top estimator tier 8192)
      expect(e.recommendedContext).toBe(qairt ? 4096 : 8192);
      expect(e.sampling.max_tokens).toBe(qairt ? 4096 : 8192);
    }
  });
  it("a healed entry is clamped to what its matched artifact can serve, never raised", () => {
    const gguf = { ref: "qwen3-8b", name: "Qwen3-8B", repo: "unsloth/Qwen3-8B-GGUF", quant: "Q4_0", paramsB: 8, sizeGB: 4.8, job: "", tokPerSec: null, thinking: false, vision: false, verified: true } as BundleModel;
    const qairt = { ...gguf, ref: "qwen3-1.7b-native", repo: "ai-hub-models/Qwen3-1.7B", quant: null, paramsB: 1.7, sizeGB: 1.7 };
    const entry = (over: number, repo: string): CatalogEntry => ({ id: "x", name: "x", repo, quant: repo.includes("GGUF") ? "Q4_0" : null, engine: repo.includes("GGUF") ? "llama_cpp" : "qairt", role: "", architecture: "x", sizeGB: 12, paramsB: 8, recommendedContext: over, sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 8192 } } as CatalogEntry);
    // the size is still put back to what the pack records; the context is clamped, not raised
    expect(healEntry(entry(8192, gguf.repo), [gguf]).recommendedContext).toBe(8192);
    expect(healEntry(entry(16384, gguf.repo), [gguf]).recommendedContext).toBe(8192);
    expect(healEntry(entry(8192, qairt.repo), [qairt]).recommendedContext).toBe(4096);
    expect(healEntry(entry(8192, gguf.repo), [gguf]).sizeGB).toBe(gguf.sizeGB);
  });
  it("compiled evidence wins over the built-in estimate, per artifact", () => {
    const pack = DYNAMIC_DATA.packs["2B"]; // its only QAIRT artifact is ai-hub-models/Qwen3-1.7B
    expect(pack).toBeTruthy();
    // without evidence the built-in estimate stands (a QAIRT pack: 4096), and it is labeled an estimate
    const est = packContextDetail(pack);
    expect(est.tokens).toBe(4096);
    expect(est.measured).toBe(false);
    expect(est.why).toMatch(/estimate/i);
    // with evidence the artifact's real compiled window wins — say this bundle compiled to 2048
    const seen = packContextDetail(pack, (m) => (/qwen3-1\.7b/i.test(m.repo) ? 2048 : null));
    expect(seen.tokens).toBe(2048); // the compiled window of the one QAIRT artifact: the binding constraint
    expect(seen.measured).toBe(true);
    expect(seen.why).toContain("2048");
    expect(packContext(pack, (m) => (/qwen3-1\.7b/i.test(m.repo) ? 2048 : null))).toBe(2048);
    // several artifacts with evidence: the SMALLEST window wins (the pack serves with one of them)
    const bm = (ref: string): BundleModel => ({ ref, name: ref, repo: `ai-hub-models/${ref}`, quant: null, paramsB: 1, sizeGB: 1, job: "", tokPerSec: null, thinking: false, vision: false, verified: true });
    const two = { id: "two", label: "T", maxParamsB: 2, models: [bm("ModelA"), bm("ModelB")], table: {} } as unknown as Pack;
    expect(packContext(two, (m) => (m.repo.endsWith("A") ? 4096 : 2048))).toBe(2048);
    // evidence that says nothing (null) changes nothing
    expect(packContextDetail(pack, () => null).tokens).toBe(4096);
  });
  it("a healed entry clamps to the artifact's compiled evidence when the caller has it", () => {
    const qairt = { ref: "qwen2.5-vl-native", name: "Qwen2.5-VL-7B", repo: "ai-hub-models/Qwen2.5-VL-7B-Instruct", quant: null, paramsB: 7, sizeGB: 7.5, job: "", tokPerSec: null, thinking: false, vision: true, verified: true } as BundleModel;
    const entry = (over: number): CatalogEntry => ({ id: "x", name: "x", repo: qairt.repo, quant: null, engine: "qairt", role: "", architecture: "x", sizeGB: 12, paramsB: 7, recommendedContext: over, sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 8192 } } as CatalogEntry);
    // the bundle compiled to 2048: a saved entry wishing 8192 comes back at 2048, not the assumed 4096
    expect(healEntry(entry(8192), [qairt], (m) => (/vl/i.test(m.repo) ? 2048 : 4096)).recommendedContext).toBe(2048);
    // without evidence the old cap stands
    expect(healEntry(entry(8192), [qairt]).recommendedContext).toBe(4096);
  });
  it("partial evidence never claims the whole pack is measured (known 4096, known 2048, unknown)", () => {
    const bm = (ref: string): BundleModel => ({ ref, name: ref, repo: `ai-hub-models/${ref}`, quant: null, paramsB: 1, sizeGB: 1, job: "", tokPerSec: null, thinking: false, vision: false, verified: true });
    const pack = { id: "mix", label: "Mix", maxParamsB: 2, models: [bm("KnownBig"), bm("KnownSmall"), bm("Unread")], table: {} } as unknown as Pack;
    // A: 4096 measured, B: 2048 measured, C: bundle never read
    const d = packContextDetail(pack, (m) => (m.repo.endsWith("KnownBig") ? 4096 : m.repo.endsWith("KnownSmall") ? 2048 : null));
    expect(d.tokens).toBe(2048); // the smallest KNOWN window, with the unread one at the usual 4096 estimate
    expect(d.measured).toBe(false); // one artifact unread: the pack's floor is NOT verified — it may compile smaller
    expect(d.coverage).toEqual({ known: 2, total: 3 });
    expect(d.why).toMatch(/partly measured/i);
    expect(d.why).toContain("ai-hub-models/Unread"); // the provenance names what was not read
    expect(d.artifacts.map((a) => a.repo)).toEqual(["ai-hub-models/KnownBig", "ai-hub-models/KnownSmall", "ai-hub-models/Unread"]);
    expect(d.artifacts[2].compiled).toBeNull();
    // per-artifact provenance for the ROUTED model: the concrete member's own limit, honestly labeled
    const routed = d.artifacts[1];
    expect(memberContext({ ...bm("KnownSmall") }, () => 2048)).toEqual({ tokens: 2048, measured: true, why: expect.stringContaining("compiled window") });
    expect(routed.compiled).toBe(2048);
    // the unread member resolves to the labeled estimate, never to another artifact's number
    const unknownMember = memberContext(bm("Unread"), () => null);
    expect(unknownMember).toEqual({ tokens: 4096, measured: false, why: expect.stringContaining("estimate") });
    // full evidence: only then is the pack measured
    const full = packContextDetail(pack, (m) => (m.repo.endsWith("KnownSmall") ? 2048 : 4096));
    expect(full.tokens).toBe(2048);
    expect(full.measured).toBe(true);
    expect(full.coverage).toEqual({ known: 3, total: 3 });
  });
  it("a correctly sized entry is healed in its context too — the size repair does not gate the clamp", () => {
    const qairt = { ref: "qwen3-1.7b-native", name: "Qwen3-1.7B", repo: "ai-hub-models/Qwen3-1.7B", quant: null, paramsB: 1.7, sizeGB: 1.7, job: "", tokPerSec: null, thinking: false, vision: false, verified: true } as BundleModel;
    // size matches the pack record exactly (no repair needed), but the saved context predates the bundle's real 2048
    const sized: CatalogEntry = { id: "x", name: "x", repo: qairt.repo, quant: null, engine: "qairt", role: "", architecture: "x", sizeGB: 1.7, paramsB: 1.7, recommendedContext: 8192, sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 8192 } } as CatalogEntry;
    const healed = healEntry(sized, [qairt], () => 2048);
    expect(healed).not.toBe(sized);
    expect(healed.recommendedContext).toBe(2048);
    expect(healed.sizeGB).toBe(1.7); // the size was already right
    // a GGUF entry with a correct size and a stale over-tall context is clamped as well
    const gguf = { ...qairt, repo: "unsloth/Qwen3-8B-GGUF", quant: "Q4_0", sizeGB: 4.8 };
    const tall: CatalogEntry = { ...sized, repo: gguf.repo, quant: "Q4_0", engine: "llama_cpp", sizeGB: 4.8, recommendedContext: 16384 } as CatalogEntry;
    expect(healEntry(tall, [gguf]).recommendedContext).toBe(8192);
    // nothing to change (context already at the evidence's limit): the SAME object comes back
    const ok: CatalogEntry = { ...sized, recommendedContext: 2048 } as CatalogEntry;
    expect(healEntry(ok, [qairt], () => 2048)).toBe(ok);
    // a context BELOW the artifact's limit is never raised
    const lower: CatalogEntry = { ...sized, recommendedContext: 1024 } as CatalogEntry;
    expect(healEntry(lower, [qairt], () => 2048)).toBe(lower);
    // no matching artifact: untouched
    expect(healEntry(sized, [], () => 2048)).toBe(sized);
  });
});

describe("a GGUF entry is never bounded by a native bundle's window", () => {
  // the real pack members: packParts over the shipped data (the 2B pack holds the native Qwen3-1.7B bundle its GGUF fallback saved entries under)
  const native = packParts(DYNAMIC_DATA.packs["2B"]).find((m) => m.ref === "qwen3-1.7b-native")!;
  const ggufMember = packParts(DYNAMIC_DATA.packs["9B"]).find((m) => m.ref === "qwen3-8b")!;
  const ggufEntry = (over: Partial<CatalogEntry>): CatalogEntry => ({
    id: "custom:unsloth/qwen3-1.7b-gguf:q4_0", name: "Qwen3-1.7B", repo: "unsloth/Qwen3-1.7B-GGUF", quant: "Q4_0",
    engine: "llama_cpp", role: "Your model", architecture: "Qwen3", sizeGB: 1.05, paramsB: 1.7,
    recommendedContext: 16384, sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 16384 }, ...over
  } as CatalogEntry);

  it("a GGUF saved under the native member's ref keeps its serve-time window, with and without compiled evidence", () => {
    const saved = ggufEntry({ dynamicRef: native.ref });
    expect(healEntry(saved, [native]).recommendedContext).toBe(16384); // the usual-4096 estimate must not reach it
    expect(healEntry(saved, [native], () => 2048).recommendedContext).toBe(16384); // nor the bundle's real compiled window
  });

  it("a user-installed GGUF matched by loose name keeps its window too", () => {
    const user = ggufEntry({});
    expect(user.dynamicRef).toBeUndefined();
    expect(healEntry(user, [native]).recommendedContext).toBe(16384);
    expect(healEntry(user, [native], () => 2048).recommendedContext).toBe(16384);
  });

  it("a native entry matched to the same member is clamped to what THAT artifact can serve, never raised", () => {
    const qairt = ggufEntry({ dynamicRef: native.ref, repo: native.repo, quant: null, engine: "qairt", recommendedContext: 8192 });
    expect(healEntry(qairt, [native]).recommendedContext).toBe(4096); // no evidence: the usual compiled window
    expect(healEntry(qairt, [native], () => 2048).recommendedContext).toBe(2048); // the bundle was read: its real window
    const low = { ...qairt, recommendedContext: 1024 } as CatalogEntry;
    expect(healEntry(low, [native], () => 2048)).toBe(low); // below the window: left alone
  });

  it("the conservative 8192 rule still holds for a GGUF entry that IS the matched GGUF member's own file", () => {
    const own = ggufEntry({ dynamicRef: ggufMember.ref, repo: ggufMember.repo, recommendedContext: 16384 });
    expect(healEntry(own, [ggufMember]).recommendedContext).toBe(8192);
  });

  it("the size repair is unchanged, and an oversized GGUF paired with a bundle member is repaired without losing its window", () => {
    const fat = ggufEntry({ dynamicRef: native.ref, sizeGB: 10 });
    const healed = healEntry(fat, [native]);
    expect(healed.sizeGB).toBe(native.sizeGB); // the pack's recorded size
    expect(healed.recommendedContext).toBe(16384); // and the window is still not capped by the bundle's
    const fatOwn = ggufEntry({ dynamicRef: ggufMember.ref, repo: ggufMember.repo, sizeGB: 50, recommendedContext: 8192 });
    expect(healEntry(fatOwn, [ggufMember]).sizeGB).toBe(ggufMember.sizeGB);
  });

  it("the repair re-derives a lowered context the way an install fits it, only on the old clamp's fingerprint", () => {
    const lowered = ggufEntry({ dynamicRef: native.ref, recommendedContext: 4096 }); // what the old clamp saved
    // the caller can fit: the file's window (16384) fitted to a machine that holds it comes back
    expect(healEntry(lowered, [native], () => 2048, () => 16384).recommendedContext).toBe(16384);
    // the caller cannot fit (no profile yet): the value is left as it is
    expect(healEntry(lowered, [native], () => 2048, () => null).recommendedContext).toBe(4096);
    expect(healEntry(lowered, [native], () => 2048).recommendedContext).toBe(4096);
    // a saved context that was never the clamp's doing is not rewritten
    const other = ggufEntry({ dynamicRef: native.ref, recommendedContext: 6144 });
    expect(healEntry(other, [native], () => 2048, () => 16384)).toBe(other);
    // a native entry is never raised, whatever the caller could fit
    const qairt = ggufEntry({ dynamicRef: native.ref, repo: native.repo, quant: null, engine: "qairt", recommendedContext: 4096 });
    expect(healEntry(qairt, [native], () => 2048, () => 16384).recommendedContext).toBe(2048);
  });

  it("an entry with nothing to heal comes back as the same object", () => {
    const ok = ggufEntry({ dynamicRef: ggufMember.ref, repo: ggufMember.repo, sizeGB: ggufMember.sizeGB, recommendedContext: 8192 });
    expect(healEntry(ok, [ggufMember])).toBe(ok);
    const fitted = ggufEntry({ dynamicRef: native.ref, recommendedContext: 16384, sizeGB: native.sizeGB });
    expect(healEntry(fitted, [native], () => 2048)).toBe(fitted);
  });
});

describe("the repair of a lowered GGUF context only goes as high as the file's own window", () => {
  const native = packParts(DYNAMIC_DATA.packs["2B"]).find((m) => m.ref === "qwen3-1.7b-native")!;
  const loweredEntry = (): CatalogEntry => ({
    id: "custom:unsloth/qwen3-1.7b-gguf:q4_0", name: "Qwen3-1.7B", repo: "unsloth/Qwen3-1.7B-GGUF", quant: "Q4_0",
    engine: "llama_cpp", role: "Your model", architecture: "Qwen3", sizeGB: 1.05, paramsB: 1.7,
    recommendedContext: 4096, sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 4096 }, dynamicRef: native.ref
  } as CatalogEntry);
  const hw = { npuBudgetGB: 7.8 } as any;
  // the same decision the main process makes for a refit: the file's window (as read from disk), the install's wanted
  // value, then fitted to this machine
  const refitFromWindow = (fileWindow: number | null, profile: any = hw) => (e: CatalogEntry): number | null => {
    const wanted = refitWanted(fileWindow);
    if (wanted === null || wanted <= e.recommendedContext) return null;
    return scoreEntry({ ...e, recommendedContext: wanted }, profile).contextTokens || null;
  };

  it("the wanted value is the file's own window capped at the serve ceiling, and unknown changes nothing", () => {
    expect(refitWanted(4096)).toBe(4096);
    expect(refitWanted(32768)).toBe(16384);
    expect(refitWanted(null)).toBe(null);
  });

  it("a GGUF entry at 4096 whose file window is 4096 stays 4096", () => {
    expect(healEntry(loweredEntry(), [native], () => 2048, refitFromWindow(4096)).recommendedContext).toBe(4096);
  });

  it("a GGUF entry at 4096 whose file window is 32768 is refitted, capped at 16384 and at the hardware fit", () => {
    const roomy = healEntry(loweredEntry(), [native], () => 2048, refitFromWindow(32768)).recommendedContext;
    expect(roomy).toBeGreaterThan(4096);
    expect(roomy).toBeLessThanOrEqual(16384);
    // a machine that cannot hold the ceiling gets less, never more than it can serve
    const tight = healEntry(loweredEntry(), [native], () => 2048, refitFromWindow(32768, { npuBudgetGB: 4.5 } as any)).recommendedContext;
    expect(tight).toBeLessThanOrEqual(roomy!);
  });

  it("an unknown file window leaves the saved 4096 untouched", () => {
    expect(healEntry(loweredEntry(), [native], () => 2048, refitFromWindow(null)).recommendedContext).toBe(4096);
  });

  it("a native entry at 4096 is never raised, whatever the file's window", () => {
    const qairt = { ...loweredEntry(), repo: native.repo, quant: null, engine: "qairt" } as CatalogEntry;
    // with evidence the bundle's own compiled window caps it; without, the usual estimate — the refit never reaches it
    expect(healEntry(qairt, [native], () => 2048, refitFromWindow(32768)).recommendedContext).toBe(2048);
    expect(healEntry(qairt, [native], undefined, refitFromWindow(32768)).recommendedContext).toBe(4096);
  });

  it("the file's window is read from the GGUF header on disk, and an unreadable file leaves it unknown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gguf-window-"));
    try {
      const str = (s: string): Buffer => { const b = Buffer.from(s, "utf8"); const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([n, b]); };
      const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
      const u64 = (v: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
      const kv = (k: string, type: number, v: Buffer): Buffer => Buffer.concat([str(k), u32(type), v]);
      const says = path.join(root, "says.gguf");
      fs.writeFileSync(says, Buffer.concat([
        Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(2),
        kv("general.architecture", 8, str("qwen3")),
        kv("qwen3.context_length", 4, u32(32768))
      ]));
      expect(ggufFileWindow(says)).toBe(32768);
      const silent = path.join(root, "silent.gguf");
      fs.writeFileSync(silent, Buffer.concat([
        Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(1),
        kv("general.architecture", 8, str("qwen3"))
      ]));
      expect(ggufFileWindow(silent)).toBe(null); // the file does not say
      expect(ggufFileWindow(path.join(root, "missing.gguf"))).toBe(null); // the file cannot be read
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the compiled QAIRT window is read from the installed bundle", () => {
  const makeBundle = (root: string, org: string, config: string | null) => {
    const dir = path.join(root, org, "Qwen2.5-VL-7B-Instruct");
    fs.mkdirSync(dir, { recursive: true });
    if (config !== null) fs.writeFileSync(path.join(dir, "genie_config.json"), config);
    return root;
  };
  const CONFIG = JSON.stringify({ dialog: { context: { size: 2048 } }, models: {} });
  it("reads dialog.context.size of the installed graph (the 2048 Qwen2.5-VL case)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qairt-ctx-"));
    try {
      makeBundle(root, "qualcomm", CONFIG);
      // both names of the same artifact: the app's canonical mapping (ai-hub-models/X counts as qualcomm/X)
      expect(compiledContextOf("ai-hub-models/Qwen2.5-VL-7B-Instruct", root)).toBe(2048);
      expect(compiledContextOf("qualcomm/Qwen2.5-VL-7B-Instruct", root)).toBe(2048);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("says null when the bundle is not installed or its config does not say", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qairt-ctx-"));
    try {
      expect(compiledContextOf("ai-hub-models/Qwen2.5-VL-7B-Instruct", root)).toBe(null);
      makeBundle(root, "qualcomm", JSON.stringify({ dialog: {} }));
      expect(compiledContextOf("ai-hub-models/Qwen2.5-VL-7B-Instruct", root)).toBe(null);
      makeBundle(root, "qualcomm", "not json at all");
      expect(compiledContextOf("ai-hub-models/Qwen2.5-VL-7B-Instruct", root)).toBe(null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("a verdict uses the compiled window as the truth and says so", () => {
    const hw = { npuBudgetGB: 7.8 } as any;
    const base = { architecture: "qwen2.5", fileGB: 1.9, kind: "native" as const, paramsB: 2.2, engine: "qairt" as const };
    const known = scoreModel({ ...base, wantedContext: 4096, compiledContext: 2048 }, hw);
    expect(known.contextTokens).toBe(2048); // NOT the 4096 the entry wished for
    expect(known.reasons.join(" ")).toMatch(/Compiled window: 2K baked into the NPU graph/);
    const unknown = scoreModel({ ...base, wantedContext: 4096 }, hw);
    expect(unknown.reasons.join(" ")).toMatch(/an estimate/);
    // GGUF verdicts keep the memory-fitted context (no compiled window involved)
    const gguf = scoreModel({ architecture: "qwen3", fileGB: 4.8, kind: "q4_0" as const, paramsB: 8, engine: "llama_cpp" as const, wantedContext: 8192, maxTestedContext: 8192, kv: { layers: 36, headDim: 128, kvHeads: 8 } }, hw);
    expect(gguf.reasons.join(" ")).not.toMatch(/Compiled window/);
  });
});

describe("fitting never claims more than the budget", () => {
  const att = (name: string, body: string) => `<attachment name="${name}">\n${body}\n</attachment>`;
  const question = "question ".repeat(150); // about 380 tokens: a real, long question
  // the review's reproduction: budget 900, system "sys", one to four large attachment blocks, a long question —
  // this used to overflow at 1153–1280 estimated tokens while a note claimed the request fits
  for (const n of [1, 2, 3, 4]) {
    it(`cuts ${n} large attachment${n > 1 ? "s" : ""} to one shared budget and still fits (and keeps the question)`, () => {
      const ms = [
        { role: "system" as const, content: "sys" },
        { role: "user" as const, content: `${Array.from({ length: n }, (_, k) => att(`f${k}.pdf`, `[page 1]\n${"x".repeat(4000)}\n`)).join("\n")}\n\n${question}` },
      ];
      const fit = fitMessages(ms, 900);
      expect(fit.overflow, `${n} files`).toBe(false);
      expect(fit.tokens, `${n} files`).toBeLessThanOrEqual(900);
      const last = String(fit.messages.at(-1)!.content);
      expect(last).toContain("question"); // the question is kept whole
      expect(last).toContain("the rest of this file was left out");
      expect(fit.notes.join(" ")).toMatch(/was cut|fits/);
    });
  }
  it("Arabic prose and code-heavy bodies are cut on the same measured budget", () => {
    const arabic = "السؤال ".repeat(120);
    const code = "const x = 1;\n".repeat(600);
    const ms = [
      { role: "system" as const, content: "system prompt" },
      { role: "user" as const, content: `${att("code.js", code)}\n${att("ملاحظات.pdf", `[page 1]\n${"نص ".repeat(1500)}`)}\n\n${arabic}` },
    ];
    const fit = fitMessages(ms, 1000);
    expect(fit.overflow).toBe(false);
    expect(fit.tokens).toBeLessThanOrEqual(1000);
    expect(String(fit.messages.at(-1)!.content)).toContain("السؤال");
  });
  it("an image is required content: counted first, never dropped silently", () => {
    const ms = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: [
        { type: "image_url" as const, image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        { type: "text" as const, text: `${att("a.pdf", `[page 1]\n${"x".repeat(4000)}`)}\n\n${question}` },
      ] },
    ];
    // enough room for the image and the question: the file is cut, the picture stays
    const ok = fitMessages(ms, 1500);
    expect(ok.overflow).toBe(false);
    expect((ok.messages.at(-1)!.content as any[])[0].type).toBe("image_url");
    expect(String((ok.messages.at(-1)!.content as any[]).find((p) => p.type === "text")!.text)).toContain("question");
    // a window that cannot hold image + question alone: said out loud, not faked
    const tight = fitMessages(ms, 700);
    expect(tight.overflow).toBe(true);
    expect(tight.notes.join(" ")).toMatch(/cannot fit/);
  });
  it("required content alone too big says what to do instead of pretending it was sent", () => {
    const fit = fitMessages([{ role: "system" as const, content: "sys" }, { role: "user" as const, content: question }], 300);
    expect(fit.overflow).toBe(true);
    expect(fit.notes.join(" ")).toMatch(/cannot fit|Shorten/);
  });
  const sse = (chunks: object[]) => new Response(new ReadableStream({ start(c) { for (const j of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(j)}\n\n`)); c.close(); } }));
  const delta = (content: string, finish?: string) => ({ choices: [{ delta: { content }, finish_reason: finish ?? null }] });
  const run = async (g: AsyncGenerator<ChatEvent>) => { const out: ChatEvent[] = []; for await (const e of g) out.push(e); return out; };
  it("a request that cannot fit is never dispatched", async () => {
    let called = 0;
    const fetchFn = (async () => { called++; return sse([delta("ok", "stop")]); }) as any;
    const evs = await run(streamComplete({ endpoint: "x", model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: question }], sampling: { temperature: 0, top_p: 1, max_tokens: 8192 }, nctx: 700, fetchFn }, "i"));
    expect(called).toBe(0); // no inference call was made
    expect(evs.some((e) => e.type === "notice" && /cannot fit/.test(e.text))).toBe(true);
  });
  it("an initial rejection ends with one terminal error event, never a successful empty answer", async () => {
    let called = 0;
    const fetchFn = (async () => { called++; return sse([delta("ok", "stop")]); }) as any;
    const huge = "please tell me ".repeat(200); // far beyond the 188-token budget of a 700 window
    const evs = await run(streamComplete({ endpoint: "x", model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: huge }], sampling: { temperature: 0, top_p: 1, max_tokens: 8192 }, nctx: 700, fetchFn }, "i"));
    expect(called).toBe(0); // the request never reached inference
    expect(evs.some((e) => e.type === "answer")).toBe(false); // no successful empty answer
    const terms = evs.filter((e) => e.type === "done" || e.type === "error");
    expect(terms).toHaveLength(1); // exactly one terminal event: the orchestrator and the UI need one to clear busy
    expect(terms[0].type).toBe("error");
    const err = (terms[0] as { error: { id: string; title: string; fix: string; raw: string } }).error;
    expect(err.id).toBe("context-overflow");
    expect(err.fix).toMatch(/bigger window|new chat|part of the documents/); // it says what to do instead
    expect(err.raw).toContain("tokens");
  });
  it("an overflow during continuation keeps the partial answer and ends with exactly one done", async () => {
    let called = 0;
    // round 0's answer is long (over 300 tokens): the continuation carries it back as a window,
    // and with the continue prompt that required content alone no longer fits the 188-token budget
    const longReply = Array.from({ length: 220 }, (_, i) => `word${i}`).join(" ") + " ";
    const fetchFn = (async () => { called++; return sse([delta(longReply, "length")]); }) as any;
    const fits = "question ".repeat(60); // about 164 of the 188-token budget: fits, then is cut ("length")
    const evs = await run(streamComplete({ endpoint: "x", model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: fits }], sampling: { temperature: 0, top_p: 1, max_tokens: 8192 }, nctx: 700, fetchFn }, "i"));
    expect(called).toBe(1); // the first round reached inference, the second never did
    expect(evs.filter((e) => e.type === "answer").map((e) => (e as { text: string }).text).join("")).toBe(longReply);
    expect(evs.some((e) => e.type === "notice" && /answer stops here|kept as written/.test(e.text))).toBe(true);
    const dones = evs.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1); // one terminal event, no duplicate
    expect((dones[0] as { stats: { finish: string | null } }).stats.finish).toBe("window-full");
    expect(evs.some((e) => e.type === "error")).toBe(false); // a kept partial answer is not an error
  });
  it("a dispatch is never sent with an answer limit bigger than the room left", async () => {
    const calls: { messages: ChatMessage[]; max: number }[] = [];
    const replies = [
      [delta('a'.repeat(4000), "length")],
      [delta("b", "stop")],
    ];
    const fetchFn = (async (_u: string, init: any) => { const b = JSON.parse(init.body); calls.push({ messages: b.messages, max: b.max_tokens }); return sse(replies[calls.length - 1]); }) as any;
    const big = att("f.pdf", `[page 1]\n${"x".repeat(30000)}`);
    await run(streamComplete({ endpoint: "x", model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: `${big}\n\ntell me everything about page one, in detail` }], sampling: { temperature: 0, top_p: 1, max_tokens: 8192 }, nctx: 2048, fetchFn, maxContinues: 1 }, "i"));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // the answer limit plus the request (at the estimate's own rate) stays inside the window
      const estimated = promptTokens(c.messages as ChatMessage[]) + Math.ceil(c.max / 1);
      expect(estimated, `max_tokens ${c.max}`).toBeLessThanOrEqual(2048 - 128);
      expect(c.max).toBeGreaterThan(0);
    }
  });
});

describe("deck low power", () => {
  const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
  const PLAN = `Title: Bees\nTheme: forest\n${["Slide: cover | Bees | none", ...Array.from({ length: 12 }, (_, i) => `Slide: content | Part ${i + 1} | none`), "Slide: closing | End | none"].join("\n")}`;
  const replyOf = (sid: string) => {
    if (sid.endsWith("deckplan")) return PLAN;
    if (sid.endsWith("deckexplain")) return "Done.";
    if (/fix/.test(sid)) return "# Topic\n- A";
    if (/slide\d+/.test(sid)) return ""; // the slide is the streamed chunks themselves
    return "# Bees\nCover";
  };
  // a slide written in chunks, `stepMs` apart on the fake clock, so the streaming-draw cadence is observable
  const fake = (stepMs = 0) => async function* (sid: string): AsyncGenerator<ChatEvent> {
    if (/slide\d+/.test(sid)) {
      for (const part of ["# Topic\n", ...Array.from({ length: 6 }, (_, i) => `- Line ${i + 1}\n`)]) {
        yield { id: "x", type: "answer", text: part };
        if (stepMs) vi.advanceTimersByTime(stepMs);
      }
    }
    yield { id: "x", type: "answer", text: replyOf(sid) };
    yield { id: "x", type: "done", stats };
  };
  const run = async (o: object, opts: { stepMs?: number; problems?: string[] } = {}) => {
    let renders = 0, looks = 0, previews = 0, replaces = 0;
    let lastMetrics: any = null;
    const fixSids: string[] = [];
    const gen = makeDeck({
      id: "x", messages: [{ role: "user", content: "Make a 14 slide presentation about bees" }],
      ...o,
      stream: fake(opts.stepMs),
      render: async () => { renders++; return { shot: "data:image/jpeg;base64,AAAA", problems: opts.problems ?? [] }; },
      lookAt: async () => { looks++; return "fine"; },
    });
    let r;
    for (;;) { const n = await gen.next(); if (n.done) { r = n.value; break; } if (n.value.type === "replace") { replaces++; previews = replaces - 1; } else if (n.value.type === "build") lastMetrics = n.value.build.deckMetrics; }
    if (!r.handled) throw new Error("deck not handled");
    return { r, renders, looks, previews, replaces, lastMetrics, fixSids };
  };
  it("low power writes every slide the request asked for (14 stays 14), skips the vision check, and draws only what the layout check flags", async () => {
    const low = await run({ lowPower: true });
    const slides = (low.r.text.match(/^# /gm) ?? []).length;
    expect(slides).toBe(14); // explicitly requested counts are never cut to ten
    expect(low.looks).toBe(0);
    expect(low.renders).toBeLessThan(slides); // most simple slides are never drawn at all
    // and with no problems found there is no fix round anyway
    expect(low.fixSids).toEqual([]);
  });
  it("low power and full power produce the SAME deck for the same request (only the checking differs)", async () => {
    const low = await run({ lowPower: true });
    const full = await run({});
    expect(low.r.text).toBe(full.r.text); // identical slide counts and content
  });
  it("the streaming preview redraws at the mode's cadence: 250 ms in full power, rarer in low power", async () => {
    vi.useFakeTimers();
    try {
      const low = await run({ lowPower: true }, { stepMs: 300 });
      const full = await run({}, { stepMs: 300 });
      expect(low.previews).toBeGreaterThan(0);
      expect(low.previews).toBeLessThan(full.previews); // fewer redraws of the whole deck
    } finally { vi.useRealTimers(); }
  });
  it("the build events report honest work counts: calls, retries, renders, previews, elapsed, tokens, mode", async () => {
    const full = await run({});
    expect(full.lastMetrics).toMatchObject({ mode: "full" });
    expect(full.lastMetrics.calls).toBeGreaterThan(0);
    expect(full.lastMetrics.renders).toBe(full.renders); // every render pass is counted, no more and no less
    expect(full.lastMetrics.previews).toBe(full.replaces - 1); // every preview update except the final artifact
    expect(full.lastMetrics.tokens).toBe(full.lastMetrics.calls * 10); // every finished call's real stats
    expect(full.lastMetrics.elapsedSec).toBeGreaterThanOrEqual(0);
    const low = await run({ lowPower: true });
    expect(low.lastMetrics).toMatchObject({ mode: "low" });
    expect(low.lastMetrics.calls).toBe(full.lastMetrics.calls); // same deck, same calls: nothing hidden
    expect(low.lastMetrics.renders).toBe(low.renders);
    expect(low.lastMetrics.renders).toBeLessThan(full.lastMetrics.renders); // low power draws fewer slides: the count proves it
  });
  it("fix rounds stay bounded: at most one per slide in low power, two in full power", async () => {
    const perSlide = (sids: string[]) => {
      const max = new Map<string, number>();
      for (const s of sids) { const k = s.replace(/:\d+$/, ""); max.set(k, Math.max(max.get(k) ?? -1, Number(s.split(":").pop()))); }
      return Math.max(0, ...[...max.values()].map((v) => v + 1));
    };
    const low = await run({ lowPower: true }, { problems: ["overflow"] });
    const full = await run({}, { problems: ["overflow"] });
    expect(perSlide(low.fixSids)).toBeLessThanOrEqual(1);
    expect(perSlide(full.fixSids)).toBeLessThanOrEqual(2);
    expect(low.fixSids.length).toBeLessThanOrEqual(full.fixSids.length);
  });
});

describe("deck edit draws only the affected slides", () => {
  const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
  const deckOf = (slides: string[]) => `<artifact type="pptx" title="Bees">\nTheme: forest\n\n${slides.join("\n\n---\n\n")}\n</artifact>`;
  const SLIDES = ["# Bees\nCover slide", "# Habitat\n- REMOVEME habitat\n- forests", "# End\nThanks"];
  it("an edit of one slide renders that slide only, never the others", async () => {
    const drawn: string[] = [];
    const gen = changeDeck({
      id: "x",
      messages: [
        { role: "user", content: "Make a presentation about bees" },
        { role: "assistant", content: deckOf(SLIDES) },
        { role: "user", content: `Slide 2: take out "REMOVEME"` },
      ],
      stream: async function* (): AsyncGenerator<ChatEvent> { yield { id: "x", type: "done", stats }; },
      render: async (html) => { drawn.push(html); return { problems: [] }; },
    });
    let r;
    for (;;) { const n = await gen.next(); if (n.done) { r = n.value; break; } }
    expect(r.handled).toBe(true);
    expect(drawn).toHaveLength(1); // exactly one render pass: the one slide the request touched
    expect(drawn[0]).toContain("Habitat"); // the affected slide is the one drawn
    expect(drawn[0]).not.toContain("Cover"); // the other slides are not in the rendered page at all
    expect(drawn[0]).not.toContain("Thanks");
    expect((r as { text: string }).text).not.toContain("- REMOVEME habitat"); // and the change really landed
  });
});
