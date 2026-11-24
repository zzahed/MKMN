import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeFileSize, wordCount } from "../src/renderer/Projects";

/**
 * The Projects screen in plain English (docs/design/usability-audit.md, P1–P13):
 * no internal words, one size unit people can picture, every input labelled,
 * and a delete that says it cannot be undone.
 */
const src = readFileSync("src/renderer/Projects.tsx", "utf8");

/** The text a person can read: JSX text, string and template literals, minus comments. */
function visibleCopy(code: string): string {
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const strings = [...noComments.matchAll(/"([^"\n]{3,})"|`([^`\n]{3,})`|>([^<>{}\n]{3,})</g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return strings.join("\n");
}

describe("Projects speaks plain English", () => {
  const copy = visibleCopy(src);

  it.each([
    // "indexing" stays allowed: it is a state name the code compares, never shown
    ["index", /search index|\bindexed\b|index build/i],
    ["tokens", /\btokens?\b/i],
    ["rides", /\brides?\b/i],
    ["context", /\bcontext\b/i],
    ["sections", /\bsections\b/i],
  ])("has no %s jargon in its visible copy", (_name, re) => {
    expect(copy).not.toMatch(re);
  });

  it("names the card for the person's documents differently from the Files page", () => {
    expect(src).toContain("<h2>Reference files</h2>");
    expect(src).not.toContain("<h2>Files</h2>");
  });

  it("labels every input and text box", () => {
    for (const tag of src.match(/<(?:input|textarea)\b[\s\S]*?\/>/g) ?? []) {
      if (/type="file"/.test(tag)) continue; // hidden picker, opened by a labelled button
      expect(tag, tag).toMatch(/aria-label=/);
    }
  });

  it("says that deleting a project cannot be undone and offers Archive instead", () => {
    expect(src).toMatch(/This cannot be undone\. To hide the project instead, use Archive\./);
  });

  it("says the linked folder is read, never changed or deleted", () => {
    expect(src).toContain("never changes or deletes them");
  });
});

describe("file sizes people can picture", () => {
  it("counts words", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  one two\nthree ")).toBe(3);
  });
  it("gives pages when there are pages, then words", () => {
    expect(describeFileSize(28000, 44, 0)).toBe(`44 pages · about ${(28000).toLocaleString()} words`);
    expect(describeFileSize(1, 1, 1)).toBe("1 page · 1 scanned · about 1 word");
    expect(describeFileSize(250, 0, 0)).toBe("about 250 words");
  });
});
