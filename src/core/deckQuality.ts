// What makes a generated deck good, measured without a model: a real cover and closing, titles that differ and say something,
// slides that do not repeat each other, content slides with enough on them, a mix of visuals in a longer talk, and every slide
// within the limits. The pipeline reports the score with its metrics; the eval harness holds every scripted scenario to a bar.
import { plain, slideProblems, type Slide } from "./slides";
import { scoreRubric, type QualityScore, type Rubric } from "./harness/quality";

/** The meaningful words of a line (3 letters or more, lower case). */
export const wordsOf = (t: string): Set<string> => new Set(plain(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
/** How alike two lines are: the share of their words they have in common (Jaccard), 0 when either is empty. */
export function likeness(a: string, b: string): number {
  const x = wordsOf(a), y = wordsOf(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
/** Two lines that say the same thing. */
export const REPEAT_AT = 0.7;

const VISUAL = (s: Slide) => !!(s.stats?.length || s.flow?.length || s.columns?.length || s.table || s.figure || s.timeline?.length || s.image || s.blocks?.length);
const FRAME = new Set(["cover", "closing", "section", "agenda", "quote", "bignumber"]);
/** The slides that carry the talk (not its cover, closing, dividers or one-element layouts). */
export const contentSlides = (slides: Slide[]) => slides.filter((s) => !FRAME.has(s.layout ?? ""));
/** How much a slide holds: a line counts 1, a text block 2, a visual 3. */
export const bodyOf = (s: Slide) => s.lines.length + 2 * (s.blocks?.length ?? 0) + (s.stats?.length || s.flow?.length || s.columns?.length || s.table || s.figure || s.timeline?.length ? 3 : 0) + (s.image ? 1 : 0);
/** The least a content slide should hold. */
export const MIN_BODY = 3;

const GENERIC = /^(?:introduction|overview|conclusions?|summary|key (?:points|ideas|facts)|slide\s*\d+|part\s*\d+|questions\??|thank you|the end|details|more|other)$/i;
const key = (t: string) => plain(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const DECK_RUBRIC: Rubric<Slide[]> = {
  name: "deck",
  checks: [
    {
      id: "cover", weight: 2,
      test: (sl) => {
        const c = sl[0];
        if (!c || c.layout !== "cover") return "the first slide is not a cover";
        if (!c.title.trim()) return "the cover has no title";
        if (sl.slice(1).some((s) => key(s.title) === key(c.title))) return "the cover's title is used again by another slide";
        return true;
      },
    },
    { id: "closing", weight: 1, test: (sl) => (sl.length < 3 || sl[sl.length - 1].layout === "closing") || "the last slide is not a closing slide" },
    {
      id: "distinctTitles", weight: 2,
      test: (sl) => {
        const seen = new Map<string, number>();
        for (const [i, s] of sl.entries()) { const k = key(s.title); if (k && seen.has(k)) return `slides ${seen.get(k)! + 1} and ${i + 1} have the same title`; seen.set(k, i); }
        return true;
      },
    },
    {
      id: "noRepeats", weight: 3,
      test: (sl) => {
        const lines = sl.flatMap((s, i) => s.lines.map((l) => ({ i, t: l.text })));
        for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) {
          if (lines[a].i !== lines[b].i && likeness(lines[a].t, lines[b].t) >= REPEAT_AT) return `slide ${lines[b].i + 1} repeats a line of slide ${lines[a].i + 1}`;
        }
        return true;
      },
    },
    {
      id: "density", weight: 3,
      test: (sl) => {
        const thin = sl.map((s, i) => ({ s, i })).filter(({ s }) => !FRAME.has(s.layout ?? "") && bodyOf(s) < MIN_BODY);
        return !thin.length || `${thin.length} content slide(s) are nearly empty (slide ${thin.map((x) => x.i + 1).join(", ")})`;
      },
    },
    {
      id: "withinLimits", weight: 2,
      test: (sl) => { const bad = sl.findIndex((s) => slideProblems(s).length); return bad < 0 || `slide ${bad + 1}: ${slideProblems(sl[bad])[0]}`; },
    },
    {
      id: "variety", weight: 1,
      test: (sl) => {
        const c = contentSlides(sl);
        if (c.length < 4) return true;
        const shown = c.filter(VISUAL).length;
        return shown >= Math.ceil(c.length / 4) || `only ${shown} of ${c.length} content slides show more than bullets`;
      },
    },
    {
      id: "messageTitles", weight: 1,
      test: (sl) => { const g = contentSlides(sl).find((s) => GENERIC.test(key(s.title))); return !g || `the title "${g.title}" names a part, not a message`; },
    },
  ],
};

/** The deck's quality: its score in [0, 1] and what fell short. */
export const deckQuality = (slides: Slide[]): QualityScore => scoreRubric(DECK_RUBRIC, slides);
