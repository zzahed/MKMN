/**
 * Quality rubrics: what "good" means for a feature's output, as weighted checks
 * the app runs without a model. The other harness pieces prove a pipeline RAN
 * (settle: every step ok; the gates: a rule not broken); a rubric scores what it
 * MADE, so a deck of six identical one-line slides no longer passes as "done".
 *
 * A check returns true when it holds, or a short note saying what is wrong
 * (the note is what a retry or a report can name back). The score is the
 * weighted share of checks that hold, in [0, 1]. Any feature that produces an
 * artifact can declare a rubric here and be scored the same way: in its own
 * pipeline (a metric on its build event), and in the eval harness (a bar every
 * scripted scenario must reach).
 */

export interface QualityCheck<T> {
  /** A short stable id, for reports and test asserts. */
  id: string;
  /** How much the check counts against the others (a positive number). */
  weight: number;
  /** true when the check holds, else a short note of what is wrong. */
  test: (subject: T) => true | string;
}

export interface Rubric<T> {
  name: string;
  checks: QualityCheck<T>[];
}

export interface QualityScore {
  /** The weighted share of checks that hold, in [0, 1], rounded to 3 places. */
  score: number;
  /** The checks that did not hold, in rubric order, with their notes. */
  failed: { id: string; note: string }[];
}

export function scoreRubric<T>(rubric: Rubric<T>, subject: T): QualityScore {
  let total = 0, held = 0;
  const failed: QualityScore["failed"] = [];
  for (const c of rubric.checks) {
    const w = Math.max(0, c.weight);
    total += w;
    let r: true | string;
    // a check that throws on an odd subject is a check that did not hold, never a crash of the pipeline it scores
    try { r = c.test(subject); } catch (e) { r = `the check could not run: ${(e as Error).message}`; }
    if (r === true) held += w;
    else failed.push({ id: c.id, note: r });
  }
  return { score: total ? Math.round((held / total) * 1000) / 1000 : 1, failed };
}

/** The bar a feature's eval scenarios must reach. */
export const QUALITY_BAR = 0.85;
