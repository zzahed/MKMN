import { describe, expect, it } from "vitest";
import { extractPdfText, type PdfDocLike } from "../src/core/pdf";
import { ocrHintOf } from "../src/core/ocr";
import { SCANNED_MARK } from "../src/core/ocr";
import { openKnowledgeIndex } from "../src/core/knowledge/store";
import { packSections, placeOf, type RetrSection } from "../src/core/knowledge/retrieve";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { UploadManager, type UploadIo } from "../src/renderer/uploads";
import type { Attachment } from "../src/shared/types";

/**
 * Scanned pages read on the device: a PDF page with no text is
 * rendered to a picture and recognized by the Windows recognizer through the
 * host's command. The recognized text rides the extracted text under a
 * `[scanned text]` mark, the index's sections carry the flag, the citations
 * say "p. 4, scanned text", and the "no selectable text" message only appears
 * when recognition also found nothing. The recognition itself is Windows' —
 * faked here; its Rust side is unit-tested with the call faked too.
 */

// ---------------------------------------------------------------- fake pdf docs

const page = (items: string[]) => ({ getTextContent: async () => ({ items: items.map((str) => ({ str, hasEOL: true })) }) });
const fakeDoc = (pages: string[][]): PdfDocLike => ({ numPages: pages.length, getPage: async (n: number) => page(pages[n - 1]) });

describe("the language hint", () => {
  it("Arabic pages hint Arabic, English pages hint English, a document with no readable text hints nothing", () => {
    expect(ocrHintOf("الميزانية السنوية للمكتبة")).toBe("ar");
    expect(ocrHintOf("The annual budget of the library")).toBe("en");
    expect(ocrHintOf("")).toBe("");
  });
});

describe("a text-less page is recognized and rides marked", () => {
  it("the recognized text joins the extraction under the [scanned text] mark, in page order", async () => {
    const doc = fakeDoc([["The heading of page one"], [], ["The tail of page three"]]);
    const calls: { n: number; hint: string }[] = [];
    const text = await extractPdfText(doc, 2_000_000, {
      ocr: async (n, hint) => { calls.push({ n, hint }); return `recognized words of page ${n}`; },
    });
    expect(calls).toEqual([{ n: 2, hint: "en" }]); // only the text-less page; the hint came from the document's own words
    expect(text).toContain("[page 2]\n[scanned text]\nrecognized words of page 2");
    expect(text).toContain("[page 1]\nThe heading of page one");
    expect(text).toContain("[page 3]\nThe tail of page three");
  });

  it("a fully scanned document: the hint is empty (nothing readable to sample), every page rides marked", async () => {
    const doc = fakeDoc([[], []]);
    const hints: string[] = [];
    const text = await extractPdfText(doc, 2_000_000, {
      ocr: async (n, hint) => { hints.push(hint); return `scan ${n}`; },
    });
    expect(hints).toEqual(["", ""]);
    expect(text).toContain("[page 1]\n[scanned text]\nscan 1");
    expect(text).toContain("[page 2]\n[scanned text]\nscan 2");
  });

  it("an Arabic document's scanned page is hinted Arabic", async () => {
    const doc = fakeDoc([["قائمة الموردين"], []]);
    let hint = "";
    await extractPdfText(doc, 2_000_000, { ocr: async (_n, h) => { hint = h; return "تم"; } });
    expect(hint).toBe("ar");
  });

  it("no recognizer wired (or an empty reply, or a failed one): the page stays out, the read never throws", async () => {
    const doc = fakeDoc([["First"], [], ["Third"]]);
    const noOcr = await extractPdfText(doc);
    expect(noOcr).not.toContain("[page 2]");
    const emptyReply = await extractPdfText(doc, 2_000_000, { ocr: async () => "   " });
    expect(emptyReply).not.toContain("[page 2]");
    const failed = await extractPdfText(doc, 2_000_000, { ocr: async () => { throw new Error("no Arabic recognizer"); } });
    expect(failed).not.toContain("[page 2]");
    expect(failed).toContain("[page 1]");
    expect(failed).toContain("[page 3]");
  });

  it("the recognized text counts toward the read's budget", async () => {
    const doc = fakeDoc([[], [], []]);
    let called = 0;
    const text = await extractPdfText(doc, 30, { ocr: async () => { called++; return "w".repeat(40); } });
    expect(called).toBe(1); // the budget stopped the read after the first page's text
    expect(text).toContain("[scanned text]");
  });

  it("the REAL scanned fixture: three pages of picture only, recognized through the faked call", async () => {
    const bytesOf = (name: string): Uint8Array => {
      const buf = fs.readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "knowledge", name));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    };
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: bytesOf("scanned-notices.pdf"), useWorkerFetch: false, isEvalSupported: false }).promise;
    const calls: number[] = [];
    const text = await extractPdfText(doc as never, 2_000_000, {
      ocr: async (n) => { calls.push(n); return `Notice number ${n}, read from the picture.`; },
    });
    expect(calls).toEqual([1, 2, 3]); // every page is text-less: every page goes to the recognizer
    expect(text).toContain("[page 1]\n[scanned text]\nNotice number 1");
    expect(text).toContain("[page 3]");
  });
});

