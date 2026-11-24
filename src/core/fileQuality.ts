// What makes a generated Word document, spreadsheet or web page good, measured without a model, on the text form the file is made
// from (the same form whether a template or the free writer produced it): there is real content, nothing is filler or said twice, the
// structure holds (headings over long text, headers over columns, sections on a page), and a sheet's formulas really compute.
// Each feature's pipeline reports its score with its build; the eval harness holds scripted scenarios to QUALITY_BAR.
import { scoreRubric, type QualityScore, type Rubric } from "./harness/quality";
import { likeness, REPEAT_AT } from "./deckQuality";
import { Workbook, SheetError, isFormula, isNumeric, parseSheets, addr, type Sheet } from "./sheet";

/** Words a model writes when it has nothing to say. A [bracketed placeholder] is NOT filler: it is the honest way to leave out what the request did not give. */
const FILLER = /\b(?:lorem ipsum|dolor sit amet|tbd|tba|to be determined|insert (?:\w+ ){0,3}here|your (?:text|content|title|description) here|placeholder text|sample text|feature (?:one|two|three|\d)|item \d+|section \d+|heading \d+|title here)\b/i;
const wordCount = (t: string) => (t.match(/[\p{L}\p{N}]+/gu) ?? []).length;
/** The first pair of texts in a list that say the same thing (texts of 5 words or more: a short label may repeat on purpose). */
function firstRepeat(texts: string[]): [string, string] | null {
  const long = texts.filter((t) => wordCount(t) >= 5);
  for (let a = 0; a < long.length; a++) for (let b = a + 1; b < long.length; b++) if (likeness(long[a], long[b]) >= REPEAT_AT) return [long[a], long[b]];
  return null;
}
const clip = (t: string, n = 50) => (t.length > n ? `${t.slice(0, n)}…` : t);

// ---------------------------------------------------------------- Word documents (the Markdown text form)

