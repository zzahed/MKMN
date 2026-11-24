import { describe, expect, it } from "vitest";
import defaults from "../src/core/skills-default.json";
import { autoSkill, patternRisk, skillFromMarkdown, skillProblems, triggerFromInput, type Skill } from "../src/core/skills";

/**
 * A skill's "start by itself" pattern runs against every message, on the window's own
 * thread. A pattern that backtracks catastrophically, written by hand or carried in an
 * imported .md skill, could freeze MKMN. Such patterns are refused on save and import,
 * never run, and the text they are run on is capped.
 */
const skill = (when: string | undefined, extra: Partial<Skill> = {}) =>
  ({ id: "s", name: "S", description: "A test skill", tags: [], models: [], instructions: "", steps: [{ title: "a", prompt: "b" }], when, ...extra }) as unknown as Skill;

const DANGEROUS = [
  String.raw`(a+)+$`,
  String.raw`(a*)*b`,
  String.raw`(a|aa)+$`,
  String.raw`(\w+\s?)*$`,
  String.raw`(?:x+x+)+y`,
  String.raw`(.*a){12}`,
  String.raw`(a+){2,}`,
  String.raw`^(([a-z])+.)+[A-Z]([a-z])+$`,
  String.raw`(\w)\1+`,
  String.raw`.*.*.*=.*`,
];

describe("patterns that can freeze are recognised", () => {
  it.each(DANGEROUS)("refuses %s", (p) => {
    expect(patternRisk(p)).not.toBeNull();
  });

  it("every built-in skill's pattern is accepted", () => {
    const list = (Array.isArray(defaults) ? defaults : (defaults as { skills: Skill[] }).skills) as Skill[];
    const withWhen = list.filter((s) => s.when);
    expect(withWhen.length).toBeGreaterThan(5);
    for (const s of withWhen) expect(patternRisk(s.when!), `${s.id}: ${s.when}`).toBeNull();
  });

  it("the plain-words form, and ordinary hand-written patterns, are accepted", () => {
    expect(patternRisk(triggerFromInput("invoice, bill, فاتورة, C++")!)).toBeNull();
    for (const p of [String.raw`\b(invoice|bill)\b`, String.raw`\b(simulat\w+|calculat\w+)\b`, String.raw`\bv\d+(\.\d+)?\b`, String.raw`[a-z]{2,8}`, String.raw`(?:re-?send|forward)`]) {
      expect(patternRisk(p), p).toBeNull();
    }
  });

  it("character classes, escapes and lookarounds are not mistaken for repeats", () => {
    expect(patternRisk(String.raw`[+*(){}|]x`)).toBeNull();
    expect(patternRisk(String.raw`\(\+\)\*`)).toBeNull();
    expect(patternRisk(String.raw`(?<![\p{L}\p{N}_])(?:a|b)(?![\p{L}\p{N}_])`)).toBeNull();
  });
});

describe("a freezing pattern is never saved, imported or run", () => {
  it("saving names the problem in plain words", () => {
    const bad = skillProblems(skill(String.raw`(a+)+$`));
    expect(bad.join(" ")).toMatch(/could make MKMN freeze/);
    expect(bad.join(" ")).toMatch(/Use plain words/);
  });

  it("an imported .md skill with such a pattern is refused as soon as it is read", () => {
    const md = ["---", "name: Trap", "description: A skill with a bad pattern", "tags: test", "models: ", String.raw`when: (a+)+$`, "---", "", "## Step one", "", "Do it."].join("\n");
    const parsed = skillFromMarkdown(md);
    expect(typeof parsed).toBe("string");
    expect(String(parsed)).toMatch(/could make MKMN freeze/);
  });

  it("a stored skill with such a pattern is skipped, and the message is checked quickly", () => {
    const evil = skill(String.raw`(a+)+$`, { id: "evil" });
    const good = skill(triggerFromInput("invoice"), { id: "good" });
    const text = `${"a".repeat(40)}! please send the invoice`;
    const t0 = performance.now();
    const got = autoSkill([evil, good], text, false);
    const ms = performance.now() - t0;
    expect(got?.id).toBe("good");
    expect(ms).toBeLessThan(200);
  });

  it.each([String.raw`.*=x`, String.raw`\w+\s\w+=x`, String.raw`\b(simulat\w+|calculat\w+)\b`])(
    "very long messages are only checked up to a limit, so the allowed pattern %s stays quick", (when) => {
      const p = skill(when, { id: "allowed" });
      expect(patternRisk(when)).toBeNull();
      const text = "a".repeat(200_000);
      const t0 = performance.now();
      autoSkill([p], text, false);
      expect(performance.now() - t0).toBeLessThan(300);
    });

  it("two repeats that match almost anything are refused: they cost the cube of the length", () => {
    expect(patternRisk(String.raw`.*.*=x`)).toMatch(/matches almost anything/);
    expect(patternRisk(String.raw`[^.]*[^,]*=x`)).toMatch(/matches almost anything/);
  });
});
