# MKMN AI 0.0.3-rc.2

This Windows 11 ARM64 release candidate is for the controlled HUMAIN pilot. The release page provides the installer, SHA-256 manifest, build provenance and device test results when the candidate is published. [RC2 release](https://github.com/zzahed/MKMN/releases/tag/v0.0.3-rc.2)

## Changes since RC1

- The Windows ARM64 installer bundles Node.js 26.13.1. Development and CI use pnpm 10.34.9, with Node.js 26.13.1 as the minimum for local builds.
- Tauri, the renderer tooling, the page editor, Sherpa-ONNX and ONNX Runtime were updated. Existing page documents remain editable. [Dependency update](https://github.com/zzahed/MKMN/pull/58)
- Harness recovery checks journal integrity, and the startup probe validates additional isolation invariants. The probe now runs when the application is launched from a Windows extended-length path. [Journal integrity](https://github.com/zzahed/MKMN/pull/56) · [Startup probe](https://github.com/zzahed/MKMN/pull/57) · [Windows paths](https://github.com/zzahed/MKMN/pull/59)

- Generated presentations, documents, spreadsheets and pages now receive artifact quality scoring. [Quality harness](https://github.com/zzahed/MKMN/pull/60)

## Installation and verification

Use Windows 11 ARM64 on a Snapdragon PC. Local NPU inference also requires Qualcomm GenieX 0.11.0 or newer, a Windows NPU driver and a compatible model. The GitHub artifact is unsigned and includes a build-provenance attestation. Verify its checksum and attestation before installing. [Verification instructions](https://github.com/zzahed/MKMN/blob/main/docs/TRUST.md)

The release operator checks CI and CodeQL on the source commit and validates the exact installer on a physical Snapdragon X2. Record the install, upgrade, non-administrator launch, NPU model switching and relaunch results with the published asset digest. Stable promotion requires documented hardware acceptance and independent security sign-off. [Hardware acceptance](https://github.com/zzahed/MKMN/issues/47) · [Review record](https://github.com/zzahed/MKMN/issues/49)

## Known limitation

Piper read-aloud requires a separate phonemizer. The shipped Sherpa-ONNX ARM64 runtime supports read-aloud with Kokoro. [Upstream phonemizer change](https://github.com/k2-fsa/sherpa-onnx/issues/3731)
