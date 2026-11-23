// The Computer Use methods of the sidecar: start and stop a run on the granted window, and
// the Edit a copy run with its review gate. Moved out of main.ts as they were; main.ts owns
// the runs, the review resolvers and the two run loops, and passes them in.
import type { SidecarDispatcher } from "../protocol";

export interface AgentDeps {
  /** The runs being driven, so Stop and the app shutdown abort them. */
  agentRuns: Map<string, AbortController>;
  /** Edit a copy's review gate: one resolver per run, consumed once. */
  docEditReviews: Map<string, (ok: boolean) => void>;
  runAgent: (runId: string, hwnd: number, task: string, modelId: string) => Promise<void>;
  runDocEditAgent: (runId: string, sourcePath: string, task: string, modelId: string) => Promise<void>;
}

export function registerAgent(dispatcher: SidecarDispatcher, { agentRuns, docEditReviews, runAgent, runDocEditAgent }: AgentDeps): void {
  dispatcher.register("agentRun", (runId: string, hwnd: number, task: string, modelId: string) => {
    // fire and forget: the progress streams out as `agentRun` events; the run ends
    // with a terminal status on the last one (done | unresolved | failed | cancelled)
    void runAgent(String(runId), Number(hwnd), String(task ?? ""), String(modelId ?? ""));
  });

  // "" stops every run: the window that lost track of its run (reopened, redrawn) has no id to give
  dispatcher.register("agentStopRun", (runId: string) => {
    if (!runId) { for (const ac of agentRuns.values()) ac.abort(); return; }
    agentRuns.get(String(runId))?.abort();
  });

  dispatcher.register("agentDocEditDecide", (runId: string, approved: unknown) => {
    const id = String(runId);
    const resolve = docEditReviews.get(id);
    if (!resolve) return; // the run already settled (or never reached the gate)
    docEditReviews.delete(id);
    resolve(approved === true);
  });

  // Edit a copy (docs/design/doc-edit-copy.md): the document-aware road to a Word
  // edit the window loop cannot take — no driver, no grant, no process touched.
  // The run is registered in the SAME agentRuns map, so agentStopRun and
  // appShutdown abort it with no new code.
  dispatcher.register("agentDocEdit", (runId: string, sourcePath: string, task: string, modelId: string) => {
    void runDocEditAgent(String(runId), String(sourcePath ?? ""), String(task ?? ""), String(modelId ?? ""));
  });
}
