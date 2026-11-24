# MKMN AI release notes

**Current release: v0.0.2**

**Current candidate: v0.0.3-rc.1** (controlled pilot; availability confirmed on its [GitHub prerelease](https://github.com/zzahed/MKMN/releases/tag/v0.0.3-rc.1))

## Unreleased

- **Projects screen in plain English** ([#61](https://github.com/zzahed/MKMN/issues/61)).
  The reference-files meter no longer shows confusing counts such as "139k / 5k":
  it shows a percentage while everything fits, and a plain sentence when the
  assistant will look up the matching parts instead. File sizes are shown in
  pages and words instead of tokens. "Search index" messages now say "Preparing
  your files" and offer "Try again". The card is renamed "Reference files" so it
  is not confused with the Files page, the folder card says it can read but never
  change or delete, every input has a label for screen readers, and deleting a
  project says it cannot be undone. Audit and writing rules:
  [usability-audit.md](design/usability-audit.md). Other screens follow in
  [#62](https://github.com/zzahed/MKMN/issues/62).

## 0.0.3-rc.1 — Engineering hardening candidate

Includes security, execution recovery, Markdown parsing, routing and test infrastructure improvements since v0.0.2. For controlled HUMAIN Windows ARM64 pilot only. [Candidate notes](releases/RELEASE_NOTES_v0.0.3-rc.1.md).


## 0.0.2 — Security and reliability fixes

Fixes from an engineering review: Computer Use refuses consequential and unnamed
controls, voice models are installed only when their SHA-256 matches, outside
addresses are checked at connection time, a generated page cannot leave its
preview, settings have one writer, deleting a chat deletes its run records, and
cited figures and document frames are checked.
[Full notes](releases/RELEASE_NOTES_v0.0.2.md).

## 0.0.1 — Initial public release

The first public release of MKMN AI, a Windows 11 ARM64 desktop app that runs
language models on the Qualcomm Hexagon NPU through GenieX.
[Full notes](releases/RELEASE_NOTES_v0.0.1.md).
