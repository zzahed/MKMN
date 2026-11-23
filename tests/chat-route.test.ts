// The route stage's thinking decision (src/core/chatRoute.ts): how much the model thinks for
// this request, and the one notice that says so. Pure: no host, no model.
import { describe, expect, it } from "vitest";
import { chooseEffort } from "../src/core/chatRoute";
import { autoEffort } from "../src/core/effort";
import type { CatalogEntry, ChatMessage } from "../src/shared/types";

const entry = (id: string, name: string): CatalogEntry => ({
  id, name, repo: `org/${id}`, quant: "Q4_0", engine: "qairt", role: "chat", architecture: "llama", sizeGB: 1,
  recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 },
});
const PLAIN = entry("test-1b", "Test 1B"); // cannot think
const TOGGLE = entry("qwen3-4b", "Qwen3 4B"); // thinks when asked
const ALWAYS = entry("thinker-r1", "Thinking R1"); // always thinks
const said = (text: string): ChatMessage[] => [{ role: "user", content: "an earlier question" }, { role: "assistant", content: "ok" }, { role: "user", content: text }];
const MATH = "Prove that the square root of 2 is irrational.";
const PLAIN_ASK = "Translate 'good morning' into French.";

describe("chooseEffort", () => {
  it("a Dynamic team's pick outside reasoning, maths and plans does not think, whatever was chosen", () => {
    expect(chooseEffort("high", TOGGLE, { category: "writing" }, said(PLAIN_ASK))).toEqual({ effort: "off", notice: null });
    expect(chooseEffort("high", TOGGLE, { category: "math" }, said(MATH))).toEqual({ effort: "high", notice: null });
  });

  it("Auto reads the level from the kind of request and its words, and names it", () => {
    const r = chooseEffort("auto", TOGGLE, null, said(MATH));
    const expected = autoEffort("math", MATH);
    expect(r.effort).toBe(expected.level);
    expect(r.notice).toBe(`Thinking: ${expected.level} (${expected.why}).`);
  });

  it("Auto on a team takes the team's category, not the words'", () => {
    const r = chooseEffort("auto", TOGGLE, { category: "math" }, said("hello"));
    expect(r.effort).toBe(autoEffort("math", "hello").level);
  });

  it("Auto reads the words of a message in parts", () => {
    const parts = [{ role: "user", content: [{ type: "text", text: MATH }] }] as ChatMessage[];
    expect(chooseEffort("auto", TOGGLE, null, parts)).toEqual(chooseEffort("auto", TOGGLE, null, said(MATH)));
  });

  it("Auto on a model that cannot think settles nothing: the choice passes on as it was", () => {
    expect(chooseEffort("auto", PLAIN, null, said(MATH))).toEqual({ effort: "auto", notice: null });
  });

  it("Medium on a plain request to a model that thinks when asked is answered without thinking, and says so", () => {
    expect(chooseEffort("medium", TOGGLE, null, said(PLAIN_ASK))).toEqual({
      effort: "off", notice: "A plain request: answered without thinking first (choose High to make it think).",
    });
  });

  it("Medium stays for a reasoning request, for a team, and for a model that always thinks", () => {
    expect(chooseEffort("medium", TOGGLE, null, said(MATH))).toEqual({ effort: "medium", notice: null });
    expect(chooseEffort("medium", TOGGLE, { category: "math" }, said(PLAIN_ASK))).toEqual({ effort: "medium", notice: null });
    expect(chooseEffort("medium", ALWAYS, null, said(PLAIN_ASK))).toEqual({ effort: "medium", notice: null });
  });

  it("High, Low, Off and no choice are the person's own and stay", () => {
    for (const e of ["high", "low", "off", null] as const) expect(chooseEffort(e, TOGGLE, null, said(PLAIN_ASK))).toEqual({ effort: e, notice: null });
  });
});
