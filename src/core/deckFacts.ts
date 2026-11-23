import type { Slide } from "./slides";
import { clipPhrase } from "./slides";
import type { DeckPlan } from "./deckBuild";

/**
 * What a text given to be turned into slides already says, read without a model: its parts, its figures, a rise from one
 * value to another. The small model that plans the slides tends to choose plain bullets for everything; these facts let the app
 * give a part with figures the figures layout, give a rise its chart (the numbers are the text's own), and give the writer the
 * part it is writing about instead of the whole text.
 */

const FIGURE = /(?:US)?[$€£]\s?\d[\d.,]*\s?(?:bn|billion|trillion|tn|m|million|k)?\b|\b\d[\d.,]*\s?(?:%|(?:percent|bn|billion|million|trillion)\b)/gi;

/** The parts of a text: its blank-line paragraphs, a lone heading line joined to what follows. */
export function partsOf(text: string): string[] {
  const out: string[] = [];
  for (const p of text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
    const lone = out.length && out[out.length - 1].split("\n").length === 1 && out[out.length - 1].length < 70 && !/[.!?]$/.test(out[out.length - 1]);
    if (lone) out[out.length - 1] += `\n${p}`; else out.push(p);
  }
  return out;
}

export function figuresIn(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(FIGURE)) seen.add(m[0].trim().replace(/[.,]$/, ""));
  return [...seen];
}

const words = (t: string) => new Set(t.toLowerCase().match(/\p{L}{4,}/gu) ?? []);
/** The part of the text a slide is about: the one that shares the most words with its topic. "" when none does. */
export function partFor(source: string, topic: string): string {
  const want = words(topic);
  let best = { part: "", score: 0 };
  for (const part of partsOf(source)) {
    const have = words(part.split("\n")[0] + " " + part.slice(0, 400));
    let score = 0; for (const w of want) if (have.has(w)) score++;
    if (score > best.score) best = { part, score };
  }
  return best.part;
}

/** "rose from $48bn in 2007 to $475bn in 2025" as the rows of a chart; null when the text has no such rise
 * or tells it in units that cannot share one scale (a chart of "from $48m to $475%" would be nonsense). */
export function trendTable(part: string): string[][] | null {
  const m = /from\s+(?:US)?[$€£]?\s?(\d[\d.,]*)\s?(bn|billion|m|million|%)?\s+in\s+((?:19|20)\d\d)\s+to\s+(?:US)?[$€£]?\s?(\d[\d.,]*)\s?(bn|billion|m|million|%)?\s+in\s+((?:19|20)\d\d)/i.exec(part);
  if (!m) return null;
  const subject = /\b(exports?|imports?|gdp|fdi|sales|revenue|growth|reserves|trade|users|population)\b[^.]{0,40}\b(?:rose|grew|increased|climbed|jumped|went up)/i.exec(part)?.[1];
  const norm = (u?: string) => (u ?? "").toLowerCase().replace("billion", "bn").replace("million", "m");
  let u1 = norm(m[2]), u2 = norm(m[5]);
  let v1 = m[1].replace(/,/g, ""), v2 = m[4].replace(/,/g, "");
  /* one scale for both rows: a rise told in mixed units ("from $48m in 2007 to $475bn in 2025") would draw a wrong
   * chart, so millions are brought into billions when the other value is in billions */
  if (!u1 && u2) u1 = u2;
  if (!u2 && u1) u2 = u1;
  if (u1 === "m" && u2 === "bn") { v1 = String(+(Number(v1) / 1000).toFixed(4)); u1 = "bn"; }
  else if (u1 === "bn" && u2 === "m") { v2 = String(+(Number(v2) / 1000).toFixed(4)); u2 = "bn"; }
  if (u1 !== u2) return null;
  const unit = u1;
  const head = `${subject ? subject[0].toUpperCase() + subject.slice(1).toLowerCase() : "Value"}${unit ? ` (${unit})` : ""}`;
  return [["Year", head], [m[3], v1], [m[6], v2]];
}

/** The plan, with a part of the text that is full of figures shown as figures and a rise shown as a chart, where the planner chose plain bullets. */
export function enrichPlan(plan: DeckPlan, source: string): DeckPlan {
  let stats = plan.slides.filter((s) => s.visual === "stats").length;
  let charts = plan.slides.filter((s) => s.visual === "chart").length;
  let timelines = plan.slides.filter((s) => s.visual === "timeline").length;
  const slides = plan.slides.map((s) => {
    if (s.role !== "content" || s.visual !== "none") return s;
    const part = partFor(source, s.topic);
    if (!part) return s;
    if (eventsIn(part).length >= 4 && timelines < 2) { timelines++; return { ...s, visual: "timeline" as const, hint: "the dated events of this part" }; }
    if (trendTable(part) && charts < 2) { charts++; return { ...s, visual: "chart" as const, hint: "bar the rise given in the text" }; }
    if (figuresIn(part).length >= 4 && stats < 3) { stats++; return { ...s, visual: "stats" as const, hint: `the figures of this part: ${figuresIn(part).slice(0, 4).join("; ")}` }; }
    return s;
  });
  return { ...plan, slides };
}

