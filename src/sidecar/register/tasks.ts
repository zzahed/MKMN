// The scheduled-task methods of the sidecar: list, save, delete and run a task, and forget
// a deleted chat's run records. Moved out of main.ts as they were; main.ts owns the task
// store, the scheduler and the task run itself, and passes them in.
import type { ScheduledTask } from "../../shared/types";
import { chatCount } from "../../core/chatOrchestrator";
import { forgetConversation } from "../../core/harness/forget";
import { journalDir } from "../../core/harness/journal";
import { runtimeLease } from "../../core/lease";
import type { JsonStore } from "../../core/library";
import { nextRun, validateSchedule } from "../../core/schedule";
import type { Scheduler } from "../../core/scheduler";
import type { SidecarDispatcher } from "../protocol";

export interface TaskDeps {
  taskStore: JsonStore<ScheduledTask>;
  scheduler: Scheduler;
  /** A benchmark holds the NPU: a task is not started over it. */
  benchRunning: () => boolean;
}

export function registerTasks(dispatcher: SidecarDispatcher, { taskStore, scheduler, benchRunning }: TaskDeps): void {
  dispatcher.register("tasks", () => taskStore.list());

  dispatcher.register("saveTask", (t: ScheduledTask) => {
    const now = Date.now();
    const prev = taskStore.get(t.id);
    const changed = !prev || JSON.stringify(prev.schedule) !== JSON.stringify(t.schedule) || (t.enabled && !prev.enabled);
    const bad = t.enabled && changed ? validateSchedule(t.schedule, now) : null;
    if (bad) throw new Error(bad);
    taskStore.upsert({
      ...t, created: prev?.created ?? now, runs: prev?.runs ?? [], running: prev?.running ?? false,
      nextRun: !t.enabled ? null : changed ? nextRun(t.schedule, now) : prev?.nextRun ?? nextRun(t.schedule, now)
    });
    return taskStore.list();
  });

  // Deleting a chat deletes the run journals and payloads it left in Workspace\harness (harness/forget.ts).
  dispatcher.register("forgetConversation", (convId: string) => {
    if (typeof convId !== "string" || !convId || convId.length > 200) return { journals: 0, payloads: 0 };
    const r = forgetConversation(convId, journalDir());
    if (r.journals || r.payloads) console.error(`[harness] a deleted chat's records were removed: ${r.journals} journal(s), ${r.payloads} payload(s)`);
    return r;
  });
  dispatcher.register("deleteTask", (id: string) => { taskStore.remove(String(id)); return taskStore.list(); });

  dispatcher.register("runTask", (id: string) => {
    const t = taskStore.get(String(id));
    if (!t) return;
    if (chatCount() > 0 || benchRunning() || runtimeLease.isBusy()) {
      taskStore.upsert({
        ...t,
        runs: [{
          id: `${t.id}:${Date.now()}`,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          status: "error" as const,
          output: "",
          error: "NPU is currently busy with another task",
          artifactIds: []
        }, ...t.runs].slice(0, 20)
      });
      return;
    }
    void scheduler.execute(String(id));
  });
}
