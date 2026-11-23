/**
 * The run's verdict: the one place that decides, and the only writer of, a run's
 * final status. Every run ends here — the settled steps are read once, the first
 * cause is named, and the lifecycle move the registry allows is returned. The
 * run's own code never decides an outcome by itself; it only applies what
 * settle() returned.
 *
 * The rule, in order: a cancellation ends the run cancelled, whatever the steps
 * say (the person stopped it; that outranks the work). A hard-failed step ends
 * the run failed. A step that spent its retry budget or was interrupted leaves
 * the run unresolved. A stop gate that said stop leaves it unresolved too — the
 * work finished but must not pass. Only every step ok and every gate passed is
 * done.
 */
import type { RunEvent, SettledStep } from "./run";

export type RunVerdict = "done" | "unresolved" | "failed" | "cancelled";

/**
 * A gate the pipeline hands settle(): a rule of the app that the steps alone cannot
 * see. The build rules are gates — a test run that still shows a problem, a
 * page that wires nothing and has no scenes, a judge below its mark, a call that
 * failed or timed out and was given up. A gate that is not passed holds the run at
 * unresolved even when every step settled ok: the work finished, but it did not prove itself.
 */
export interface SettleGate {
  /** The rule's name, for the verdict's cause. */
  name: string;
  /** false = the rule fires: the run is not done. */
  ok: boolean;
  /** What the person is told when the gate is not passed. */
  reason?: string;
}

export interface SettleInput {
  steps: readonly SettledStep[];
  /** The seqs of the steps the person's skip/back press threw away: they do not decide the verdict — the redo's steps do. */
  superseded?: readonly number[];
  /** The cause the APP stopped this run with (the turn's budget refused a further call): the run did not finish its course, and the stop was not the person's, so the verdict is unresolved with this cause named — never `done`, never `cancelled`. */
  stoppedBy?: string;
  /** The cancellation reason, when cancel() was called during the run. */
  cancelled?: string;
  /** The pipeline's own rules (the ones for a build); the first not passed decides with its reason. */
  gates?: readonly SettleGate[];
}

/** How the run ended: the lifecycle event, the state it lands on, and the first cause when it is not done. */
export interface SettleOutcome {
  event: RunEvent;
  state: RunVerdict;
  error?: string;
}

export function settle(input: SettleInput): SettleOutcome {
  if (input.cancelled !== undefined) {
    return { event: "cancel", state: "cancelled", error: input.cancelled };
  }
  // the policy stopped the run (the turn's budget refused a further call): the
  // course was cut short by a rule of the app, not by a fault and not by the
  // person — the work that ran stands, and the cause is named.
  // A genuinely failed step cannot sit below this: a policy refusal ends the
  // run at once, so nothing else had the chance to fail after it.
  if (input.stoppedBy !== undefined) {
    return { event: "verdict_problems", state: "unresolved", error: input.stoppedBy };
  }
  // the effective steps: a step the person's press threw away is read no further —
  // its record stands in the journal, the redo's steps decide the verdict
  const steps = input.superseded?.length ? input.steps.filter((s) => !input.superseded!.includes(s.seq)) : input.steps;
  const bad = steps.find((s) => s.status !== "ok");
  if (bad) {
    if (bad.status === "failed") {
      return { event: "verdict_error", state: "failed", error: bad.error ?? `the step ${bad.id} failed` };
    }
    return { event: "verdict_problems", state: "unresolved", error: bad.error ?? `the step ${bad.id} did not settle ok` };
  }
  const gate = steps.find((s) => s.kind === "stop-gate" && s.output === false);
  if (gate) {
    return { event: "verdict_problems", state: "unresolved", error: `the stop gate ${gate.id} said stop` };
  }
  const open = input.gates?.find((g) => !g.ok);
  if (open) {
    return { event: "verdict_problems", state: "unresolved", error: `${open.name}: ${open.reason ?? "the gate is not passed"}` };
  }
  return { event: "verdict_ok", state: "done" };
}
