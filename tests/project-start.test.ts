import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { filesReadiness } from "../src/renderer/Projects";

/**
 * A project page gave "New chat" the main place and left the files further down,
 * with no word on whether they were ready. It now offers two starting actions side
 * by side, Add files and Start chat, with the files' readiness on the same line.
 */

const src = readFileSync("src/renderer/Projects.tsx", "utf8");

describe("a project page starts with Add files and Start chat", () => {
  it("offers both actions beside the chat box", () => {
    const foot = src.slice(src.indexOf('className="proj-ask-foot"'), src.indexOf('<h2 className="proj-sub">Chats in this project'));
    expect(foot).toMatch(/>Add files</);
    expect(foot).toMatch(/>Start chat</);
    expect(foot).toMatch(/filesReadiness\(/);
  });

  it("says whether the files are ready", () => {
    expect(filesReadiness(0, null, false)).toBe("No files added: chats will use your instructions only");
    expect(filesReadiness(1, null, false)).toBe("1 reference file · ready, read in full in every chat");
    expect(filesReadiness(3, "ready", true)).toBe("3 reference files · ready, the matching parts are read for each question");
    expect(filesReadiness(3, "indexing", true)).toMatch(/preparing your files/);
    expect(filesReadiness(3, "failed", true)).toMatch(/could not be prepared: try again/);
    // no status known: no claim that the files are being prepared
    expect(filesReadiness(3, null, true)).toBe("3 reference files · the matching parts are read for each question");
  });

  it("never shows internal words (index, tokens) in the readiness line", () => {
    for (const [n, st, over] of [[0, null, false], [1, null, false], [3, "ready", true], [3, "indexing", true], [3, "failed", true], [3, "queued", true]] as const) {
      expect(filesReadiness(n, st, over)).not.toMatch(/index|token|budget|context/i);
    }
  });
});
