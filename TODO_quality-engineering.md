# TODO — Quality Engineering Strategy for MKMN AI

> Risk-based test strategy, findings and trackable tasks for `zzahed/MKMN` (v0.0.2).
> Every item has a stable ID. Tick the box when the item is done **and** its success criteria are verified.
> Evidence comes from a run on 2026-11-22 (Linux container, Node 22.23.5, pnpm 10.28.0, commit `5efc4ac`). Rust and Windows-only paths were read, not run.

---

## Context

### Project
- **Name:** MKMN AI (مكمن). A local-first AI workspace for Windows 11 ARM64 (Snapdragon X / Hexagon NPU).
- **Repository:** `zzahed/MKMN`, branch `main` (12 commits, 5 merged PRs).
- **Architecture (from `CONTRIBUTING.md`):**
  - **Tauri v2 host in Rust.** `src-tauri/src`, 32 files: supervisor, sidecar, NPU recovery, QoS, settings, single instance, tray, monitor.
  - **Plain-Node sidecar.** `src/sidecar` holds the JSON-line protocol on stdout and 132 methods. It carries `src/core` (~194 files): chat orchestrator, harness/gateway, knowledge/RAG, office/PDF import, slides, bench, setup/downloads, isolation of generated code.
  - **React 19 renderer.** `src/renderer`, ~103 files.
  - **Shared contracts.** `src/shared`: settings schema, state machines, paths, API types.
  - **External engines.** Qualcomm GenieX (≥ v0.11.0), Foundry Local, QAIRT, sherpa-onnx (voice), onnxruntime, Docker (optional).
  - **Cloud (opt-in).** HUMAIN FUSE and HUMAIN Node, with the user's own API key. The key is stored with Windows DPAPI (`src/sidecar/humainVault.ts`).
  - **Packaging.** NSIS installer (`installer.nsi`) and the PowerShell build scripts in `scripts/`.

### Current quality maturity: **Level 2 of 5 (Repeatable, not yet Managed)**

| Dimension | Observed state | Evidence |
|---|---|---|
| Unit/contract tests (TS) | **Strong volume:** 272 files, 2,833 tests | `npx vitest run` |
| Suite health on a non-Windows host | **Red:** 22 failed, 7 skipped, 4 unhandled errors | see QE-ITEM-1.x |
| Rust tests | 255 `#[test]` across 28 files. **0** in `commands.rs` (529 LOC IPC surface), `tray.rs`, `settings_defaults.rs`, `main.rs` | `grep -c '#\[test\]'` |
| Component tests | jsdom with Testing Library. `.tsx` tests exist (navigation, chat-send-guard, settings) | `vitest.config.ts` |
| E2E (renderer in a browser) | **None.** A browser stand-in bridge exists (`src/renderer/mock.ts`, `mock-entry.ts`, `mock.html`) but no Playwright suite drives it | file tree |
| Installed-app E2E | Manual. The feature matrix lists **358 CONTRACT / 13 MANUAL / 1 BLOCKED / 9 PASS** rows. CONTRACT means "visual or installed path checked by hand" | `docs/MKMN_FEATURE_TEST_MATRIX_0.0.2.md` |
| CI | **One workflow, `workflow_dispatch` only.** No PR or push gate. PRs merge without any automated check | `.github/workflows/*.yml` |
| Coverage measurement | **None.** No `@vitest/coverage-*`, no thresholds, no `cargo llvm-cov` | `package.json` |
| Static and security scanning | Typecheck only. No ESLint, no `cargo clippy` gate, no dependency audit, no secret scan, no CodeQL, no Dependabot | `.github/` |
| Policy-as-tests | **Excellent:** hooks order, console hygiene, network guard, isolation, language, prompt budget, GenieX gate, one-engine guard | `CONTRIBUTING.md` rules 1–8 |
| Defect process | No issue templates (only `config.yml`), no severity scheme, no labels, no RCA records | `.github/ISSUE_TEMPLATE` |

