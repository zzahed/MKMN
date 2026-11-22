import { extractPdfText, pdfErrorCategory } from "../core/pdf";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Thrown when the read was stopped before or while it ran: the caller shows "stopped", never a parser error. */
export class PdfAborted extends Error {
  constructor() { super("The PDF read was stopped."); this.name = "PdfAborted"; }
}

/** The loaded pdf.js and the bundled worker's URL, kept for the whole session: the
 * library is ~450 KB and the worker ~1.3 MB, both loaded only once a PDF is attached. */
let lib: Promise<typeof import("pdfjs-dist")> | null = null;

async function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!lib) {
    lib = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = worker;
      return pdfjs;
    })();
    // a failed load must not stay cached: the next attach tries again
    lib.catch(() => { lib = null; });
  }
  return lib;
}

export interface ReadPdfOptions {
  /** Page-by-page progress while the text is extracted (page read, page count). */
  onProgress?: (page: number, total: number) => void;
  /** Stops the read: the loading task is destroyed and the promise rejects. */
  signal?: AbortSignal;
  /** Recognizes one text-less page's picture (a scan): the real app uses the host's
   * Windows recognizer (src-tauri/src/ocr.rs); a test fakes the call. The reply is the
   * recognized words; a rejection or an empty reply leaves the page out. */
  ocr?: (page: number, png: Uint8Array, hint: string) => Promise<string>;
  /** A recognition problem to tell the person (the language pack to add), when a
   * page could not be recognized — shown instead of the generic "no selectable text". */
  onOcrProblem?: (message: string) => void;
}

/** The real recognizer: the page's picture to the host's OCR command (Windows.Media.Ocr, on the device). */
async function tauriOcr(_page: number, png: Uint8Array, hint: string): Promise<string> {
  if (!isTauri()) throw new Error("the recognizer is only in the installed app");
  const r = await invoke<{ text: string }>("ocr_page_cmd", { png: Array.from(png), lang: hint });
  return r.text;
}

/** One PDF page rendered to a PNG (twice its size at most, within what the recognizer accepts).
 * The document is pdf.js's own proxy, typed loosely: its render parameters differ across pdf.js versions. */
async function renderPagePng(doc: unknown, n: number): Promise<Uint8Array> {
  const pg = await (doc as { getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: Record<string, unknown>): { promise: Promise<unknown> } }> }).getPage(n);
  const base = pg.getViewport({ scale: 1 });
  const scale = Math.min(2, 1800 / Math.max(base.width, base.height));
  const vp = pg.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("the page picture could not be drawn");
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error("the page picture could not be kept"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Reads the text of a PDF file. pdf.js is loaded only when someone adds a PDF.
 * The stop signal is checked BEFORE the library is loaded, BEFORE the file's bytes
 * are read and BEFORE the parsing task is created, and at every await in between —
 * nothing is loaded or parsed for a read that was already stopped.
 * The loading task — document and the worker it holds — is destroyed on success,
 * failure and cancellation, so no PDF stays in memory after its text was taken.
 * NOTE: the text of a long or odd file can come back PARTIAL (pdf.js skips pages it
 * cannot parse); the caller says so when a file yields less text than its size suggests. */
export async function readPdf(file: File, o?: ReadPdfOptions): Promise<string> {
  const stopped = () => !!o?.signal?.aborted;
  if (stopped()) throw new PdfAborted();
  // pdf.js calls Promise.try and Uint8Array toHex; without them the read hangs or fails deep inside pdf.js.
  if (typeof (Promise as unknown as { try?: unknown }).try !== "function") {
    throw new Error("PDF reading needs Node.js 26 or later (Promise.try is missing).");
  }
  if (typeof (Uint8Array.prototype as unknown as { toHex?: unknown }).toHex !== "function") {
    throw new Error("PDF reading needs Node.js 26 or later (Uint8Array toHex is missing).");
  }
  const pdfjsLib = await pdfjs();
  if (stopped()) throw new PdfAborted(); // the library load can take a while: the stop is honoured even there
  const data = new Uint8Array(await file.arrayBuffer());
  if (stopped()) throw new PdfAborted();
  const task = pdfjsLib.getDocument({ data });
  const onAbort = () => { task.destroy().catch(() => { /* already gone */ }); };
  o?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (stopped()) throw new PdfAborted();
    const doc = await task.promise;
    if (stopped()) throw new PdfAborted();
    // Text-less pages (a scan) go to the recognizer: the page is rendered to a picture,
    // the host's Windows command reads it. A wired recognizer that answers nothing (or
    // fails for every page) reports its problem once — the "no selectable text" message
    // the callers show only stands when recognition also found nothing.
    const wantsOcr = o?.ocr ?? (isTauri() ? tauriOcr : undefined);
    let ocrProblem: string | null = null;
    let ocrRead = false;
    const ocr = wantsOcr
      ? async (n: number, hint: string): Promise<string> => {
          try {
            const png = await renderPagePng(doc, n);
            const text = await wantsOcr(n, png, hint);
            if (text.trim()) ocrRead = true;
            return text;
          } catch (e) {
            ocrProblem ??= (e as Error).message || String(e);
            return "";
          }
        }
      : undefined;
    const text = await extractPdfText(doc, 2_000_000, { onProgress: o?.onProgress, signal: o?.signal, ocr });
    if (stopped()) throw new PdfAborted(); // a stop during extraction leaves nothing half-done behind
    if (ocrProblem && !ocrRead) o?.onOcrProblem?.(ocrProblem);
    return text;
  } catch (e) {
    if (stopped()) throw e instanceof PdfAborted ? e : new PdfAborted();
    // Diagnostics only: category and size, never the name's text or any document content.
    console.warn(`[pdf] extraction failed: category=${pdfErrorCategory(e)} bytes=${file.size}`);
    throw e;
  } finally {
    o?.signal?.removeEventListener("abort", onAbort);
    await task.destroy().catch(() => { /* the worker was already torn down */ });
  }
}
