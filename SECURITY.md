# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Only the maintainers see the report. Say what
you found, how to reproduce it, which MKMN version and Windows build you used,
and what an attacker could do with it.

You will get a reply in the report thread. Once a fix is released, the report
can be published as a security advisory, with credit to you if you want it.

## Verifying a release

Each installer ships with a SHA-256 checksum and a Sigstore build-provenance
attestation. See [docs/TRUST.md](docs/TRUST.md) for how to verify a download and
how MKMN is signed and distributed.

## Supported versions

Security fixes go into the latest release only. Update to it before you report.

## Scope

In scope: the MKMN app (the Tauri host, the Node sidecar, the window), its
installer, and the code it runs for a model (generated code, tools, the computer
use and browser features).

Out of scope: problems in Windows, in a model's own output, or in third-party
software MKMN downloads, such as GenieX or a model file. Report those to their
own makers.
