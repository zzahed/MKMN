import { describe, expect, it } from "vitest";
import defaults from "../src/core/skills-default.json";
import { autoSkill, patternRisk, skillFromMarkdown, skillProblems, SKILL_MATCH_CHARS, triggerFromInput, type Skill } from "../src/core/skills";

/**
 * A skill's "start by itself" pattern runs against every message, on the window's own
 * thread. A pattern that backtracks badly, written by hand or carried in an imported .md
 * skill, could freeze MKMN. patternRisk ALLOWS a small grammar and refuses everything else;
 * refused patterns are never saved, imported or run, and the text they run on is capped.
 *
 * The bypass list comes from the security review of the first version (a deny-list
 * scanner): each one was accepted there and hung or slowed the window.
 */
const skill = (when: string | undefined, extra: Partial<Skill> = {}) =>
  ({ id: "s", name: "S", description: "A test skill", tags: [], models: [], instructions: "", steps: [{ title: "a", prompt: "b" }], when, ...extra }) as unknown as Skill;

/** [pattern, an input that makes it slow] — every one must be refused. */
const DANGEROUS: [string, string][] = [
  [String.raw`(a+)+$`, "a".repeat(40) + "!"],
  [String.raw`(a*)*b`, "a".repeat(40)],
  [String.raw`(a|aa)+$`, "a".repeat(40) + "!"],
  [String.raw`(\w+\s?)*$`, "a".repeat(40) + "!"],
  [String.raw`(?:x+x+)+y`, "x".repeat(40)],
  [String.raw`(.*a){12}`, "a".repeat(40)],
  [String.raw`(\w)\1+`, "a".repeat(40)],
  [String.raw`.*.*.*=.*`, "a".repeat(1000)],
  // review bypasses of the deny-list version
  [String.raw`[^](a+)+]`, "x" + "a".repeat(30) + "!"],
  [String.raw`[](a+)+]`, "x" + "a".repeat(30) + "!"],
  [String.raw`(?:a?){500}a{500}`, "a".repeat(500)],
  [String.raw`(?:a?){50}a{50}`, "a".repeat(50)],
  [String.raw`\w{0,999}\w{0,999}\w{0,999}!`, "a".repeat(1000)],
  [String.raw`.{0,999}.{0,999}.{0,999}!`, "a".repeat(1000)],
  [String.raw`a{0,500}a{0,500}a{0,500}b`, "a".repeat(1000)],
  [String.raw`\w{0,99}\w{0,99}!`, "a".repeat(1000)],
  [String.raw`\p{L}*\p{L}*!`, "a".repeat(1000)],
  [String.raw`\s*\s*x`, " ".repeat(1000)],
  [String.raw`\x61*\x61*!`, "a".repeat(1000)],
  [String.raw`\w*\w*!`, "a".repeat(1000)],
  [String.raw`(?=\w*\w*!)`, "a".repeat(1000)],
  [String.raw`[a-z]*[a-z]*!`, "a".repeat(1000)],
  [String.raw`[a-z]+[a-z]+!`, "a".repeat(1000)],
  [String.raw`a?a?a?a?a?a?a?aaaaaaa`, "aaaaaaa"],
  // second review: overlapping alternatives in a row, no repeat at all
  ["(a|a)".repeat(25) + "!", "a".repeat(1000)],
  [String.raw`(?:\w|a)`.repeat(22) + "!", "a".repeat(1000)],
  ["(?:a|aa)".repeat(18) + "!", "a".repeat(1000)],
  ["(?:a|a)".repeat(20) + "!", "a".repeat(1000)],
  ["(?:.|a)".repeat(20) + "!", "a".repeat(1000)],
  // second review: a stored pattern far over the editor's limit
  [String.raw`\w*!|`.repeat(2000) + "x", "a".repeat(1000)],
  [String.raw`\w*!|`.repeat(60) + "x", "a".repeat(1000)],
];

describe("patterns that can freeze are refused", () => {
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
    expect(patternRisk(triggerFromInput("invoice, bill, فاتورة, C++, e.g.")!)).toBeNull();
    for (const p of [String.raw`\b(invoice|bill)\b`, String.raw`\b(simulat\w+|calculat\w+)\b`, String.raw`\bv\d+\.?\d?\b`, String.raw`[a-z]{2,8}`, String.raw`(?:re-?send|forward)`, String.raw`\btic[- ]?tac[- ]?toe\b`]) {
      expect(patternRisk(p), p).toBeNull();
    }
  });

  it("symbols inside a class or escaped are not mistaken for structure", () => {
    expect(patternRisk(String.raw`[+*(){}|]x`)).toBeNull();
    expect(patternRisk(String.raw`\(\+\)\*`)).toBeNull();
    expect(patternRisk(String.raw`[\]]x`)).toBeNull();
  });

  it("a lookaround is allowed only in the plain-words form the app builds itself", () => {
    expect(patternRisk(String.raw`(?<![\p{L}\p{N}_])(?:a|b)(?![\p{L}\p{N}_])`)).toBeNull();
    expect(patternRisk(String.raw`(?<![\p{L}\p{N}_])(?:a+|b)(?![\p{L}\p{N}_])`)).not.toBeNull();
    expect(patternRisk(String.raw`(?=invoice)`)).not.toBeNull();
  });
});

describe("a freezing pattern is never saved, imported or run", () => {
  it("saving names the problem in plain words", () => {
    const bad = skillProblems(skill(String.raw`(a+)+$`));
    expect(bad.join(" ")).toMatch(/could make MKMN freeze/);
    expect(bad.join(" ")).toMatch(/Use plain words/);
  });

  it("an imported .md skill with such a pattern is refused as soon as it is read", () => {
    const md = ["---", "name: Trap", "description: A skill with a bad pattern", "tags: test", "models: ", String.raw`when: [^](a+)+]`, "---", "", "## Step one", "", "Do it."].join("\n");
    const parsed = skillFromMarkdown(md);
    expect(typeof parsed).toBe("string");
    expect(String(parsed)).toMatch(/could make MKMN freeze/);
  });

  it.each(DANGEROUS)("a stored skill with %s is skipped, and the message is checked quickly", (when, input) => {
    const evil = skill(when, { id: "evil" });
    const good = skill(triggerFromInput("invoice"), { id: "good" });
    const t0 = performance.now();
    // the request first: only the first SKILL_MATCH_CHARS characters are matched
    const got = autoSkill([evil, good], `please send the invoice ${input}`, false);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(got?.id).toBe("good");
  });

  /** The slowest shapes the grammar allows, on the worst input for each. */
  it.each([
    [String.raw`.*=x`, "a".repeat(200_000)],
    [String.raw`[^.\n]{0,50}=x`, "a".repeat(200_000)],
    [String.raw`a?b?c?d?\w+!`, "a".repeat(200_000)],
    [String.raw`\b(simulat\w+|converter|calculat\w+|bmi)\b`, "simulat".repeat(30_000)],
  ])("the allowed pattern %s stays quick on a huge message", (when, input) => {
    expect(patternRisk(when)).toBeNull();
    const t0 = performance.now();
    autoSkill([skill(when)], input, false);
    expect(performance.now() - t0).toBeLessThan(150);
  });

  it("only the start of a message is matched", () => {
    expect(SKILL_MATCH_CHARS).toBe(1000);
    const s = skill(triggerFromInput("invoice"));
    expect(autoSkill([s], `${"x ".repeat(600)}invoice`, false)).toBeFalsy();
    expect(autoSkill([s], `invoice ${"x ".repeat(600)}`, false)?.id).toBe("s");
  });
});
