# MKMN Repository Enhancement Roadmap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out every recommendation from the three review sessions of 2026-11-22: get the test suite green, add CI on pull requests, close the security and data-at-rest gaps, add repo hygiene and docs, then do the longer test-coverage and refactor work.

**Architecture:** Work in phases. Each phase leaves `main` green and shippable. Phases 0–2 are small, test-first fixes. Phases 3–5 are hygiene and docs. Phases 6–7 are larger, incremental work. Phase 8 lists the items that need an owner decision or an outside account and cannot be done by an agent alone.

**Tech Stack:** TypeScript (Node ≥ 24, Vitest 5, React 19, Vite 7), Rust/Tauri 2 host (`src-tauri`), pnpm 10.26.1, GitHub Actions (`ubuntu-latest`, `windows-11-arm`), NSIS installer.

**Spec (sources, all from 2026-11-22):**
1. *Quality engineering strategy* session → `TODO_quality-engineering.md` on branch `claude/zealous-fermat-whw06n` (IDs `QE-PLAN-*`, `QE-ITEM-*`, proposals `P-1`…`P-7`). Executors: `git show origin/claude/zealous-fermat-whw06n:TODO_quality-engineering.md`.
2. *Codebase analysis and onboarding* session → enhancement list (items E1–E6 below).
3. *GitHub repository analysis for freelancers* session → enhancement list (items F1–F12 below).

### Source item → task map

| Source item | Task |
|---|---|
| QE-1.1, F1 (README broke 2 tests) | 1 |
| F3 (hardware warning at top), F4 (disclaimer near top) | 1 |
| QE-1.2 (Windows-only tests fail on Linux) | 2 |
| QE-1.3, P-3, P-6 (Node ≥ 24, pdf hangs) | 3 |
| QE-1.5 (QAIRT ctx `null`) | 4 |
| QE-1.6 (bench "estimated" label) | 5 |
| QE-1.7 (artifact check reason) | 6 |
| QE-1.8 (NPU kill test timeout) | 7 |
| QE-1.9, P-2 (unhandled errors) | 8 |
| QE-4.1, 4.6, P-1, E1, F2 (CI on PRs; stale artifact path) | 9 |
| E5b (`pnpm regen` + stale-generated check) | 9 |
| QE-1.4, P-5 (sandbox network denial) | 10 |
| QE-6.2 (dependency/secret/CodeQL scanning) | 11 |
| E3a (project delete leaves knowledge) | 12 |
| E3b (retention setting) | 13 |
| E6c, F8 (SECURITY.md, PR + issue templates) | 14 |
| E5c, F9 (ESLint + Prettier) | 15 |
| E6a (`opennpu` naming) | 16 |
| E6b, F11 (`shelved/` folders) | 17 |
| E5a, F6 (browser preview docs, glossary, FAQ) | 18 |
| QE-2.1, P-2 (coverage + thresholds) | 19 |
| QE-2.3, QE-PLAN-1.6 (browser E2E on mock bridge) | 20 |
| QE-2.2 (`commands.rs` tests) | 21 |
| E2, F10 (split big files) | 22, 23 |
| E4, F7 (code signing), F5 (screenshots), F8 (topics, Discussions), F12 (release cadence), E3c (DPAPI), QE-5.x/6.x/8.x (process) | Phase 8 (owner actions) |

## Global Constraints

- Node: `>=24` (pdfjs-dist needs `Promise.try`). CI uses `node-version: 24`; pnpm `10.26.1`; install with `pnpm --ignore-workspace install --frozen-lockfile` then `pnpm rebuild esbuild`.
- Every fix starts with a failing test (CONTRIBUTING rule). Tests never open a real network connection (`tests/setup-model-guard.ts`).
- Do not rename the `opennpu.conversations` storage key without a migration: saved chats must survive.
- Generated files (`*.generated.ts`, feature matrix, settings schema) are edited only through their generator in `scripts/`.
- README must keep the strings `Release status: v<version>` and a `makensis /DVERSION=` command (contract tests `tests/version.test.ts:25`, `tests/build-docs.test.ts:23`).
- Pin third-party GitHub Actions to a commit SHA.
- Plain-English copy (`scripts/check-language.mjs` must pass).
- No real secrets, signing keys or certificates in the repo.

