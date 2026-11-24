import { libraryFromMarkdown, libraryPrompt, libraryProblems, libraryToMarkdown, type SkillLibrary } from "./skillLibs";
export type { SkillLibrary } from "./skillLibs";

/**
 * A skill is more than a prompt: shared rules plus a series of steps. The steps run one after the other in the conversation, each with a
 * small job, so that a small model never has to hold the whole task at once. No picture: a skill is text only.
 */
export interface SkillStep { title: string; prompt: string }
export interface Skill {
  id: string;
  name: string;
  description: string;
  /** At most MAX_TAGS, lower case, no spaces. */
  tags: string[];
  /** Rules kept in front of the model for every step. */
  instructions: string;
  steps: SkillStep[];
  /** Models that suit this skill, best first (catalog ids). */
  models: string[];
  /** Id of an icon of the library (renderer/skillIcons.tsx); the icon of its category when unset. */
  icon?: string;
  builtin?: boolean;
  /** Part of the "default skills" section: installed with the app, removed (and put back) from the Customize tab. */
  core?: boolean;
  /** Source of a regular expression (case-insensitive): the words of a request this skill is loaded for by itself. */
  when?: string;
  /** Libraries installed with the skill (public or custom); see skillLibs.ts. */
  libraries?: SkillLibrary[];
}

export const MAX_TAGS = 10;
export const MAX_STEPS = 12;
const TOKEN_CHARS = 3.5;

export const tokensOfText = (t: string) => Math.ceil(t.length / TOKEN_CHARS);

/** What the model carries at the heaviest moment: the shared rules and the longest step. */
export function skillTokens(s: Pick<Skill, "instructions" | "steps" | "libraries">): number {
  return tokensOfText(s.instructions) + tokensOfText(libraryPrompt((s as Pick<Skill, "libraries">).libraries)) + Math.max(0, ...s.steps.map((x) => tokensOfText(x.prompt)));
}

export type SkillSize = { tokens: number; level: 1 | 2 | 3; label: string; short: string };
/** Size written on the skill: the number of tokens and the models that can carry it (the same three levels as the instructions). */
export function skillSize(s: Pick<Skill, "instructions" | "steps" | "libraries">): SkillSize {
  const tokens = skillTokens(s);
  const level = tokens <= 500 ? 1 : tokens <= 1200 ? 2 : 3;
  // plain words for people; the token count stays in the object for whoever needs it
  // the levels follow the conversation length a model is set up for (8K and 16K tokens), not the model's size
  const label = level === 1 ? "Short: works with any setting." : level === 2 ? "Medium: works best when the conversation length is Long." : "Long: may be cut short unless the conversation length is Long.";
  return { tokens, level, label, short: level === 1 ? "short" : level === 2 ? "medium" : "long" };
}

/** Only these mark what a person typed as a regular expression: plain words such as "C++",
 *  "e.g." or "v1.2" stay words (escaped), never a pattern by accident. */
