# Evidence ledger — MKMN enhancement roadmap

The state record for `2026-11-22-repo-enhancement-roadmap.md` (see its sections C2, C3 and C8). Add one row per task, and add to a row as the task moves through implement, verify and review. Write each command as `command → exit status`. Use repo-relative paths only. Leave out personal data and model identifiers.

| task | phase | plan_version | base_rev | head_rev | executor | commands | tests (pass/fail/skip vs base) | rework_used | stop_reason | reviewer | verdict + findings | accepted_by | follow_ups | false_accept_later |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | fd402bd | fd402bd | de7ef23 | native (inline) | `pnpm exec vitest run tests/readme-header.test.ts tests/version.test.ts tests/build-docs.test.ts` → 1 before (4 failed), 0 after; `node scripts/check-language.mjs` → 0 | 7/0/0 in the three files; full suite failures 2 → 0 | 0 | done | pending final review | — | — | — | — |
| 2 | 0 | fd402bd | de7ef23 | (this commit) | native (inline) | six named files → 0 (40 passed, 0 skipped on Windows) | Windows skip count unchanged (0 new skips); Linux not run here | 0 | done (Linux half unverified until CI, Task 9) | pending final review | — | — | — | — |

## Baseline (before Task 1)

To be recorded at the start of execution: `pnpm exec vitest run` totals on the base revision, Node version, and `pnpm typecheck` exit status. The QE session saw 22 failed, 7 skipped and 4 unhandled errors (Linux, Node 22.23.5).

Recorded 2026-11-22 on base `fd402bd`, Windows 11 ARM64, Node 26.13.0, pnpm 10.26.1:

- `pnpm typecheck` → 0
- `pnpm exec vitest run` → 1: 2 failed (`tests/build-docs.test.ts`, `tests/version.test.ts`, both README contract strings), 2830 passed, 1 skipped, 0 unhandled errors, 100 s.
- No Linux host is available in this run (no WSL, no Docker). The Linux-only failures (QE-1.2, 1.5–1.8) cannot be reproduced here; their Linux evidence comes from the CI job added in Task 9.

## Rulings

- Task 2: Ruling: the RED step (22 failures on Linux) cannot be observed on this Windows host — the gating was written from reading each test, and the Windows run proves the tests still run and pass here. Linux proof is deferred to the Task 9 `unit` job. Cost if wrong: a test still fails on Linux and shows up red in CI.
- Task 2: Ruling: `tests/npu-reset-command.test.ts` already guards its PowerShell calls with `onWindows`, so it is left unchanged. Cost if wrong: none found.


## Follow-ups (owner decides)

| found in task | item | decision |
|---|---|---|

## Owner waivers and deferrals

| task | what | reason | date |
|---|---|---|---|