## Review Focus

1. **Windows host after Linux skips (Tasks 2, 4, 7):** a test gated with `itWindows` must still run and pass on `windows-11-arm`; the Windows skip count must not rise. Task 9's Windows job is the check.
2. **Sandbox probe on a runtime that does deny network (Task 10):** the probe must not produce a false "unsafe" on Node 24, which would turn off generated code for every user. Test both outcomes with an injected probe.
3. **Deleting a project whose id has unsafe characters (Task 12):** ids are sanitised (`[^A-Za-z0-9._-]` → `_`) when files are written; deletion must use the same sanitiser so it removes the right files and never a path outside `knowledge/`.
4. **Deleting a project that never had an index (Task 12):** missing files must not raise; `deleteProject` must still succeed.
5. **Old saved chats after the rename (Task 16):** a profile holding `opennpu.*` keys must load unchanged after the rename.

---

## Phase 0 — Green the suite on Linux

### Task 1: README contract strings + top-of-page warnings

**Files:**
- Modify: `README.md`
- Test: `tests/version.test.ts`, `tests/build-docs.test.ts` (existing), `tests/readme-header.test.ts` (new)

- [ ] **Step 1: Write the failing test** `tests/readme-header.test.ts`:

```ts
const head = readFileSync("README.md", "utf8").split("\n").slice(0, 30).join("\n");
it("names the hardware requirement near the top", () => expect(head).toMatch(/Snapdragon X/));
it("states the non-endorsement near the top", () => expect(head).toMatch(/not (affiliated with|endorsed by) HUMAIN or Qualcomm/i));
```

- [ ] **Step 2: Run** `pnpm exec vitest run tests/readme-header.test.ts tests/version.test.ts tests/build-docs.test.ts`. Expected: 4 FAIL (2 new, plus `Release status` and `makensis` checks).
- [ ] **Step 3: Edit `README.md`:** within the first 30 lines add a bold line "Works only on Snapdragon X laptops with Windows 11 (check: Settings → System → About)" and move the existing non-endorsement sentence there. Add a `Release status: v0.0.2` line linking `docs/releases/RELEASE_NOTES_v0.0.2.md`. Add a "Build the installer by hand" block with `makensis /DVERSION=0.0.2 installer.nsi`.
- [ ] **Step 4: Run** the same command and `node scripts/check-language.mjs`. Expected: all PASS.
- [ ] **Step 5: Commit** `docs: restore README release contract and put hardware and disclaimer lines first`.

### Task 2: Platform-aware skips for Windows-only tests

**Files:**
- Create: `tests/helpers/platform.ts`
- Modify: `tests/paths-contract.test.ts`, `tests/powershell-native.test.ts`, `tests/runtime-contracts.test.ts`, `tests/watchdog.test.ts`, `tests/siteOpen.test.ts`; check `tests/npu-reset-command.test.ts`

**Interfaces:**
- Produces: `isWindows: boolean`, `describeWindows`, `itWindows` (`describe.skipIf(!isWindows)` / `it.skipIf(!isWindows)`), `posixRel(p: string): string` (splits on `[\\/]`, joins with `/`). Used by Tasks 4 and 7.

