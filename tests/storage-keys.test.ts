// The app was once called OpenNPU. Its code names (the bridge type, the window global, the test
// switches of the voice worker) now say MKMN, but the keys a profile has saved under stay
// exactly as they are: renaming one would lose the chats, drafts and layout already saved.
import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConversations } from "../src/renderer/store";
import { draftKey } from "../src/core/composer";

const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => { saved.set(k, v); },
    removeItem: (k: string) => { saved.delete(k); },
  };
});

/** The files under src that git tracks, read as text. */
const tracked = (): { file: string; text: string }[] =>
  execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.includes(".generated."))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));

describe("saved keys survive the rename", () => {
  it("a profile saved under opennpu.conversations loads the same chats", () => {
    const chats = [{ id: "c1", title: "Herons", updated: 5, turns: [{ role: "user", content: "How many herons?" }] }];
    saved.set("opennpu.conversations", JSON.stringify(chats));
    const loaded = loadConversations();
    expect(loaded.map((c) => [c.id, c.title, c.turns[0].content])).toEqual([["c1", "Herons", "How many herons?"]]);
  });

  it("a draft is still found under opennpu.draft.<chat>", () => {
    expect(draftKey("c1")).toBe("opennpu.draft.c1");
  });

  it("every opennpu.* key the window reads is kept, and no new one appears unnoticed", () => {
    const keys = new Set<string>();
    for (const { text } of tracked()) for (const m of text.matchAll(/["'`]opennpu\.([A-Za-z]+)/g)) keys.add(m[1]);
    expect([...keys].sort()).toEqual(["conversations", "draft", "fold", "railExpanded", "sideW"]);
  });
});

describe("the code names say MKMN", () => {
  it("no OpenNpu type, window.opennpu global or OPENNPU_ switch is left in src", () => {
    const left = tracked()
      .filter(({ text }) => /OpenNpu|OPENNPU_|window\.opennpu|\.opennpu\b|opennpu:/.test(text))
      .map(({ file }) => file);
    expect(left).toEqual([]);
  });

  it("the bridge is window.mkmn", async () => {
    const bridge = { appInfo: async () => ({}) };
    (globalThis as any).window = { ...(globalThis as any).window, mkmn: bridge };
    const { api } = await import("../src/renderer/api");
    expect(api()).toBe(bridge);
  });
});
