import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/core/markdown";

describe("Markdown thematic-break boundaries", () => {
  it.each(["---", "***", "___", "- - -", "* * *", "_ _ _"])(
    "starts a thematic break after nonblank paragraph text: %s",
    (rule) => {
      expect(parseMarkdown(`before\n${rule}\nafter`).map((block) => block.t)).toEqual(["p", "hr", "p"]);
    },
  );

  it("does not split a paragraph on a lone dash", () => {
    expect(parseMarkdown("before\n-\nafter").map((block) => block.t)).toEqual(["p"]);
  });

  it("preserves subsequent list, quote and fenced-code boundaries", () => {
    expect(
      parseMarkdown("before\n---\n- item\n> quote\n```js\nconst n = 1;\n```").map(
        (block) => block.t,
      ),
    ).toEqual(["p", "hr", "ul", "quote", "code"]);
  });
});
