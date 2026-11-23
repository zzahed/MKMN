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

- Task 13: Ruling: retention covers run journals (`Workspace\harness\*.jsonl`) and offloaded payloads (`Workspace\harness\offload\*.txt`) only. Artifact versions, which the brief also names, live in the window's local storage (`mkmn.versions.<id>`), out of the sidecar's reach; they stay until deleted, and the doc says so. Only files ending `.jsonl` or `.txt`, directly in the two folders, are ever removed; other files and folders are never touched. Cost if wrong: versions are not covered by the setting.
- Task 13: Ruling: "files referenced by an open chat are kept" is `pruneOlderThan`'s `keep` option (a set of paths), tested. At sidecar start no chat is running yet, so the start-up pass passes none. Age is the file's last change, so a journal still being written is never old. Cost if wrong: a chat left open across a restart that reads an old payload finds it gone (the payload is a copy of text the chat already holds or can rebuild).
- Task 13: Ruling: `privacy.retentionDays` has no Settings control: the control lives in `src/renderer/SettingsView.tsx`, not in the task's file list. The schema entry carries a `hidden` reason saying it is set in `Config/settings.json`. A missing, damaged, zero, negative or fractional value is read as null and removes nothing. `src/shared/types.ts` gains `privacy` and the generator's `expand` list names it, so the schema check covers the key. Cost if wrong: the setting is reachable only by editing the file until a control is added.

- Task 15: Ruling: the first `pnpm lint` reported 1254 errors in existing code, 1007 of them under 14 rules (`no-explicit-any` 600, `no-unused-vars` 178, `no-useless-escape` 71 and others). Instead of a file-level disable in some 200 files, `eslint.config.js` lists those 14 rules in `DEBT` and sets them to warn; every other recommended rule is an error. `no-undef` is off for TypeScript files (the type check covers it), X block files get the `X` global and the audio worklet its own globals. The React hooks rules apply to the window only (`src/core/versionBook.ts` calls a `useVersion` that is not a hook). Cost if wrong: the 14 rules do not stop new breaches until they are raised back to errors one by one.
- Task 15: Ruling: five source lines outside the file list change so the run is 0 errors: `src/voice/backend.ts` (its disable comment named `no-var-requires`, a rule typescript-eslint 8 no longer has; now `no-require-imports`), `src/renderer/FoundryPanel.tsx` (a local helper named `usePort` was not a hook; renamed `readPort`), `scripts/smoke-sidecar-devtools.js` (`null ? true : true` is `true`), and a line disable with its reason in `src/core/speechText.ts` (the emoji class is on purpose) and `src/core/markdown.ts` (a real bug, logged as a follow-up, not fixed here: it needs its own failing test). `pnpm-lock.yaml` gains the six dev packages; `globals` is added for the Node and browser globals. `CONTRIBUTING.md` names `pnpm lint` in the `lint-type` job. Cost if wrong: small; each line is reviewed in the diff.
- Task 15: Ruling: `pnpm format:check` runs and reports 776 files Prettier would change; it is not in CI and nothing is reformatted (the brief keeps a mass reformat for a separate, owner-approved commit). `.prettierrc` uses double quotes, semicolons and `printWidth` 120 to stay close to the code. Cost if wrong: the reformat commit is larger or smaller than it could be.