### Known gaps (summary)
1. **No PR quality gate.** PR #5 (README redesign) merged and broke 2 tests: `build-docs.test.ts` and `version.test.ts`. This is a real defect escape.
2. **Platform coupling.** 10 of the 14 failing files fail only because they assume Windows: PowerShell spawn, `\` path separators, `C:\` paths. None of them skip cleanly, so a non-Windows run is always red.
3. **Runtime version not declared.** `package.json` has no `engines`. `pdfjs-dist@6.5` needs `Promise.try`, which Node 22 lacks. This causes 4 timeouts and 80 s of wasted suite time.
4. **Sandbox guarantee depends on the Node version.** `isolation.test.ts` reports `CONNECTED` instead of `ERR_ACCESS_DENIED`, so on this Node the permission model does not block network access from model-generated code (`src/core/isolate.ts:27`).
5. **No coverage numbers, no E2E, no non-functional baselines.** Release confidence rests on contract tests and manual click-through.

### Risk level distribution (components, see QE-PLAN-2)

| Tier | Count | Components |
|---|---|---|
| **Critical** | 8 | generated-code isolation, computer use and approvals, HUMAIN credential vault, prompt-injection boundary, artifact frame isolation, NPU/engine supervisor and process ownership, settings persistence and migration, installer/updater trust |
| **High** | 9 | chat orchestrator and streaming, harness gateway/turn/settle, sidecar protocol, model setup/download/manifest, knowledge (RAG) ingest and retrieval, PDF/Office import, router/placement, HUMAIN FUSE/Node cloud chat, single-instance and shutdown |
| **Medium** | 8 | bench runner/stats, voice (STT/TTS), slides/deck build, charts/diagrams/sheets, xblocks/construct engine, Prompt Lab, projects/tasks, search |
| **Low** | 5 | theme/brand assets, icons, motion/CSS polish, docs generators, feature-matrix generator |

---

## Strategy Plan

### 1. Test Pyramid Design

- [ ] **QE-PLAN-1.1 [Unit tests — TS core/shared]**:
  - **Goal**: Pure logic in `src/core/**` and `src/shared/**` is correct for every equivalence class and boundary: parsers, schedulers, budget math, routing, stats, sampling, zip/xml, settings writer.
  - **Coverage Target**: 85 % lines and 75 % branches on `src/core` and `src/shared`. 95 % lines and 90 % branches on Critical-tier files: `isolate.ts`, `approval.ts`, `netGuard.ts`, `installerTrust.ts`, `settingsWriter.ts`, `harness/policy.ts`, `zip.ts`.
  - **Ownership**: Feature author (the PR that adds the code adds the test). A Core maintainer reviews.
  - **Tooling**: Vitest 5 (`node` env), `@vitest/coverage-v8`, `fast-check` for property tests on parsers (zip, xml, sheet formulas, markdown, cite).

- [ ] **QE-PLAN-1.2 [Unit tests — Rust host]**:
  - **Goal**: Supervisor state transitions, NPU recovery, settings load/save, memory estimator, QoS, job objects and single-instance are deterministic and safe.
  - **Coverage Target**: 70 % lines overall in `src-tauri/src`. 85 % in `supervisor.rs`, `state_machine.rs`, `settings.rs`, `npu_recovery.rs`, `sidecar.rs`. At least 1 test per public command in `commands.rs` (it has 0 today).
  - **Ownership**: Host (Rust) maintainer.
  - **Tooling**: `cargo test`, `cargo llvm-cov`, `proptest` for state-machine transition tables, `cargo clippy -D warnings`.

- [ ] **QE-PLAN-1.3 [Component tests — renderer]**:
  - **Goal**: Each screen and control behaves correctly from the user's point of view (keyboard, focus, busy states, error states) against a fake bridge.
  - **Coverage Target**: 70 % lines and 60 % branches on `src/renderer/**`. 100 % of the 9 screens have at least one interaction test, and 100 % of Settings sections have one render plus one save test.
  - **Ownership**: Renderer/UI maintainer.
  - **Tooling**: Vitest with `@vitest-environment jsdom`, `@testing-library/react` and `user-event` (already installed), `vitest-axe` for a11y assertions.

- [ ] **QE-PLAN-1.4 [Integration tests — sidecar ⇄ core ⇄ fake engines]**:
  - **Goal**: Sidecar methods call real `src/core` modules end to end against fakes for the engines and the network: `tests/fake-geniex.js`, `FakeModel` in `src/core/harness/testing.ts`, and stubbed `fetch`.
  - **Coverage Target**: 100 % of the 132 sidecar methods have at least one integration test (happy path plus one failure path). Track the method→test map in the feature matrix generator.
  - **Ownership**: Core and sidecar maintainers.
  - **Tooling**: Vitest (`node`), the existing `scripts/smoke-sidecar-*.js` promoted into the suite, and the `MKMN_REQUIRE_SIDECAR=1` live check.

- [ ] **QE-PLAN-1.5 [Contract tests — process boundaries]**:
  - **Goal**: Both sides of each boundary agree on the same schema:
    1. renderer ⇄ host (Tauri `invoke` commands and events),
    2. host ⇄ sidecar (JSON-line protocol, `src/sidecar/protocol.ts` ⇄ `src-tauri/src/agent_wire.rs`),
    3. sidecar ⇄ GenieX/Foundry/HUMAIN HTTP APIs (OpenAI-style SSE),
    4. settings schema (TS ⇄ Rust `settings_defaults.rs`),
    5. state machines (JSON ⇄ TS ⇄ Rust).
  - **Coverage Target**: 100 % of commands, protocol messages and settings keys appear in a shared, generated fixture that both TS and Rust tests read. 0 unmatched keys.
  - **Ownership**: Whoever changes a boundary updates the fixture. The Host and Core maintainers co-own it.
  - **Tooling**: The generated fixtures already exist (`stateMachines.json`, `settingsSchema.ts`, `lifecycles.json`). Extend the pattern with a JSON-schema fixture per protocol message, validated by `ajv` in TS and `serde_json` in Rust. Pact is not needed: both sides live in one repository.

- [ ] **QE-PLAN-1.6 [E2E — renderer in a browser against the mock bridge]**:
  - **Goal**: The critical flows in QE-PLAN-3 work through the real React app in a real browser engine (WebView2 is Chromium-based).
  - **Coverage Target**: 10–15 specs, one per Critical/High flow. Under 5 min wall time. No more than 10 % of total test count (keeps the pyramid shape).
  - **Ownership**: QA engineer, or the UI maintainer if there is no QA role.
  - **Tooling**: Playwright (Chromium) on `vite` serving `src/renderer/mock.html`, `@axe-core/playwright`, and screenshot comparison for the 9 screens.

- [ ] **QE-PLAN-1.7 [E2E — installed app on Windows ARM64]**:
  - **Goal**: The packaged installer installs, launches, runs a local model on the NPU, survives close/relaunch and uninstalls cleanly.
  - **Coverage Target**: The existing PowerShell checks (`Validate-Installer.ps1`, `Live-Relaunch-Check.ps1`, `Check-After-Close.ps1`, `Check-Installed-Sidecar.ps1`) run on every release candidate. Turn the 13 MANUAL matrix rows into a scripted checklist with at least 80 % automated by v0.1.0.
  - **Ownership**: Release manager.
  - **Tooling**: `windows-11-arm` GitHub runner, PowerShell, and `tauri-driver` + WebdriverIO for WebView2 UI smoke if needed.

### 2. Risk Assessment Matrix

Likelihood (L) and Impact (I) are each 1–5. Score = L × I. Critical ≥ 15, High 10–14, Medium 5–9, Low ≤ 4.

| ID | Component (code area) | L | I | Score | Tier | Rationale |
|---|---|---|---|---|---|---|
| R-01 | Generated-code isolation (`src/core/isolate.ts`, `src/sidecar/isolation.ts`, `isolateWorker.ts`) | 4 | 5 | 20 | Critical | Model-written code runs on the user's PC. The network denial **failed** on Node 22 (QE-ITEM-1.4) |
| R-02 | Computer use and irreversible approvals (`src/sidecar/computerUse.ts`, `src/core/approval.ts`) | 3 | 5 | 15 | Critical | Actions on the desktop. A bypass means unwanted side effects |
| R-03 | HUMAIN credential vault (`src/sidecar/humainVault.ts`) | 2 | 5 | 10→15* | Critical | API key leak means billing and privacy harm. *Raised to Critical because Windows-only code is untested in Linux CI |
| R-04 | Prompt-injection boundary (`tests/prompt-injection.test.ts`, `src/core/instructions.ts`, `websearch.ts`, `browse.ts`) | 4 | 4 | 16 | Critical | Untrusted web, PDF and Office content goes into prompts |
| R-05 | Artifact frame isolation (`artifact-frame.html`, `src-tauri/src/artifact_frame.rs`, CSP in `tauri.conf.json`) | 3 | 5 | 15 | Critical | Generated HTML runs inside the app |
| R-06 | NPU/engine supervisor and process ownership (`supervisor.rs` 3,966 LOC, `npu_recovery.rs`, `npuOwner.ts`, `one-engine` guard) | 4 | 4 | 16 | Critical | A wedged NPU can leave the device unusable. Largest file in the repo |
| R-07 | Settings persistence and migration (`settingsWriter.ts`, `settings.rs`, `settingsSchema.ts`) | 3 | 5 | 15 | Critical | Data loss or a corrupt config blocks launch |
| R-08 | Installer/updater trust (`installerTrust.ts`, `updater.ts`, `installer.nsi`, `geniexRelease.ts`) | 3 | 5 | 15 | Critical | Supply-chain entry point |
| R-09 | Chat orchestrator and streaming (`chatOrchestrator.ts` 1,595 LOC, `chat.ts`, `harness/*`) | 4 | 3 | 12 | High | Core value path. Stalls and token accounting (bench failure QE-ITEM-1.6) |
| R-10 | Sidecar protocol (`protocol.ts`, `main.ts` 3,388 LOC, `agent_wire.rs`) | 3 | 4 | 12 | High | A single stdout stray byte breaks IPC |
| R-11 | Model setup/download/manifest (`setup*.ts`, `download.ts`, `manifest.ts`, `hf.ts`, `model_manifest.rs`) | 3 | 4 | 12 | High | First-run blocker |
| R-12 | Knowledge RAG (`src/core/knowledge/*`) | 3 | 3 | 9→10 | High | Wrong citations break the trust claim |
| R-13 | PDF/Office import (`pdf.ts`, `office*.ts`, `zip.ts`) | 4 | 3 | 12 | High | Hostile files, zip bombs. Node-version breakage seen (QE-ITEM-1.3) |
| R-14 | Router/placement (`router.ts`, `placement.ts`, `adaptiveCompute.ts`) | 3 | 3 | 9→10 | High | Wrong engine choice causes slow runs or NPU contention |
| R-15 | HUMAIN FUSE/Node cloud chat (`cloudChat.ts`, `humain.ts`, `endpoint.ts`) | 3 | 4 | 12 | High | Paid calls, data leaving the device |
| R-16 | Single instance, shutdown, session end (`single_instance.rs`, `shutdown.rs`, `session_end.rs`) | 3 | 3 | 9→10 | High | Orphaned processes hold the NPU |
| R-17 | Bench (`bench*.ts`, `bench.rs`) | 3 | 2 | 6 | Medium | Shown numbers must be honest (design-honesty tests) |
| R-18 | Voice (`src/voice`, `voice*.ts`) | 3 | 2 | 6 | Medium | Optional feature |
| R-19 | Slides/deck/charts/sheets/diagrams | 3 | 2 | 6 | Medium | Output quality |
| R-20 | xblocks/construct engine | 3 | 2 | 6 | Medium | Generated sites/games |
| R-21 | Prompt Lab, projects, tasks, search | 2 | 2 | 4→5 | Medium | Secondary flows |
| R-22 | Theme, brand, icons, motion, docs generators | 2 | 1 | 2 | Low | Cosmetic |

### 3. Critical User Flows (mapped to E2E/integration scenarios)

> MKMN has no checkout or payment. The revenue/compliance-equivalent flows are: (a) the HUMAIN API key and paid cloud calls, and (b) the privacy promise that "chats and files stay on your PC". Both are treated as transaction-critical below.

| Flow ID | Flow | Risk | Layer | Scenario → expected outcome |
|---|---|---|---|---|
| F-01 | First-run onboarding: hardware check → pick recommended model → download → install → first chat | Critical | E2E-mock + installed | Fresh profile; SetupScreen shows NPU/Hybrid/CPU labels; download with resume after a forced drop; first token < 10 s after load; settings saved once |
| F-02 | "Authentication": add a HUMAIN API key (FUSE/Node), validate, store, use, remove | Critical | Integration + installed | Key never appears in logs, settings export or stdout. Invalid key gives a friendly error and no retry storm. Removing the key deletes the vault entry |
| F-03 | Local chat on NPU (happy path) | Critical | Integration (FakeModel/fake-geniex) + E2E-mock | Streamed answer renders incrementally; stop button aborts in < 500 ms; conversation saved |
| F-04 | Cloud chat with web search and citations | High | Integration | Cite chips map to real sources; no request goes out unless a cloud engine is selected |
| F-05 | Offline/privacy mode: no egress | Critical | Integration (net-guard) + installed | With only local engines, 0 outbound connections other than 127.0.0.1 (proxy capture on installed app) |
| F-06 | Document import (PDF/DOCX/XLSX/PPTX) → ask → answer with page citations | High | Integration + E2E-mock | Page markers correct; oversize and corrupt files rejected with a category message; no main-thread freeze > 200 ms |
| F-07 | Create/update/delete data: conversations, projects, knowledge sources, artifacts | High | Integration + component | Create → appears; rename collision handled; delete → removed from disk and index (`forget-conversation`, `removal-safety`) |
| F-08 | Search and discovery: conversation search, multilingual (Arabic/English) search, settings search | Medium | Component + E2E-mock | Arabic query matches Arabic content (RTL); empty results give an empty state |
| F-09 | Generate an artifact (page/deck/chart) and run its check in isolation | Critical | Integration + E2E-mock | Generated code runs only via `isolation()`; artifact frame cannot reach `ipc:` |
| F-10 | Computer-use task with an irreversible step | Critical | Integration | Irreversible action blocks until approval; deny means nothing executes |
| F-11 | Model switch / engine switch while busy | High | Integration | Only one engine holds the NPU; Foundry is released before GenieX starts |
| F-12 | Close/relaunch/uninstall | High | Installed (PowerShell checks) | No orphan processes after close (`Check-After-Close.ps1`); uninstall removes data only when asked |
| F-13 | Settings change → export → import → reset scope | High | Component + integration | Round-trip is identical; secrets excluded from export |

---

## Findings and Recommendations

### 1. Defects and suite health found in this run

- [ ] **QE-ITEM-1.1 [Suite is red on `main`: README redesign broke 2 doc-contract tests]**:
  - **Area**: Docs/release contract (`tests/build-docs.test.ts`, `tests/version.test.ts`, `README.md`)
  - **Risk Level**: High (process). It proves PRs merge without running tests.
  - **Scope**: Commit `9578082` ("Redesign the README as a HUMAIN AI PC showcase") removed the `makensis /DVERSION=` manual-build line and the `Release status: v0.0.2` pointer that the tests require.
  - **Scenarios**: (a) Restore both strings in the README, or move the build manual to `docs/guide` and point the tests there. (b) Re-run both tests.
  - **Success Criteria**: Both tests pass. The rule "README must link the current release" still holds.
  - **Automation Level**: Automated (existing tests). Blocked from recurring by QE-ITEM-4.1.
  - **Effort**: 0.5 h

- [ ] **QE-ITEM-1.2 [Windows-only tests fail instead of skipping on non-Windows hosts]**:
  - **Area**: Test infrastructure
  - **Risk Level**: Medium. A red suite trains people to ignore failures, and it blocks a Linux PR gate.
  - **Scope**:
    - `paths-contract.test.ts` (2 tests), `powershell-native.test.ts` (4) and `runtime-contracts.test.ts` (1) spawn `powershell.exe`.
    - `watchdog.test.ts` expects `core\chat.ts`, but `path.relative` returns `/` on POSIX.
    - `siteOpen.test.ts` uses `sub\\index.html`, which is not a separator on POSIX.
    - Also check `npu-reset-command.test.ts`.
  - **Scenarios**: Add a `tests/helpers/platform.ts` with `describeWindows`/`itWindows` (`describe.skipIf(process.platform !== "win32")`). Normalise separators in `watchdog.test.ts` with `.split(path.sep).join("/")`. Make the `siteOpen` backslash case run only on win32. Add a POSIX-equivalent case (`sub/index.html`) that runs everywhere.
  - **Success Criteria**: The suite on Linux is 0 failed, and Windows-only tests show as skipped with a reason. On `windows-11-arm`, the same tests run and pass (no skip count rise there).
  - **Automation Level**: Automated
  - **Effort**: 3 h

- [ ] **QE-ITEM-1.3 [Node runtime version not declared; `pdfjs-dist` needs `Promise.try` (Node ≥ 24)]**:
  - **Area**: Build/runtime contract (`package.json`, `src/core/pdf.ts`, `tests/pdf-lifecycle.test.ts`)
  - **Risk Level**: High. PDF import is a High-tier flow (F-06). On Node 22 it hangs, it does not fail.
  - **Scope**: 4 tests time out at 20 s each, which costs 80 s of the 128 s suite time. `Build-Windows.ps1` checks Node ≥ 24, but `pnpm test` and `pnpm start` do not.
  - **Scenarios**:
    - (a) Add `"engines": { "node": ">=24" }` and `engine-strict=true` in `.npmrc`.
    - (b) Make `readPdf` fail fast with a clear message if `Promise.try` is missing. Do not hang.
    - (c) Add a test that asserts the bundled sidecar Node major equals the CI Node major.
  - **Success Criteria**: `pnpm install` on Node 22 refuses with a clear message. `readPdf` never runs past its own timeout. Suite time is under 60 s on Linux.
  - **Automation Level**: Automated
  - **Effort**: 2 h

- [ ] **QE-ITEM-1.4 [Isolation sandbox does not deny network on this Node version — verify on the bundled runtime]**:
  - **Area**: Security, Critical R-01 (`src/core/isolate.ts:27` `lockedNodeArgs`)
  - **Risk Level**: **High (potential Critical)**
  - **Scope**: `lockedNodeArgs` passes only `--permission --allow-fs-read=…`. On Node 22.23 the isolated child **connected** to a local TCP server (`isolation.test.ts`: expected `ERR_ACCESS_DENIED`, got `CONNECTED`). Network restriction in Node's permission model depends on the Node version. CI pins `node-version: 24`, but the build script accepts "24 or later". So whether model-written code can reach the network depends on whichever Node gets bundled.
  - **Scenarios**:
    - (a) Run `isolation.test.ts` on the exact Node binary that `Bundle-Sidecar.ps1` ships. Record the version in release notes.
    - (b) At sidecar start-up, probe the sandbox: spawn a locked child that tries `net.connect` to a local listener. If it connects, refuse to run generated code. Do not fall back silently.
    - (c) Defence in depth: deny-by-default `--allow-net` (where supported). Remove `net`, `http`, `dgram` and `child_process` from the worker's `require` surface.
    - (d) Negative tests: DNS lookup, UDP send, `fetch`, WebSocket, `process.binding`, a `worker_threads` escape.
  - **Success Criteria**: All network primitives return an access error in the locked process on the shipped runtime. The start-up probe exists and has a test. A failure is a release blocker.
  - **Automation Level**: Automated (unit, integration and a start-up self-test)
  - **Effort**: 1–2 days

- [ ] **QE-ITEM-1.5 [QAIRT context size resolves to `null` instead of 2048]**:
  - **Area**: PDF context window and compiled context IPC (`tests/compiled-context-ipc.test.ts` ×2, `tests/pdf-context.test.ts`)
  - **Risk Level**: Medium
  - **Scope**: The canonical identity of a compiled QAIRT artifact does not resolve on POSIX. This is most likely Windows path keying (e.g. `\` in a cache key). Root-cause it before deciding to skip.
  - **Scenarios**: Find the key builder. If it is path-based, normalise it to a platform-neutral canonical key and assert the same key on both platforms. If it is truly Windows-only, gate it with `itWindows`.
  - **Success Criteria**: The test passes on Linux, or is skipped with a documented reason and passes on Windows.
  - **Automation Level**: Automated
  - **Effort**: 3 h

- [ ] **QE-ITEM-1.6 [Bench: stream token counts not labelled "estimated" when the server sends no usage]**:
  - **Area**: Bench honesty (`src/core/benchRunner.ts`, `tests/bench.test.ts:799`)
  - **Risk Level**: Medium. Displayed tok/s could be presented as measured when it is estimated, which goes against the README claim of "MKMN measures on your device".
  - **Scope**: `ran.every(t => t.tokensEstimated === true)` is false. The test streams chunks at 1 ms, so it may be timing-sensitive. Run it 50× to decide between a defect and flakiness.
  - **Scenarios**: Run `npx vitest run tests/bench.test.ts -t "estimated" --repeat 50` (or a loop) on Linux and Windows.
  - **Success Criteria**: The test is deterministic (50/50 pass). If it is a real defect, a regression test is added and the label is fixed.
  - **Automation Level**: Automated
  - **Effort**: 3 h

- [ ] **QE-ITEM-1.7 [Artifact check reports wrong reason for an unwired page]**:
  - **Area**: Construction engine checks (`tests/check-artifact-shared.test.ts`, `src/core/xcheck.ts`)
  - **Risk Level**: Medium
  - **Scope**: Expected "nothing on the page is wired to keys…". Got a line-count summary. The diagnostic the user sees for a broken page is wrong.
  - **Scenarios**: Find the cause (check ordering, or a platform-dependent file read). Add a paired positive/negative case.
  - **Success Criteria**: The test passes on all platforms.
  - **Automation Level**: Automated
  - **Effort**: 2 h

- [ ] **QE-ITEM-1.8 [NPU runtime safety: wedged-process kill test times out]**:
  - **Area**: Critical R-06 (`tests/npu-runtime-safety.test.ts`)
  - **Risk Level**: High
  - **Scope**: "confirms the exit of a wedged process once a re-issued kill…" hits the 20 s timeout, and the file takes 31 s. It likely depends on Windows process semantics or real timers.
  - **Scenarios**: Replace real timers with `vi.useFakeTimers()` and inject the process table. Keep one real-process test gated by `itWindows`.
  - **Success Criteria**: The file runs in under 3 s and is deterministic.
  - **Automation Level**: Automated
  - **Effort**: 4 h

- [ ] **QE-ITEM-1.9 [Unhandled rejections are tolerated by the runner]**:
  - **Area**: Test infrastructure
  - **Risk Level**: Medium
  - **Scope**: 4 unhandled errors came from `pdf-lifecycle`. Vitest warns that this "might cause false positive tests".
  - **Scenarios**: Set `dangerouslyIgnoreUnhandledErrors: false` (the default). Fail CI on a nonzero `numUnhandledErrors` from the JSON reporter.
  - **Success Criteria**: CI fails on any unhandled error.
  - **Automation Level**: Automated
  - **Effort**: 0.5 h

### 2. Test pyramid and coverage gaps

- [ ] **QE-ITEM-2.1 [Measure coverage; set ratcheting thresholds]**:
  - **Area**: All TS code
  - **Risk Level**: High. Without numbers there is no gate, and untested Critical files stay invisible.
  - **Scope**: Add `@vitest/coverage-v8` and `coverage` config (see Proposed Code Changes). Record the baseline, then set thresholds at baseline −1 % and ratchet +2 % per minor release toward the QE-PLAN-1.x targets.
  - **Scenarios**: Per-file thresholds for the Critical files listed in QE-PLAN-1.1.
  - **Success Criteria**: The coverage report is uploaded as a CI artifact. The gate fails below threshold. A trend is kept per release.
  - **Automation Level**: Automated
  - **Effort**: 4 h

- [ ] **QE-ITEM-2.2 [Rust coverage and missing tests in `commands.rs`, `tray.rs`, `settings_defaults.rs`]**:
  - **Area**: Host
  - **Risk Level**: High. `commands.rs` is the renderer→host attack surface (40 host commands per the feature matrix).
  - **Scope**: Pull the logic out of the `#[tauri::command]` wrappers into testable fns. Test argument validation (path traversal, empty, oversize) for each command. Make `settings_defaults.rs` assert equality with `settingsSchema.ts` defaults through a generated fixture (CONTRIBUTING rule 4).
  - **Scenarios**: Each command gets 1 valid input, 1 invalid type, 1 boundary value, and 1 forbidden path (for fs-related commands).
  - **Success Criteria**: `cargo llvm-cov` ≥ 70 % overall. Every command is covered. A schema-defaults mismatch fails the test.
  - **Automation Level**: Automated
  - **Effort**: 3 days

- [ ] **QE-ITEM-2.3 [Add a browser E2E layer against the existing mock bridge]**:
  - **Area**: Renderer critical flows F-01, F-03, F-06, F-07, F-08, F-09, F-13
  - **Risk Level**: High. 358 feature-matrix rows are only CONTRACT-tested, and their visual path is checked by hand.
  - **Scope**: Playwright with Chromium on `vite --open mock.html`. Put the specs under `tests/e2e/`, kept separate from the Vitest include glob.
  - **Scenarios**: One spec per flow above, plus an axe scan on each of the 9 screens, plus a keyboard-only pass of F-03.
  - **Success Criteria**: At most 15 specs, under 5 min, 0 flaky in 20 consecutive CI runs. Each spec moves its matrix rows from CONTRACT to PASS.
  - **Automation Level**: Automated
  - **Effort**: 4–5 days

- [ ] **QE-ITEM-2.4 [Sidecar method → test traceability]**:
  - **Area**: `src/sidecar/main.ts` (132 methods), `scripts/generate-feature-matrix.mjs`
  - **Risk Level**: Medium
  - **Scope**: Extend the generator to fail `--check` when a sidecar method or host command has no named test file in the matrix.
  - **Scenarios**: Add a method without a test, and `--check` must fail.
  - **Success Criteria**: 100 % of methods and commands have a test reference.
  - **Automation Level**: Automated
  - **Effort**: 1 day

- [ ] **QE-ITEM-2.5 [Cross-language contract fixtures for the protocol and settings]**:
  - **Area**: Boundaries in QE-PLAN-1.5
  - **Risk Level**: High (R-10)
  - **Scope**: Generate `tests/fixtures/contracts/*.json` (message schemas, settings defaults, command names). Read them from both Vitest and `cargo test`.
  - **Scenarios**: Unknown message type, missing field, extra field, wrong type, oversize line (> 1 MiB), partial line split across reads, non-UTF-8 bytes, BOM.
  - **Success Criteria**: Both sides reject malformed input the same way and never crash the peer.
  - **Automation Level**: Automated
  - **Effort**: 2 days

### 3. Edge cases and negative testing (High/Critical areas)

- [ ] **QE-ITEM-3.1 [Boundary values on all user and file inputs]**:
  - **Area**: Composer, uploads, settings rows, import (R-07, R-13)
  - **Risk Level**: High
  - **Scope**: `composer.ts`, `uploads.ts`, `attachments.ts`, `settingsWriter.ts`, `zip.ts`, `pdf.ts`, `office*.ts`, `sheet.ts`
  - **Scenarios**:
    - **Strings:** 0 chars, 1 char, max length, max+1, 1 MiB paste, mixed RTL/LTR, zero-width joiners, emoji ZWJ sequences, lone surrogates, NUL bytes.
    - **Numbers:** settings sliders at min, max, min−1, max+1, `NaN`, `Infinity`, `-0`, non-integer where an integer is expected.
    - **Arrays and files:** 0 files, 1 file, max files, max+1. 0-byte file, a file exactly at the size limit, limit+1. 10k-page PDF. Zip with 100k entries. Nested zip bomb (compression ratio > 100). Entry paths with `../`, absolute paths, `C:\` and UNC (`\\server\share`).
    - **Date/time:** schedule and task intervals across DST change (Asia/Riyadh has none; also test Europe/London), leap day 2028-02-29, year 2038, clock moving backwards (`schedule.ts`, `scheduler.ts`, `task-interval`).
  - **Success Criteria**: Every case either succeeds or returns a categorised, user-readable error. No crash, no hang over 2 s, no write outside the app data dir. Each negative case has a paired positive case.
  - **Automation Level**: Automated (table-driven tests plus `fast-check` properties for zip, xml, sheet and markdown)
  - **Effort**: 4 days

- [ ] **QE-ITEM-3.2 [Invalid and malformed data handling]**:
  - **Area**: Settings file, conversation store, model manifests, catalog, HF metadata, SSE streams
  - **Risk Level**: High
  - **Scope**: `settings.rs`, `store.ts`, `manifest.ts`, `model_manifest.rs`, `catalog.ts`, `hf.ts`, `gguf.ts`, `harness/gateway.ts`
  - **Scenarios**:
    - JSON that is truncated mid-write, `null` at the root, wrong types, missing required fields, unknown extra fields (must be preserved or ignored, never crash), a BOM, CRLF line endings.
    - A GGUF with a bad magic number or header length overflow.
    - SSE with no `[DONE]`, a split UTF-8 multibyte character across chunks, `data:` without a space, a keep-alive comment line, a 10 MB single event.
  - **Success Criteria**: A corrupt settings file is backed up and replaced by defaults, with a notice shown to the user. A malformed stream ends the turn with a categorised error within the stall watchdog window.
  - **Automation Level**: Automated
  - **Effort**: 3 days

- [ ] **QE-ITEM-3.3 [Concurrency and race conditions]**:
  - **Area**: R-06, R-09, R-11, R-16
  - **Risk Level**: Critical
  - **Scope**: `npuOwner.ts`, `lease.ts`, `scheduler.ts`, `supervisor.rs`, `single_instance.rs`, `settingsWriter.ts`, `download.ts`, `conversationSaver.ts`
  - **Scenarios**:
    - Two chats start while the model is loading.
    - The engine is switched during a streaming answer.
    - Stop is pressed at the same tick the stream ends.
    - Two settings saves within 5 ms (last write wins, no torn file).
    - A second app instance launches during the first one's shutdown.
    - A download is resumed while the old partial file is still locked.
    - Bench runs while the user chats (`npu-in-use`).
    - Sidecar crash during a write (`bridge-sidecar-exit`).
  - **Success Criteria**: There is never more than one NPU owner (assert this invariant in every test). No deadlock: every test finishes under 5 s using fake timers. Files are written atomically (write to a temp file, then rename). Rust: `loom` or `proptest` on the supervisor state table finds no illegal transition.
  - **Automation Level**: Automated (deterministic with fake timers and injected clocks). One soak run per release on hardware.
  - **Effort**: 5 days

- [ ] **QE-ITEM-3.4 [Dependency failure resilience]**:
  - **Area**: GenieX, Foundry Local, QAIRT, HUMAIN APIs, HF downloads, Docker, sherpa-onnx
  - **Risk Level**: High
  - **Scope**: `geniex.ts`, `foundryHost.ts`, `qairt.ts`, `cloudChat.ts`, `download.ts`, `docker.ts`, `voiceEngine.ts`
  - **Scenarios**:
    - The engine binary is missing, or older than v0.11.0.
    - The engine starts and then exits with code 0xC0000005 (access violation).
    - The engine accepts the connection but never responds (stall).
    - HTTP 429, 500 or 503 with `Retry-After`.
    - TLS failure.
    - DNS failure in offline mode.
    - The connection resets mid-download.
    - Disk full during download or install.
    - Docker daemon not running.
    - The NPU driver resets mid-inference (`npuReset.ts`).
    - Cascade: GenieX dies → router falls back → the fallback engine is also missing.
  - **Success Criteria**: Every failure surfaces a named, actionable message (`errors.ts`, `loadFailures.ts`). Retries use bounded backoff, at most 3 tries and at most 30 s total. No orphan process remains (`job_object.rs`). The UI never shows an infinite spinner (`artifact-stuck`, the watchdog).
  - **Automation Level**: Automated with `fake-geniex.js` modes (add `--crash-after`, `--stall`, `--status`) and stubbed fetch. A hardware-only NPU reset is a manual release check.
  - **Effort**: 4 days

- [ ] **QE-ITEM-3.5 [Security abuse scenarios]**:
  - **Area**: R-01, R-02, R-04, R-05, R-08, R-15
  - **Risk Level**: Critical
  - **Scope**: `prompt-injection`, `isolation`, `artifact-frame-isolation`, `computerUse-irreversible`, `endpoint-auth`, `net-guard`, `installer-trust`, `upload-ownership`, `siteOpen`
  - **Scenarios**:
    - **Injection:** instructions hidden in PDF text, DOCX comments, XLSX cell formulas (`=HYPERLINK`, `=cmd|`), image alt text and web search results that try to trigger computer use, opening URLs or exfiltrating settings. Also check that `safe-formula-reserved` covers CSV/XLSX export.
    - **Path and command injection:** filenames with `;`, `&`, `|`, `` ` ``, `$()`, and PowerShell `$env:` sequences in every spawn site (`powershell-native`, `humainVault.ts` passes the key via `$v`, so verify it is passed through stdin or an env var, never interpolated).
    - **Authorization bypass:** the artifact iframe calls `window.__TAURI__`, `ipc:`, `http://ipc.localhost` or `parent.postMessage` with forged origins. Model output reaches `opener:allow-open-url` with `file://`, `javascript:`, `ms-settings:` or `search-ms:` (the capability allows only `http(s)://**`; assert that the host also rejects the other schemes).
    - **Authentication abuse:** an empty, 10 kB or non-ASCII HUMAIN key. A key that appears in an error message.
    - **Rate limiting:** a runaway agent loop. Assert the turn budget (`turn-budget`) and loop limits (`loops`) stop it.
    - **Malicious payloads:** SVG with `<script>` in charts or diagrams, Mermaid/KaTeX injection, Markdown `javascript:` links.
  - **Success Criteria**: 0 successful escapes. Every scenario has an automated test, and each new advisory or class adds a case.
  - **Automation Level**: Automated, plus a manual red-team session per minor release.
  - **Effort**: 5 days

### 4. Automation and CI/CD integration

- [ ] **QE-ITEM-4.1 [Add a PR/push quality gate workflow]**:
  - **Area**: CI (`.github/workflows/`)
  - **Risk Level**: **Critical (process).** It is the root cause of QE-ITEM-1.1.
  - **Scope**: A new `ci.yml` on `pull_request` and `push: main`. Stages are in the Proposed Code Changes section. Keep the existing manual ARM64 workflow for installer builds, and also trigger it on release tags.
  - **Scenarios**: A PR that breaks any test, typecheck, language check or generated-file `--check` is blocked by branch protection.
  - **Success Criteria**: Branch protection on `main` requires `ci / lint-type`, `ci / unit (shards)`, `ci / windows-arm64-tests` and `ci / security`. Median PR feedback is under 12 min.
  - **Automation Level**: Automated
  - **Effort**: 1 day

- [ ] **QE-ITEM-4.2 [Framework and tool selections (justified)]**:
  - **Area**: Tooling
  - **Risk Level**: Medium
  - **Scope / decisions**:
    - **TS unit, component and integration:** Vitest 5 is already in use. Add `@vitest/coverage-v8`, `fast-check` and `vitest-axe`.
    - **Browser E2E:** Playwright with Chromium. It matches the WebView2 engine, and the repo already has `mock.html` for a browser stand-in.
    - **Installed-app UI:** `tauri-driver` + WebdriverIO, only for a 3-spec smoke. It is the only supported way to drive WebView2.
    - **Rust:** `cargo test`, `cargo llvm-cov`, `proptest`, `cargo clippy`, `cargo deny`/`cargo audit`.
    - **Lint:** ESLint with `typescript-eslint` and `eslint-plugin-react-hooks`. That plugin makes the hand-written `hooks.test.ts` rule a linter rule, but keep the test too.
    - **Performance:** `vitest bench` for hot pure functions. A custom harness for engine tok/s reuses `src/core/bench*`. k6 is not used, because there is no server workload.
    - **Python:** not used, apart from `scripts/nsis_extract.py`. No Python test stack is needed beyond `python -m py_compile` in CI.
  - **Success Criteria**: Each tool is pinned to an exact version in the lockfile, and the decision is recorded here.
  - **Automation Level**: N/A (decision)
  - **Effort**: 1 h

- [ ] **QE-ITEM-4.3 [Time budgets, speed tiers and selective execution]**:
  - **Area**: Suite performance
  - **Risk Level**: Medium
  - **Scope**: The current suite takes 128 s wall time. The slowest files are `pdf-lifecycle` (80 s, a defect), `bench` (36 s), `npu-runtime-safety` (31 s), `navigation.test.tsx` (14 s) and `voice` (11 s).
  - **Scenarios**:
    - **Tier S:** any file under 2 s. **Tier M:** 2–10 s. **Tier L:** over 10 s, which needs an owner and a ticket.
    - The PR job runs `vitest --changed origin/main` first for fast feedback, then the full sharded suite.
    - Use `isolate: false` for node-env pure-logic files only. Vitest estimated a 15 s saving, but check first for leaks of global state.
  - **Success Criteria**: Full suite ≤ 90 s per shard × 3 shards. No single file over 10 s. The gate fails if total time grows more than 20 % over the rolling 10-run median.
  - **Automation Level**: Automated (JSON reporter, then a duration check script in CI)
  - **Effort**: 1 day

- [ ] **QE-ITEM-4.4 [Flaky test detection, quarantine and remediation]**:
  - **Area**: Test reliability
  - **Risk Level**: Medium
  - **Scope**: Candidates found today are timing-sensitive tests: `bench` "estimated" (1 ms chunks), `npu-runtime-safety`, `navigation.test.tsx`.
  - **Scenarios**:
    1. **Detect.** A nightly job runs the full suite 5× with `--sequence.shuffle`. Any test whose results differ across runs is flaky.
    2. **Quarantine.** Move it to `tests/quarantine/` with `it.skip` and an issue link in the skip message. Do this within 24 h.
    3. **Remediate.** An RCA is mandatory: fake timers, injected clocks, no real sleeps, no shared temp directories. Fix or delete within 10 working days.
    4. **Retry policy.** `retry: 0` on PRs, so retries do not hide flakes. `retry: 1` only on nightly, and log every retry.
  - **Success Criteria**: Flake rate < 0.5 % of test executions per week. Quarantine size ≤ 5 tests. Every quarantined test has an owner and a due date.
  - **Automation Level**: Automated detection. Manual RCA.
  - **Effort**: 1 day setup, then ongoing

- [ ] **QE-ITEM-4.5 [Test data management and PII handling]**:
  - **Area**: `tests/fixtures/**`, `tests/gguf-builder.ts`, `tests/fake-geniex.js`, `src/core/harness/testing.ts`
  - **Risk Level**: Medium
  - **Scope**: Synthetic factories for conversations, projects, knowledge sources and settings profiles. Each test writes under `fs.mkdtempSync(os.tmpdir())` and removes it in `afterEach`. Never touch the real `%LOCALAPPDATA%` (use `mkmnPaths()` with an injected root).
  - **Scenarios**: A lint test fails if any test file writes to `os.homedir()` or `%APPDATA%`. Fixtures contain no real names, emails or API keys. Run a secret scan over `tests/fixtures`. Arabic and English fixture text is synthetic.
  - **Success Criteria**: 0 leftover temp directories after a run (checked by a teardown script). 0 secret-scan hits.
  - **Automation Level**: Automated
  - **Effort**: 1 day

- [ ] **QE-ITEM-4.6 [Quality gates per pipeline stage]**:
  - **Area**: CI
  - **Risk Level**: High
  - **Scope / thresholds**:

    | Stage | Gate | Threshold |
    |---|---|---|
    | lint-type | `tsc` both projects, ESLint, `check-language`, generator `--check` (settings, state machines, feature matrix) | 0 errors |
    | unit (Linux, 3 shards) | Vitest | 0 failures, 0 unhandled errors, coverage ≥ thresholds, time ≤ budget |
    | rust | `cargo clippy -D warnings`, `cargo test` | 0 warnings, 0 failures |
    | windows-arm64-tests | full Vitest + `MKMN_REQUIRE_SIDECAR=1` + `cargo test` | 0 failures, Windows-only tests not skipped |
    | security | `pnpm audit --audit-level=high`, `cargo audit`, gitleaks, CodeQL (JS/TS) | 0 high/critical unwaived |
    | e2e (on PR label `e2e` + nightly + release) | Playwright + axe | 0 failures, 0 serious/critical axe violations |
    | release | ARM64 build, installer validate, relaunch and after-close checks, manual MANUAL-row checklist signed | all pass + sign-off |
  - **Success Criteria**: The gates are written as code in the workflow, and branch protection enforces them.
  - **Automation Level**: Automated (sign-off is manual)
  - **Effort**: Included in QE-ITEM-4.1

### 5. Metrics and quality gates

- [ ] **QE-ITEM-5.1 [Coverage targets with incremental tracking]**:
  - **Area**: Metrics
  - **Risk Level**: Medium
  - **Scope / targets for v0.1.0**:
    - **TS:** line 80 %, branch 70 %. **Critical-tier files:** line 95 %, branch 90 %.
    - **Renderer:** line 70 %, branch 60 %.
    - **Rust:** line 70 %. **Critical-tier modules:** line 85 %.
    - **Path coverage:** 100 % of the transitions in `stateMachines.json`, asserted by the state-machine tests.
    - **Risk-based:** 100 % of R-01…R-08 have at least one negative test per scenario in QE-ITEM-3.5.
    - **New or changed lines in a PR:** 80 % (diff coverage).
  - **Success Criteria**: Each PR shows its coverage change. The trend is kept per release in `docs/releases/`.
  - **Automation Level**: Automated
  - **Effort**: 0.5 day

- [ ] **QE-ITEM-5.2 [Defect metrics with numeric targets]**:
  - **Area**: Defect management
  - **Risk Level**: Medium
  - **Scope / targets**:

    | Metric | Definition | Target |
    |---|---|---|
    | Defect escape rate | prod/user-reported defects ÷ all defects found per release | < 10 % |
    | Defect density | confirmed defects ÷ KLOC changed per release | < 1.0 |
    | Time to detection | merge → defect report (median) | < 2 days (CI catches most in < 15 min) |
    | Severity distribution | share of S1/S2 among escapes | 0 S1 escapes, S2 < 2 per release |
    | Reopen rate | reopened ÷ closed | < 5 % |
    | Regression test on fix | bug-fix PRs with a failing-first test (CONTRIBUTING rule) | 100 % |
  - **Success Criteria**: The metrics are computed from GitHub issue labels by a script in CI or nightly, and published to the quality dashboard.
  - **Automation Level**: Automated (computation). Manual (labelling).
  - **Effort**: 1 day

- [ ] **QE-ITEM-5.3 [Observability dashboard for test results]**:
  - **Area**: Reporting
  - **Risk Level**: Low
  - **Scope**: Publish the JUnit XML and JSON reporter output as CI artifacts (30-day retention, 90 days for releases), plus HTML coverage and the Playwright trace on failure only. A GitHub Actions job summary shows pass/fail/skip counts, the slowest 10 files, flaky candidates and the coverage change.
  - **Scenarios**: A failing test links to the trace or screenshot. Trends are plotted across the last 30 `main` runs.
  - **Success Criteria**: Anyone can see why a run failed without re-running it.
  - **Automation Level**: Automated
  - **Effort**: 1 day

- [ ] **QE-ITEM-5.4 [Release exit criteria and sign-off]**:
  - **Area**: Release readiness (feature matrix `REL0xx` gates)
  - **Risk Level**: High
  - **Scope / criteria** (all must hold):
    1. CI green on the release commit across all stages in QE-ITEM-4.6, with 0 quarantined tests in Critical tiers.
    2. Coverage at or above the thresholds, and no drop of more than 1 % from the previous release.
    3. 0 open S1/S2 defects. S3 defects only with a written waiver.
    4. Security: 0 high/critical vulnerabilities without a waiver. The QE-ITEM-1.4 sandbox probe passes on the bundled Node.
    5. Performance within the QE-ITEM-6.1 baselines (no regression > 10 %).
    6. Installed-app checks pass on a Snapdragon X device. The MANUAL rows are signed.
    7. Feature matrix regenerated, and each row is PASS, CONTRACT with an E2E reference, or MANUAL-signed.
  - **Sign-off**: The release manager, plus the Host maintainer for Rust changes and the Core maintainer for sidecar changes.
  - **Success Criteria**: A checklist in `docs/releases/RELEASE_NOTES_v<x>.md` with each item ticked and linked.
  - **Automation Level**: Mixed (1–5 and 7 automated, 6 partly manual)
  - **Effort**: 0.5 day per release

- [ ] **QE-ITEM-5.5 [Rollback triggers and post-release monitoring]**:
  - **Area**: Post-release
  - **Risk Level**: High
  - **Scope**: MKMN is a desktop app with no telemetry, and it is local-first. Monitoring is opt-in and based on reports: issue intake, `CopyLog` diagnostics bundles, `loadFailures.ts` categories.
  - **Triggers to pull the release asset or ship a hotfix within 24 h**:
    - Any S1, which means: data loss, a sandbox escape, a credential leak, the NPU wedged and needing a reboot, or the installer failing on the reference device.
    - 3 or more independent reports of the same S2 within 72 h.
    - Installer validation failing on a second device model.
  - **Success Criteria**: The previous installer stays downloadable. The updater (`updater.ts`) can point to the previous version. The rollback is rehearsed once per minor release.
  - **Automation Level**: Manual decision. Automated hotfix pipeline.
  - **Effort**: 1 day

### 6. Non-functional testing

- [ ] **QE-ITEM-6.1 [Performance baselines (load, stress, spike, endurance, scalability)]**:
  - **Area**: Engines, orchestrator, renderer, knowledge index
  - **Risk Level**: High
  - **Scope / plan**:
    - **Baselines** on the Snapdragon X2 Elite reference device, using the built-in bench: time to first token, tok/s, model load time and peak RAM for each recommended model. Store them in `docs/releases/perf-baseline-<ver>.json`.
    - **Load:** 50-turn conversation with a 32k context.
    - **Stress:** knowledge index of 5,000 documents or 2 GB.
    - **Spike:** 10 PDFs dropped at once.
    - **Endurance:** an 8-hour soak alternating chat, bench and voice. RAM growth must stay under 5 %, and handle and thread counts must be stable (`monitor.rs`, `resourceMonitor`).
    - **Scalability:** 1k, 10k and 100k conversations in the store, measured by search latency.
    - **CI (non-hardware):** `vitest bench` on `knowledge` retrieval, `markdown`, `highlight`, `zip` and `sheet`. Fail on more than 20 % regression against the stored baseline.
    - **Renderer:** first meaningful render under 1.5 s, and stream rendering with no long task over 50 ms (Playwright performance trace).
  - **Success Criteria**: Each release stays within 10 % of the baseline. Endurance shows no leak.
  - **Automation Level**: CI micro-benchmarks are automated. Hardware runs use a scripted bench and a manual trigger.
  - **Effort**: 4 days

- [ ] **QE-ITEM-6.2 [Security scanning baseline in CI]**:
  - **Area**: Supply chain and secrets
  - **Risk Level**: Critical (R-08)
  - **Scope**:
    - **Dependency scanning:** `pnpm audit` plus Dependabot (npm, cargo and github-actions ecosystems).
    - **Rust:** `cargo audit` and `cargo deny` (licenses, which complements `scripts/licenses.cjs`).
    - **Static analysis:** CodeQL for JS/TS.
    - **Secrets:** gitleaks on PRs.
    - **Workflow security:** pin third-party actions to a commit SHA, and keep `permissions: contents: read`, which is already done.
    - **Installer:** Authenticode signature check in `Validate-Installer.ps1` when signing is enabled. The current artifact is named "unsigned".
  - **Success Criteria**: 0 high or critical unwaived. Each waiver has an expiry date.
  - **Automation Level**: Automated
  - **Effort**: 1 day

- [ ] **QE-ITEM-6.3 [Compliance coverage: privacy promise and data residency]**:
  - **Area**: R-15, F-05, the README claims
  - **Risk Level**: High
  - **Scope**:
    - **Privacy promises** to test: "chats and files stay on your PC" and "works offline after setup".
    - **Saudi PDPL alignment** for the optional cloud path: data leaves the device only after the user selects HUMAIN.
    - **Settings export** excludes secrets (`settings-secrets` test).
    - **Uninstall** removes data only on request (`uninstall-data` test).
    - **Third-party licenses:** `pnpm run licenses` runs in CI.
  - **Scenarios**: An installed-app run behind a capturing proxy with local engines only must show 0 non-loopback connections. The same run after enabling HUMAIN must show connections only to the HUMAIN hosts.
  - **Success Criteria**: Passes every release, with the evidence attached to the release notes.
  - **Automation Level**: Automated in unit tests (`net-guard`). Scripted capture on hardware.
  - **Effort**: 2 days

- [ ] **QE-ITEM-6.4 [Accessibility (WCAG 2.2 AA)]**:
  - **Area**: Renderer, all 9 screens
  - **Risk Level**: Medium
  - **Scope**:
    - An axe scan in Playwright and `vitest-axe` in component tests.
    - Keyboard-only navigation for every flow in QE-PLAN-3. `row-keyboard.test.tsx` exists and should be extended.
    - Visible focus, and focus trapped and restored in dialogs (VoiceSetup, Settings).
    - Color contrast ≥ 4.5:1 in light and dark themes (`themeGen.ts` can assert this in a unit test).
    - Live regions for streaming answers.
    - RTL layout and screen-reader labels in Arabic.
    - Manual NVDA and Windows Narrator pass per minor release.
  - **Success Criteria**: 0 serious or critical axe violations. Contrast unit test passes for all theme tokens. The Narrator checklist is signed.
  - **Automation Level**: Automated plus a manual screen-reader pass
  - **Effort**: 3 days

- [ ] **QE-ITEM-6.5 [Compatibility matrix]**:
  - **Area**: Platforms and engines
  - **Risk Level**: Medium
  - **Scope**:
    - **OS:** Windows 11 ARM64 23H2 and 24H2, and Windows 11 x64. The README says it also runs on other Snapdragon X machines; decide whether x64 is supported or excluded.
    - **Devices:** Snapdragon X Elite, X Plus and X2 Elite.
    - **WebView2:** stable, plus the minimum version.
    - **Node:** the bundled version only, enforced by QE-ITEM-1.3.
    - **Engines and APIs:** GenieX v0.11.0 (minimum) and latest, Foundry Local, QAIRT versions (`geniexVersionLines.json`), and HUMAIN API versions.
  - **Success Criteria**: A matrix in the release notes. The minimum and latest of each engine are tested per release.
  - **Automation Level**: Version gates are automated (`geniex-gate`). Devices are manual.
  - **Effort**: 1 day per release

- [ ] **QE-ITEM-6.6 [Chaos and resilience experiments]**:
  - **Area**: R-06, R-10, R-16
  - **Risk Level**: High
  - **Scope / experiments** (run on staging hardware):
    1. Kill the sidecar mid-stream. Expect the host to restart it, the UI to recover and the conversation to be intact.
    2. Kill the GenieX process. Expect the supervisor to detect it within the watchdog window and the router to fall back.
    3. Suspend the NPU driver or simulate a reset (`npu_recovery.rs`).
    4. Fill the disk to 100 % during a model install.
    5. Make the settings file read-only.
    6. Cut power during a settings save. Simulate this with a killed process after the temp write, before the rename.
    7. Unplug the network during a cloud stream.
    8. Put the device in battery saver or EcoQoS (`ecoqos`, `power.rs`).
  - **Success Criteria**: Graceful degradation with a clear message, no data loss, no orphan processes and no manual reboot needed. Each experiment has a written hypothesis and result.
  - **Automation Level**: 1, 2, 4, 5, 6 and 7 are automated as integration tests with fakes. 3 and 8 are manual on hardware.
  - **Effort**: 3 days

### 7. Scope boundaries

- [ ] **QE-ITEM-7.1 [Document scope, exclusions, mock vs. integrate]**:
  - **Area**: Strategy
  - **Risk Level**: Medium
  - **In scope**: `src/**`, `src-tauri/src/**`, `scripts/*.ps1|mjs|js` (build, validation and generators), `installer.nsi`, generated contracts.
  - **Out of scope (with rationale)**:
    - `crates/tauri-winres` and `crates/vswhom-sys` are vendored third-party code with their own upstream CI. Re-run their tests only when the vendored copy changes.
    - `src/core/shelved/**` and `tests/shelved/**` are not shipped. Exclude them from coverage, and add a test that asserts nothing imports them.
    - The internals of GenieX, Foundry, QAIRT and sherpa-onnx are vendor-owned. MKMN tests only its own contract with them.
  - **Third-party services**:
    - **HUMAIN FUSE/Node:** mocked in CI. A contract fixture is recorded from the documented API. An opt-in live smoke (`scripts/smoke-sidecar-humain.js`) runs only with a test key, kept in an environment secret and never on fork PRs.
    - **Hugging Face downloads:** mocked, with Range/resume semantics (`voice-download-range`).
    - **Web search and Wikimedia:** mocked.
  - **Legacy components**: `installer.nsi` and the PowerShell scripts are tested by `Validate-Installer.ps1` and the `powershell-native` tests, Windows-only.
  - **Mock vs. integrate**:
    - **Mock:** every network call (already enforced by `setup-model-guard.ts`), the NPU, the engines (`fake-geniex.js`, `FakeModel`) and DPAPI on non-Windows.
    - **Integrate (real):** filesystem in a temp root, child processes for isolation, the real `pdfjs-dist`, the real zip and xml parsers, and the real sidecar process (`MKMN_REQUIRE_SIDECAR`).
  - **Success Criteria**: This section is reviewed every quarter, and coverage config excludes match it.
  - **Automation Level**: N/A
  - **Effort**: 1 h

### 8. Defect management and continuous improvement

- [ ] **QE-ITEM-8.1 [Severity levels, priority, triage, SLAs, escalation]**:
  - **Area**: Process
  - **Risk Level**: Medium
  - **Scope**:

    | Sev | Definition (MKMN-specific) | Triage SLA | Fix SLA |
    |---|---|---|---|
    | S1 | Sandbox escape, credential leak, data loss, NPU wedge needing reboot, install/launch failure on reference device | 4 h | hotfix ≤ 48 h |
    | S2 | Critical flow broken without workaround (F-01…F-13), wrong citation/bench figures shown as measured | 1 day | next patch ≤ 7 days |
    | S3 | Degraded flow with workaround, a11y serious issue | 3 days | next minor |
    | S4 | Cosmetic, copy, low-impact | 1 week | backlog |

  - **Triage workflow**: An issue form (bug template with version, device, engine and a diagnostics bundle from `CopyLog`) gets the label `needs-triage`. The weekly triage applies `sev:*`, `area:*` (matching the R-xx components) and an owner.
  - **Escalation**: S1 goes to the maintainer immediately and blocks the release. S2 untouched for 2 days goes to the release manager.
  - **Success Criteria**: 95 % of issues triaged within SLA.
  - **Automation Level**: Issue forms and label automation are automated. Triage is manual.
  - **Effort**: 0.5 day

- [ ] **QE-ITEM-8.2 [Root cause analysis and prevention]**:
  - **Area**: Process
  - **Risk Level**: Medium
  - **Scope**:
    - A blameless RCA for every S1/S2 and every escape, kept in `docs/rca/<date>-<slug>.md`: 5-whys, the missing test layer, and a prevention action.
    - Every RCA must add a regression test (already a CONTRIBUTING rule) and, where possible, a policy test of the `hooks.test.ts`/`console-hygiene` kind that prevents the whole class.
    - **First RCA to write:** QE-ITEM-1.1, a README change that broke contract tests. Root cause: no PR CI. Prevention: QE-ITEM-4.1.
  - **Success Criteria**: 100 % of escapes have an RCA within 5 working days. A quarterly pattern review groups RCAs by component and feeds risk-score updates.
  - **Automation Level**: Manual
  - **Effort**: Ongoing

- [ ] **QE-ITEM-8.3 [Production feedback and retrospectives]**:
  - **Area**: Process
  - **Risk Level**: Low
  - **Scope**:
    - Fold user-reported issues and the categories from `loadFailures.ts` into the risk matrix each quarter.
    - Hold a quality retro per minor release, reviewing escape rate, flake rate, suite time and coverage change.
    - Tighten gate thresholds when targets are met for 2 consecutive releases.
  - **Success Criteria**: The risk matrix and thresholds in this file are updated at least once a quarter, with dates.
  - **Automation Level**: Manual
  - **Effort**: 2 h per release

- [ ] **QE-ITEM-8.4 [Process metrics: cycle time, reopen, escape, execution time, automation coverage, ROI]**:
  - **Area**: Metrics
  - **Risk Level**: Low
  - **Scope / targets**:
    - **Cycle time:** bug open to closed. S2 median under 7 days.
    - **Reopen rate:** under 5 %.
    - **Escape rate:** under 10 %.
    - **Suite execution time:** under 90 s per shard.
    - **Automation coverage:** feature-matrix rows that are PASS (automated end to end). From 9 out of 381 today (2.4 %) to 30 % at v0.1.0 and 60 % at v0.2.0.
    - **Automation ROI:** (manual hours saved per release × releases) ÷ automation hours invested. Target above 1 within 3 releases.
  - **Success Criteria**: Metrics are reported in each release's notes.
  - **Automation Level**: Automated computation
  - **Effort**: 0.5 day

### 9. Stability and regression

- [ ] **QE-ITEM-9.1 [Regression risk for critical flows]**:
  - **Area**: F-01…F-13
  - **Risk Level**: High
  - **Scope**:
    - A `@critical` tag (test name prefix or a `tests/critical.list`) on every test that covers R-01…R-08.
    - A selective rule: a PR touching `supervisor.rs`, `isolate*`, `computerUse*`, `humainVault*`, `settings*`, `installer*` or `artifact_frame*` always runs the full Windows ARM64 job and the E2E job, whatever the label.
  - **Success Criteria**: 0 Critical-tier regressions escape to a release.
  - **Automation Level**: Automated (path filters in the workflow)
  - **Effort**: 0.5 day

- [ ] **QE-ITEM-9.2 [Flakiness prevention practices]**:
  - **Area**: Test code
  - **Risk Level**: Medium
  - **Scope**:
    - Add a lint/policy test, in the style of `hooks.test.ts`, that bans `setTimeout`-based sleeps over 50 ms in `tests/**` unless the line carries `// real-time: <reason>`.
    - Ban `Date.now()` in `src/core` scheduling code unless the clock is injected.
    - Require `mkdtemp` and forbid fixed temp paths.
  - **Success Criteria**: The policy test is green. New flakes are under 1 per month.
  - **Automation Level**: Automated
  - **Effort**: 1 day

- [ ] **QE-ITEM-9.3 [Release confidence indicators]**:
  - **Area**: Release
  - **Risk Level**: Medium
  - **Scope**: A single "release confidence" summary in the CI job summary:
    - green streak on `main` (10 or more runs),
    - flake rate (under 0.5 %),
    - Critical-tier coverage (95 % or more),
    - open S1/S2 count (0),
    - performance delta (within 10 %),
    - matrix automation share (rising).
  - **Success Criteria**: The release manager uses it as the go/no-go input.
  - **Automation Level**: Automated
  - **Effort**: 1 day

### 10. Reliability targets

- [ ] **QE-ITEM-10.1 [Reliability and resilience expectations]**:
  - **Area**: Runtime
  - **Risk Level**: High
  - **Scope / targets** (measured on the reference device during the endurance run, QE-ITEM-6.1):
    - Crash-free sessions of 99.5 % or more.
    - Sidecar auto-restart succeeds within 5 s in 100 % of injected kills.
    - The stall watchdog fires within its defined window (`watchdog.test.ts` pins the constant) in 100 % of stall injections.
    - 0 orphan processes after close.
    - Recovery from an NPU reset without a reboot in 95 % or more of cases.
  - **Success Criteria**: The targets are met before a release.
  - **Automation Level**: Mixed
  - **Effort**: Included in QE-ITEM-6.1 and 6.6

---

## Proposed Code Changes

> These are proposals only. Per the request, no file other than this TODO was created or modified.

### P-1 — PR/push quality gate (`.github/workflows/ci.yml`, new) → QE-ITEM-4.1, 4.6, 9.1

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-type:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.26.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm --ignore-workspace install --frozen-lockfile
      - run: pnpm rebuild esbuild
      - run: pnpm typecheck
      - run: node scripts/check-language.mjs
      - run: node scripts/generate-state-machines.mjs --check
      - run: node scripts/generate-feature-matrix.mjs --check
      - run: node scripts/generate-settings-schema.mjs --check

  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 12
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2, 3] }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.26.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm --ignore-workspace install --frozen-lockfile
      - run: pnpm rebuild esbuild
      - run: pnpm exec vitest run --shard=${{ matrix.shard }}/3 --coverage --reporter=default --reporter=junit --outputFile.junit=reports/junit-${{ matrix.shard }}.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: unit-${{ matrix.shard }}
          path: |
            reports/
            coverage/
          retention-days: 30

  windows-arm64-tests:
    runs-on: windows-11-arm
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.26.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: aarch64-pc-windows-msvc, components: clippy }
      - shell: pwsh
        run: |
          pnpm --ignore-workspace install --frozen-lockfile; if ($LASTEXITCODE) { exit $LASTEXITCODE }
          pnpm rebuild esbuild;                              if ($LASTEXITCODE) { exit $LASTEXITCODE }
          pnpm run build:sidecar;                            if ($LASTEXITCODE) { exit $LASTEXITCODE }
          $env:MKMN_REQUIRE_SIDECAR = "1"
          pnpm test;                                         if ($LASTEXITCODE) { exit $LASTEXITCODE }
          cargo clippy --manifest-path src-tauri/Cargo.toml --target aarch64-pc-windows-msvc -- -D warnings; if ($LASTEXITCODE) { exit $LASTEXITCODE }
          cargo test   --manifest-path src-tauri/Cargo.toml --target aarch64-pc-windows-msvc;              exit $LASTEXITCODE

  security:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
        with: { version: 10.26.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: pnpm audit --audit-level=high
      - run: cargo install cargo-audit --locked && cargo audit --file src-tauri/Cargo.lock
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

*(Pin each third-party action to a commit SHA before merging, per QE-ITEM-6.2. Check that `generate-settings-schema.mjs` supports `--check`. If it does not, add it.)*

### P-2 — Coverage and unhandled-error gate (`vitest.config.ts`) → QE-ITEM-1.9, 2.1

```diff
 import { defineConfig } from "vitest/config";

 export default defineConfig({
   esbuild: { jsx: "automatic" },
-  test: { include: ["tests/**/*.test.{ts,tsx}"], testTimeout: 20000, setupFiles: ["tests/setup-model-guard.ts"] }
+  test: {
+    include: ["tests/**/*.test.{ts,tsx}"],
+    exclude: ["tests/shelved/**", "tests/quarantine/**", "tests/e2e/**", "node_modules/**"],
+    testTimeout: 20000,
+    setupFiles: ["tests/setup-model-guard.ts"],
+    dangerouslyIgnoreUnhandledErrors: false,
+    coverage: {
+      provider: "v8",
+      include: ["src/**/*.{ts,tsx}"],
+      exclude: ["src/**/*.generated.ts", "src/core/shelved/**", "src/renderer/mock*.ts", "src/renderer/vite-env.d.ts"],
+      reporter: ["text-summary", "html", "lcov", "json-summary"],
+      // Baseline first (run once, then set each number to baseline − 1 and ratchet).
+      thresholds: {
+        lines: 0, branches: 0, functions: 0, statements: 0,
+        "src/core/isolate.ts":        { lines: 95, branches: 90 },
+        "src/core/approval.ts":       { lines: 95, branches: 90 },
+        "src/core/netGuard.ts":       { lines: 95, branches: 90 },
+        "src/core/installerTrust.ts": { lines: 95, branches: 90 },
+        "src/core/settingsWriter.ts": { lines: 95, branches: 90 },
+        "src/core/zip.ts":            { lines: 95, branches: 90 }
+      }
+    }
+  }
 });
