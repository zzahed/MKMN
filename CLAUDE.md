# MKMN

@CONTRIBUTING.md

## Layout

- `src-tauri/` — Tauri v2 host (Rust)
- `src/sidecar/` — plain Node process that runs the logic in `src/core/`; stdout is protocol-only
- `src/renderer/` — React window; `src/shared/` — types, settings schema and paths used by all three
- `scripts/` — PowerShell build/release scripts and Node generators
- `tests/` — flat Vitest suite; `tests/e2e/` — Playwright

## Commands

```powershell
pnpm --ignore-workspace install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run tests/<name>.test.ts    # one file
pnpm regen:check                             # generated files up to date?
cargo check --manifest-path src-tauri\Cargo.toml
```

## Gotchas

- The real app runs only on Windows ARM64 (Snapdragon X). Elsewhere, check UI changes on the mock:
  `pnpm dev:renderer` → `/mock.html`, or the `mock-ui` entry in `.claude/launch.json` (port 5199).
- Never hand-edit generated files (`docs/settings-inventory.md`, `docs/state-machines.md`, the feature matrix).
  Change the source (`src/shared/settingsSchema.ts`, `src/shared/stateMachines.json`), then run `pnpm regen`.