describe("the scanned flag in the index and the citations", () => {
  it("pdfSections marks a scanned page's section and keeps the mark out of the search text", () => {
    const idx = openKnowledgeIndex(null, "p", [{ id: "f1", name: "scanned-notices.pdf", content: "[page 1]\n[scanned text]\nNotice one, recognized.\n\n[page 2]\nA typed page." }]);
    const [p1, p2] = idx.sections();
    expect(p1.scanned).toBe(true);
    expect(p1.page).toBe(1);
    expect(p1.text).toContain("Notice one");
    expect(p1.text).not.toContain("[scanned text]");
    expect(p2.scanned).toBeUndefined();
  });

  it("the citation of a scanned section says p. N, scanned text", () => {
    const s: RetrSection = { fileId: "f", file: "scanned-notices.pdf", title: "page", text: "x", page: 4, scanned: true };
    expect(placeOf(s)).toBe("p. 4, scanned text");
    const typed: RetrSection = { fileId: "f", file: "scanned-notices.pdf", title: "page", text: "x", page: 4 };
    expect(placeOf(typed)).toBe("p. 4");
  });

  it("packSections carries the scanned flag into the packed block's place", () => {
    const s: RetrSection = { fileId: "f", file: "scan.pdf", title: "page", text: "recognized words", page: 4, scanned: true };
    const packed = packSections([s], [0], 1000);
    expect(packed.body).toContain('place="p. 4, scanned text"');
    expect(packed.loaded).toMatchObject([{ file: "scan.pdf", place: "p. 4, scanned text" }]);
    expect(packed.loaded).toHaveLength(1);
  });

  it("the store keeps the flag (version 3), and an older store is rebuilt, never trusted half", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-store-"));
    const files = [{ id: "f1", name: "scan.pdf", content: "[page 1]\n[scanned text]\nrecognized words" }];
    const first = openKnowledgeIndex(dir, "p", files);
    expect(first.rebuilt).toBe(true);
    const same = openKnowledgeIndex(dir, "p", files);
    expect(same.rebuilt).toBe(false);
    expect(same.sections()[0].scanned).toBe(true);
    // a version 2 store (before the flag) is rebuilt once
    const storeFile = path.join(dir, "p.json");
    const stored = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    fs.writeFileSync(storeFile, JSON.stringify({ ...stored, version: 2 }));
    const old = openKnowledgeIndex(dir, "p", files);
    expect(old.rebuilt).toBe(true);
    expect(old.sections()[0].scanned).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- the person is told, plainly

const file = (name: string, type = "text/plain") => new File(["body"], name, { type });

function uploadWorld(readPdf: UploadIo["readPdf"]) {
  const env = {
    conv: "c1",
    currentConv: () => env.conv,
    appended: [] as Attachment[],
    appendFiles: (fs: Attachment[]) => { env.appended.push(...fs); },
    notice: undefined as string | null | undefined,
    setNotice: (n: string | null) => { env.notice = n; },
    reading: false,
    setReading: (on: boolean) => { env.reading = on; },
    canSee: () => true,
  };
  const io: UploadIo = {
    readPdf,
    readDocument: async () => "",
    saveMedia: async () => ({ mediaId: "m" }),
    readImage: async () => "",
    readText: async () => "",
  };
  return { mgr: new UploadManager(io, env), env };
}

describe("the 'no selectable text' message only when recognition found nothing either", () => {
  it("the recognition's own problem (the language pack to add) is what the person reads", async () => {
    const pack = "Arabic text recognition is not installed on this PC. Add it in Windows settings: Time & language > Language & region.";
    const w = uploadWorld(async (_f, o) => { o.onOcrProblem?.(pack); return ""; });
    await w.mgr.add([file("scan.pdf", "application/pdf")]);
    expect(w.env.notice).toContain(pack);
    expect(w.env.notice).not.toContain("found no text it could read");
  });

  it("recognition wired but silent (or absent): the honest generic message stands", async () => {
    const w = uploadWorld(async () => "");
    await w.mgr.add([file("scan.pdf", "application/pdf")]);
    expect(w.env.notice).toContain("found no text it could read");
    expect(w.env.notice).not.toMatch(/vision model|selectable/); // no engine words
  });

  it("recognition that did read the page: no message at all, the text rides", async () => {
    const w = uploadWorld(async () => "[scanned text]\nread from the picture");
    await w.mgr.add([file("scan.pdf", "application/pdf")]);
    expect(w.env.notice ?? null).toBeNull();
    expect(w.env.appended.map((a) => a.name)).toEqual(["scan.pdf"]);
  });
});

describe("the scanned mark itself", () => {
  it("is the one mark the extraction, the index and the renderer agree on", () => {
    expect(SCANNED_MARK).toBe("scanned text");
  });
});
