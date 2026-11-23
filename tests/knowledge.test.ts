import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { kindOf, scriptOf, sectionsOf, tokenize } from "../src/core/knowledge/index";
import { mergeByBestRank } from "../src/core/knowledge/retrieve";
import { knowledgeDirOf, openKnowledgeIndex } from "../src/core/knowledge/store";

/**
 * Searchable knowledge: knowledge files are cut into sections by
 * their kind, indexed with BM25 over normalised English and Arabic words, and
 * kept in a store that rebuilds only when the files changed.
 */

const longPdf = (pages: number): string =>
  Array.from({ length: pages }, (_, i) => `[page ${i + 1}]\nPage ${i + 1} talks about topic ${i}.`).join("\n").replace("topic 149.", "topic 149. The xylophone budget is 1997 dinars.");

describe("the kind of a knowledge file", () => {
  it("a PDF's text carries page marks", () => {
    expect(kindOf({ id: "a", name: "report.pdf", content: "[page 1]\ntext" })).toBe("pdf");
    expect(kindOf({ id: "a", name: "notes.txt", content: "just text, no marks" })).toBe("text");
    expect(kindOf({ id: "a", name: "guide.md", content: "# Title\nbody" })).toBe("markdown");
  });
  it("an office file's kind comes from its name, the way documentText writes it", () => {
    // documentText writes Word, OpenDocument text and RTF as markdown-ish text
    expect(kindOf({ id: "a", name: "report.docx", content: "# Title\nbody" })).toBe("word");
    expect(kindOf({ id: "a", name: "notes.odt", content: "body" })).toBe("word");
    expect(kindOf({ id: "a", name: "letter.rtf", content: "[Word text (RTF), shown as plain text.]\nbody" })).toBe("word");
    // a workbook is `## Sheet` and a | table |; a csv arrives as plain text rows
    expect(kindOf({ id: "a", name: "data.xlsx", content: "## Sheet1\n| a | b |\n|---|---|" })).toBe("sheet");
    expect(kindOf({ id: "a", name: "data.ods", content: "## Sheet1\n| a |" })).toBe("sheet");
    expect(kindOf({ id: "a", name: "list.csv", content: "a,b\n1,2" })).toBe("sheet");
    // slides are separated by a line ---
    expect(kindOf({ id: "a", name: "deck.pptx", content: "# Slide one\n---\n# Slide two" })).toBe("slides");
    expect(kindOf({ id: "a", name: "deck.odp", content: "# Slide one" })).toBe("slides");
    // a page mark inside a Word file does not make it a PDF: the name decides first
    expect(kindOf({ id: "a", name: "report.docx", content: "[page 3]\nbody" })).toBe("word");
  });
});

