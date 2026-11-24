import { describe, expect, it } from "vitest";
import defaults from "../src/core/skills-default.json";
import { autoSkill, patternRisk, skillFromMarkdown, skillPattern, skillProblems, SKILL_MATCH_CHARS, triggerFromInput, type Skill } from "../src/core/skills";

describe("the u flag is the app's own, never forced by a hand-written pattern", () => {
  // fourth review: [\\p{] put the text "\p{" in a class, forced u, and u made "." ~100x slower on Arabic
  const forced = "(?:.|.)".repeat(6) + ".".repeat(252) + String.raw`[\\p{]`;

  it("a hand-written pattern compiles without u, whatever text it holds", () => {
    expect(forced.length).toBe(300);
    expect(patternRisk(forced)).toBeNull();
    expect(skillPattern(forced, "gi").flags).toBe("gi");
    expect(skillPattern(String.raw`\b(invoice|bill)\b`, "gi").flags).toBe("gi");
  });

  it("the plain-words form keeps u, so Arabic words have edges", () => {
    expect(skillPattern(triggerFromInput("فاتورة")!, "gi").flags).toBe("giu");
  });

  it.each([["Arabic", "ب".repeat(1000)], ["lone surrogates", "\uD83D".repeat(1000)], ["emoji", "😀".repeat(500)], ["an Arabic message", "أريد فاتورة للعميل ".repeat(60)]])(
    "the review's forced-u pattern stays quick on %s", (_name, input) => {
      const s = { id: "s", name: "S", description: "A test skill", tags: [], models: [], instructions: "", steps: [{ title: "a", prompt: "b" }], when: forced } as unknown as Skill;
      autoSkill([s], input, false); // warm the compile
      const t0 = performance.now();
      for (let k = 0; k < 3; k++) autoSkill([s], input, false);
      expect((performance.now() - t0) / 3).toBeLessThan(40);
    });
});

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
  // third review: fixed counts the cost model treated as free, beside one allowed repeat
  [".*" + "(?:.{100}|.{100})".repeat(6) + "!", "please send the invoice ".repeat(50)],
  [String.raw`\w*` + String.raw`(?:\w{99}|\w{98}|\w{97}|\w{96})`.repeat(3) + "!", "a".repeat(1000)],
  [String.raw`\w*` + String.raw`(?:\w{100}|\w{100})`.repeat(6) + "!", "a".repeat(1000)],
  [String.raw`\w*?` + String.raw`(?:\w{99})?`.repeat(6) + "!", "a".repeat(1000)],
  [String.raw`\s*` + String.raw`(?:\s{99})?`.repeat(6) + "x", " ".repeat(1000)],
  [".*" + "(?:.{99})?".repeat(6) + "!", "a".repeat(1000)],
  [String.raw`\w*\w{100}!`, "a".repeat(1000)],
  [String.raw`.*.{100}!`, "a".repeat(1000)],
  // and one repeat on its own, a shape a cost model once allowed
  [String.raw`.*=x`, "a".repeat(1000)],
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

  it("the plain-words form, and hand-written patterns without repeats, are accepted", () => {
    expect(patternRisk(triggerFromInput("invoice, bill, فاتورة, C++, e.g.")!)).toBeNull();
    for (const p of [String.raw`\b(invoice|bill)\b`, String.raw`\bv\d\.?\d?\b`, String.raw`[a-z][a-z]`, String.raw`(?:re-?send|forward)`, String.raw`\btic[- ]?tac[- ]?toe\b`, String.raw`\b(?:invoices?|bills?)\b`]) {
      expect(patternRisk(p), p).toBeNull();
    }
  });

  it("any repeat in a hand-written pattern is refused, with a plain reason", () => {
    for (const p of [String.raw`\b(simulat\w+|calculat\w+)\b`, String.raw`[a-z]{2,8}`, String.raw`a+`, String.raw`x*`, String.raw`\w{3}`]) {
      expect(patternRisk(p), p).toMatch(/repeats a part/);
    }
  });

  it("a built-in pattern is trusted only exactly as shipped", () => {
    const list = defaults as Skill[];
    const calc = list.find((s) => s.when?.includes("simulat"))!.when!;
    expect(patternRisk(calc)).toBeNull();
    expect(patternRisk(calc + " ")).not.toBeNull(); // edited by one character: checked like any other
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

  /** The slowest shapes allowed: the busiest shipped patterns, and the most ways with no repeat. */
  it.each([
    ...(defaults as Skill[]).filter((s) => s.when).map((s) => [s.when!, "write make create a ".repeat(10_000)] as [string, string]),
    [String.raw`\b(simulat\w+|converter|calculat\w+|bmi)\b`, "simulat".repeat(30_000)],
    ["(?:a|a)".repeat(6) + "!", "a".repeat(200_000)],
    ["(?:.|a)".repeat(6) + "!", "a".repeat(200_000)],
    ["a?".repeat(6) + "a".repeat(100) + "!", "a".repeat(200_000)],
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