const REGEX_MARKS = /[\\(|]/;
/** Word edges that know every script: `\b` without the u flag sees only Latin letters, so an
 *  Arabic word never had an edge and never matched. */
const WORD_START = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_END = String.raw`(?![\p{L}\p{N}_])`;
const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

/** What a person types into "start by itself": plain words separated by commas ("invoice, bill",
 *  "فاتورة") become the pattern a skill starts on, in any script; a regular expression is kept as written. */
export function triggerFromInput(input: string): string | undefined {
  const t = input.trim();
  if (!t) return undefined;
  if (!t.includes(",") && REGEX_MARKS.test(t)) return t;
  const words = t.split(",").map((w) => w.trim()).filter(Boolean);
  return words.length ? `${WORD_START}(?:${words.map(escapeRe).join("|")})${WORD_END}` : undefined;
}

/** The other way: a pattern made from plain words is shown as those words again
 *  (also the earlier `\b(a|b)\b` form). */
export function triggerForInput(when: string | undefined): string {
  if (!when) return "";
  if (when.startsWith(`${WORD_START}(?:`) && when.endsWith(`)${WORD_END}`)) {
    const body = when.slice(WORD_START.length + 3, when.length - WORD_END.length - 1);
    return body.split(/(?<!\\)\|/).map((w) => w.replace(/\\(.)/g, "$1")).join(", ");
  }
  const m = when.match(/^\\b\(([^\\^$.*+?()[\]{}]+)\)\\b$/);
  return m ? m[1].split("|").join(", ") : when;
}

/** A skill's pattern, compiled: the u flag when it uses Unicode classes (the words form), so a
 *  pattern written by hand under the old rules keeps compiling exactly as before. */
export function skillPattern(when: string, flags: string): RegExp {
  return new RegExp(when, when.includes("\\p{") ? `${flags}u` : flags);
}

/** The most a "start by itself" pattern reads of a message: enough to recognise a request,
 *  and with the grammar below every allowed pattern stays quick (at worst the square of this). */
export const SKILL_MATCH_CHARS = 1000;

/** Repeats of varying length (+, *, {n,m}) one path through a pattern may hold: two in a row
 *  cost the cube of the message length (\w*\w*! took 0.6 s on 1,000 characters). */
const MAX_VARIABLE_REPEATS = 1;
/** Repeats of varying length in the whole pattern, across its alternatives: each branch's
 *  repeat is tried at every position (60 branches of \w*! cost 165 ms a message). */
const MAX_TOTAL_REPEATS = 3;
/** Ways a pattern can try to match at one position: alternatives add up, parts in a row
 *  multiply, an optional part doubles. Overlapping alternatives in a row, (a|a)(a|a)…,
 *  are exponential with no repeat at all (25 of them ran for more than 8 s). */
const MAX_WAYS = 64;
/** The longest pattern checked or run, in any form: the editor's own limit. */
const MAX_PATTERN_CHARS = 300;
/** The largest number a {n} or {n,m} may use. */
const MAX_BOUND = 100;

const WORD_LITERAL = /^(?:\\[.*+?^${}()|[\]\\]|[^.*+?^${}()|[\]\\])+$/;

/** The plain-words form exactly as triggerFromInput builds it: escaped words in one alternation. */
function isWordsForm(p: string): boolean {
  if (!p.startsWith(`${WORD_START}(?:`) || !p.endsWith(`)${WORD_END}`)) return false;
  const body = p.slice(WORD_START.length + 3, p.length - WORD_END.length - 1);
  return body.split(/(?<!\\)\|/).every((w) => WORD_LITERAL.test(w));
}

class Refused extends Error {}

/** What the pattern costs at one position: the varying repeats along its worst path, and the
 *  number of ways it can try to match. */
interface Cost { repeats: number; ways: number }
const ONE: Cost = { repeats: 0, ways: 1 };

/**
 * Why a hand-written "start by itself" pattern could make the window freeze, or null when it
 * is safe to run on every message. The pattern runs on the window's own thread, and a list of
 * known dangerous shapes always misses one, so this ALLOWS a small grammar and refuses the rest:
 *  - letters and escaped symbols, `.`, `^`, `$`, `\b`, `\d \w \s` (and capitals), character
 *    classes, groups `( )` and `(?: )`, and `|`;
 *  - a repeat (`+ * {n,m}`) only on a single character, escape or class, and at most one
 *    repeat of varying length along any path through the pattern;
 *  - `?` on a single item or on a group with no repeat inside;
 *  - at most 64 ways to try a match at one position (alternatives add, parts in a row
 *    multiply, `?` doubles) and at most three varying repeats in the whole pattern;
 *  - no repeat on a group, no lookarounds, no back-references, no \p, \u, \x or \c;
 *  - at most 300 characters, whatever its form.
 * Every built-in skill's pattern and the plain-words form pass.
 */
export function patternRisk(p: string): string | null {
  if (p.length > MAX_PATTERN_CHARS) return `it is longer than ${MAX_PATTERN_CHARS} characters`;
  if (isWordsForm(p)) return null;
  let i = 0, totalRepeats = 0;
  const fail = (why: string): never => { throw new Refused(why); };
  /** Two parts in a row: their repeats add up along the path, their ways multiply. */
  const then = (a: Cost, b: Cost): Cost => ({ repeats: a.repeats + b.repeats, ways: a.ways * b.ways });
  const check = (c: Cost): Cost => {
    if (c.repeats > MAX_VARIABLE_REPEATS) fail("it repeats more than one part of varying length in a row");
    if (c.ways > MAX_WAYS) fail("it has too many alternatives or optional parts");
    return c;
  };

  /** A quantifier after a single item: what it adds to the cost; i moves past it. */
  const quantifier = (): Cost => {
    const c = p[i];
    let cost: Cost = ONE;
    if (c === "?") { i++; cost = { repeats: 0, ways: 2 }; }
    else if (c === "+" || c === "*") { i++; cost = { repeats: 1, ways: 1 }; }
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (!m) fail("it has a { that is not a count");
      const lo = Number(m![1]), hi = m![2] === undefined ? lo : m![3] === "" ? null : Number(m![3]);
      if (lo > MAX_BOUND || (hi !== null && hi > MAX_BOUND)) fail(`it repeats something more than ${MAX_BOUND} times`);
      i += m![0].length;
      if (hi === null || hi > lo) cost = { repeats: 1, ways: 1 };
    } else return cost;
    if (p[i] === "?") i++; // a lazy repeat costs the same
    if (p[i] === "+" || p[i] === "*" || p[i] === "{" || (p[i] === "?" && cost.ways > 1)) fail("it repeats a repeat");
    if (cost.repeats && ++totalRepeats > MAX_TOTAL_REPEATS) fail("it has too many parts of varying length");
    return cost;
  };

  /** A character class from p[i] = "[" to its "]"; i moves past it. */
  const charClass = () => {
    i++;
    if (p[i] === "^") i++;
    // in JavaScript "[]" matches nothing and "[^]" matches anything: refused, never misread
    if (p[i] === "]") fail("it has an empty character class");
    while (i < p.length && p[i] !== "]") {
      if (p[i] === "\\") {
        const e = p[i + 1];
        if (e === undefined || /[pPuxck0-9]/.test(e)) fail("it uses an escape that is not allowed here");
        i += 2;
      } else if (p[i] === "[") fail("it has a [ inside a character class");
      else i++;
    }
    if (p[i] !== "]") fail("it has a character class that does not end");
    i++;
  };

  const sequence = (): Cost => {
    let cost: Cost = ONE;
    while (i < p.length && p[i] !== "|" && p[i] !== ")") {
      const c = p[i];
      if (c === "(") {
        i++;
        if (p[i] === "?") {
          if (p[i + 1] !== ":") fail("it uses a lookaround or a named group");
          i += 2;
        }
        const inner = alternation();
        if (p[i] !== ")") fail("it has a ( that does not close");
        i++;
        // any repeat of a group, even a fixed count such as (a?){50}, multiplies what is inside
        if (p[i] === "+" || p[i] === "*" || p[i] === "{") fail("it repeats a group");
        const q = quantifier();
        if (q.ways > 1 && inner.repeats) fail("it makes optional a group that has a repeat inside");
        // an optional group: skip it, or any of its own ways
        cost = check(then(cost, q.ways > 1 ? { repeats: 0, ways: inner.ways + 1 } : inner));
      } else if (c === "[") {
        charClass();
        cost = check(then(cost, quantifier()));
      } else if (c === "\\") {
        const e = p[i + 1];
        if (e === undefined) fail("it ends with a \\");
        if (e === "b" || e === "B") { i += 2; if (p[i] && "?+*{".includes(p[i])) fail("it repeats a word edge"); continue; }
        if (!/[dDwWsStnr]/.test(e) && /[A-Za-z0-9]/.test(e)) fail("it uses an escape that is not allowed here");
        i += 2;
        cost = check(then(cost, quantifier()));
      } else if (c === "^" || c === "$") {
        i++;
        if (p[i] && "?+*{".includes(p[i])) fail("it repeats an anchor");
      } else if ("?+*{}]".includes(c)) {
        fail("it has a repeat with nothing to repeat");
      } else {
        i++; // a letter, a digit, a space or another plain symbol, or "."
        cost = check(then(cost, quantifier()));
      }
    }
    return cost;
  };

  const alternation = (): Cost => {
    // alternatives: the worst path's repeats, and every branch's ways added up
    let all = sequence();
    while (p[i] === "|") {
      i++;
      const b = sequence();
      all = check({ repeats: Math.max(all.repeats, b.repeats), ways: all.ways + b.ways });
    }
    return all;
  };

  try {
    alternation();
    if (i < p.length) fail("it has a ) with no matching (");
    return null;
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
}

export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const t of tags) {
    const c = t.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 24);
    if (c) seen.add(c);
  }
  return [...seen].slice(0, MAX_TAGS);
}