```

```diff
   "devDependencies": {
+    "@vitest/coverage-v8": "<same major as vitest>",
+    "fast-check": "^4.0.0",
```

### P-3 — Declare the runtime (`package.json`, `.npmrc`) → QE-ITEM-1.3

```diff
   "license": "MIT",
+  "engines": { "node": ">=24" },
   "scripts": {
```

```diff
+engine-strict=true
```

### P-4 — Platform-aware test helper (`tests/helpers/platform.ts`, new) → QE-ITEM-1.2

```ts
import { describe, it } from "vitest";

/** Windows-only behaviour (PowerShell, DPAPI, backslash paths). Skips elsewhere with a reason in the report. */
export const isWindows = process.platform === "win32";
export const describeWindows = describe.skipIf(!isWindows);
export const itWindows = it.skipIf(!isWindows);

/** Turn a relative path into the repo's canonical forward-slash form, for comparisons that must hold on every OS. */
export const posixRel = (p: string): string => p.split(/[\\/]/).join("/");
```

Usage examples:

```diff
// tests/paths-contract.test.ts, tests/powershell-native.test.ts, tests/runtime-contracts.test.ts
-describe("the scripts resolve paths instead of guessing them", () => {
+import { describeWindows } from "./helpers/platform";
+describeWindows("the scripts resolve paths instead of guessing them", () => {
```

```diff
// tests/watchdog.test.ts — compare canonical paths, not OS-specific ones
-    expect(files).toEqual(["core\\chat.ts"]);
+    expect(files.map(posixRel)).toEqual(["core/chat.ts"]);
```

```diff
// tests/siteOpen.test.ts — the backslash case is a Windows separator; test the portable form everywhere
-    expect(siteOpenRefusal("sub\\index.html", dir)).toMatch(/HTML page/);
+    expect(siteOpenRefusal("sub/index.html", dir)).toMatch(/HTML page/);
+    if (isWindows) expect(siteOpenRefusal("sub\\index.html", dir)).toMatch(/HTML page/);
```

*(Read each test before you edit it, and adapt the exact lines. The snippets show the pattern.)*

### P-5 — Sandbox self-test at start-up (`src/core/isolate.ts`) → QE-ITEM-1.4

```ts
import { execFile } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

/**
 * Proves the locked process cannot open a socket on THIS Node binary.
 * Call once before the first isolated run. If it connects, refuse generated code.
 */
export async function proveNetworkDenied(nodePath: string, readDirs: string[]): Promise<boolean> {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const code = `const s=require("net").connect(${port},"127.0.0.1");s.on("connect",()=>{console.log("CONNECTED");s.destroy()});s.on("error",e=>console.log(e.code))`;
  try {
    const out = await new Promise<string>((resolve) =>
      execFile(nodePath, [...lockedNodeArgs(readDirs, "-e"), code], { windowsHide: true, timeout: 10_000 },
        (_e, stdout) => resolve(String(stdout).trim())));
    return out !== "CONNECTED";
  } finally { server.close(); }
}
```

Test to add (`tests/isolation.test.ts`):

```ts
it("refuses to run generated code when the runtime cannot deny the network", async () => {
  // inject a runner whose probe reports CONNECTED → isolation() must throw a named error, never run the code
});
```

### P-6 — Fail fast when `Promise.try` is missing (`src/core/pdf.ts`) → QE-ITEM-1.3

```ts
if (typeof (Promise as unknown as { try?: unknown }).try !== "function") {
  throw new Error("PDF reading needs Node.js 24 or later (Promise.try is missing).");
}
```

### P-7 — Duration and unhandled-error budget check (inline CI step) → QE-ITEM-4.3

```bash
node -e '
const r=require("./reports/vitest.json");
if (r.numUnhandledErrors) { console.error("unhandled errors:", r.numUnhandledErrors); process.exit(1); }
const slow=r.testResults.map(f=>[f.endTime-f.startTime,f.name]).filter(([d])=>d>10000);
if (slow.length){ console.error("files over 10 s:", slow); process.exit(1); }'
```

---

## Commands

### Local (Linux/macOS/Windows, Node ≥ 24)

```bash
pnpm --ignore-workspace install --frozen-lockfile
```

```bash
pnpm rebuild esbuild
```

```bash
pnpm typecheck
```

```bash
pnpm exec vitest run
```

```bash
pnpm exec vitest run --coverage
```

```bash
pnpm exec vitest run --changed origin/main
```

```bash
pnpm exec vitest run tests/bench.test.ts -t "estimated" --repeat 50
```

```bash
pnpm exec vitest run --sequence.shuffle --reporter=json --outputFile=reports/vitest.json
```

```bash
node scripts/check-language.mjs
```

```bash
node scripts/generate-state-machines.mjs --check
```

```bash
node scripts/generate-feature-matrix.mjs --check
```

### Windows ARM64 (host and release)

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --target aarch64-pc-windows-msvc -- -D warnings
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml --target aarch64-pc-windows-msvc
```

```bash
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --target aarch64-pc-windows-msvc --html
```

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Validate-Installer.ps1
```

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Live-Relaunch-Check.ps1
```

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Check-After-Close.ps1
```

### Security (local or CI)

```bash
pnpm audit --audit-level=high
```

```bash
cargo audit --file src-tauri/Cargo.lock
```

### E2E (after QE-ITEM-2.3 lands)

```bash
pnpm exec playwright test --trace off
```

---

## Evidence snapshot (2026-11-22, Linux, Node 22.23.5)

| Metric | Value |
|---|---|
| Test files | 272 (258 passed, 14 failed) |
| Tests | 2,833 (2,804 passed, 22 failed, 7 skipped) |
| Unhandled errors | 4 (`pdf-lifecycle`, `Promise.try`) |
| Wall time | 127.8 s (pdf-lifecycle 80 s, bench 36 s, npu-runtime-safety 31 s, navigation 14 s, voice 11 s) |
| Typecheck | pass |
| Language scan | pass |
| Failure classes | Windows-only spawn/paths: 10 tests in 5 files. Node-version: 4 tests (pdf) plus 1 (isolation network). Doc drift: 2. Needs RCA: bench 1, check-artifact 1, QAIRT context 3, npu-runtime 1 |
| Rust | not run (Windows target). 255 `#[test]` found |
| CI | 1 workflow, manual trigger only |

---

## Quality Engineering Quality Task Checklist (self-verification)

- [x] Every test pyramid layer has explicit coverage targets and assigned ownership (QE-PLAN-1.1–1.7)
- [x] All critical user flows are mapped to risk levels and test scenarios (QE-PLAN-3, F-01–F-13)
- [x] Edge-case and negative testing requirements cover boundaries, invalid inputs, concurrency and dependency failures (QE-ITEM-3.1–3.5)
- [x] Automation framework selections are justified with language and project context (QE-ITEM-4.2)
- [x] CI/CD pipeline design includes parallelization, time budgets and quality gates (QE-ITEM-4.1, 4.3, 4.6, P-1)
- [x] Flaky test management has detection, quarantine and remediation steps (QE-ITEM-4.4, 9.2)
- [x] Coverage and defect metrics have concrete numeric targets (QE-ITEM-5.1, 5.2, 8.4)
- [x] Exit criteria are measurable and include rollback triggers (QE-ITEM-5.4, 5.5)

## Quality Assurance Task Checklist (before finalizing)

- [x] Every recommendation maps to a requirement or risk statement (R-xx / F-xx references)
- [x] Coverage references cite relevant code areas, services or critical paths (file paths throughout)
- [x] Recommendations reference current test and defect data where available (Evidence snapshot, QE-ITEM-1.x)
- [x] All findings are based on identified risks, not assumptions. Unverified items are marked "verify" or "root-cause first" (QE-ITEM-1.4, 1.5, 1.6)
- [x] Test descriptions provide concrete scenarios, not vague summaries
- [x] Automated and manual tests are clearly distinguished (the "Automation Level" field on every item)
- [x] Quality gate verification steps are actionable and measurable (QE-ITEM-4.6 table, P-1, P-7)
