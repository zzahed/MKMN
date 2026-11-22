# Contributing to MKMN

MKMN is a Windows on Snapdragon (ARM64) desktop app: a Tauri v2 host in Rust
(`src-tauri`), a plain-Node sidecar (`src/sidecar`) that carries the logic of
`src/core`, and a React window (`src/renderer`). The README explains how to
build and run it.

## Before you open a pull request

```powershell
pnpm --ignore-workspace install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run
cargo check --manifest-path src-tauri\Cargo.toml   # when Rust changed
```

All of them must pass. Pull requests target `main`.

If you changed a settings key, a state machine, a feature, an X block or the
icon list, run `pnpm regen` to rebuild the generated files and commit them.
`pnpm regen:check` tells you if any of them are out of date.

### Continuous integration

Every pull request runs `.github/workflows/ci.yml`. It has four jobs:

- `lint-type`: the type check, the plain-English check and `pnpm regen:check`
- `unit`: the test suite on Linux, in three parts
- `windows-arm64-tests`: the test suite and the Rust checks on Windows ARM64
- `security`: the dependency audits and a secret scan

CI must pass before a pull request is merged. The repository owner turns on
branch protection for `main` so that `lint-type` and `unit` are required.

## Rules the test suite enforces

1. **Hooks go above every early `return` of a component.** A hook placed after
   `if (!x) return ...` makes React throw "Rendered more hooks than during the
   previous render". `tests/hooks.test.ts` reads every renderer component and
   fails on a hook after an early return.
2. **The sidecar stays free of desktop-shell imports, and its stdout is
   protocol-only.** All `console.*` output goes to stderr.
3. **Never guess an app path.** The layout lives in one place,
   `src/shared/paths.ts` (`mkmnPaths()`); scripts resolve it with
   `scripts/Resolve-MkmnPaths.ps1`.
4. **Each setting has one default.** What the interface shows and what the app
   does must read the same value from `src/shared/settingsSchema.ts`.
5. **English and Arabic only** in interface text, comments and documents
   (`node scripts/check-language.mjs`, `tests/language.test.ts`).
6. **Code a model wrote never runs in the sidecar process.** A check that runs
   generated code goes through `isolation()` (`tests/isolation.test.ts`).
7. **No console window from any spawn** (`tests/console-hygiene.test.ts`).
8. **Every GenieX inference path calls the version gate**
   (`tests/geniex-gate.test.ts`), and every GenieX start releases Foundry Local
   first (`tests/one-engine-guard.test.ts`).

## Every change

- A bug fix starts with a regression test that fails on the old code.
- Change only what the task needs. Leave no debug logging or temporary files.
- A new command, sidecar method, Settings row, screen or script needs a row in
  the feature matrix: run `node scripts/generate-feature-matrix.mjs --write`.
- After changing `src/shared/settingsSchema.ts` or
  `src/shared/stateMachines.json`, regenerate with
  `node scripts/generate-settings-schema.mjs --write` and
  `node scripts/generate-state-machines.mjs`.

## Every prompt change

Every instruction block sent to a model (system prompt, appended rules, template
or writer text) is registered in `INSTRUCTION_BLOCKS` (`src/core/prompts.ts`)
with a priority, and the budget test (`tests/prompt-budget.test.ts`) must pass.
Never size instructions from the length or words of the user's message.

## Every release

- Use a patch version for fixes and a minor version for new features.
- Change the version in all four places: `package.json`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the app's own entry only) and
  `src-tauri/tauri.conf.json`, and the default `ExpectedVersion` in
  `scripts/Live-Relaunch-Check.ps1`.
- Add `docs/releases/RELEASE_NOTES_v<version>.md` and update the pointers in
  `docs/RELEASE-NOTES.md`, `docs/README.md` and `README.md`.
- Rename and regenerate the feature matrix for the new version.
- Build the installer with `scripts\Build-Windows.ps1`.