- [ ] **Step 1: Record the baseline:** `pnpm exec vitest run 2>&1 | tail -15`. Expected: 22 failed.
- [ ] **Step 2: Create the helper** (body as in QE TODO `P-4`).
- [ ] **Step 3: Gate** the PowerShell-spawning `describe` blocks with `describeWindows`; in `watchdog.test.ts` compare `files.map(posixRel)` to `["core/chat.ts"]`; in `siteOpen.test.ts` assert `sub/index.html` everywhere and `sub\\index.html` only when `isWindows`. Read each test first and adapt the exact lines.
- [ ] **Step 4: Run** the six files. Expected: 0 failed; gated tests reported as skipped.
- [ ] **Step 5: Commit** `test: skip Windows-only tests on other systems instead of failing`.

### Task 3: Declare Node ≥ 24 and make PDF reading fail fast

**Files:**
- Modify: `package.json` (add `"engines": { "node": ">=24" }`), `.npmrc` (add `engine-strict=true`), `src/core/pdf.ts`
- Test: `tests/pdf-runtime.test.ts` (new)

- [ ] **Step 1: Write the failing test:** stub `Promise.try` to `undefined` (restore in `afterEach`), call `readPdf` on a fixture from `tests/fixtures`, and assert it rejects within 1 s with `/needs Node\.js 24 or later/`. Second test: `JSON.parse(package.json).engines.node === ">=24"`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/pdf-runtime.test.ts`. Expected: FAIL (hang/timeout, missing `engines`).
- [ ] **Step 3: Implement** the guard from QE `P-6` at the top of the PDF entry point in `src/core/pdf.ts`, before pdfjs is loaded; add the `engines` field and `.npmrc` line.
- [ ] **Step 4: Run** the test. Expected: PASS. On Node 24, `tests/pdf-lifecycle.test.ts` also passes and the full suite runs in under 60 s.
- [ ] **Step 5: Commit** `fix: require Node 24 and fail fast when PDF reading cannot run`.

### Task 4: Root-cause QAIRT context size `null` (QE-1.5)

**Files:** find the canonical-key builder used by `tests/compiled-context-ipc.test.ts` and `tests/pdf-context.test.ts`.

- [ ] **Step 1: Reproduce:** `pnpm exec vitest run tests/compiled-context-ipc.test.ts tests/pdf-context.test.ts`. Expected: 3 FAIL, context `null` instead of `2048`.
- [ ] **Step 2: Diagnose** (use superpowers:systematic-debugging). If the key is built from a path with `\`, normalise it with `posixRel` in the source and add a test asserting the same key for `a\\b` and `a/b`. If the behaviour is truly Windows-only, gate with `itWindows` and write the reason in the test name.
- [ ] **Step 3: Run** both files. Expected: PASS on Linux (or skipped with reason).
- [ ] **Step 4: Commit** `fix: resolve compiled context identity on every platform` (or `test: …windows-only…`).

### Task 5: Bench "estimated" token label (QE-1.6)

**Files:** `src/core/benchRunner.ts`, `tests/bench.test.ts:799`

- [ ] **Step 1: Repeat** `pnpm exec vitest run tests/bench.test.ts -t estimated --repeat 50`. Record pass count.
- [ ] **Step 2a (always fails → defect):** set `tokensEstimated: true` on every streamed turn where the server sent no `usage`; the existing test is the failing test.
- [ ] **Step 2b (intermittent → flaky):** replace the 1 ms chunk timer with `vi.useFakeTimers()` and advance explicitly.
- [ ] **Step 3: Run** the repeat command. Expected: 50/50 PASS.
- [ ] **Step 4: Commit.**

### Task 6: Artifact check reports the right reason (QE-1.7)

**Files:** `src/core/xcheck.ts`, `tests/check-artifact-shared.test.ts`

- [ ] **Step 1: Reproduce;** expected message `nothing on the page is wired to keys…`, actual a line-count summary.
- [ ] **Step 2: Add** a paired case: a wired page passes, an unwired page returns the "not wired" reason first.
- [ ] **Step 3: Fix** the check order (or the platform-dependent read) in `xcheck.ts` so the wiring check's reason wins.
- [ ] **Step 4: Run** the file. Expected: PASS. **Commit.**

### Task 7: Deterministic NPU wedged-process kill test (QE-1.8)

**Files:** `tests/npu-runtime-safety.test.ts` and the module it covers.

- [ ] **Step 1:** Convert the "confirms the exit of a wedged process once a re-issued kill…" test to `vi.useFakeTimers()` with an injected process table; keep one real-process variant under `itWindows`.
- [ ] **Step 2: Run** the file. Expected: PASS, file time < 3 s. If injection needs a seam in source, add a parameter defaulting to the real implementation.
- [ ] **Step 3: Commit.**

### Task 8: Fail on unhandled errors (QE-1.9)

**Files:** `vitest.config.ts`

- [ ] **Step 1:** Add `dangerouslyIgnoreUnhandledErrors: false` and `exclude: ["tests/shelved/**", "node_modules/**"]` to `test`.
- [ ] **Step 2: Run** `pnpm exec vitest run`. Expected on Node 24: 0 failed, 0 unhandled errors. Any remaining unhandled error is fixed at its source, not ignored.
- [ ] **Step 3: Commit** `test: fail the run on unhandled errors`.

---

## Phase 1 — Checks on every pull request

### Task 9: `ci.yml`, `pnpm regen`, stale artifact path

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml:82` (remove `desktop/MKMN-App/dist/...` path; use the path `Build-Windows.ps1` writes), `package.json` scripts, `CONTRIBUTING.md`

