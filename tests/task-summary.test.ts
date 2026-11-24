import { describe, expect, it } from "vitest";
import { taskSummary } from "../src/renderer/Tasks";
import type { Project, ScheduledTask } from "../src/shared/types";

/**
 * The task editor saved a task without saying when it would first run, which
 * model it would use, or what of the project it would read. The summary is shown
 * before saving and follows every edit.
 */

const base = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t", name: "n", prompt: "p", projectId: null, modelId: null, schedule: { kind: "interval", everyMin: 30 },
  enabled: true, created: 0, nextRun: null, running: false, runs: [], ...over
});
const now = new Date(2026, 10, 13, 9, 0).getTime();
const models = [{ entry: { id: "m1", name: "Model One" } }] as any;
const projects = [{ id: "p1", name: "Notes" }] as unknown as Project[];

describe("the task editor says what the task will do before it is saved", () => {
  it("names the next run", () => {
    const s = taskSummary(base(), now, projects, models, "Chat Model");
    expect(s.when).toBe(`Next run: ${new Date(now + 30 * 60_000).toLocaleString()}`);
  });
  it("says a paused task will not run, and a past time will not run", () => {
    expect(taskSummary(base({ enabled: false }), now, projects, models, null).when).toMatch(/^Paused/);
    expect(taskSummary(base({ schedule: { kind: "once", at: now - 1000 } }), now, projects, models, null).when).toMatch(/will not run/);
  });
  it("names the model, its own or the selected one", () => {
    expect(taskSummary(base({ modelId: "m1" }), now, projects, models, "Chat Model").model).toBe("Model: Model One");
    expect(taskSummary(base(), now, projects, models, "Chat Model").model).toMatch(/selected one \(now Chat Model\)/);
    expect(taskSummary(base(), now, projects, models, null).model).toMatch(/none is selected/);
  });
  it("names the project and that its files stay current", () => {
    expect(taskSummary(base({ projectId: "p1" }), now, projects, models, null).project).toBe("Project: Notes (uses its latest instructions and files)");
    expect(taskSummary(base(), now, projects, models, null).project).toBe("Project: none");
  });
});