export const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "skill";

/** The problems that make a skill unusable; empty when it is fine. */
export function skillProblems(s: Skill): string[] {
  const out: string[] = [];
  if (!s.name.trim()) out.push("it has no name");
  if (!s.description.trim()) out.push("it has no description");
  if (!s.steps.length) out.push("it has no step");
  if (s.steps.length > MAX_STEPS) out.push(`it has more than ${MAX_STEPS} steps`);
  s.steps.forEach((x, i) => { if (!x.prompt.trim()) out.push(`step ${i + 1} is empty`); });
  if (s.tags.length > MAX_TAGS) out.push(`it has more than ${MAX_TAGS} tags`);
  if (s.when) {
    if (s.when.length > 300) out.push("its \"start by itself\" words are longer than 300 characters");
    try { skillPattern(s.when, "i"); } catch { out.push("its \"start by itself\" words or pattern are not valid: check them, or leave the box empty"); }
    const risk = patternRisk(s.when);
    if (risk) out.push(`its "start by itself" pattern could make MKMN freeze (${risk}). Use plain words separated by commas instead`);
  }
  out.push(...libraryProblems(s.libraries));
  return out;
}

/** Text form (a .md or .txt file): a header between --- lines, the shared rules, then one "## Step: title" per step. */
export function skillToMarkdown(s: Skill): string {
  const head = ["---", `name: ${s.name}`, `description: ${s.description.replace(/\n/g, " ")}`, `tags: ${s.tags.join(", ")}`, ...(s.icon ? [`icon: ${s.icon}`] : []), `models: ${s.models.join(", ")}`, ...(s.when ? [`when: ${s.when}`] : []), "---"];
  const body = s.steps.map((x) => `## Step: ${x.title}\n${x.prompt.trim()}`);
  const libs = (s.libraries ?? []).map(libraryToMarkdown);
  return [head.join("\n"), s.instructions.trim(), ...body, ...libs].filter((x) => x !== "").join("\n\n") + "\n";
}

