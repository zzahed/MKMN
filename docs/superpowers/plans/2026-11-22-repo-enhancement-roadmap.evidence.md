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

- Task 9 (after CI run 45056310505): Ruling by the owner: require Node.js 26, replacing Task 3's `>=24`. Changed `engines`, both workflows, `scripts/Build-Windows.ps1`, the README and `.npmrc`; `scripts/Bundle-Sidecar.ps1` now refuses to bundle a Node older than 26, because the installer ships that runtime and Node 24 does not block network access for generated code. The `readPdf` guard also checks `Uint8Array.prototype.toHex`. New `tests/node-version.test.ts` keeps all of these on one major. Cost if wrong: contributors on Node 24 can no longer install.

- Task 5: Root cause (hypothesis 3, from CI run 45057924047): `summary.tokPerSecEstimated` is false because every test's `tokPerSec` is null — `src/core/chat.ts:484` gives a rate only for a stream that took over 50 ms, and the test's mock waits 1 ms between about 6 chunks. A 1 ms timer lasts about 1 ms on Linux (about 6 ms in all) but about 15–20 ms on Windows. Confirmed on Windows by setting the delay to 0: the test failed at the same line, 814. Fix in the test: 20 ms between chunks. The code is right not to time a 6 ms burst.
- Task 7 follow-up `tests/ocr.test.ts`: Root cause: the knowledge index memo trusts `size:mtimeMs`; the test rewrites the store at the same size, and a probe on this host found 140 of 200 back-to-back rewrites keep the same mtime. A real bug, not only a test one: another writer in the same tick is not seen. Fix: while the store's mtime is within 2 s of when the memo entry was made, the store's text is hashed and compared; once found unchanged later, the stamp alone is trusted again. New test in `tests/knowledge-fast.test.ts` pins both writes to one second and failed 3/3 before the fix. Cost if wrong: a memory hit made within 2 s of a store write reads and hashes the store file once more.

- Task 9 (after CI run 45059603059): Ruling: `windows-arm64-tests` failed in `cargo clippy -- -D warnings`, the first clippy run on this code. Two causes: `tauri::generate_context!` needs `dist/renderer`, which the job never built — `ci.yml` now runs `pnpm run build` first, as `release.yml` does; and four warnings — an unused `pid` (`src-tauri/src/supervisor.rs:2301`), two `map_or(true, …)` (`src-tauri/src/agent_wire.rs:275, 284`) and one `tick % 5 == 0` (`supervisor.rs:2747`), each replaced by the form clippy names, with no change in behaviour. Clippy and `cargo test` pass locally on Rust 1.99.1; CI uses 1.100.0, which may report more. Cost if wrong: another CI round for lints new in 1.100.

- Task 9 (after CI run 45060658703): every test passed on both systems; clippy on Rust 1.100.0 raised `needless_bool` in `src-tauri/src/bin/agent-desktop.rs:633`, a lint Rust 1.99.1 (this host) does not raise. Replaced by the form clippy names, no change in behaviour.

- Task 9: Ruling by the owner: pin one Rust version. `rust-toolchain.toml` at the repository root (cargo is run from there) names 1.100.0, with clippy and the ARM64 target; both workflows pass `toolchain: 1.100.0`; the README names it. 1.100.0, not this host's 1.99.1: it is the current stable and the version CI already ran, and either choice made rustup download a toolchain here. New `tests/rust-version.test.ts` keeps them in step. Clippy `-D warnings` and `cargo test` pass on 1.100.0 locally. Cost if wrong: contributors download 1.100.0 on their first build.

- Task 9 (after CI run 45063349828): clippy passed on 1.100.0 and every JavaScript test passed; `cargo test` ran in CI for the first time and `supervisor::tests::a_held_port_is_reported_as_a_conflict_without_spawning_a_server` failed with "GenieX is not installed". Root cause: `start` checks for an installed GenieX before the port, and the test used whatever GenieX the machine has; this host has one, the runner has none. Not reproducible here (`find_geniex` falls back to the real install), so the CI panic is the evidence. Fix in the test: it passes its own fake geniex.exe (a copy of PowerShell declared v0.11.0, never run), as the adoption tests already do. Cost if wrong: none for the app.

