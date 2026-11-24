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
    expect(filesReadiness(0, null, false)).toBe("No reference files yet");
    expect(filesReadiness(0, null, false, true)).toBe("No reference files yet · linked folder available");
    expect(filesReadiness(1, null, false)).toBe("1 reference file · ready. The assistant reads all of it in every chat.");
    expect(filesReadiness(3, "ready", true)).toBe("3 reference files · ready. The assistant looks up the parts that match each question.");
    expect(filesReadiness(3, "indexing", true)).toBe("3 reference files · preparing them. You can start a chat now.");
    expect(filesReadiness(3, "failed", true)).toBe("3 reference files · could not be prepared. See Reference files.");
    // no status known: no claim that the files are being prepared
    expect(filesReadiness(3, null, true)).toBe("3 reference files · the assistant looks up the parts that match each question.");
  });

  it("never shows internal words (index, tokens) in the readiness line", () => {
    for (const [n, st, over] of [[0, null, false], [1, null, false], [3, "ready", true], [3, "indexing", true], [3, "failed", true], [3, "queued", true], [3, null, true]] as const) {
      expect(filesReadiness(n, st, over)).not.toMatch(/index|token|budget|context/i);
    }
  });
});
