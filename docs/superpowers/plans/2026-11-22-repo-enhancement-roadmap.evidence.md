# Evidence ledger — MKMN enhancement roadmap

The state record for `2026-11-22-repo-enhancement-roadmap.md` (see its sections C2, C3 and C8). Add one row per task, and add to a row as the task moves through implement, verify and review. Write each command as `command → exit status`. Use repo-relative paths only. Leave out personal data and model identifiers.

| task | phase | plan_version | base_rev | head_rev | executor | commands | tests (pass/fail/skip vs base) | rework_used | stop_reason | reviewer | verdict + findings | accepted_by | follow_ups | false_accept_later |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Baseline (before Task 1)

To be recorded at the start of execution: `pnpm exec vitest run` totals on the base revision, Node version, and `pnpm typecheck` exit status. The QE session saw 22 failed, 7 skipped and 4 unhandled errors (Linux, Node 22.23.5).

## Follow-ups (owner decides)

| found in task | item | decision |
|---|---|---|

## Owner waivers and deferrals

| task | what | reason | date |
|---|---|---|---|