**Interfaces:**
- Produces: `pnpm regen` (runs `generate-settings-schema`, `generate-state-machines`, `generate-feature-matrix`, `build-xblocks`, `vendor-icons`), `pnpm regen:check` (the three generators that support `--check`).

- [ ] **Step 1:** Add `regen` and `regen:check` scripts. Run `pnpm regen:check`. Expected: exit 0 on a clean tree.
- [ ] **Step 2:** Write `ci.yml` from QE `P-1` (jobs `lint-type`, `unit` sharded ×3, `windows-arm64-tests`, `security`), with `lint-type` calling `pnpm regen:check`, actions pinned to SHAs, and the `--coverage` flag removed until Task 19.
- [ ] **Step 3:** Fix the release artifact path.
- [ ] **Step 4: Verify** by pushing the branch and opening a draft PR (ask the user first): all jobs green. Locally: `pnpm typecheck && pnpm test`.
- [ ] **Step 5:** Document in CONTRIBUTING: CI must pass; turn on branch protection for `main` requiring `lint-type` and `unit` (owner action, see Phase 8).
- [ ] **Step 6: Commit** `ci: run type check, generator checks and tests on every pull request`.

---

## Phase 2 — Security

### Task 10: Prove the sandbox denies network before running generated code (QE-1.4)

**Files:**
- Modify: `src/core/isolate.ts`, `src/sidecar/isolation.ts`
- Test: `tests/isolation.test.ts`

**Interfaces:**
- Produces: `proveNetworkDenied(nodePath: string, readDirs: string[]): Promise<boolean>` in `src/core/isolate.ts` (sketch in QE `P-5`); `IsolationUnsafeError` (name `"IsolationUnsafeError"`, message `"Generated code is turned off: this Node.js runtime cannot block network access."`).