/** Reads the text form back. A plain text with no header is one skill with one step, named after its first line. */
export function skillFromMarkdown(text: string, id?: string): Skill | string {
  const src = text.replace(/\r\n/g, "\n").trim();
  if (!src) return "the file is empty";
  const meta: Record<string, string> = {};
  let body = src;
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split("\n")) { const k = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (k) meta[k[1].toLowerCase()] = k[2].trim(); }
  }
  const parts = body.split(/^##\s*(?=(?:Step|Library):)/m);
  const instructions = parts[0].trim();
  const libraries = parts.slice(1).filter((p) => /^Library:/.test(p)).map(libraryFromMarkdown);
  const steps: SkillStep[] = parts.slice(1).filter((p) => /^Step:/.test(p)).map((p) => p.replace(/^Step:\s*/, "")).map((p) => { const nl = p.indexOf("\n"); return nl < 0 ? { title: p.trim(), prompt: "" } : { title: p.slice(0, nl).trim(), prompt: p.slice(nl + 1).trim() }; });
  const first = (instructions || body).split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 60);
  const name = meta.name || first;
  const skill: Skill = {
    id: id ?? slug(name), name, description: meta.description ?? "", tags: cleanTags((meta.tags ?? "").split(/[,\s]+/)),
    instructions: steps.length ? instructions : "", steps: steps.length ? steps : [{ title: "Do it", prompt: body.trim() }],
    icon: meta.icon || undefined,
    ...(meta.when ? { when: meta.when } : {}),
    ...(libraries.length ? { libraries } : {}),
    models: (meta.models ?? "").split(",").map((x) => x.trim()).filter(Boolean)
  };
  if (!skill.description) skill.description = first;
  const bad = skillProblems(skill);
  return bad.length ? `this skill cannot be used: ${bad.join(", ")}` : skill;
}