- Task 10: Ruling: Step 4 runs on Node 26, not Node 24 — the owner required Node 26 after CI showed Node 24 does not deny network (CI run 45056310505), which is the release blocker Step 4 names. Cost if wrong: none; Node 24 can no longer install.
- Task 10: Ruling: the probe fails closed. QE P-5 returns `out !== "CONNECTED"`, so no output, a timeout or a crash would count as proof; here only an explicit `ERR_ACCESS_DENIED` does. It connects to port 9 with nothing listening, so it needs no server and works for `runSync` too (`proveNetworkDeniedSync`), and runs with an empty environment so `NODE_OPTIONS` cannot add `--allow-net`. Cost if wrong: a runtime whose probe cannot start runs no generated code.
- Task 10: Ruling: the verdict is asked lazily on the first isolated run and kept for the life of the runner (one per sidecar start), not at start-up, so a sidecar that never runs generated code spawns no probe. A refusal propagates as an error, exactly as a failed spawn of the isolated process already did; how callers report that is unchanged. Cost if wrong: the first check waits about 0.2 s for the probe.
- Task 10: Ruling: QE-1.4(d) negatives — DNS, UDP and `fetch` — are all denied by Node 26's permission model (checked by hand, then as a test). Step 5 asks for a release notes template, which did not exist and is not in the task's file list: added `docs/releases/RELEASE_NOTES_TEMPLATE.md` with a Bundled runtime section. Cost if wrong: one new docs file.

- Task 11: Ruling: `cargo audit` is not installed on this host, and installing it means downloading and compiling a tool, so Step 1's Rust result is taken from the `security` job of CI run 45064583668, which runs the same command on the same lockfile. Findings: `pnpm audit` none (local and CI); `cargo audit` 0 vulnerabilities and 6 allowed warnings — unmaintained `chrono` 0.4.45, `proc-macro-error` 1.0.4, `zbus_names` 4.3.5, `zvariant` 5.15.1, `zvariant_derive` 5.15.1, and unsound `glib` 0.18.5 (RUSTSEC-2024-0429); `glib` is not built for `aarch64-pc-windows-msvc` (`cargo tree -i glib` prints nothing), so it does not reach the shipped app. gitleaks: no leaks. No high or critical finding, so no waiver is needed. The `security` job in `ci.yml` already ran all three, so it is unchanged. Cost if wrong: a local-only advisory database difference.
- Task 11: Ruling: CodeQL uses `build-mode: none` (JavaScript and TypeScript need no build) and also runs on pushes to `main`, so the Security tab has a baseline for `main`. Cost if wrong: one extra scan per merge.

- Task 10 (after CI run 45067081101): Ruling: `proveNetworkDenied` and `proveNetworkDeniedSync` live in `src/sidecar/isolation.ts`, not `src/core/isolate.ts` as the plan's interface names. Core's module reaches the window's bundle through `src/core/construct/sandbox.ts`, and its `child_process` import broke `vite build` on the Windows job (`"execFile" is not exported by "__vite-browser-external"`). I had checked only for direct imports from `src/renderer` and an old `dist` build, and the local gate does not run `vite build`. `IsolationUnsafeError` stays in core (no Node API). A new test fails if `src/core/isolate.ts` imports a Node built-in; `pnpm run build:renderer` passes again. Cost if wrong: none for behaviour; only the module named in the plan differs.

- Task 11: CodeQL's first run (45067390598, on 12db7e4) passed with 1 alert, high: `js/incomplete-sanitization` in `tests/rust-version.test.ts:27`, a regular expression built from the toolchain version with only the dots escaped. Not exploitable (the input is the repository's own `rust-toolchain.toml`, already required to be an exact x.y.z), but fixed: every special character is escaped. The test still passes and still fails when `rust-toolchain.toml` names another version (checked by hand).