- [ ] **Step 1: Write failing tests:** (a) with an injected probe returning `false`, the sidecar isolation runner's `run` rejects with `IsolationUnsafeError` and never spawns the op; (b) with probe `true`, `run` proceeds; (c) on the real runtime, `proveNetworkDenied(process.execPath, [...])` returns the same answer as the existing `ERR_ACCESS_DENIED` test.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/isolation.test.ts`. Expected: FAIL (function missing).
- [ ] **Step 3: Implement** the probe; call it once per sidecar start, cache the result, refuse when `false`. Do not fall back silently. Add negative cases from QE-1.4(d) (DNS, UDP, `fetch`) as they are supported by the Node permission model.
- [ ] **Step 4: Run** on Node 24. Expected: PASS; network test reports `ERR_ACCESS_DENIED`. If Node 24 itself does not deny network, stop and report: this is a release blocker needing an owner decision (pin a Node that does, or remove network modules from the worker's surface per QE-1.4(c)).
- [ ] **Step 5:** Record the bundled Node version in `docs/releases/` notes template. **Commit** `fix(security): refuse generated code when the runtime cannot block network`.

### Task 11: Dependency, secret and code scanning

**Files:** `.github/workflows/ci.yml` (`security` job from Task 9), `.github/dependabot.yml` (new), `.github/workflows/codeql.yml` (new)

- [ ] **Step 1:** Run `pnpm audit --audit-level=high` and `cargo audit --file src-tauri/Cargo.lock` locally; record findings in the PR description.
- [ ] **Step 2:** Add Dependabot for `npm`, `cargo`, `github-actions` (weekly); add CodeQL for `javascript-typescript` on PRs and weekly.
- [ ] **Step 3: Verify** jobs green on the draft PR (high/critical findings fixed or listed for an owner waiver). **Commit.**

---

## Phase 3 — Data at rest

### Task 12: Deleting a project removes its knowledge files

**Files:**
- Modify: `src/core/knowledge/store.ts`, `src/core/knowledge/vectors.ts`, `src/sidecar/main.ts` (register method), `src/shared/api.ts`, `src/renderer/tauriBridge.ts:1369`, `src/renderer/mock.ts:204`, `docs/design/data-at-rest.md` (remove open item)
- Test: `tests/knowledge-forget.test.ts` (new)

**Interfaces:**
- Produces: `removeKnowledgeFiles(knowledgeDir: string, offloadDir: string, projectId: string): string[]` in `src/core/knowledge/store.ts` — deletes `<id>.json`, `<id>.vectors` (same sanitiser as `indexFileOf` / `fileOf`) and `knowledge-<id>.txt` in the fold/offload dir (name from `chatOrchestrator.ts:1201`); clears both in-memory memos for that project; returns removed file names; missing files are ignored. Sidecar method `knowledgeForget(projectId: string)`.

- [ ] **Step 1: Write failing tests** in a temp dir: (a) all three files removed and returned; (b) id `"../x y"` removes only `.._x_y.*` inside the dirs; (c) no files → returns `[]`, no throw; (d) another project's files untouched; (e) after removal `knowledgeIndexStatus` reports not built.
- [ ] **Step 2: Run** — FAIL (missing export).
- [ ] **Step 3: Implement;** export a shared `safeIdOf(projectId)` and use it in both `indexFileOf` and `fileOf`. Register `knowledgeForget` in `main.ts` next to `knowledgeStatus` (~line 3111). In `tauriBridge.deleteProject`, call `sidecarCall("knowledgeForget", id)` after the list write; a failure is logged, not thrown.
- [ ] **Step 4: Run** the new test and `pnpm typecheck`. Expected: PASS. **Commit** `fix(privacy): deleting a project removes its knowledge index and payload`.

### Task 13: Retention setting for journals, payloads and versions

**Files:** settings schema source used by `scripts/generate-settings-schema.mjs`, a new `src/core/retention.ts`, sidecar start-up hook, `docs/design/data-at-rest.md`, `docs/settings-inventory.md`
- Test: `tests/retention.test.ts`

**Interfaces:**
- Produces: setting `privacy.retentionDays: number | null` (default `null` = keep forever, preserving today's behaviour); `pruneOlderThan(dirs: string[], days: number, now: number): string[]`.

- [ ] **Step 1: Failing tests:** files older than N days are removed, newer kept, `null` removes nothing, files currently referenced by an open chat are kept.
- [ ] **Step 2: Implement;** run pruning once at sidecar start. Regenerate via `pnpm regen`.
- [ ] **Step 3: Run** tests + `pnpm regen:check`. **Commit.**

---

## Phase 4 — Repository hygiene

### Task 14: Community files

**Files:** create `SECURITY.md`, `.github/pull_request_template.md` (mirror the CONTRIBUTING checklist), `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml` (keep existing `config.yml`).

- [ ] **Step 1:** Write them. `SECURITY.md` points to GitHub private vulnerability reporting (no personal email). Bug template asks for device model, Windows build, MKMN version, "Copy full log" output.
- [ ] **Step 2: Verify** `node scripts/check-language.mjs`. **Commit** `docs: add security policy and issue and PR templates`.

### Task 15: ESLint and Prettier

**Files:** `eslint.config.js` (flat config: `typescript-eslint` recommended + `eslint-plugin-react-hooks`), `.prettierrc`, `.prettierignore` (generated files, `THIRD_PARTY_LICENSES.txt`), `package.json` (`lint`, `format:check`), `ci.yml` (`lint-type` job).

- [ ] **Step 1:** Add config; run `pnpm lint`. Fix or file-level-disable existing errors so the run is 0 errors (warnings allowed). Existing `eslint-disable` comments must now refer to real rules.
- [ ] **Step 2:** Run Prettier **check only**; do not reformat the codebase in this task (a mass reformat is a separate, owner-approved commit).
- [ ] **Step 3:** Add `pnpm lint` to CI. **Commit.**

### Task 16: Rename leftover `opennpu` / `OpenNpuApi` identifiers

**Files:** `src/shared/api.ts`, `src/renderer/{tauriBridge,App,api,main,store,mock}.ts(x)`, `src/voice/{worker,backend}.ts`, `src/sidecar/protocol.ts`
- Test: `tests/storage-keys.test.ts` (new)

- [ ] **Step 1: Failing test:** a profile with `opennpu.conversations` (and any other `opennpu.*` key found by `grep -rn "opennpu\." src`) loads the same conversations after the rename.
- [ ] **Step 2:** Rename type/identifier names only (`OpenNpuApi` → `MkmnApi`, etc.); keep storage key strings, or add a one-time copy to `mkmn.*` that keeps the old key.
- [ ] **Step 3: Run** `pnpm typecheck && pnpm test`. **Commit.**

### Task 17: Remove shelved code

**Files:** delete `src/core/shelved/`, `tests/shelved/`; remove references (grep `shelved`).

- [ ] **Step 1:** `grep -rn shelved src tests scripts docs vitest.config.ts`; remove each reference.
- [ ] **Step 2: Run** `pnpm typecheck && pnpm test`. **Commit** `chore: remove shelved code (kept in git history)`.

---

## Phase 5 — Docs for users and contributors

### Task 18: Browser preview mode, glossary, FAQ

**Files:** `CONTRIBUTING.md`, `docs/guide/user-guide.md` (or new `docs/guide/faq.md`), `README.md` (links)

- [ ] **Step 1:** CONTRIBUTING: "UI work without a Snapdragon laptop" — `pnpm dev:renderer`, open `mock.html`, what the mock bridge (`src/renderer/mock.ts`) fakes.
- [ ] **Step 2:** Glossary (NPU, GenieX, FUSE, Node, QAIRT — one sentence each) and FAQ (Is it free? Does it work offline? The model won't load — what now? Is my data private? Which PCs?).
- [ ] **Step 3: Verify** `node scripts/check-language.mjs` and `tests/build-docs.test.ts` pass. **Commit.**

---

## Phase 6 — Test depth

### Task 19: Coverage with ratcheting thresholds (QE-2.1)

**Files:** `package.json` (`@vitest/coverage-v8`, same major as `vitest`), `vitest.config.ts` (coverage block from QE `P-2`), `ci.yml` (`--coverage`)

- [ ] **Step 1:** Run `pnpm exec vitest run --coverage`; record the baseline per file in the PR.
- [ ] **Step 2:** Set global thresholds to baseline − 1; set per-file thresholds for the critical files in `P-2` only where the baseline already meets them, and list the rest as follow-ups.
- [ ] **Step 3: Verify** CI green with coverage. **Commit.**

### Task 20: Browser E2E against the mock bridge (QE-2.3)

**Files:** `playwright.config.ts`, `tests/e2e/*.spec.ts`, `ci.yml` (new `e2e` job), `vitest.config.ts` (exclude `tests/e2e/**`)

- [ ] **Step 1:** Serve `vite` with `mock.html`; write specs for the top flows in QE-PLAN-3 that the mock supports (send a chat and see a streamed reply; open settings and change a value; create and delete a project).
- [ ] **Step 2: Run** `pnpm exec playwright test --trace off`. Expected: PASS. **Commit.**

### Task 21: Rust tests for `commands.rs` (QE-2.2)

**Files:** `src-tauri/src/commands.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1:** Add tests for the argument validation and path handling of each command that does not need a live window. Run `cargo test --manifest-path src-tauri/Cargo.toml` on `windows-11-arm` CI (Task 9 job). **Commit.**

---

## Phase 7 — Split the largest files (incremental, behaviour-preserving)

### Task 22: Split `src/sidecar/main.ts` registrations by area

**Files:** create `src/sidecar/register/{models,voice,bench,foundry,knowledge,tasks,agent}.ts`, each exporting `registerX(dispatcher: Dispatcher, deps): void` (pattern: `registerHumain` in `src/sidecar/humain.ts`); `main.ts` keeps start-up and calls them.

- [ ] **Step 1: Safety test:** `tests/sidecar-methods.test.ts` snapshots the sorted list of registered method names (currently ~124). It must be identical after each move.
- [ ] **Step 2:** Move one area per commit; run `pnpm typecheck && pnpm test` and the snapshot after each.

### Task 23: Stage `runChatOrchestrator`

**Files:** `src/core/chatOrchestrator.ts` → extract `prepare`, `route`, `retrieve`, `generate`, `postProcess` as named functions in the same folder.

- [ ] **Step 1:** Before extracting, add a `FakeModel` golden test per stage boundary (input → output) using `src/core/harness/testing.ts`.
- [ ] **Step 2:** Extract one stage per commit; full suite green after each. `supervisor.rs`, `SettingsView.tsx`, `Chat.tsx`, `tauriBridge.ts` follow the same pattern later, one file per plan.

---

## Phase 8 — Owner actions and decisions (not agent tasks)

| Item | What you do | Source |
|---|---|---|
| Branch protection on `main` | Require `lint-type` and `unit` checks after Task 9 lands | QE-4.1, F2 |
| Code signing | Apply to SignPath Foundation (free for OSS) or set up Azure Trusted Signing; keep keys outside the repo; wire into `Build-Windows.ps1` | E4, F7 |
| Screenshots / GIF | Capture chat, cited answer, generated deck on a Snapdragon PC; add to README | F5 |
| Repo topics + Discussions | GitHub settings: topics `npu`, `snapdragon`, `local-llm`, `windows-on-arm`; enable Discussions | F8 |
| Chat encryption (DPAPI) | Decide yes/no; if yes, write a design note first | E3c |
| Release cadence | Small, frequent releases with a short changelog | F12 |
| Process items | Metrics, dashboards, defect SLAs, perf baselines, chaos, a11y, compatibility (QE-ITEM-5.x, 6.1, 6.3–6.6, 8.x, 9.x, 10.1) — adopt after Phases 0–2, using the QE TODO as the reference | QE |

## Not doing (per the source sessions)

- No large rewrite or architecture change; strengthen existing patterns.
- No Intel/AMD/Mac support.

## Suggested order

Week 1: Tasks 1–3, 8, 9 (suite green + CI), then 10 and 12.
Week 2: Tasks 4–7, 11, 14, 18. Then Phases 4–7 as time allows.
