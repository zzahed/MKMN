// Pure setup-state presentation logic, safe to import from the renderer:
// no Node built-ins, no filesystem, no installer code. The Node side
// (downloads, geniex location) lives in src/core/setup.ts,
// which re-exports these types for compatibility.

import type { MachineState } from "../shared/stateMachines";

export type StepId = "geniex" | "llama" | "voice-stt" | "voice-tts";
/** The setup registry machine names these; the screen and the service share one list. */
export type StepState = MachineState<"setup">;

export interface SetupStep {
  id: StepId;
  label: string;
  detail: string;
  /** What this part makes possible, and what still works when it is skipped. */
  enables: string;
  withoutIt: string;
  /** Approximate download size, only when it is known (never guessed). */
  sizeMB: number | null;
  state: StepState;
  percent: number | null;
  message: string | null;
  /** Plain-words problem and what to do. */
  error: string | null;
  /** The installer was not run because it is unsigned: its SHA-256, for "Run it anyway". */
  unsigned?: string | null;
}

export interface SetupState {
  active: boolean;
  /** Something is missing and the person has not yet said whether it may be downloaded. */
  awaitingConfirm: boolean;
  steps: SetupStep[];
}

export const setupFinished = (s: SetupStep[]) => s.every((x) => x.state === "done" || x.state === "skipped" || x.state === "error");

/** What setup actually concluded, derived from step states — never claimed
 *  unconditionally. The setup screen renders exactly this view. */
export type SetupOutcome = "confirm" | "busy" | "failed" | "partial" | "ready";

export interface SetupOutcomeView {
  outcome: SetupOutcome;
  heading: string;
  description: string;
}

const listNames = (names: string[]) =>
  names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Where each part can be installed later: each lives in its own Settings group. */
const INSTALL_LATER: Record<StepId, { what: string; where: string }> = {
  geniex: { what: "the NPU engine", where: "Settings › Developer" },
  llama: { what: "the graphics card and processor engine", where: "Settings › Speed & memory, after choosing the graphics card or processor" },
  "voice-stt": { what: "dictation", where: "Settings › Voice" },
  "voice-tts": { what: "read-aloud", where: "Settings › Voice" },
};

/** "You can install it later in …", naming the right place for each part. */
export function installLater(ids: StepId[]): string {
  if (ids.length === 1) return `You can install it later in ${INSTALL_LATER[ids[0]].where}.`;
  return `You can install them later: ${ids.map((id) => `${INSTALL_LATER[id].what} in ${INSTALL_LATER[id].where}`).join("; ")}.`;
}

/** Derive the setup screen's heading and description from the real outcome:
 *  consent first, then installation in progress, then failures, then skipped
 *  components, and only then "ready". Never asserts "this happens once". */
export function setupOutcomeView(state: SetupState): SetupOutcomeView {
  if (state.awaitingConfirm) {
    return {
      outcome: "confirm",
      heading: "Welcome to MKMN AI",
      description: "MKMN AI needs a few components and did not find them on this PC. Nothing is downloaded until you agree.",
    };
  }
  const busy = state.steps.some((s) => s.state === "running" || s.state === "pending");
  if (busy) {
    return {
      outcome: "busy",
      heading: "Setting things up",
      description: "MKMN AI is installing what it needs. You can leave this open; it continues in the background.",
    };
  }
  const failed = state.steps.filter((s) => s.state === "error");
  if (failed.length > 0) {
    return {
      outcome: "failed",
      heading: "Some components couldn't be installed",
      description: `${failed.length === 1 ? "One part" : `${failed.length} parts`} didn't finish installing: ${listNames(failed.map((s) => s.label))}. Use Try again, or continue with fewer features. ${installLater(failed.map((s) => s.id))}`,
    };
  }
  const skipped = state.steps.filter((s) => s.state === "skipped");
  if (skipped.length > 0) {
    const names = skipped.map((s) => s.label);
    return {
      outcome: "partial",
      heading: "Some components were skipped",
      description: `${listNames(names)} ${names.length === 1 ? "wasn't" : "weren't"} installed, so related features are limited. You can install them anytime from Settings.`,
    };
  }
  return {
    outcome: "ready",
    heading: "MKMN AI is ready",
    description: "Everything MKMN AI needs is installed on this PC.",
  };
}
