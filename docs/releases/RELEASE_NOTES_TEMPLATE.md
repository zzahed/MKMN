# MKMN AI <version> — <one-line summary>

<Two or three sentences: what kind of release this is and who should install it.>

## Fixes

- **<What now works.>** <What was wrong before, what changed, and what is still
  not covered.> Tests: `<test file>`.

## Bundled runtime

- **Node.js:** <version, from `node --version` on the build PC> (ARM64), copied
  into the installer by `scripts/Bundle-Sidecar.ps1`.
- MKMN needs Node.js 26 or later. Code a model writes runs in a locked-down Node
  process, and only from Node.js 25 on does that lock block network access. The
  bundling script refuses an older Node.js, and at start the app checks that the
  bundled one really blocks the network; if it does not, generated code is
  turned off.
- **Rust:** <version from `rust-toolchain.toml`>.

## Known limits

- <Anything a person should know before installing.>
