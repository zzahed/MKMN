# MKMN AI 0.0.3-rc.3

This Windows 11 ARM64 candidate is for the controlled HUMAIN pilot and includes the changes prepared for RC2. The [GitHub prerelease](https://github.com/zzahed/MKMN/releases/tag/v0.0.3-rc.3) will carry the installer and verification files after device acceptance. The latest stable release is v0.0.2.

## Changes since the RC2 draft

- The local router stops after its idle window. MKMN instances coordinate use of the shared router, application logs rotate at 1 MiB, and shared logs are protected against concurrent writes. Windows supplies NPU memory readings directly, and the benchmark retries transient memory and Python startup checks. [Performance and reliability update](https://github.com/zzahed/MKMN/pull/78)
- Setup explains where to install optional components later. Model download errors and chat status messages give clearer next steps. Skill patterns with repetition operators are disabled to prevent the window from freezing. Existing affected skills can still be started manually, or their automatic triggers can be rewritten as comma-separated words. [Setup and error messages](https://github.com/zzahed/MKMN/pull/75) · [Chat status](https://github.com/zzahed/MKMN/pull/77)
- The build workflow supports Authenticode signing when a signing certificate is configured. The published checksum and attestation describe the exact installer provided. [Signing workflow](https://github.com/zzahed/MKMN/pull/74)

## Installation and verification

Use a Windows 11 ARM64 Snapdragon PC. Local NPU inference requires Qualcomm GenieX 0.11.0 or newer, a Windows NPU driver and a compatible model. The installer bundles Node.js 26.13.1. Piper read-aloud requires a separate phonemizer. The bundled Sherpa-ONNX runtime supports Kokoro. [RC2 changes](RELEASE_NOTES_v0.0.3-rc.2.md)

Verify the installer against its SHA-256 manifest and build provenance. The release operator records physical Snapdragon X2 install, upgrade, non-administrator launch, NPU model switching and relaunch results for that same installer. Stable promotion requires documented hardware acceptance and independent security sign-off. [Verification instructions](../TRUST.md) · [Hardware acceptance](https://github.com/zzahed/MKMN/issues/47) · [Security review](https://github.com/zzahed/MKMN/issues/49)
