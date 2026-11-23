## What this changes

<!-- What the change does and why. Link the issue it closes, if any. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm exec vitest run` passes
- [ ] `cargo check --manifest-path src-tauri\Cargo.toml` passes (when Rust changed)
- [ ] A bug fix starts with a regression test that fails on the old code
- [ ] Only what the change needs: no debug logging or temporary files
- [ ] A changed settings key, state machine, feature, X block or icon list: `pnpm regen` was run and `pnpm regen:check` passes
- [ ] A new command, sidecar method, Settings row, screen or script has a row in the feature matrix
- [ ] `node scripts/check-language.mjs` passes (English and Arabic only)