/** A slide written from the text itself, when the model's slide came back empty: the part's sentences, shortened at a natural place. */
export function slideFromPart(topic: string, part: string): Slide {
  const sentences = part.replace(/^[^\n]*\n(?=[^\n]*[.!?])/, "").split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.split(" ").length >= 4);
  const lines = sentences.slice(0, 3).map((x) => ({ text: clipPhrase(x.replace(/[.!?]$/, ""), 14), level: 0, bullet: true }));
  return { title: clipPhrase(topic, 9), lines, table: null, notes: "" };
}

const YEAR = "(?:19|20)\\d\\d";
const LEAD = /^(?:and|then|also|has|have|had|it|he|she|they|vietnam|that|which|since|after|in|by|the|a|an|as a result,?|but|while)\s+/i;
/** Dated events of a part, in order of date: "joined ASEAN in 1995 and APEC in 1998", "the CPTPP (2018)". A year that stands alone is not an event. */
export function eventsIn(part: string): { when: string; what: string }[] {
  const out: { when: string; what: string }[] = [];
  const text = part.replace(/^[^\n]*\n(?=[^\n]*[.!?])/, "").replace(/\s+/g, " ");
  const clean = (x: string) => {
    let t = x.trim().replace(/^[,;:(\s]+|[,;:)\s]+$/g, "");
    for (let i = 0; i < 4; i++) t = t.replace(LEAD, "");
    t = t.replace(/^[A-Z][a-z]+\s+(?=(?:joined|signed|ratified|adopted|received|launched|created)\b)/, "");
    t = t.replace(/^(?:joined|signed|ratified|adopted)\s+/i, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase());
    const w = t.split(" ");
    return clipPhrase(w.slice(-6).join(" "), 6).replace(/^./, (c) => c.toUpperCase());
  };
  for (const m of text.matchAll(new RegExp(`([^.;]{3,80}?)\\s+(?:in|since)\\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+)?(${YEAR})\\b|([A-Z][\\w/-]*(?:[ -][A-Za-z][\\w/-]*){0,4})\\s*\\((${YEAR})\\)`, "g"))) {
    const year = m[3] ?? m[5];
    // "X in 1995 and Y in 1998": only the words after the last "and"/comma belong to this year
    const raw = m[1] ?? m[4];
    const label = clean((raw.split(/,\s+|\s+and\s+/i).pop() ?? raw));
    const prev = out[out.length - 1]?.what ?? "";
    const named = /^[A-Z][A-Z/-]{2,}$/.test(label) && /^(Joined|Signed|Ratified)\b/.test(prev) ? `${prev.split(" ")[0]} ${label}` : label;
    if (/[$€£%]|\d/.test(named)) continue; // a figure is not an event
    if (named.length >= 3 && !out.some((e) => e.when === year && e.what === named)) out.push({ when: year, what: named });
  }
  return out.sort((a, b) => Number(a.when) - Number(b.when)).slice(0, 7);
}

/** What a rise says in one line, from the numbers of the text: "×9.9 in 18 years, about 13% a year". null when it is not a clear rise. */
export function insightOf(t: string[][] | null, _part: string): string | null {
  if (!t || t.length < 3) return null;
  const a = Number(t[1][1]), b = Number(t[2][1]), y = Number(t[2][0]) - Number(t[1][0]);
  if (!(a > 0) || !(b > a) || y <= 0) return null;
  const ratio = b / a, rate = (ratio ** (1 / y) - 1) * 100;
  const subject = /^[A-Za-z]/.test(t[0][1]) ? t[0][1].replace(/\s*\(.*\)/, "") : "";
  return `${subject ? `${subject} ` : ""}×${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} in ${y} years (about ${Math.round(rate)}% a year)`.trim();
}

const STRONG = /\b(as a result|this is why|therefore|thus|which means|consequently)\b/i;
const CAUSE = /\b(however|but|unlike|while)\b/i;
/** The sentence of a part that says what it means: one with a cause or a contrast, else the one that carries the most figures. At most 22 words, no figure cut in two. */
export function takeawayOf(part: string): string | null {
  const body = part.replace(/^[^\n]*\n(?=[^\n]*[.!?])/, "");
  const sentences = body.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.split(" ").length >= 6);
  if (!sentences.length) return null;
  const pick = sentences.find((x) => STRONG.test(x)) ?? [...sentences].reverse().find((x) => CAUSE.test(x)) ?? [...sentences].sort((a, b) => figuresIn(b).length - figuresIn(a).length)[0];
  let t = pick.replace(/^(?:as a result|this is why|therefore|thus|consequently|however|but)\s*,?\s*/i, "");
  t = clipPhrase(t.replace(/[.!?]$/, ""), 22);
  return t ? t[0].toUpperCase() + t.slice(1) : null;
}