interface Doc { title: string; headings: string[]; blocks: string[]; body: string; emptyHeadings: string[]; emptyTables: number }
export function readDoc(src: string): Doc {
  const lines = src.replace(/\r/g, "").split("\n");
  const title = /^#\s+(.+)$/m.exec(src)?.[1]?.trim() ?? "";
  const headings: string[] = [], blocks: string[] = [], emptyHeadings: string[] = [];
  let open: string | null = null, emptyTables = 0;
  for (const raw of lines) {
    const l = raw.trim();
    const h = /^#{2,6}\s+(.+)$/.exec(l);
    if (h) { if (open !== null) emptyHeadings.push(open); open = h[1]; headings.push(h[1]); continue; }
    if (!l || /^#\s/.test(l) || /^-{3,}$/.test(l) || /^\|?\s*:?-{3,}/.test(l)) continue;
    if (l.startsWith("|")) { const cells = l.split("|").slice(1, -1).map((c) => c.trim()); if (cells.every((c) => !c)) { emptyTables++; continue; } }
    open = null;
    blocks.push(l.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/[*_`]/g, ""));
  }
  if (open !== null) emptyHeadings.push(open);
  return { title, headings, blocks, body: blocks.join("\n"), emptyHeadings, emptyTables };
}

/** The fewest words a document carries to be more than a shell (a short letter or an invoice clears it). */
export const DOC_MIN_WORDS = 40;

export const DOCX_RUBRIC: Rubric<Doc> = {
  name: "docx",
  checks: [
    { id: "title", weight: 2, test: (d) => !!d.title || "the document has no title (a # line)" },
    { id: "substance", weight: 3, test: (d) => wordCount(d.body) >= DOC_MIN_WORDS || `the document says almost nothing (${wordCount(d.body)} words)` },
    { id: "noEmptySections", weight: 2, test: (d) => !d.emptyHeadings.length || `the heading "${clip(d.emptyHeadings[0])}" has nothing under it` },
    { id: "noFiller", weight: 2, test: (d) => { const m = FILLER.exec(d.body); return !m || `filler text: "${m[0]}"`; } },
    { id: "noRepeats", weight: 2, test: (d) => { const r = firstRepeat(d.blocks); return !r || `"${clip(r[1])}" says again what "${clip(r[0])}" said`; } },
    { id: "structure", weight: 1, test: (d) => wordCount(d.body) < 250 || d.headings.length >= 2 || "a long document with no headings to find one's way" },
    { id: "tables", weight: 1, test: (d) => !d.emptyTables || `${d.emptyTables} table row(s) are entirely empty` },
  ],
};
export const docxQuality = (src: string): QualityScore => scoreRubric(DOCX_RUBRIC, readDoc(src));

// ---------------------------------------------------------------- spreadsheets (## Sheet + Markdown tables)

/** A row label that names a total (the whole label: "Total to share" is a setting, not a total). */
const TOTAL = /^(?:total|sum|subtotal|grand total|balance|net(?: total)?)\s*:?$/i;
/** Errors a blank row legitimately shows before it is filled in: a share of nothing. Every other error is a broken formula. */
const BLANK_OK = new Set(["#DIV/0!"]);

export const XLSX_RUBRIC: Rubric<Sheet[]> = {
  name: "xlsx",
  checks: [
    { id: "hasData", weight: 3, test: (s) => s.some((x) => x.rows.length >= 2 && x.rows[0].filter(Boolean).length >= 2) || "no sheet has a header row and a row under it" },
    {
      id: "headers", weight: 2,
      test: (s) => {
        for (const x of s) {
          const h = x.rows[0] ?? [];
          if (h.some((c) => !c.trim())) return `the sheet "${x.name}" has a column with no header`;
          const seen = new Set<string>();
          for (const c of h) { const k = c.trim().toLowerCase(); if (seen.has(k)) return `the sheet "${x.name}" has two columns named "${c.trim()}"`; seen.add(k); }
        }
        return true;
      },
    },
    {
      id: "formulasCompute", weight: 3,
      test: (s) => {
        const wb = new Workbook(s);
        for (const x of s) for (const [y, r] of x.rows.entries()) for (const [i, c] of r.entries()) {
          if (!isFormula(c)) continue;
          const v = wb.cell(x.name, y, i);
          if (v instanceof SheetError && !BLANK_OK.has(v.code)) return `${s.length > 1 ? `${x.name}!` : ""}${addr(y, i)} ${clip(c, 40)} gives ${v.code}`;
        }
        return true;
      },
    },
    {
      id: "totalsAreFormulas", weight: 1,
      test: (s) => {
        for (const x of s) for (const [y, r] of x.rows.entries()) {
          if (y === 0 || !TOTAL.test((r[0] ?? "").replace(/[*_]/g, "").trim())) continue;
          if (r.slice(1).some((c) => isNumeric(c)) && !r.slice(1).some(isFormula)) return `the "${r[0]}" row of "${x.name}" is typed as numbers, not calculated`;
        }
        return true;
      },
    },
    { id: "rowShape", weight: 1, test: (s) => { const bad = s.find((x) => x.rows.some((r) => r.length !== (x.rows[0]?.length ?? 0))); return !bad || `rows of "${bad.name}" do not all have the same number of cells as its header`; } },
    { id: "noFiller", weight: 1, test: (s) => { for (const x of s) for (const r of x.rows) for (const c of r) { const m = FILLER.exec(c); if (m) return `filler text in "${x.name}": "${m[0]}"`; } return true; } },
  ],
};
export const xlsxQuality = (src: string): QualityScore => scoreRubric(XLSX_RUBRIC, parseSheets(src));

// ---------------------------------------------------------------- web pages (one HTML file)

interface Page { title: string; h1: number; sections: number; headings: string[]; texts: string[]; words: number; anchors: string[]; ids: Set<string>; imgsNoAlt: number }
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
export function readPage(html: string): Page {
  // what the reader sees: never the script, the style, the menu (it repeats the section titles on purpose) or data blocks
  const seen = html.replace(/<(script|style|nav|template|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(seen)?.[1] ?? seen;
  const all = (re: RegExp) => [...body.matchAll(re)].map((m) => strip(m[1])).filter(Boolean);
  return {
    title: strip(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""),
    h1: all(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi).length,
    sections: (body.match(/<section\b/gi) ?? []).length,
    headings: all(/<h[2-3]\b[^>]*>([\s\S]*?)<\/h[2-3]>/gi),
    texts: all(/<(?:p|li|blockquote|dd)\b[^>]*>([\s\S]*?)<\/(?:p|li|blockquote|dd)>/gi),
    words: wordCount(strip(body)),
    anchors: [...html.matchAll(/href="#([^"]+)"/gi)].map((m) => m[1]),
    ids: new Set([...html.matchAll(/\bid="([^"]+)"/gi)].map((m) => m[1])),
    imgsNoAlt: (body.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) ?? []).length,
  };
}

export const PAGE_MIN_WORDS = 80;

export const PAGE_RUBRIC: Rubric<Page> = {
  name: "page",
  checks: [
    { id: "title", weight: 1, test: (p) => (!!p.title && p.h1 >= 1) || "the page has no <title> or no main heading" },
    { id: "substance", weight: 3, test: (p) => p.words >= PAGE_MIN_WORDS || `the page says almost nothing (${p.words} words)` },
    { id: "structure", weight: 2, test: (p) => p.sections >= 3 || p.headings.length >= 2 || "the page is not divided into parts (sections or headings)" },
    { id: "noFiller", weight: 2, test: (p) => { const m = FILLER.exec([...p.headings, ...p.texts].join("\n")); return !m || `filler text: "${m[0]}"`; } },
    { id: "noRepeats", weight: 2, test: (p) => { const r = firstRepeat(p.texts); return !r || `"${clip(r[1])}" says again what "${clip(r[0])}" said`; } },
    { id: "distinctHeadings", weight: 1, test: (p) => { const s = new Set<string>(); for (const h of p.headings) { const k = h.toLowerCase(); if (s.has(k)) return `two parts have the heading "${h}"`; s.add(k); } return true; } },
    { id: "anchors", weight: 1, test: (p) => { const bad = p.anchors.find((a) => !p.ids.has(a) && a !== "top"); return !bad || `a link points to #${bad}, which is not on the page`; } },
    { id: "imageAlt", weight: 1, test: (p) => !p.imgsNoAlt || `${p.imgsNoAlt} picture(s) have no alt text` },
  ],
};
export const pageQuality = (html: string): QualityScore => scoreRubric(PAGE_RUBRIC, readPage(html));

// ---------------------------------------------------------------- one door

export type FileKind = "docx" | "xlsx" | "html";
export const fileQuality = (kind: FileKind, source: string): QualityScore => (kind === "docx" ? docxQuality(source) : kind === "xlsx" ? xlsxQuality(source) : pageQuality(source));
/** The rubric's notes as problems a writer can act on in a second try. */
export const qualityProblems = (q: QualityScore): string[] => q.failed.map((f) => f.note);
