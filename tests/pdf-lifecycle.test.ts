// The REAL readPdf lifecycle: real pdf.js, a real loading task, real parsing — only the worker's URL
// module is stubbed (a `?url` import has no meaning under node), and the real getDocument is wrapped
// so the real loading task it returns can be captured (to assert its destruction). The PDFs below are
// built byte by byte with correct xref tables, so every test runs the genuine pdf.js path.
import { afterAll, describe, expect, it, vi } from "vitest";
import { extractPdfText, type PdfDocLike } from "../src/core/pdf";

const state = vi.hoisted(() => ({ tasks: [] as { destroyed: boolean }[] }));

vi.mock("pdfjs-dist", async (importOriginal) => {
  const mod = await importOriginal<typeof import("pdfjs-dist")>();
  return {
    ...mod,
    getDocument: (src: object) => {
      const t = mod.getDocument(src as never) as unknown as { destroyed: boolean };
      state.tasks.push(t);
      return t;
    },
  };
});
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const req = createRequire(process.cwd() + "/package.json");
  return { default: pathToFileURL(req.resolve("pdfjs-dist/build/pdf.worker.min.mjs")).href };
});

const { PdfAborted, readPdf } = await import("../src/renderer/pdf");
afterAll(() => { vi.restoreAllMocks(); });

// a real, small, uncompressed PDF: `pages` pages, page p carrying `text[p]`
function tinyPdf(text: string[], pages = 1): Uint8Array {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 3} 0 R`).join(" ");
  objects.push("<</Type/Catalog/Pages 2 0 R>>");
  objects.push(`<</Type/Pages/Kids[${kids}]/Count ${pages}>>`);
  for (let p = 0; p < pages; p++) {
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents ${4 + p * 3} 0 R/Resources<</Font<</F1 ${5 + p * 3} 0 R>>>>>>`);
    const content = pages === 1
      ? `BT /F1 14 Tf 20 100 Td (${text.join(") Tj T* (")}) Tj ET`
      : `BT /F1 14 Tf 20 100 Td (${text[p]} page ${p + 1}) Tj ET`;
    objects.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    objects.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const fileOf = (bytes: Uint8Array, name = "t.pdf") => new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });

describe("the real readPdf lifecycle", () => {
  it("a good PDF: the text comes back page-marked, progress is reported, and the loading task is destroyed", async () => {
    const seen: [number, number][] = [];
    const text = await readPdf(fileOf(tinyPdf(["Hello bees", "Second line"], 1)), { onProgress: (p, total) => seen.push([p, total]) });
    expect(text).toContain("Hello bees");
    expect(text).toContain("Second line");
    expect(text).toMatch(/^\[page 1\]/);
    expect(seen).toEqual([[1, 1]]);
    expect(state.tasks.length).toBe(1);
    expect(state.tasks[0].destroyed).toBe(true); // the real task destroyed: nothing of the PDF stays loaded
  });

  it("a multi-page PDF reports every page and destroys its task too", async () => {
    const seen: [number, number][] = [];
    const text = await readPdf(fileOf(tinyPdf(["Bees", "Wasps"], 2)), { onProgress: (p, total) => seen.push([p, total]) });
    expect(text).toContain("[page 1]");
    expect(text).toContain("[page 2]");
    expect(text).toContain("page 2");
    expect(seen).toEqual([[1, 2], [2, 2]]);
    expect(state.tasks.at(-1)!.destroyed).toBe(true);
  });

  it("a file that is not a PDF: the real parser rejects, the diagnostic names only a category and a size", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    try {
      const secret = "TOP SECRET BUDGET NUMBERS 12345";
      await expect(readPdf(fileOf(new TextEncoder().encode(secret), "leak.pdf"))).rejects.toThrow();
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/category=/);
      expect(logged).toMatch(/bytes=/);
      expect(logged).not.toContain("TOP SECRET"); // no document text, no name content in diagnostics
      expect(logged).not.toContain("leak");
    } finally { warn.mockRestore(); }
  });

  it("an already-aborted signal: nothing is loaded, no file bytes are read, no task is created", async () => {
    const before = state.tasks.length;
    const c = new AbortController();
    c.abort();
    const file = fileOf(tinyPdf(["Hello bees"]));
    let read = false;
    const guard = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => { read = true; return guard(); };
    await expect(readPdf(file, { signal: c.signal })).rejects.toThrow(PdfAborted);
    expect(read).toBe(false); // the bytes of a stopped read are never even taken
    expect(state.tasks.length).toBe(before); // no loading task was ever created
  });

  it("a stop while the document loads: the task is destroyed and the read rejects as stopped", async () => {
    const before = state.tasks.length;
    const c = new AbortController();
    const pending = readPdf(fileOf(tinyPdf(["Hello bees"])), { signal: c.signal });
    c.abort(); // may land before, during or after the load; every one of those paths must end stopped
    await expect(pending).rejects.toThrow(/stopped/);
    if (state.tasks.length > before) expect(state.tasks.at(-1)!.destroyed).toBe(true); // when a task was made, it was torn down
  });

  it("repeated imports: each read gets its own task, each is destroyed, each returns the text", async () => {
    const before = state.tasks.length;
    for (let i = 0; i < 3; i++) {
      const text = await readPdf(fileOf(tinyPdf([`Round ${i}`])));
      expect(text).toContain(`Round ${i}`);
      expect(state.tasks.length).toBe(before + i + 1);
      expect(state.tasks.at(-1)!.destroyed).toBe(true);
    }
  });

  it("a partial read is disclosed in the text, not passed off as the whole document", async () => {
    const doc: PdfDocLike = {
      numPages: 3,
      getPage: async (n) => ({ getTextContent: async () => ({ items: [{ str: `page ${n} text`, hasEOL: true }] }) }),
    };
    const text = await extractPdfText(doc, 5); // maxChars forces the read to stop after the first page
    expect(text).toContain("[page 1]");
    expect(text).not.toContain("[page 3]");
    expect(text).toMatch(/\[only pages 1 to 1 of 3 were read/);
  });
});