- Task 16: Ruling: the code names are renamed and the saved keys are not. `OpenNpuApi` becomes `MkmnApi`, the window global `window.opennpu` becomes `window.mkmn` (set and read only by the window's own code; the host injects nothing under that name), and the voice worker's test switches `OPENNPU_FAKE_VOICE`, `OPENNPU_FAKE_QNN_CRASH` and `OPENNPU_FAKE_QNN_FAIL` become `MKMN_FAKE_*`. The five keys a profile has saved under (`opennpu.conversations`, `opennpu.draft.<chat>`, `opennpu.fold`, `opennpu.railExpanded`, `opennpu.sideW`) keep their names, so no copy is needed; `tests/storage-keys.test.ts` pins that list. The rename reaches 19 test files and `scripts/smoke-sidecar-voice.js` outside the file list, one name per line. Cost if wrong: a script outside the repo that set `OPENNPU_FAKE_VOICE` no longer gets the fake voice backend.

- Task 19: Ruling: coverage is measured and enforced in the `windows-arm64-tests` job (`pnpm test --coverage`), not in the Linux `unit` job. The `unit` job runs the suite in three shards, and a threshold checked per shard sees a third of the code; the Windows job runs the whole suite once, on the platform the baseline was measured on, so its numbers compare. The job uploads `coverage-summary.json` and `lcov.info`. Cost if wrong: the Windows job, the slowest, gets slower by the coverage overhead (locally 117 s against 111 s, plus writing the reports).
- Task 19: Ruling: the global thresholds are the baseline less 1, rounded down to whole numbers (statements 72, branches 62, functions 63, lines 77). Of the six critical files P-2 names (lines 95, branches 90), a floor is set only for each measure the baseline already meets: `src/core/approval.ts` lines and branches, `src/core/settingsWriter.ts` lines, `src/core/zip.ts` lines. The rest are follow-ups. `@vitest/coverage-v8` is pinned to 5.1.0, the installed `vitest`'s exact version (5.1.1 asked for a newer `vitest`). P-2's `src/core/shelved/**`, `tests/quarantine/**` and `tests/e2e/**` excludes are left out: none of those folders exists. `CONTRIBUTING.md` says the Windows job checks coverage. Cost if wrong: a floor set too tight fails CI on a change that does not reduce coverage (a local repeat run differed by 2 branches of 40 273).

- Task 20: Ruling: the three specs (`tests/e2e/flows.spec.ts`) cover the flows the brief names and the stand-in bridge supports: a chat message with its streamed reply (Stop shows while it streams, then the reply, its speed line and the sidebar entry), Settings (Appearance set to Dark is applied to the page and still checked when Settings is opened again), and a project (created, renamed, asked before delete, kept on No, removed on Yes). Before they passed, a copy pointed at the production page (no stand-in bridge) failed all three. The CI job `e2e` runs them on Linux with Playwright's Chromium; locally on this ARM64 PC they run on the installed Edge (`PLAYWRIGHT_CHANNEL=msedge`), so no browser is downloaded here. Outside the file list: `package.json` gains `@playwright/test` and a `pnpm e2e` script, `.gitignore` gains Playwright's output folders, `CONTRIBUTING.md` lists the fifth job, and a stale comment in `ci.yml` about coverage is corrected. Cost if wrong: a flow broken only in WebView2, not in Chromium, is not caught.

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
| 13 | Add a Settings control for `privacy.retentionDays` (Chats & answers, advanced) in `src/renderer/SettingsView.tsx`, and drop its `hidden` reason | |
| 13 | Artifact versions (`mkmn.versions.<id>` in the window's storage) have no retention; the window would prune them itself | |
| 15 | `src/core/markdown.ts` `isSpecial`: the thematic-break branch uses `\2`, which names the math group, so a `---` line is not treated as a rule and a lone `-`, `*` or `_` line is. Fix with a failing test first and drop the line disable | |
| 15 | Raise the 14 `DEBT` lint rules in `eslint.config.js` back to errors one by one, fixing each rule's warnings (1028 lint warnings in all today) | |
| 15 | The Prettier reformat of the codebase (776 files), as one owner-approved commit, then `pnpm format:check` in CI | |
| 19 | Coverage of the critical files below P-2's floor (lines 95, branches 90): `src/core/isolate.ts` branches 16.7 (lines 90.9), `src/core/netGuard.ts` lines 79.7 and branches 76.3, `src/core/installerTrust.ts` lines 50.0 and branches 65.2, `src/core/settingsWriter.ts` branches 82.1, `src/core/zip.ts` branches 80.4. Add tests, then set each floor | |

## Owner waivers and deferrals

| task | what | reason | date |
|---|---|---|---|
| 5 | deferred to the Linux CI job (Task 9) | fails only on Linux; two hypotheses tested and ruled out on Windows | 2026-11-22 |
| 6 | deferred to the Linux CI job (Task 9) | fails only on Linux; two hypotheses tested and ruled out on Windows | 2026-11-22 |
| 9 | owner gate accepted (CI workflow, Node 26, Rust 1.100.0, CONTRIBUTING rule) after review of PR 6 | repo policy and CI (C4) | 2026-11-22 |
| 10 | owner gate accepted (network probe, refusal of generated code, probe moved into the sidecar) | security (C4) | 2026-11-22 |
| 12 | owner gate accepted (deleting a project removes its knowledge index, vectors and offloaded text) after CI run 45071081599 | privacy (C4) | 2026-11-23 |
| 13 | owner gate accepted (privacy.retentionDays, default null, prunes journals and payloads at sidecar start) after CI run 45071081599 | privacy, saved data (C4) | 2026-11-23 |
| 14 | owner gate accepted (SECURITY.md, PR template, bug and feature issue forms) | repo policy (C4) | 2026-11-23 |
| 15 | owner gate accepted (ESLint at 0 errors with 14 rules set to warn as `DEBT`, Prettier check only, `pnpm lint` in `lint-type`) | CI (C4) | 2026-11-23 |
| 16 | owner gate accepted (code names renamed to MKMN; the five `opennpu.*` saved keys kept) | saved data (C4) | 2026-11-23 |

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

## CI run 45071081599 (PR 6, commit 5f6e8f2, Node 26.13.1, Rust 1.100.0)

All seven jobs pass: `lint-type`, `unit` (1–3), `windows-arm64-tests` (2866 JavaScript tests passed, 1 skipped; clippy `-D warnings`; 264 + 10 Rust tests), `security`, and CodeQL `analyze` (run 45071081730, 0 open alerts). This run covers Tasks 12 and 13; the run for f5cb620 was cancelled by the 5f6e8f2 push. Their owner gates (privacy, saved data) are open.

## Coverage baseline (Task 19, full suite on Windows ARM64, 2026-11-23)

All files: statements 73.18% (33878/46292), branches 63.75% (25677/40273), functions 64.71% (7052/10897), lines 78.46% (24422/31123). 279 test files, 2871 tests passed, 1 skipped. Per file (percent):

<details>
<summary>368 files</summary>

| file | lines | branches | functions | statements |
|---|---|---|---|---|
| `src/core/abortable.ts` | 100 | 50 | 75 | 77.77 |
| `src/core/adaptiveCompute.ts` | 89.76 | 71.75 | 86.2 | 89.1 |
| `src/core/agents.ts` | 100 | 85 | 100 | 96.59 |
| `src/core/approval.ts` | 100 | 100 | 100 | 100 |
| `src/core/arch.ts` | 100 | 100 | 100 | 100 |
| `src/core/artifactGroups.ts` | 100 | 90.32 | 100 | 100 |
| `src/core/artifacts.ts` | 100 | 75.49 | 100 | 91.26 |
| `src/core/attachments.ts` | 100 | 81.81 | 94.44 | 93.84 |
| `src/core/backends.ts` | 92.85 | 80.48 | 100 | 88.88 |
| `src/core/battery.ts` | 97.84 | 90.17 | 90 | 92.85 |
| `src/core/bench.ts` | 97.53 | 87.44 | 97.53 | 95.55 |
| `src/core/benchCandidates.ts` | 100 | 100 | 100 | 100 |
| `src/core/benchCharts.ts` | 100 | 82.5 | 100 | 98.98 |
| `src/core/benchChecks.ts` | 98.79 | 84.52 | 100 | 95.52 |
| `src/core/benchEstimate.ts` | 100 | 100 | 100 | 100 |
| `src/core/benchExport.ts` | 92.68 | 72.61 | 84.84 | 88.47 |
| `src/core/benchRunner.ts` | 92.63 | 73.79 | 65.4 | 82.68 |
| `src/core/benchSections.ts` | 100 | 100 | 100 | 100 |
| `src/core/benchStats.ts` | 100 | 81.25 | 100 | 98.73 |
| `src/core/benchStore.ts` | 100 | 92.68 | 100 | 99.01 |
| `src/core/benchTests.ts` | 75.97 | 50.58 | 72.97 | 79.08 |
| `src/core/blocks.ts` | 99.18 | 85.4 | 100 | 95.28 |
| `src/core/browse.ts` | 97.59 | 71.52 | 90.47 | 92.17 |
| `src/core/budget.ts` | 100 | 75 | 100 | 100 |
| `src/core/build.ts` | 93.97 | 83.08 | 87 | 89.15 |
| `src/core/bundle.ts` | 100 | 72.22 | 95 | 92.57 |
| `src/core/capabilities.ts` | 100 | 96.49 | 100 | 97.56 |
| `src/core/catalog.ts` | 100 | 100 | 100 | 100 |
| `src/core/chapters.ts` | 100 | 93.33 | 100 | 100 |
| `src/core/chart.ts` | 99.42 | 80.03 | 93.04 | 92.32 |
| `src/core/chartTemplates.ts` | 100 | 90 | 100 | 90.9 |
| `src/core/chat.ts` | 97.28 | 89.02 | 82.14 | 93.34 |
| `src/core/chatOrchestrator.ts` | 69.9 | 57.91 | 55.33 | 64.5 |
| `src/core/cite.ts` | 100 | 81.66 | 95.45 | 97.56 |
| `src/core/cloudChat.ts` | 100 | 66.66 | 100 | 100 |
| `src/core/codecheck.ts` | 98.16 | 82.97 | 92.85 | 94.7 |
| `src/core/color.ts` | 100 | 96.15 | 100 | 100 |
| `src/core/compaction.ts` | 99.03 | 85.85 | 95.12 | 95.3 |
| `src/core/composer.ts` | 100 | 100 | 100 | 100 |
| `src/core/construct/art.ts` | 97.56 | 73.33 | 85.71 | 89.09 |
| `src/core/construct/assemble.ts` | 100 | 92.39 | 100 | 97.72 |
| `src/core/construct/batches.ts` | 100 | 100 | 100 | 100 |
| `src/core/construct/bind.ts` | 91.24 | 78.34 | 82.14 | 80.24 |
| `src/core/construct/checkArtifact.ts` | 78.57 | 42.1 | 100 | 73.33 |
| `src/core/construct/context.ts` | 100 | 85.15 | 100 | 95.63 |
| `src/core/construct/docs.ts` | 100 | 75 | 100 | 100 |
| `src/core/construct/edits.ts` | 100 | 93.33 | 100 | 98.3 |
| `src/core/construct/fixes.ts` | 97.46 | 78.12 | 93.4 | 84.15 |
| `src/core/construct/marks.ts` | 100 | 100 | 100 | 88.88 |
| `src/core/construct/mend.ts` | 93.82 | 76.02 | 100 | 82.91 |
| `src/core/construct/pagecheck.ts` | 97.87 | 75.92 | 100 | 91.8 |
| `src/core/construct/pipeline.ts` | 94.52 | 80.85 | 91.89 | 87.42 |
| `src/core/construct/repomap.ts` | 100 | 89.47 | 100 | 100 |
| `src/core/construct/sandbox.ts` | 98.87 | 88.04 | 100 | 94.77 |
| `src/core/construct/scenarios.ts` | 95.83 | 71.66 | 94.11 | 90.83 |
| `src/core/construct/scene.ts` | 97.95 | 64.86 | 69.23 | 80.23 |
| `src/core/construct/stateUse.ts` | 95.91 | 87.13 | 94.91 | 89.42 |
| `src/core/construct/tasklist.ts` | 99.28 | 94.17 | 100 | 97.56 |
| `src/core/construct/templates/index.ts` | 100 | 100 | 100 | 100 |
| `src/core/construct/templates/platformer.ts` | 100 | 100 | 100 | 100 |
| `src/core/construct/templates/rpg.ts` | 100 | 100 | 100 | 100 |
| `src/core/construct/templates/types.ts` | 100 | 100 | 100 | 100 |
| `src/core/construct/types.ts` | 100 | 100 | 100 | 100 |
| `src/core/construct/wiring.ts` | 98.21 | 90.8 | 100 | 93.93 |
| `src/core/context.ts` | 100 | 90.26 | 100 | 98.06 |
| `src/core/contextUse.ts` | 100 | 93.75 | 100 | 100 |
| `src/core/deckBrief.ts` | 100 | 94.73 | 92.85 | 95.65 |
| `src/core/deckBuild.ts` | 95.44 | 73.98 | 82.52 | 85.35 |
| `src/core/deckEdit.ts` | 85.62 | 61.78 | 88.13 | 73.69 |
| `src/core/deckFacts.ts` | 95.06 | 81.63 | 86.2 | 88.8 |
| `src/core/diagram.ts` | 95.69 | 87.05 | 81.81 | 93.91 |
| `src/core/docBlocks.ts` | 100 | 88 | 100 | 97.5 |
| `src/core/docEdit.ts` | 96.5 | 86.11 | 100 | 92.77 |
| `src/core/docker.ts` | 100 | 68.75 | 100 | 89.65 |
| `src/core/download.ts` | 95.23 | 85.71 | 88.88 | 82.45 |
| `src/core/dynamic-data.ts` | 100 | 100 | 100 | 100 |
| `src/core/dynamic.ts` | 97.1 | 83.14 | 94.28 | 95.02 |
| `src/core/effort.ts` | 100 | 84.37 | 92.85 | 95.65 |
| `src/core/endpoint.ts` | 100 | 92.3 | 100 | 100 |
| `src/core/engine.ts` | 98.63 | 77.81 | 95.91 | 88.8 |
| `src/core/engineRuntime.ts` | 100 | 75 | 100 | 94.11 |
| `src/core/engineSkeletons.ts` | 100 | 83.33 | 100 | 100 |
| `src/core/errors.ts` | 100 | 100 | 100 | 100 |
| `src/core/exportFormats.ts` | 100 | 66.66 | 75 | 94.11 |
| `src/core/figures.ts` | 40 | 0 | 50 | 55.55 |
| `src/core/figureWork.ts` | 100 | 100 | 100 | 100 |
| `src/core/fit.ts` | 94.11 | 90.09 | 100 | 95.06 |
| `src/core/focus.ts` | 98.76 | 82.66 | 93.75 | 91.2 |
| `src/core/folderRun.ts` | 71.13 | 49.56 | 70 | 58.38 |
| `src/core/folderTools.ts` | 96.29 | 70.96 | 100 | 94.28 |
| `src/core/fonts.ts` | 100 | 100 | 100 | 100 |
| `src/core/foundry.ts` | 80.54 | 68.47 | 66.23 | 73.99 |
| `src/core/foundryHost.ts` | 82.35 | 59.13 | 57.14 | 71.12 |
| `src/core/frames.ts` | 100 | 100 | 100 | 100 |
| `src/core/fuzzy.ts` | 100 | 90 | 100 | 95.23 |
| `src/core/gameBlocks.ts` | 100 | 91.66 | 100 | 100 |
| `src/core/geniex.ts` | 72.08 | 56.75 | 62.96 | 66.66 |
| `src/core/geniexGate.ts` | 95.45 | 76.74 | 75 | 90.9 |
| `src/core/geniexRelease.ts` | 100 | 80.32 | 100 | 96.22 |
| `src/core/gguf.ts` | 80.15 | 63.21 | 65.21 | 69.27 |
| `src/core/hardware.ts` | 97.22 | 84.9 | 100 | 91.48 |
| `src/core/harness/current.ts` | 100 | 80 | 100 | 92.3 |
| `src/core/harness/evals.ts` | 97.64 | 74.07 | 96 | 96.26 |
| `src/core/harness/forget.ts` | 96.29 | 86.36 | 100 | 97.36 |
| `src/core/harness/gateway.ts` | 95.53 | 89.71 | 100 | 93.57 |
| `src/core/harness/identity.ts` | 100 | 97.91 | 100 | 100 |
| `src/core/harness/journal.ts` | 92.59 | 92.85 | 80 | 88.23 |
| `src/core/harness/offload.ts` | 100 | 92.3 | 100 | 100 |
| `src/core/harness/policy.ts` | 100 | 100 | 100 | 100 |
| `src/core/harness/run.ts` | 88.34 | 86.66 | 86.11 | 88.88 |
| `src/core/harness/schema.ts` | 88.73 | 70.58 | 66.66 | 76.23 |
| `src/core/harness/settle.ts` | 100 | 90.9 | 100 | 100 |
| `src/core/harness/testing.ts` | 97.67 | 73.07 | 94.73 | 96.22 |
| `src/core/harness/turn.ts` | 100 | 100 | 100 | 100 |
| `src/core/hf.ts` | 81.81 | 51.8 | 82.35 | 74.19 |
| `src/core/highlight.ts` | 100 | 92.06 | 100 | 96.15 |
| `src/core/humain.ts` | 100 | 70.58 | 80 | 87.5 |
| `src/core/improve.ts` | 96.03 | 69.23 | 84.37 | 87.57 |
| `src/core/installedEntries.ts` | 100 | 80 | 100 | 96.55 |
| `src/core/installerTrust.ts` | 50 | 65.21 | 30 | 50 |
| `src/core/instructions.ts` | 100 | 100 | 100 | 100 |
| `src/core/isolate.ts` | 90.9 | 16.66 | 100 | 85.71 |
| `src/core/knowledge/embed.ts` | 71.57 | 52.83 | 43.47 | 70.28 |
| `src/core/knowledge/ids.ts` | 100 | 100 | 100 | 100 |
| `src/core/knowledge/index.ts` | 100 | 84.78 | 100 | 99.12 |
| `src/core/knowledge/retrieve.ts` | 100 | 88.5 | 95.12 | 95.29 |
| `src/core/knowledge/store.ts` | 97.44 | 87.27 | 97.5 | 93.9 |
| `src/core/knowledge/vectorModel.ts` | 82.75 | 64.1 | 78.57 | 79.45 |
| `src/core/knowledge/vectors.ts` | 96.07 | 94.28 | 100 | 92.75 |
| `src/core/labCode.ts` | 100 | 89.65 | 100 | 95.91 |
| `src/core/labRunner.ts` | 100 | 81.25 | 100 | 96.36 |
| `src/core/lease.ts` | 64.86 | 52.94 | 75 | 59.52 |
| `src/core/library.ts` | 88.88 | 83.33 | 80 | 88.46 |
| `src/core/live.ts` | 100 | 87.87 | 100 | 100 |
| `src/core/loadFailures.ts` | 100 | 90 | 100 | 100 |
| `src/core/loadWords.ts` | 100 | 66.66 | 100 | 80 |
| `src/core/look.ts` | 99.18 | 80.92 | 100 | 91.69 |
| `src/core/loops.ts` | 100 | 100 | 100 | 100 |
| `src/core/manifest.ts` | 100 | 88.23 | 100 | 100 |
| `src/core/markdown.ts` | 100 | 90.62 | 100 | 91.83 |
| `src/core/math.ts` | 90.52 | 73.77 | 100 | 85.12 |
| `src/core/memo.ts` | 100 | 88.13 | 95 | 98.61 |
| `src/core/memory.ts` | 95.83 | 93.33 | 85.71 | 93.1 |
| `src/core/modelIdentity.ts` | 96.1 | 83.69 | 90 | 93.26 |
| `src/core/modelList.ts` | 100 | 80.95 | 96.15 | 97.56 |
| `src/core/native.ts` | 100 | 81.25 | 100 | 100 |
| `src/core/netGuard.ts` | 79.74 | 76.25 | 76 | 75.8 |
| `src/core/npuInUse.ts` | 100 | 100 | 100 | 100 |
| `src/core/npuLoad.ts` | 100 | 94.68 | 96.96 | 98.75 |
| `src/core/npuOwner.ts` | 100 | 76.47 | 83.33 | 90.62 |
| `src/core/npuReset.ts` | 50 | 0 | 75 | 36.36 |
| `src/core/npuTest.ts` | 88.52 | 57.14 | 47.36 | 72.16 |
| `src/core/ocr.ts` | 100 | 100 | 100 | 100 |
| `src/core/office.ts` | 97.89 | 77.86 | 98.13 | 92.42 |
| `src/core/officeConvert.ts` | 0 | 0 | 0 | 0 |
| `src/core/officeParts.ts` | 100 | 100 | 100 | 100 |
| `src/core/officeRead.ts` | 91.96 | 62.56 | 60.86 | 79.14 |
| `src/core/orchestrate.ts` | 95.53 | 84.84 | 100 | 89.28 |
| `src/core/page/blocks.tsx` | 87.8 | 76.88 | 78.2 | 84.02 |
| `src/core/page/catalog.ts` | 100 | 73.46 | 89.28 | 95.5 |
| `src/core/page/css.ts` | 100 | 75 | 100 | 100 |
| `src/core/page/html.ts` | 63.33 | 75.55 | 92.3 | 63.41 |
| `src/core/page/iconLib.ts` | 100 | 83.33 | 100 | 100 |
| `src/core/page/icons.ts` | 100 | 87.09 | 100 | 91.66 |
| `src/core/page/iconTable.ts` | 100 | 100 | 100 | 100 |
| `src/core/page/spec.ts` | 100 | 83.33 | 100 | 85.71 |
| `src/core/page/theme.ts` | 100 | 87.5 | 100 | 92.3 |
| `src/core/pdf.ts` | 98.61 | 83.03 | 100 | 90.72 |
| `src/core/pdfSections.ts` | 98.03 | 75.91 | 84.84 | 92.11 |
| `src/core/perf.ts` | 94.54 | 79.54 | 90 | 93.82 |
| `src/core/pick.ts` | 100 | 48.93 | 66.66 | 71.42 |
| `src/core/placement.ts` | 100 | 82.53 | 100 | 100 |
| `src/core/projects.ts` | 100 | 92.3 | 100 | 100 |
| `src/core/promptLab.ts` | 98.65 | 83.25 | 95.12 | 94.2 |
| `src/core/promptLabPlans.ts` | 100 | 100 | 100 | 100 |
| `src/core/promptLabPlans2.ts` | 100 | 100 | 100 | 100 |
| `src/core/promptLabPlans3.ts` | 100 | 100 | 100 | 100 |
| `src/core/promptLabUnits.ts` | 100 | 100 | 100 | 100 |
| `src/core/promptLabUnits2.ts` | 100 | 97.8 | 100 | 100 |
| `src/core/prompts.ts` | 100 | 96.87 | 100 | 97.82 |
| `src/core/providers.ts` | 100 | 100 | 100 | 100 |
| `src/core/qairt.ts` | 100 | 100 | 100 | 100 |
| `src/core/quant.ts` | 100 | 92 | 90 | 92.3 |
| `src/core/requirements.ts` | 95.06 | 77.77 | 75.67 | 86.06 |
| `src/core/resolve.ts` | 94.11 | 71.42 | 80 | 87.5 |
| `src/core/retention.ts` | 100 | 95.23 | 100 | 96.29 |
| `src/core/review.ts` | 96.44 | 77.47 | 92.3 | 92.28 |
| `src/core/router.ts` | 96.22 | 91.08 | 90.24 | 94.02 |
| `src/core/runcode.ts` | 94.44 | 80 | 83.33 | 95.65 |
| `src/core/runtime.ts` | 98.01 | 89.5 | 87.5 | 92.12 |
| `src/core/sampling.ts` | 100 | 93.75 | 100 | 96.87 |
| `src/core/schedule.ts` | 93.75 | 77.58 | 83.33 | 84.61 |
| `src/core/scheduler.ts` | 100 | 92 | 85.71 | 95.83 |
| `src/core/scores.ts` | 100 | 100 | 100 | 100 |
| `src/core/server.ts` | 96.62 | 84.52 | 86.04 | 91.51 |
| `src/core/settingsUi.ts` | 98.23 | 92.93 | 94.31 | 95.84 |
| `src/core/settingsWriter.ts` | 100 | 82.05 | 80 | 92.3 |
| `src/core/setup.ts` | 100 | 92.59 | 100 | 96.15 |
| `src/core/setupService.ts` | 92.43 | 87.32 | 81.25 | 92.54 |
| `src/core/setupView.ts` | 100 | 73.68 | 77.77 | 91.3 |
| `src/core/sheet.ts` | 89.83 | 67.12 | 97.61 | 85.86 |
| `src/core/site.ts` | 100 | 73.58 | 85.71 | 93.1 |
| `src/core/skeletons.ts` | 100 | 100 | 100 | 100 |
| `src/core/skillDocs.ts` | 100 | 100 | 100 | 100 |
| `src/core/skillLibs.ts` | 98.95 | 78.52 | 90.62 | 92.95 |
| `src/core/skills.ts` | 100 | 73 | 100 | 91.66 |
| `src/core/skillsDefault.ts` | 100 | 100 | 100 | 100 |
| `src/core/slidePicks.ts` | 100 | 88.88 | 100 | 97.77 |
| `src/core/slides.ts` | 79.96 | 71.31 | 76.63 | 75.89 |
| `src/core/source.ts` | 93.75 | 74.78 | 100 | 88.5 |
| `src/core/speakNumbers.ts` | 100 | 81.89 | 94.28 | 96.77 |
| `src/core/speechText.ts` | 98.14 | 90.08 | 94.11 | 95.68 |
| `src/core/speeds.ts` | 100 | 96.15 | 100 | 100 |
| `src/core/spoken.ts` | 100 | 87.5 | 100 | 97.77 |
| `src/core/svgPartial.ts` | 100 | 75 | 80 | 91.17 |
| `src/core/taskKnowledge.ts` | 100 | 70 | 100 | 81.25 |
| `src/core/templates/build.ts` | 94.25 | 66.66 | 78.12 | 82.02 |
| `src/core/templates/calcsheet.ts` | 96.07 | 63.58 | 98.27 | 89.74 |
| `src/core/templates/excel.ts` | 100 | 81.06 | 98.63 | 99.41 |
| `src/core/templates/freefile.ts` | 97.95 | 78.46 | 100 | 87.17 |
| `src/core/templates/index.ts` | 100 | 100 | 90.9 | 96.55 |
| `src/core/templates/kit.ts` | 100 | 76.19 | 100 | 100 |
| `src/core/templates/multipage.ts` | 92.85 | 72.22 | 90.47 | 86.41 |
| `src/core/templates/site.ts` | 98.73 | 67.87 | 88.88 | 81.96 |
| `src/core/templates/word.ts` | 98.68 | 72.51 | 92.5 | 87.27 |
| `src/core/tested.ts` | 100 | 100 | 100 | 100 |
| `src/core/themeGen.ts` | 100 | 91.17 | 100 | 100 |
| `src/core/toolCommands.ts` | 100 | 100 | 100 | 100 |
| `src/core/transcript.ts` | 100 | 100 | 100 | 100 |
| `src/core/updater.ts` | 100 | 100 | 100 | 100 |
| `src/core/vad.ts` | 97.46 | 96.55 | 86.66 | 98.26 |
| `src/core/versionBook.ts` | 84.44 | 50 | 84.61 | 71.87 |
| `src/core/versions.ts` | 97.69 | 78.94 | 95.45 | 94.88 |
| `src/core/vision.ts` | 100 | 80.95 | 100 | 97.36 |
| `src/core/visualRoute.ts` | 100 | 83.05 | 66.66 | 91.07 |
| `src/core/visuals.ts` | 94.44 | 70.58 | 85.71 | 95.65 |
| `src/core/voiceEngine.ts` | 89.28 | 82.05 | 66.66 | 84.33 |
| `src/core/voiceInstall.ts` | 100 | 80 | 100 | 95.08 |
| `src/core/voiceModels.ts` | 94.59 | 82.5 | 94.11 | 93.87 |
| `src/core/voicePick.ts` | 90.47 | 82.43 | 100 | 88.52 |
| `src/core/voiceService.ts` | 65.42 | 50.5 | 57.14 | 57.72 |
| `src/core/wav.ts` | 100 | 100 | 100 | 100 |
| `src/core/websearch.ts` | 100 | 100 | 100 | 100 |
| `src/core/wikimedia.ts` | 100 | 100 | 100 | 100 |
| `src/core/workLog.ts` | 96.15 | 83.27 | 91.37 | 95.33 |
| `src/core/xbuild.ts` | 86.03 | 57.67 | 84.09 | 78.16 |
| `src/core/xcheck.ts` | 98.47 | 83.74 | 95.48 | 91.65 |
| `src/core/xdocs.ts` | 100 | 83.33 | 91.66 | 89.28 |
| `src/core/xedit.ts` | 95.37 | 69.36 | 84.7 | 87.08 |
| `src/core/xml.ts` | 96.15 | 70.96 | 100 | 94.11 |
| `src/core/xplan.ts` | 97.58 | 73.12 | 91.3 | 92.5 |
| `src/core/zip.ts` | 98.91 | 80.43 | 90.9 | 93.75 |
| `src/renderer/Activity.tsx` | 37.7 | 12.35 | 35.48 | 30.85 |
| `src/renderer/api.ts` | 100 | 100 | 100 | 100 |
| `src/renderer/App.tsx` | 81.64 | 68.26 | 63.46 | 72.82 |
| `src/renderer/ArtifactEditor.tsx` | 3.03 | 0 | 0 | 1.85 |
| `src/renderer/Artifacts.tsx` | 53.12 | 11.66 | 12.12 | 26.98 |
| `src/renderer/ArtifactView.tsx` | 67.82 | 48.83 | 45.71 | 56.68 |
| `src/renderer/audio.ts` | 47.01 | 15.51 | 42.42 | 39.53 |
| `src/renderer/BatteryProbe.tsx` | 90.9 | 24.24 | 50 | 67.64 |
| `src/renderer/BenchDashboard.tsx` | 4.81 | 0 | 0 | 2.72 |
| `src/renderer/Benchmark.tsx` | 56.25 | 18.91 | 8.06 | 36.44 |
| `src/renderer/brand.ts` | 0 | 0 | 0 | 0 |
| `src/renderer/BuildProgress.tsx` | 17.14 | 10.78 | 18.07 | 17.11 |
| `src/renderer/Capabilities.tsx` | 100 | 50 | 75 | 80 |
| `src/renderer/ChartBlock.tsx` | 3.41 | 0 | 0 | 2.64 |
| `src/renderer/chartExport.ts` | 3.63 | 0 | 0 | 2.43 |
| `src/renderer/Chat.tsx` | 57.56 | 42.49 | 31.45 | 46.77 |
| `src/renderer/Code.tsx` | 57.14 | 40 | 42.85 | 50 |
| `src/renderer/Collapse.tsx` | 100 | 66.66 | 100 | 100 |
| `src/renderer/ComposerParts.tsx` | 20.83 | 29.62 | 41.66 | 23.68 |
| `src/renderer/computerUse.tsx` | 95.12 | 76.42 | 87.75 | 88.88 |
| `src/renderer/conversationSaver.ts` | 93.54 | 86.36 | 87.5 | 88.09 |
| `src/renderer/CopyLog.tsx` | 66.66 | 50 | 33.33 | 28.57 |
| `src/renderer/CopySupport.tsx` | 30 | 50 | 25 | 27.27 |
| `src/renderer/Customize.tsx` | 70.96 | 79.16 | 60.86 | 65.3 |
| `src/renderer/DiagramBlock.tsx` | 6.93 | 0 | 0 | 3.93 |
| `src/renderer/docs.ts` | 0 | 0 | 0 | 0 |
| `src/renderer/DynamicCard.tsx` | 22.95 | 4.27 | 7.69 | 17.47 |
| `src/renderer/DynamicEditor.tsx` | 40 | 21.73 | 21.73 | 35.84 |
| `src/renderer/EditableDoc.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/EngineCompare.tsx` | 50.76 | 26.66 | 11.76 | 37.75 |
| `src/renderer/ErrorBoundary.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/EvidenceBadges.tsx` | 7.14 | 0 | 0 | 4.54 |
| `src/renderer/Explore.tsx` | 10.43 | 0 | 0 | 6.06 |
| `src/renderer/figureImages.ts` | 10.52 | 0 | 0 | 6.15 |
| `src/renderer/FigureProgress.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/Figures.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/Foldable.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/FoundryPanel.tsx` | 66.85 | 61.67 | 40 | 58.33 |
| `src/renderer/frameRecovery.ts` | 100 | 100 | 100 | 100 |
| `src/renderer/HumainSettings.tsx` | 46.69 | 54.87 | 36.84 | 42.12 |
| `src/renderer/Icon.tsx` | 100 | 100 | 100 | 100 |
| `src/renderer/Icons.tsx` | 100 | 50 | 61.53 | 83.51 |
| `src/renderer/logoGeometry.ts` | 100 | 100 | 100 | 100 |
| `src/renderer/main.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/Markdown.tsx` | 70 | 51.38 | 66.66 | 58.99 |
| `src/renderer/MetersBar.tsx` | 100 | 88.23 | 100 | 100 |
| `src/renderer/metricsModel.ts` | 100 | 97.33 | 100 | 100 |
| `src/renderer/ModelMenu.tsx` | 82.6 | 50 | 54.83 | 65.27 |
| `src/renderer/Models.tsx` | 51.13 | 35.85 | 38.04 | 44.26 |
| `src/renderer/modelSwitch.ts` | 94.73 | 88.57 | 75 | 89.58 |
| `src/renderer/MultilingualSearch.tsx` | 96.66 | 73.52 | 84.61 | 89.74 |
| `src/renderer/NpuLoadTest.tsx` | 86.2 | 34.09 | 43.47 | 55.76 |
| `src/renderer/PageEditor.tsx` | 66.66 | 25 | 50 | 57.14 |
| `src/renderer/pdf.ts` | 64.51 | 50 | 35.71 | 55.69 |
| `src/renderer/preloadController.ts` | 99.14 | 93.68 | 92 | 94.36 |
| `src/renderer/Projects.tsx` | 59 | 55.18 | 41.66 | 52.2 |
| `src/renderer/PromptLab.tsx` | 40.57 | 26.16 | 13.72 | 30.18 |
| `src/renderer/ProviderMatrix.tsx` | 100 | 86.36 | 100 | 90.9 |
| `src/renderer/RadioSeg.tsx` | 23.8 | 16.66 | 28.57 | 17.85 |
| `src/renderer/readAloud.ts` | 100 | 100 | 100 | 100 |
| `src/renderer/Requirements.tsx` | 98.14 | 84.28 | 95 | 91.3 |
| `src/renderer/ResetNpuButton.tsx` | 66.66 | 33.33 | 50 | 28.57 |
| `src/renderer/RouterPanel.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/rowAction.ts` | 100 | 85.71 | 100 | 100 |
| `src/renderer/RunsBadge.tsx` | 80 | 35.71 | 100 | 71.42 |
| `src/renderer/RuntimePanel.tsx` | 39.72 | 14.08 | 20.4 | 33.65 |
| `src/renderer/ScoreChip.tsx` | 100 | 75 | 100 | 100 |
| `src/renderer/Search.tsx` | 91.89 | 75.63 | 78.37 | 79.16 |
| `src/renderer/Seg.tsx` | 100 | 57.14 | 100 | 85.71 |
| `src/renderer/settingsSearch.ts` | 100 | 89.65 | 100 | 100 |
| `src/renderer/SettingsView.tsx` | 46.46 | 43.15 | 34.7 | 43.72 |
| `src/renderer/SetupScreen.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/Skeleton.tsx` | 0 | 0 | 0 | 0 |
| `src/renderer/skillIcons.tsx` | 71.42 | 40 | 42.85 | 53.84 |
| `src/renderer/Skills.tsx` | 32.41 | 17.26 | 12.08 | 22.36 |
| `src/renderer/StepIcon.tsx` | 100 | 77.77 | 100 | 100 |
| `src/renderer/store.ts` | 94.59 | 64.7 | 82.05 | 83.05 |
| `src/renderer/Tasks.tsx` | 61.53 | 50.36 | 36.73 | 47.42 |
| `src/renderer/tauriBridge.ts` | 47.76 | 42.58 | 29.49 | 45.76 |
| `src/renderer/Tex.tsx` | 100 | 90 | 100 | 100 |
| `src/renderer/theme.ts` | 91.66 | 100 | 83.33 | 82.35 |
| `src/renderer/TitlebarMetrics.tsx` | 43.1 | 13.33 | 37.5 | 44.77 |
| `src/renderer/ToolsMenu.tsx` | 78.94 | 54.54 | 50 | 65.51 |
| `src/renderer/uploads.ts` | 85.07 | 59.37 | 76.92 | 70.96 |
| `src/renderer/useDocumentVisible.ts` | 100 | 100 | 80 | 88.88 |
| `src/renderer/usePresence.ts` | 97.67 | 79.74 | 100 | 90.4 |
| `src/renderer/useSmoothText.ts` | 73.68 | 50 | 80 | 64.7 |
| `src/renderer/VersionMenu.tsx` | 71.92 | 62.35 | 65.51 | 64.36 |
| `src/renderer/VersionsPanel.tsx` | 2.27 | 0 | 0 | 1.23 |
| `src/renderer/vm-shim.ts` | 0 | 0 | 0 | 0 |
| `src/renderer/voiceChat.ts` | 50.46 | 30.23 | 36.2 | 41.19 |
| `src/renderer/VoiceSetup.tsx` | 71.23 | 27.4 | 43.33 | 60.65 |
| `src/renderer/WorkLog.tsx` | 36.98 | 27.33 | 19.29 | 31.86 |
| `src/shared/agent.ts` | 100 | 100 | 100 | 100 |
| `src/shared/api.ts` | 0 | 0 | 0 | 0 |
| `src/shared/brand.ts` | 100 | 100 | 100 | 100 |
| `src/shared/consequential.ts` | 100 | 90.9 | 100 | 100 |
| `src/shared/humain.ts` | 85.29 | 67.44 | 100 | 87.8 |
| `src/shared/paths.ts` | 100 | 100 | 100 | 100 |
| `src/shared/settings.ts` | 100 | 92.5 | 100 | 97.14 |
| `src/shared/settingsSchema.ts` | 97.45 | 89.54 | 91.66 | 91.92 |
| `src/shared/stateMachines.ts` | 100 | 100 | 100 | 100 |
| `src/shared/types.ts` | 0 | 0 | 0 | 0 |
| `src/sidecar/computerUse.ts` | 89.77 | 63.69 | 93.93 | 83.39 |
| `src/sidecar/docEditRun.ts` | 97.85 | 83.33 | 100 | 91.17 |
| `src/sidecar/headless.ts` | 92.3 | 82.81 | 75 | 90.32 |
| `src/sidecar/humain.ts` | 58 | 49.5 | 58.92 | 53.27 |
| `src/sidecar/humainVault.ts` | 94.44 | 60 | 76.92 | 82.22 |
| `src/sidecar/isolateWorker.ts` | 0 | 0 | 0 | 0 |
| `src/sidecar/isolation.ts` | 100 | 75 | 77.27 | 83.07 |
| `src/sidecar/main.ts` | 0 | 0 | 0 | 0 |
| `src/sidecar/protocol.ts` | 91.66 | 85.71 | 84.61 | 93.02 |
| `src/sidecar/siteLaunch.ts` | 93.33 | 60 | 100 | 85.71 |
| `src/sidecar/unknownModelCheck.ts` | 100 | 75 | 100 | 94.33 |
| `src/voice/backend.ts` | 50 | 46.15 | 50 | 46.87 |
| `src/voice/worker.ts` | 0 | 0 | 0 | 0 |

</details>

## CI run 45118319810 (PR 6, commit d526c42, Task 19)

All jobs pass, CodeQL too (0 open alerts). `windows-arm64-tests` ran the suite with coverage: 279 files, 2871 tests passed, 1 skipped; statements 73.2%, branches 63.77%, functions 64.73%, lines 78.46%, within 0.02 of the local baseline and above every threshold. The `coverage` artifact (summary and lcov) was uploaded. Task 18 (b247f06) passed on run 45117160589; Tasks 18 and 19 are green.
