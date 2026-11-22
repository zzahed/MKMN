# Evidence ledger — MKMN enhancement roadmap

The state record for `2026-11-22-repo-enhancement-roadmap.md` (see its sections C2, C3 and C8). Add one row per task, and add to a row as the task moves through implement, verify and review. Write each command as `command → exit status`. Use repo-relative paths only. Leave out personal data and model identifiers.

| task | phase | plan_version | base_rev | head_rev | executor | commands | tests (pass/fail/skip vs base) | rework_used | stop_reason | reviewer | verdict + findings | accepted_by | follow_ups | false_accept_later |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | fd402bd | fd402bd | de7ef23 | native (inline) | `pnpm exec vitest run tests/readme-header.test.ts tests/version.test.ts tests/build-docs.test.ts` → 1 before (4 failed), 0 after; `node scripts/check-language.mjs` → 0 | 7/0/0 in the three files; full suite failures 2 → 0 | 0 | done | pending final review | — | — | — | — |
| 2 | 0 | fd402bd | de7ef23 | (this commit) | native (inline) | six named files → 0 (40 passed, 0 skipped on Windows) | Windows skip count unchanged (0 new skips); Linux not run here | 0 | done (Linux half unverified until CI, Task 9) | pending final review | — | — | — | — |
| 3 | 0 | fd402bd | 5ed8ef0 | (this commit) | native (inline) | `pnpm exec vitest run tests/pdf-runtime.test.ts` → 1 before (3 failed: 2 s timeout, no engines, no engine-strict), 0 after; with `tests/pdf-lifecycle.test.ts` → 0 (10 passed); `pnpm --ignore-workspace install --frozen-lockfile --offline` → 0 | +3 tests, all pass | 0 | done, awaiting owner gate | pending final review | — | **owner gate open**: `engine-strict` refuses installs on Node 22 | QE-1.3(c): test that the bundled sidecar Node major equals the CI Node major | — |
| 8 | 0 | fd402bd | d834fd6 | (this commit) | native (inline) | `pnpm exec vitest run tests/vitest-config.test.ts` → 1 before (2 failed), 0 after; `pnpm exec vitest run` → 0 (274 files, 2835 passed, 1 skipped, 0 unhandled); `pnpm typecheck` → 0 | full suite green on Windows; shelved test no longer run (−1 file) | 0 | done | pending final review | — | — | — | — |
| 4 | 0 | fd402bd | 57e97d6 | (this commit) | native (inline) | reproduced on Windows with `TEMP`/`TMP` set to a case-sensitive folder (`fsutil file setCaseSensitiveInfo … enable`): `pnpm exec vitest run tests/compiled-context-ipc.test.ts tests/pdf-context.test.ts` → 1 (the same 3 failures as Linux, `null` instead of 2048); new `tests/removal-safety.test.ts` case → 1 before, 0 after; three files → 0 (62 passed) in both normal and case-sensitive temp; `pnpm typecheck` → 0; `pnpm exec vitest run` → 0 (2838 passed, 1 skipped) | +3 tests | 0 | done | pending final review — **look closely**: `modelFolders` also feeds the fallback recursive delete | — | — | — | — |
| 5 | 0 | fd402bd | 79b9929 | 79b9929 (no change) | native (inline) | `vitest run tests/bench.test.ts -t estimated --repeat 50` → 1 (`--repeat` is not a Vitest CLI flag); 50 separate runs of the test → 50/50 pass on Windows; full suite in a case-sensitive temp folder → 0 | no change | 0 | **escalated: cannot reproduce on this host** — 2 hypotheses tested (C7 budget). Needs the Linux `unit` job from Task 9 to show the failing test's per-test `error`/`note` values | — | — | owner | error-path results in `BenchRunner.test` (`src/core/benchRunner.ts`, catch branch) carry no `tokensEstimated`; should be `true` | — |
| 6 | 0 | fd402bd | 79b9929 | 79b9929 (no change) | native (inline) | `pnpm exec vitest run tests/check-artifact-shared.test.ts` → 0 on Windows (2 passed); LF-only copy of the test → 0; all three files in an LF-only worktree (`core.autocrlf=false`) → 0 (102 passed); full suite with a case-sensitive temp folder → 0 | no change | 0 | **escalated: cannot reproduce on this host** — 2 hypotheses tested (C7 budget). Needs the Linux `unit` job from Task 9 to show the build's stage notes | — | — | owner | — | — |
| 7 | 0 | fd402bd | 79b9929 | (this commit) | native (inline) | new test with `process.platform` overridden to `linux` → 1 before ("Could not confirm…", the Linux failure reproduced on Windows), 0 after; `pnpm exec vitest run tests/npu-runtime-safety.test.ts` → 0 (16 passed, 1.6 s); `pnpm typecheck` → 0; `pnpm exec vitest run` → 1, 1, 0 (two different intermittent failures in unrelated files, see Follow-ups; third run 2839 passed, 1 skipped); `node scripts/check-language.mjs` → 0 | +1 test | 0 | done | pending final review | — | — | intermittent `tests/ocr.test.ts` and `tests/computerUsePanel.test.tsx` | — |

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
- Task 5: Hypothesis 1: a test that ends in the error branch has no `tokensEstimated`, so `every(t => t.tokensEstimated === true)` fails. Tested: a fetch that fails one test's prompt every time is absorbed by the gateway (scores drop, no `error`), so the branch is not reached this way — not confirmed as the Linux cause. Hypothesis 2: the 1 ms chunk timer is flaky. Tested: 50/50 pass on Windows — not reproduced. Stopped and escalated per C7.
- Task 6: Hypothesis 1: CRLF line endings in the Windows checkout change the inline test page. Tested: an LF-only copy of the test, and an LF-only worktree of the whole repo, both pass — ruled out. Hypothesis 2: a platform-dependent read in the check. Tested by reading `src/core/construct/checkArtifact.ts` and `src/core/xcheck.ts`: no platform, path or process code — ruled out. Stopped and escalated per C7. Note: the plan names `src/core/xcheck.ts`, but the reason text comes from `src/core/build.ts:1660`.
- Task 7: Root cause: `ServerManager.stopCurrent` re-issues the kill every 5 s only when `process.platform === "win32"`; elsewhere it sends one `kill()`, so the test's wedged process (it acts on the third kill) never exits, and `await start` waits past the 11 s the test advances until the 20 s test timeout. Confirmed on Windows by overriding `process.platform`.
- Task 7: Ruling: added a `platform` option to `ServerManager` (defaults to `process.platform`) and run the wedged-process test with the Windows kill policy injected. No real-process variant was added under `itWindows`: the file never had one (its processes are fakes with no pid, so no real `taskkill` runs), and a real one would spawn and kill a process in a unit test. Cost if wrong: the real `taskkill` re-issue is still covered only by reading the code and by the Windows smoke checks.

