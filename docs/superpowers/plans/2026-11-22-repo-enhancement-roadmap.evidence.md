# Evidence ledger — MKMN enhancement roadmap

The state record for `2026-11-22-repo-enhancement-roadmap.md` (see its sections C2, C3 and C8). Add one row per task, and add to a row as the task moves through implement, verify and review. Write each command as `command → exit status`. Use repo-relative paths only. Leave out personal data and model identifiers.

| task | phase | plan_version | base_rev | head_rev | executor | commands | tests (pass/fail/skip vs base) | rework_used | stop_reason | reviewer | verdict + findings | accepted_by | follow_ups | false_accept_later |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | fd402bd | fd402bd | de7ef23 | native (inline) | `pnpm exec vitest run tests/readme-header.test.ts tests/version.test.ts tests/build-docs.test.ts` → 1 before (4 failed), 0 after; `node scripts/check-language.mjs` → 0 | 7/0/0 in the three files; full suite failures 2 → 0 | 0 | done | pending final review | — | — | — | — |
| 2 | 0 | fd402bd | de7ef23 | (this commit) | native (inline) | six named files → 0 (40 passed, 0 skipped on Windows) | Windows skip count unchanged (0 new skips); Linux not run here | 0 | done (Linux half unverified until CI, Task 9) | pending final review | — | — | — | — |
| 3 | 0 | fd402bd | 5ed8ef0 | (this commit) | native (inline) | `pnpm exec vitest run tests/pdf-runtime.test.ts` → 1 before (3 failed: 2 s timeout, no engines, no engine-strict), 0 after; with `tests/pdf-lifecycle.test.ts` → 0 (10 passed); `pnpm --ignore-workspace install --frozen-lockfile --offline` → 0 | +3 tests, all pass | 0 | done, awaiting owner gate | pending final review | — | **owner gate open**: `engine-strict` refuses installs on Node 22 | QE-1.3(c): test that the bundled sidecar Node major equals the CI Node major | — |
| 8 | 0 | fd402bd | d834fd6 | (this commit) | native (inline) | `pnpm exec vitest run tests/vitest-config.test.ts` → 1 before (2 failed), 0 after; `pnpm exec vitest run` → 0 (274 files, 2835 passed, 1 skipped, 0 unhandled); `pnpm typecheck` → 0 | full suite green on Windows; shelved test no longer run (−1 file) | 0 | done | pending final review | — | — | — | — |
| 4 | 0 | fd402bd | 57e97d6 | (this commit) | native (inline) | reproduced on Windows with `TEMP`/`TMP` set to a case-sensitive folder (`fsutil file setCaseSensitiveInfo … enable`): `pnpm exec vitest run tests/compiled-context-ipc.test.ts tests/pdf-context.test.ts` → 1 (the same 3 failures as Linux, `null` instead of 2048); new `tests/removal-safety.test.ts` case → 1 before, 0 after; three files → 0 (62 passed) in both normal and case-sensitive temp; `pnpm typecheck` → 0; `pnpm exec vitest run` → 0 (2838 passed, 1 skipped) | +3 tests | 0 | done | pending final review — **look closely**: `modelFolders` also feeds the fallback recursive delete | — | — | — | — |

## Baseline (before Task 1)

To be recorded at the start of execution: `pnpm exec vitest run` totals on the base revision, Node version, and `pnpm typecheck` exit status. The QE session saw 22 failed, 7 skipped and 4 unhandled errors (Linux, Node 22.23.5).

Recorded 2026-11-22 on base `fd402bd`, Windows 11 ARM64, Node 26.13.0, pnpm 10.26.1:

- `pnpm typecheck` → 0
- `pnpm exec vitest run` → 1: 2 failed (`tests/build-docs.test.ts`, `tests/version.test.ts`, both README contract strings), 2830 passed, 1 skipped, 0 unhandled errors, 100 s.
- No Linux host is available in this run (no WSL, no Docker). The Linux-only failures (QE-1.2, 1.5–1.8) cannot be reproduced here; their Linux evidence comes from the CI job added in Task 9.

## Rulings

- Task 2: Ruling: the RED step (22 failures on Linux) cannot be observed on this Windows host — the gating was written from reading each test, and the Windows run proves the tests still run and pass here. Linux proof is deferred to the Task 9 `unit` job. Cost if wrong: a test still fails on Linux and shows up red in CI.
- Task 3: Ruling: the guard goes in `readPdf` in `src/renderer/pdf.ts`, not `src/core/pdf.ts` — `readPdf` is the function the plan's test calls and the only place pdf.js is loaded; `src/core/pdf.ts` never imports pdf.js. Cost if wrong: none for behaviour; only the file named in the plan differs.
- Task 2: Ruling: `tests/npu-reset-command.test.ts` already guards its PowerShell calls with `onWindows`, so it is left unchanged. Cost if wrong: none found.

- Task 4: Root cause: `canonicalName` lowercases (`qualcomm/qwen3-1.7b`) while the cache keeps the publisher's spelling (`qualcomm/Qwen3-1.7B`); `modelFolders` found it only because Windows folders ignore case by default. Hypothesis 1 (backslash keys, from the plan) was ruled out by reading `compiledContextOf`; hypothesis 2 (case) was confirmed by reproducing the Linux failure on Windows in a case-sensitive folder.
- Task 4: Ruling: fix instead of skip — the failure also happens on Windows in a case-sensitive folder, so it is not Windows-only. `modelFolders` now falls back to the one folder that matches apart from case, one segment at a time, inside the models folder only; two matches are ambiguous and select nothing, so the delete path never widens. Cost if wrong: on a case-sensitive cache holding two spellings of one model, neither is found (a missed context size or a skipped fallback delete, never a wrong delete).

## Follow-ups (owner decides)

| found in task | item | decision |
|---|---|---|

## Owner waivers and deferrals

| task | what | reason | date |
|---|---|---|---|
