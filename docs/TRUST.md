# Trust, signing & verification

How MKMN AI earns trust from Windows and antivirus/EDR tools, and how anyone can
verify a release. The goal is to stop clean builds being flagged as "unrecognized"
or as false positives — **not** to avoid being scanned. Avoiding or disabling a
scanner is exactly what malware does and lowers your reputation; everything here
raises it instead.

## What a security tool actually measures

A fresh, unknown installer gets a SmartScreen wall and AV false positives mainly
because it is **unsigned and has no reputation yet** — not because it is being
scanned. Trust is built with signing, verifiable provenance, clean build hygiene,
and a stable publisher identity. The free items below cover all four.

---

## Already in place (free, done)

- **SHA-256 for every installer**, published beside the asset (`*.sha256`).
- **Sigstore build-provenance attestation** — `.github/workflows/release.yml`
  runs `actions/attest-build-provenance`, so each installer is cryptographically
  tied to the exact repo, commit and workflow that built it. No cost, public repos only.
- **No packer or obfuscator** (no UPX etc.). Packing is a top false-positive trigger.
- **Signed-download hygiene** — the installer verifies the WebView2 bootstrapper's
  Authenticode signature before running it.
- **CodeQL + CI gating** before any release is published.
- **Public MIT source** on GitHub — a stable, inspectable publisher identity.

---

## Free items worth doing (need your GitHub/Microsoft account — I can't do these for you)

### 1. Free Authenticode certificate for open source — **biggest free win**
A real code-signing certificate is normally paid, but OSS projects can get one
**free** through the **SignPath Foundation** (https://signpath.org/). MKMN
qualifies: MIT-licensed, public GitHub repo, real release history. A signed
installer is what removes the "Windows protected your PC" SmartScreen wall.
Apply once, then sign the NSIS installer in CI or in `scripts\Build-Windows.ps1`
with `signtool`.

### 2. Submit clean builds to Microsoft (free)
Submit each release installer at
https://www.microsoft.com/en-us/wdsi/filesubmission as a software developer so
Defender recognizes it. If a vendor false-positives you, use their false-positive
form (most AV vendors have one) with the SHA-256 and the attestation.

### 3. winget / Microsoft Store listing (free)
Publishing through winget or the Store attaches a vetted publisher identity that
carries reputation with it.

---

## How anyone can verify an MKMN release (share this with users)

**Checksum:**
```powershell
# Compare against the published .sha256
Get-FileHash -Algorithm SHA256 .\MKMN-<version>-arm64-Setup.exe
```

**Build provenance (proves GitHub built it from this repo):**
```powershell
gh attestation verify .\MKMN-<version>-arm64-Setup.exe --repo zzahed/MKMN
```

---

## "Not scanned while working" — the legitimate version

MKMN should not try to hide from, disable, or avoid a scanner from inside the app.
If a scan is slowing the app during heavy NPU/model work, the supported fix is for
the **user or their IT admin** to add a scan exclusion on their own machine — their
choice, on software they trust:

> Windows Security → Virus & threat protection → Manage settings →
> Exclusions → Add an exclusion → Folder → MKMN's install folder.

A properly signed, reputable build usually needs no exclusion at all.
