# MKMN AI 0.0.3-rc.1 — Engineering hardening candidate

**Status:** Release candidate for controlled Windows 11 ARM64 / HUMAIN AI PC evaluation. This document does not assert that an installer has been built, published, installed or approved. The latest public stable release remains v0.0.2 until a later publication decision.

**Baseline:** All changes merged on `main` after `v0.0.2`, including 44 merged pull requests across the repository's history as of 24 November 2026. This is a summary of highlights, not a claim that each PR was introduced exclusively in this candidate.

## Main improvements since v0.0.2

- **Fail-closed network isolation:** An isolated Node process cannot authorize generated-code execution based on a misleading `ERR_ACCESS_DENIED` printout after child-process failure. Async execution errors, failed synchronous exits and inconclusive results refuse execution. PR #45. Tests: `tests/isolation-probe-contract.test.ts`, `tests/isolation.test.ts`.
- **Safer harness recovery:** Resume refuses checkpoint journals whose settled steps do not form a contiguous, matching prefix of the current execution plan. PR #46. Tests: `tests/harness-run.test.ts`.
- **Correct Markdown boundaries:** Thematic breaks after paragraphs are recognized as their own blocks instead of being consumed as paragraph text. PR #44. Tests: `tests/markdown-boundaries.test.ts`.
- **Routing and resilience:** Forced model warm-up requests are queued rather than dropped; the document-edit stop test synchronizes on its review gate. PRs #41 and #42.
- **Broader validation:** New and expanded tests for security-sensitive paths, coverage thresholds, pinned CI dependencies, deterministic lint/type checks and CodeQL analysis across Rust, JavaScript/TypeScript and GitHub Actions. Relevant changes include PRs #31–#43.
- **Dependency and documentation maintenance:** Updated selected development and runtime dependencies, project README, onboarding materials and quality-engineering plans.

## Build and verification evidence

- Source integration baseline: `a369ad80ba2297f9b98031e61e4161f490b01f7d`, with passing CI ([7/7 jobs](https://github.com/zzahed/MKMN/actions/runs/45266534116)) and CodeQL ([3/3 analyses](https://github.com/zzahed/MKMN/actions/runs/45266534033)).
- This candidate changes version metadata and release documentation, so **fresh CI, CodeQL and installer build evidence are required on the actual candidate commit** before distributing an installer.
- Expected unsigned installer name: `MKMN-0.0.3-rc.1-arm64-Setup.exe`. Record its exact SHA-256 and the Git commit it was built from after the artifact exists.
- Packaging pipeline: `.github/workflows/release.yml`. Its verification does not prove that an installed application functions on physical HUMAIN hardware.

## Known limitations and release gates

- **Not yet production accepted:** Independent security approval remains pending ([#49](https://github.com/zzahed/MKMN/issues/49)).
- **Physical device testing pending:** Clean install, no-admin operation, actual GenieX/Hexagon NPU execution (not CPU fallback), offline work, network restrictions with the packaged Node runtime, crash recovery and HUMAIN FUSE/Node integrations must be evidenced on the intended Windows ARM64 HUMAIN computer ([#47](https://github.com/zzahed/MKMN/issues/47)).
- **Unsigned installer:** Windows SmartScreen and organizational policy may block installation. Do not bypass enterprise restrictions without IT approval.
- **Prerequisites:** Windows 11 ARM64 Snapdragon X; Qualcomm GenieX and an appropriate model for local NPU operation. Initial model/runtime downloads and optional HUMAIN cloud services require network connectivity and authorization.
- A passing GitHub CI test on a Windows ARM64 runner does **not** demonstrate NPU execution on a physical HUMAIN Snapdragon X2 device.

## Promotion policy

Treat `v0.0.3-rc.1` as a controlled pilot build only. Publish stable `v0.0.3` only after a new stable-version build passes its own tests and the explicit hardware/security acceptance gates have documented sign-off.
