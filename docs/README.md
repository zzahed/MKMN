# MKMN documentation index

**Current release: v0.0.2**

**Current candidate: v0.0.3-rc.1** (source candidate; pending packaging and publication). [Candidate notes](releases/RELEASE_NOTES_v0.0.3-rc.1.md). (Tauri v2 Rust host + Node sidecar, Windows 11 ARM64; Qualcomm GenieX v0.11.0 or newer for local inference).
The version is set by hand in four files and checked by `tests/version.test.ts`.
[CONTRIBUTING.md](../CONTRIBUTING.md) holds the rules for changes.

## Layout

| Folder / file | What is in it |
| --- | --- |
| [RELEASE-NOTES.md](RELEASE-NOTES.md) | The release index |
| [releases/](releases/) | `RELEASE_NOTES_v<version>.md`, one per release ([v0.0.3-rc.1](releases/RELEASE_NOTES_v0.0.3-rc.1.md), [v0.0.2](releases/RELEASE_NOTES_v0.0.2.md), [v0.0.1](releases/RELEASE_NOTES_v0.0.1.md)) |
| [MKMN_FEATURE_TEST_MATRIX_0.0.2.md](MKMN_FEATURE_TEST_MATRIX_0.0.2.md) | Generated (`scripts/generate-feature-matrix.mjs`): every command, sidecar method, Settings row, screen and script with the test that covers it |
| [settings-inventory.md](settings-inventory.md) | Generated (`scripts/generate-settings-schema.mjs`): every stored settings key, its default and where it is shown |
| [state-machines.md](state-machines.md) | Generated (`scripts/generate-state-machines.mjs`): the lifecycle machines and their transitions |
| [guide/](guide/) | [user-guide.md](guide/user-guide.md): what the app does, in plain words |
| [design/](design/) | How parts are built and why: the construction engine, blocks, Computer Use, document editing, the prompt budget, brand, animations, what is stored on the PC ([data-at-rest.md](design/data-at-rest.md)) |
| [prompt-lab/](prompt-lab/) | The prompt lab guide ([prompt-lab.md](prompt-lab/prompt-lab.md)) and its ready series (router, planning, units) |
| [research/](research/) | Background research: NPU loading, the Dynamic model, document retrieval |

## Where to start

- Building and installing: the root [README.md](../README.md), then `scripts\Build-Windows.ps1`.
- Chat location and HUMAIN API keys: the [user guide](guide/user-guide.md#local-and-humain-cloud-chat).
- Model loading on the NPU: [research/npu-load-research.md](research/npu-load-research.md) before touching it.
- Document retrieval speed and accuracy: [research/knowledge-retrieval-benchmark.md](research/knowledge-retrieval-benchmark.md).

Third-party notices: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