describe("sections per kind", () => {
  it("a PDF's text is cut at its page marks: the fact on page 150 is its own section", () => {
    const secs = sectionsOf({ id: "a", name: "report.pdf", content: longPdf(200) });
    expect(secs.length).toBe(200);
    expect(secs[0].title).toBe("[page 1]");
    expect(secs[149].text).toContain("xylophone");
    expect(secs[149].text).not.toContain("topic 3.");
  });
  it("a markdown file is cut at its headings", () => {
    const secs = sectionsOf({ id: "a", name: "guide.md", content: "# Setup\nInstall the tool.\n\n## Usage\nRun it with a flag." });
    expect(secs.map((s) => s.title)).toEqual(["Setup", "Usage"]);
    expect(secs[1].text).toBe("Run it with a flag.");
  });
  it("a markdown file without headings falls back to paragraphs", () => {
    const secs = sectionsOf({ id: "a", name: "guide.md", content: "plain words\n\nmore words" });
    expect(secs.length).toBe(1);
  });
  it("plain text is grouped into paragraph blocks", () => {
    const para = "Some words for a paragraph. ";
    const secs = sectionsOf({ id: "a", name: "notes.txt", content: Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${para.repeat(8)}`).join("\n\n") });
    expect(secs.length).toBeGreaterThan(1);
    expect(secs.every((s) => s.text)).toBe(true);
  });
  it("an empty file has no sections", () => {
    expect(sectionsOf({ id: "a", name: "empty.txt", content: "  \n\n " })).toEqual([]);
  });
});

describe("sections of the office kinds", () => {
  it("a Word file is cut at its headings, the heading's words travel with the section", () => {
    const doc = "# Budget\nThe xylophone budget is 1997 dinars.\n\n# Warranty\nThe roof was fixed in May.";
    const secs = sectionsOf({ id: "a", name: "house.docx", content: doc });
    expect(secs.map((s) => s.title)).toEqual(["Budget", "Warranty"]);
    expect(secs[0].text).toContain("1997 dinars");
    expect(secs[0].text).toContain("Budget"); // the heading is part of what retrieval scores
    expect(secs[0].file).toBe("house.docx");
  });
  it("a Word file without headings is cut at paragraph ends in blocks of about 2000 characters, with a small overlap", () => {
    const para = "A paragraph about the garage door spring. ";
    const doc = Array.from({ length: 120 }, (_, i) => `Paragraph ${i}: ${para.repeat(4)} marker${i}.`).join("\n\n");
    const secs = sectionsOf({ id: "a", name: "notes.docx", content: doc });
    expect(secs.length).toBeGreaterThan(2);
    // every cut lands on a paragraph end: a block ends with a whole paragraph
    for (const s of secs) expect(s.text.endsWith("marker")).toBe(false);
    // and about the asked size, not whole-file or one line (the last block keeps what is left)
    expect(secs.slice(0, -1).every((s) => s.text.length >= 1800)).toBe(true);
    expect(secs.slice(0, -1).every((s) => s.text.length < 2600)).toBe(true);
    // the last paragraph of a block opens the next one, so a fact on a cut is in both
    for (let i = 1; i < secs.length; i++) {
      const overlap = secs[i - 1].text.split("\n\n").slice(-1)[0];
      expect(secs[i].text.startsWith(overlap)).toBe(true);
    }
  });
  it("an RTF file (plain text after the head line) falls into paragraph blocks too", () => {
    const doc = `[Word text (RTF), shown as plain text. Formatting is not shown.]\n${"Word after word. ".repeat(400)}`;
    const secs = sectionsOf({ id: "a", name: "letter.rtf", content: doc });
    expect(secs.length).toBeGreaterThan(1);
  });
  it("a workbook is one section per sheet and row block, the header row repeated in every block", () => {
    const rows = Array.from({ length: 95 }, (_, i) => `| item ${i} | ${i} kg |`).join("\n");
    const wb = `## Parts\n| name | weight |\n|---|---|\n${rows}\n\n## Prices\n| name | cost |\n|---|---|\n| bolt | 2 |`;
    const secs = sectionsOf({ id: "a", name: "stock.xlsx", content: wb });
    const parts = secs.filter((s) => s.sheet === "Parts");
    const prices = secs.filter((s) => s.sheet === "Prices");
    expect(parts.length).toBe(3); // 95 rows in blocks of 40
    expect(prices.length).toBe(1);
    expect(parts[0].rowFrom).toBe(1);
    expect(parts[0].rowTo).toBe(40);
    expect(parts[1].rowFrom).toBe(41);
    expect(parts[2].rowTo).toBe(96); // header row is row 1
    // the header row and its rule open every later block (the header is row 1, so block 2 opens at item 39)
    expect(parts[1].text.startsWith("| name | weight |\n|---|---|\n| item 39 |")).toBe(true);
    expect(parts[0].text.startsWith("| name | weight |")).toBe(true);
    expect(parts[0].title).toBe("Parts rows 1-40");
    expect(prices[0].title).toBe("Prices rows 1-2");
    expect(secs.every((s) => s.file === "stock.xlsx")).toBe(true);
  });
  it("a csv is one sheet of rows, its header line repeated in every block", () => {
    const csv = ["name,amount", ...Array.from({ length: 85 }, (_, i) => `item ${i},${i}`)].join("\n");
    const secs = sectionsOf({ id: "a", name: "list.csv", content: csv });
    expect(secs.length).toBe(3);
    expect(secs[1].text.startsWith("name,amount\nitem 39,")).toBe(true);
    expect(secs[2].rowFrom).toBe(81);
    expect(secs[2].rowTo).toBe(86);
    expect(secs[1].sheet).toBe("list");
  });
  it("a deck is one section per slide, with its notes, an empty slide is skipped", () => {
    const deck = [
      "# Kickoff\n- date is March 3\nNotes: introduce the team",
      "---",
      "(empty slide)",
      "---",
      "# Budget\nThe xylophone line is 1997 dinars\nNotes: keep this short",
    ].join("\n\n");
    const secs = sectionsOf({ id: "a", name: "deck.pptx", content: deck });
    expect(secs.length).toBe(2);
    expect(secs[0].title).toBe("Kickoff");
    expect(secs[0].slide).toBe(1);
    expect(secs[0].text).toContain("Notes: introduce the team");
    expect(secs[1].title).toBe("Budget");
    expect(secs[1].slide).toBe(3); // the empty slide keeps its number
    expect(secs[1].text).toContain("1997 dinars");
  });
  it("a hit from an office file carries where it came from: sheet and rows, slide", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-"));
    const idx = openKnowledgeIndex(dir, "p", [
      { id: "s", name: "stock.xlsx", content: "## Parts\n| name | weight |\n|---|---|\n| beam | 40 kg |" },
      { id: "d", name: "deck.pptx", content: "# Budget\nThe xylophone line is 1997 dinars" },
    ]);
    const sheetHit = idx.search("beam weight").find((h) => h.name === "stock.xlsx");
    expect(sheetHit?.sheet).toBe("Parts");
    expect(sheetHit?.rowFrom).toBe(1);
    expect(sheetHit?.rowTo).toBe(2); // the header row and the beam are one block's rows 1 and 2
    const slideHit = idx.search("xylophone").find((h) => h.name === "deck.pptx");
    expect(slideHit?.slide).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the words are normalised, English and Arabic", () => {
  it("Arabic folds to one shape each: hamza forms, taa marbuta, alef maqsura, tashkeel, tatweel", () => {
    expect(tokenize("أحمد")).toEqual(tokenize("احمد"));
    expect(tokenize("مباشرةً")).toEqual(tokenize("مباشرة"));
    expect(tokenize("مـدرسة")).toEqual(tokenize("مدرسه")); // tatweel AND taa marbuta
    expect(tokenize("هدى")).toEqual(tokenize("هدي")); // alef maqsura
  });
  it("English folds case and drops punctuation", () => {
    expect(tokenize("Hello, WORLD!")).toEqual(["hello", "world"]);
    expect(tokenize("a I")).toEqual([]); // single letters are not search words
  });
});

describe("the script a text is written in", () => {
  it("a character count, never a language guess: Arabic letters against Latin ones", () => {
    expect(scriptOf("الصفحة تتحدث عن الموضوع")).toBe("ar");
    expect(scriptOf("Page one talks about the topic")).toBe("en");
    expect(scriptOf("Page 12: الصفحة الـ 12")).toBe("ar"); // Arabic letters outnumber the Latin ones
    expect(scriptOf("what is the xylophone budget? ميزانية")).toBe("en"); // and the other way round
    expect(scriptOf("1234 — !?")).toBe(""); // no letters of either: nothing was detected
  });
});

describe("two searches merged by best rank", () => {
  const h = (doc: number, score = 0): { doc: number; score: number } => ({ doc, score });
  it("a section both queries found rides first; the rest follow by the best rank either gave", () => {
    const a = [h(10), h(20), h(30)];
    const b = [h(30), h(40)];
    expect(mergeByBestRank(a, b, (x) => x.doc, 12).map((x) => x.doc)).toEqual([30, 10, 20, 40]);
  });
  it("the question's own hits keep their floor: a rewrite that found nothing changes nothing", () => {
    const a = [h(10), h(20)];
    expect(mergeByBestRank(a, [], (x) => x.doc, 12).map((x) => x.doc)).toEqual([10, 20]);
  });
  it("the limit holds, and single-list hits interleave by their own rank", () => {
    const a = [1, 2, 3, 4].map(h);
    const b = [5, 6].map(h);
    expect(mergeByBestRank(a, b, (x) => x.doc, 4).map((x) => x.doc)).toEqual([1, 5, 2, 6]);
  });
});

describe("the BM25 search", () => {
  const files = [
    { id: "f1", name: "budget.txt", content: "The xylophone budget is 1997 dinars, agreed in March.\n\nThe garage door needs a new spring." },
    { id: "f2", name: "travel.md", content: "# Canada\nThe capital of Canada is Ottawa.\n\n# Food\nPoutine is a dish of fries." },
  ];
  const idx = () => openKnowledgeIndex(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-")), "p1", files);
  it("the section that holds the fact comes first, the unrelated ones behind", () => {
    const hits = idx().search("xylophone budget amount");
    expect(hits[0].text).toContain("1997 dinars");
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
  it("a question finds nothing when no section shares a word", () => {
    expect(idx().search("klingon opera tickets")).toEqual([]);
  });
  it("the limit holds", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, name: `n${i}.txt`, content: `Xylophone fact number ${i}.` }));
    expect(openKnowledgeIndex(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-")), "p2", many).search("xylophone", 5).length).toBe(5);
  });
  it("an Arabic question finds the section written in Arabic, folded shapes and all", () => {
    const ar = { id: "ar", name: "عقار.txt", content: "اتفقنا على أن سعر الأرض يكون مليون ريال، والدفعة الأولى بعد أسبوع.\n\nالموعد النهائي للتسليم هو شهر مارس." };
    const hits = openKnowledgeIndex(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-")), "p3", [ar]).search("ما هو سعر الأرض الذي اتفقنا عليه؟");
    expect(hits[0]?.text).toContain("مليون ريال");
  });
  it("a hit carries where it came from: file name and section title", () => {
    const hits = idx().search("Ottawa");
    expect(hits[0].name).toBe("travel.md");
    expect(hits[0].title).toBe("Canada");
  });
});

describe("the store rebuilds only when the files changed", () => {
  it("the same files load the store; changed files rebuild it; a damaged store is rebuilt, never trusted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-"));
    const files = [{ id: "f1", name: "a.txt", content: "The xylophone budget is 1997 dinars." }];
    const first = openKnowledgeIndex(dir, "p", files);
    expect(first.rebuilt).toBe(true);
    const same = openKnowledgeIndex(dir, "p", files);
    expect(same.rebuilt).toBe(false);
    expect(same.search("xylophone").length).toBe(1);
    const changed = openKnowledgeIndex(dir, "p", [{ id: "f1", name: "a.txt", content: "The xylophone budget is 3000 dinars now." }]);
    expect(changed.rebuilt).toBe(true);
    expect(changed.search("3000").length).toBe(1);
    expect(changed.search("1997").length).toBe(0);
    const idxFile = path.join(dir, "p.json");
    fs.writeFileSync(idxFile, "{ broken", "utf8");
    const damaged = openKnowledgeIndex(dir, "p", files);
    expect(damaged.rebuilt).toBe(true);
    expect(damaged.count).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("the index lives under the workspace the paths resolver derives from the environment, never somewhere hand-joined", () => {
    const env = { LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "paths-")) } as NodeJS.ProcessEnv;
    const dir = knowledgeDirOf(env);
    expect(dir.startsWith(path.join(String(env.LOCALAPPDATA), "MKMN", "Workspace"))).toBe(true);
    fs.rmSync(String(env.LOCALAPPDATA), { recursive: true, force: true });
  });
});