- Task 9: Ruling: no new test file — the task names none and changes only workflow, script and document files; the proof is `pnpm regen:check` exiting 0 locally and the CI run itself. Cost if wrong: a broken `regen` script is caught only when someone runs it.
- Task 9: Ruling: `lint-type` calls `pnpm regen:check` instead of the three generator lines in QE P-1 — the same three commands, one place to change them. `--coverage` and the `coverage/` upload are left out until Task 19, as the brief says. Actions are pinned to the commit each tag points to (the peeled commit for annotated tags). Cost if wrong: none for behaviour.
- Task 9: Ruling: `release.yml` uploads only `dist/MKMN-*-arm64-Setup.exe`, the path `installer.nsi` (`OutFile`) and `scripts/Build-Windows.ps1` write. Cost if wrong: the upload finds no file and fails loudly (`if-no-files-found: error`).

## Follow-ups (owner decides)

| found in task | item | decision |
|---|---|---|
| 3 | QE-1.3(c): a test that the bundled sidecar Node major equals the CI Node major | |
| 7 | Intermittent failures seen in full runs on Windows, both passing alone: `tests/ocr.test.ts` "an older store is rebuilt" (`rebuilt` came back false; likely the index memo is keyed by a file time that does not change within one tick) and `tests/computerUsePanel.test.tsx` "Enter opens the picker" (focus timing). Not caused by this plan's changes | |
| 5 | The error branch of `BenchRunner.test` returns no `tokensEstimated`; an errored test has no usage, so it should say `true` | |
| 9 | `pnpm regen` rewrites `src/core/page/icons.generated.ts` with different content although `lucide-static` is 1.68.0 in both the lockfile and `node_modules`: the committed file is stale. Left unchanged here (not a Task 9 file) | |

## Owner waivers and deferrals

| task | what | reason | date |
|---|---|---|---|
| 5 | deferred to the Linux CI job (Task 9) | fails only on Linux; two hypotheses tested and ruled out on Windows | 2026-11-22 |
| 6 | deferred to the Linux CI job (Task 9) | fails only on Linux; two hypotheses tested and ruled out on Windows | 2026-11-22 |
