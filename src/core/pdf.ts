/** The part of a pdf.js document we read, so the extraction can be tested without a browser. */
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  getOutline?(): Promise<OutlineItem[] | null>;
  getDestination?(name: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
}
interface OutlineItem { title: string; dest: string | unknown[] | null; items?: OutlineItem[] }
interface TextItem { str: string; hasEOL?: boolean; transform?: number[] }

import { SCANNED_LINE, ocrHintOf } from "./ocr";

/** Marker lines in the extracted text; the chapter splitter reads them back. */
export const PAGE_MARK = /^\[page (\d+)\]$/;
export const CHAPTER_MARK = /^\[chapter: (.+)\]$/;

const HEADING = /^(chapter|part|section|appendix|unit|module|lesson)\s+([\dIVXLC]+|[A-Z])\b.{0,70}$/i;
const NUMBERED = /^\d{1,2}(\.\d{1,2})?\.?\s+\p{Lu}[^\n]{2,70}$/u;

/** Chapter titles by page from the PDF's own outline (top level; the next level when the top has a single entry). */
async function outlineTitles(doc: PdfDocLike): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  try {
    let items = (await doc.getOutline?.()) ?? [];
    if (items.length === 1 && items[0].items?.length) items = items[0].items;
    for (const it of items.slice(0, 300)) {
      let dest = it.dest;
      if (typeof dest === "string") dest = (await doc.getDestination?.(dest)) ?? null;
      const ref = Array.isArray(dest) ? dest[0] : null;
      if (ref === null || ref === undefined || (typeof ref !== "number" && !doc.getPageIndex)) continue;
      const page = (typeof ref === "number" ? ref : await doc.getPageIndex!(ref)) + 1;
      const title = it.title.replace(/\s+/g, " ").trim();
      if (title) out.set(page, [...(out.get(page) ?? []), title]);
    }
  } catch { /* no usable outline: headings are looked for in the text */ }
  return out;
}

/** Chapter headings found in a page's text, when the PDF has no outline. */
function headingsOf(lines: string[]): string[] {
  const found: string[] = [];
  lines.forEach((l, k) => {
    const t = l.trim();
    if (HEADING.test(t) || (k < 3 && NUMBERED.test(t) && !/[.;,]$/.test(t))) found.push(t);
  });
  return found;
}

/** Text of a PDF page by page, lines rebuilt from the text positions. Pages are marked `[page N]` and chapters `[chapter: Title]`, so the model can say where something is and only the needed chapters have to be sent.
 * A page with no text (a scan) is handed to `o.ocr` with the document's language hint — its reply rides the page under a `[scanned text]` mark; a rejected call or an empty reply leaves the page out, like an unrecognized scan always was.
 * `o.onProgress` reports (pages read, page count) so a long file can show its progress; `o.signal` stops the extraction between pages. */
export async function extractPdfText(doc: PdfDocLike, maxChars = 2_000_000, o?: {
  onProgress?: (page: number, total: number) => void;
  signal?: AbortSignal;
  /** Recognizes one text-less page ("ar", "en", or "" when the document has no readable words to sample). */
  ocr?: (page: number, hint: string) => Promise<string>;
}): Promise<string> {
  const outline = await outlineTitles(doc);
  const pages: { n: number; text: string }[] = [];
  let total = 0;
  let lastRead = 0;
  let sample = ""; // the first readable words, for the recognizer's language hint
  for (let n = 1; n <= doc.numPages && total < maxChars; n++) {
    if (o?.signal?.aborted) throw new DOMException("PDF reading was stopped", "AbortError");
    lastRead = n;
    o?.onProgress?.(n, doc.numPages);
    const content = await (await doc.getPage(n)).getTextContent();
    let text = "";
    let lastY: number | null = null;
    for (const raw of content.items) {
      const it = raw as TextItem;
      if (typeof it.str !== "string") continue;
      const y = it.transform?.[5];
      if (text && lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !text.endsWith("\n")) text += "\n";
      text += it.str + (it.hasEOL ? "\n" : "");
      if (y !== undefined) lastY = y;
    }
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    // the hint sample takes only the document's own text layer: recognized words are the
    // app's output, and feeding them back would make one page's guess steer the next
    if (sample.length < 4_000 && text) sample = `${sample}\n${text}`.slice(0, 4_000);
    if (!text && o?.ocr) {
      // a scan: the recognizer's words ride the page, marked for what they are
      try {
        const scanned = (await o.ocr(n, ocrHintOf(sample))).replace(/\r\n?/g, "\n").trim();
        if (scanned) text = `${SCANNED_LINE}\n${scanned}`;
      } catch { /* no recognition for this page: it stays out, like an unrecognized scan always was */ }
    }
    if (!text) continue;
    pages.push({ n, text });
    total += text.length;
  }
  const useOutline = outline.size >= 2;
  const body = pages.map(({ n, text }) => {
    const titles = useOutline ? outline.get(n) ?? [] : headingsOf(text.split("\n"));
    return [`[page ${n}]`, ...titles.map((t) => `[chapter: ${t}]`), text].join("\n");
  }).join("\n\n");
  // a partial read is said out loud, never passed off as the whole document
  return lastRead < doc.numPages
    ? `${body}\n\n[only pages 1 to ${lastRead} of ${doc.numPages} were read; the file is longer than the app reads in one attach]`
    : body;
}

/**
 * Why a PDF could not be attached, in plain words, from the error's class and message.
 * The classes are pdf.js's own (PasswordException, InvalidPDFException, MissingPDFException,
 * AbortError); anything else keeps the underlying reason, cut, so no page text ever lands in
 * the message — a pdf.js parse error can quote a fragment of the document.
 */
export function describePdfError(name: string, e: unknown): string {
  const en = (e as { name?: string } | null)?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (en === "AbortError" || /aborted|was stopped|worker was destroyed/i.test(msg)) return `${name}: reading was stopped.`;
  if (en === "PasswordException" || /password/i.test(msg)) return `${name}: this PDF is protected by a password. Open it, remove the protection (print it to a new PDF) and attach that one.`;
  if (en === "InvalidPDFException" || /invalid pdf|corrupt|damaged/i.test(msg)) return `${name}: this file is damaged or is not a readable PDF.`;
  if (en === "MissingPDFException" || en === "UnexpectedResponseException") return `${name}: the PDF's pages could not be found in the file. Save it again as a PDF, then add it again.`;
  if (/fake worker|setting up fake worker|worker/i.test(msg)) return `${name}: the PDF reader could not start in this window. Try again; if it keeps failing, restart the app.`;
  // an unknown error: no part of its raw message is shown — a parser message can quote the document's
  // own text, and truncating it cannot guarantee that none survives. The sanitized category is shown instead.
  return `${name}: could not be read. Save it again as a PDF, then add it again. (Code for support: ${pdfErrorCategory(e)})`;
}

/** Short category of a PDF failure for diagnostics — no name, no content, safe to log. */
export function pdfErrorCategory(e: unknown): string {
  const en = (e as { name?: string } | null)?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (en === "AbortError" || /aborted|was stopped|worker was destroyed/i.test(msg)) return "cancelled";
  if (en === "PasswordException" || /password/i.test(msg)) return "password";
  if (en === "InvalidPDFException" || /invalid pdf|corrupt|damaged/i.test(msg)) return "invalid";
  if (en === "MissingPDFException" || en === "UnexpectedResponseException") return "missing";
  if (/worker/i.test(msg)) return "worker";
  if (/time\s?-?\s?out|timed out/i.test(msg)) return "timeout";
  return "other";
}