- Task 12: Ruling: `safeIdOf` lives in a new `src/core/knowledge/ids.ts` and is re-exported from `store.ts`. `store.ts` must clear the vectors' memory (`forgetVectorProject`), so defining `safeIdOf` in `store.ts` would make `store.ts` and `vectors.ts` import each other. Cost if wrong: one more small file.
- Task 12: Ruling: `removeKnowledgeFiles` also drops the project's build state, not only the two memos, so a later open of the same id starts from "queued". The sidecar's offload folder is `path.join(journalDir(), "offload")`, the folder `foldDirOf` uses when the host sets no journal file (the sidecar sets none). Cost if wrong: a host that sets its own journal file would keep its knowledge text there.
- Task 12: Ruling: `tauriBridge.deleteProject` starts `knowledgeForget` without awaiting it: the project is already saved as removed, and the host gives a sidecar call up to 600 s (`CALL_TIMEOUT`), so awaiting could hold the delete. A failure is logged with `console.error`. `src/renderer/mock.ts` is unchanged: the browser preview keeps no knowledge files. `src/shared/api.ts` gets a description on `deleteProject` only; no new API method is needed. Cost if wrong: if the sidecar is down at the delete, the files stay until removed by hand.
- Task 12: Ruling: the new sidecar method made the generated feature matrix stale. It is regenerated by its generator; `scripts/generate-feature-matrix.mjs` (not in the task's file list) now groups `knowledgeForget` under Privacy with `tests/knowledge-forget.test.ts`, instead of the default "Host bridge". Cost if wrong: one row's group.

## Follow-ups (owner decides)

| found in task | item | decision |
|---|---|---|
| 3 | QE-1.3(c): a test that the bundled sidecar Node major equals the CI Node major | |
| 7 | Intermittent failures seen in full runs on Windows, both passing alone: `tests/ocr.test.ts` "an older store is rebuilt" (`rebuilt` came back false; likely the index memo is keyed by a file time that does not change within one tick) and `tests/computerUsePanel.test.tsx` "Enter opens the picker" (focus timing). Not caused by this plan's changes | |
| 5 | The error branch of `BenchRunner.test` returns no `tokensEstimated`; an errored test has no usage, so it should say `true` | |
| 9 | `pnpm regen` rewrites `src/core/page/icons.generated.ts` with different content although `lucide-static` is 1.68.0 in both the lockfile and `node_modules`: the committed file is stale. Left unchanged here (not a Task 9 file) | |
| 7 | `src/core/knowledge/vectors.ts` keeps the same `size:mtimeMs` memo stamp, so a same-size rewrite in one tick is not seen there either | |
| 9 | CI installs the newest stable Rust, so a new clippy lint can fail CI with no code change, and this host (1.99.1) cannot see it first. Pin one Rust version (a `rust-toolchain.toml`) for CI and local builds | done: pinned to 1.100.0 |
| 11 | `.github/workflows/release.yml` still uses five actions by tag (`@v4`, `@stable`), against the rule to pin every action to a commit. Dependabot's `github-actions` updates will propose versions; pinning them is a change to `release.yml` | |
| 11 | GitHub warns that `actions/checkout`, `setup-node`, `upload-artifact`, `pnpm/action-setup` and `gitleaks-action` v4/v2 target Node 20, which runners force onto Node 24; Dependabot should propose the newer versions | |
| 10 | `tests/computerUsePanel.test.tsx` failed once more on Linux ("the picker answers the keyboard", CI run 45067081101), a second test in the file already logged for focus timing | |
| 10 | The standard gate does not include `vite build`, so a Node import reaching the window bundle is caught only by the Windows CI job. Adding `pnpm run build:renderer` to `lint-type` would catch it on Linux in about 20 s | |

## Owner waivers and deferrals

| task | what | reason | date |
|---|---|---|---|
| 5 | deferred to the Linux CI job (Task 9) | fails only on Linux; two hypotheses tested and ruled out on Windows | 2026-11-22 |
| 6 | deferred to the Linux CI job (Task 9) | fails only on Linux; two hypotheses tested and ruled out on Windows | 2026-11-22 |
| 9 | owner gate accepted (CI workflow, Node 26, Rust 1.100.0, CONTRIBUTING rule) after review of PR 6 | repo policy and CI (C4) | 2026-11-22 |
| 10 | owner gate accepted (network probe, refusal of generated code, probe moved into the sidecar) | security (C4) | 2026-11-22 |

## CI run 45056310505 (PR 6, commit 36a4040, Node 24.22.3)

| job | result | failing tests |
|---|---|---|
| lint-type | pass | |
| unit (2) | pass | |
| unit (1) | fail | `bench.test.ts` estimated label (summary `tokPerSecEstimated` false; the per-test labels pass); `computerUsePanel.test.tsx` focus; `pdf-lifecycle.test.ts` ×3 (`a.toHex is not a function`) |
| unit (3) | fail | `check-artifact-shared.test.ts` (reason is `Identifier 'S' has already been declared`); `isolation.test.ts` network lock (`CONNECTED`) |
| windows-arm64-tests | fail | `check-artifact-shared`, `isolation`, `pdf-lifecycle` ×3 (same as Linux); `state-machines.test.ts` generator check (stale on a Windows checkout); `ocr.test.ts` rebuilt flag (the known intermittent one) |
| security | fail | `cargo audit`: `url` 2.5.8, RUSTSEC-2026-0592, fixed in 2.5.9; six "unmaintained" warnings allowed. `pnpm audit` passed; gitleaks did not run |

Finding: `check-artifact-shared`, `isolation` and `pdf-lifecycle` fail on both Linux and Windows under Node 24 and pass under Node 26 locally, so their cause is the Node version, not the system. Task 6 is one of them, so it is not Linux-only. `isolation`: Node 24's `--permission` does not restrict network access, so generated code can open connections when the sidecar runs on Node 24. `pdf-lifecycle`: pdf.js 6.5 calls `Uint8Array.prototype.toHex`, which Node 24 lacks (the app reads PDFs in WebView2, where it exists; only the test runs pdf.js in Node).

## CI run 45057924047 (PR 6, commit 64522c9, Node 26.13.1)

| job | result | failing tests |
|---|---|---|
| lint-type | pass | |
| unit (2), unit (3) | pass | |
| security | pass | `pnpm audit`, `cargo audit` (six unmaintained warnings allowed) and gitleaks all pass |
| unit (1) | fail | `bench.test.ts` estimated label: `r.summary.tokPerSecEstimated` is false at line 814 while every test's `tokensEstimated` is true at line 813 (Task 5, Linux only) |
| windows-arm64-tests | fail | `ocr.test.ts` "an older store is rebuilt": `old.rebuilt` false at line 145. It failed in both Windows CI runs, so on that runner it is not intermittent |

Node 26 cleared `isolation`, `check-artifact-shared` (Task 6), `pdf-lifecycle` ×3 and `computerUsePanel`; the CRLF fix cleared `state-machines`.

## CI run 45064583668 (PR 6, commit 976cf6b, Node 26.13.1, Rust 1.100.0)

All six jobs pass: `lint-type`, `unit` (1–3), `windows-arm64-tests` (2849 JavaScript tests, clippy `-D warnings`, 264 + 10 Rust tests) and `security` (`pnpm audit`, `cargo audit`, gitleaks). Tasks 5 and 6, deferred to this job, are resolved: Task 5 by the bench test fix (6c1cc8f), Task 6 by requiring Node 26 (5017dc2). Task 9 is complete; its owner gate (repo policy and CI) is open.