/** The first of the skills whose name or tags start with what was typed after "/". */
export function matchSkills(skills: Skill[], query: string): Skill[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return skills;
  const score = (s: Skill) => (s.name.toLowerCase().startsWith(q) ? 0 : s.name.toLowerCase().includes(q) ? 1 : s.tags.some((t) => t.startsWith(q)) ? 2 : s.description.toLowerCase().includes(q) ? 3 : 9);
  return skills.filter((s) => score(s) < 9).sort((a, b) => score(a) - score(b));
}

/** The system text of one step: the shared rules, where the work stands, and the job of this step. */
export function stepPrompt(s: Skill, i: number): string {
  const n = s.steps.length;
  return [s.instructions.trim(), libraryPrompt(s.libraries), `You are doing the skill "${s.name}", step ${i + 1} of ${n}: ${s.steps[i].title}.`, s.steps[i].prompt.trim(), n > 1 ? "Do only this step. The next steps come after." : ""].filter(Boolean).join("\n\n");
}

/** The categories of the list, in the order a skill is placed in the first one whose tags it carries. */
export const SKILL_CATEGORIES = [
  { id: "create", label: "Create files & apps", tags: ["create"] },
  { id: "code", label: "Code", tags: ["code", "debug", "review"] },
  { id: "data", label: "Data & charts", tags: ["data", "chart", "diagram", "table"] },
  { id: "language", label: "Languages", tags: ["language", "translation"] },
  { id: "writing", label: "Writing", tags: ["writing", "editing", "email", "summary"] },
  { id: "study", label: "Study", tags: ["study", "learning", "explain", "quiz"] },
  { id: "everyday", label: "Everyday life", tags: ["food", "home"] },
  { id: "planning", label: "Planning & work", tags: ["planning", "work", "project", "productivity", "decision", "analysis"] },
  { id: "ideas", label: "Ideas", tags: ["ideas", "creative"] },
  { id: "other", label: "Other", tags: [] as string[] }
] as const;
export type SkillCategoryId = (typeof SKILL_CATEGORIES)[number]["id"];

export function categoryOf(s: Pick<Skill, "tags">): SkillCategoryId {
  return SKILL_CATEGORIES.find((c) => c.tags.some((t) => s.tags.includes(t)))?.id ?? "other";
}

/**
 * The installed skill to load by itself for a request, or null. A skill only adds its rules to the answer: the app does the work the same way
 * without it. With files in the chat only the default skill that changes files can apply; the longest matching words win.
 */
export function autoSkill(skills: Skill[], request: string, hasFiles: boolean): Skill | null {
  let best: Skill | null = null, bestLen = 0;
  // the start of the message is enough to recognise a request, and keeps every pattern quick
  const head = request.slice(0, SKILL_MATCH_CHARS);
  for (const s of skills) {
    // the skills that come with the app are split by whether files are in the chat; a skill of the person's own applies in both cases
    if (!s.when || (s.core && (s.id === "edit-files") !== hasFiles)) continue;
    // a pattern that could freeze the window is never run (a skill saved before this check, or edited by hand)
    if (patternRisk(s.when)) continue;
    let re: RegExp;
    try { re = skillPattern(s.when, "gi"); } catch { continue; }
    const len = Math.max(0, ...(head.match(re) ?? []).map((m) => m.length));
    // at equal length a skill of the person's own wins over a default one
    if (len > bestLen || (len > 0 && len === bestLen && best?.core && !s.core)) { best = s; bestLen = len; }
  }
  return best;
}

/** What an automatically loaded skill gives the model: its rules and the order of its steps, in one short text. */
export const autoSkillPrompt = (s: Skill): string => [s.instructions.trim(), libraryPrompt(s.libraries), `Work in this order: ${s.steps.map((x) => x.title.toLowerCase()).join(", ")}.`].filter(Boolean).join("\n");
