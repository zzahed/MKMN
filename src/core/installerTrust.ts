// Whether a downloaded installer may be run.
//
// Setup ran the GenieX installer it had just downloaded with nothing checked but the
// HTTPS host. Before it runs now, Windows is asked for its Authenticode signature:
// - a valid signature whose signer is the publisher runs;
// - a signature that is broken, untrusted or from anyone else is refused;
// - no signature at all is not run by itself: the step shows the file's SHA-256 and the
//   person may run THAT file (same digest) with "Run it anyway".

import { execFile } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";

export interface Signature {
  /** Windows' word for it: Valid, NotSigned, HashMismatch, NotTrusted, UnknownError... */
  status: string;
  /** The signer certificate's subject, when there is one. */
  signer: string | null;
}

export type Trust =
  | { verdict: "trusted" }
  | { verdict: "unsigned" }
  | { verdict: "refused"; reason: string };

/** The organisations whose signature lets the GenieX installer run, matched whole: a name
 * that only STARTS with "Qualcomm" (another company's certificate) is not the publisher. */
// Exact O= names only. "QUALCOMM Inc." is the one the GenieX installer is really signed with (read from the 0.11.0 download).
export const GENIEX_PUBLISHERS = ["QUALCOMM Inc.", "Qualcomm Technologies, Inc.", "Qualcomm Incorporated"];

/** The O= value of a certificate subject (a value may hold commas: it ends where the next RDN starts). */
export function organisationOf(subject: string): string | null {
  const m = /(?:^|,\s*)O=(?:"((?:[^"]|"")*)"|(.*?))(?=,\s*[A-Za-z]+=|$)/.exec(subject);
  return m ? (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]).trim() : null;
}

export function judgeSignature(sig: Signature, publishers: readonly string[] = GENIEX_PUBLISHERS): Trust {
  if (sig.status === "NotSigned") return { verdict: "unsigned" };
  if (sig.status !== "Valid") return { verdict: "refused", reason: `its signature is not valid (${sig.status})` };
  const org = sig.signer ? organisationOf(sig.signer) : null;
  if (!org || !publishers.includes(org)) return { verdict: "refused", reason: `it is signed by someone else (${sig.signer ?? "no signer"})` };
  return { verdict: "trusted" };
}

/** The installer is not signed: it runs only once the person approves this exact file. */
export class UnsignedInstallerError extends Error {
  constructor(readonly sha256: string) {
    super(`The NPU engine's installer isn't signed by its publisher, so MKMN didn't run it. Choose Run it anyway only if you trust this download. Details for support: SHA-256 ${sha256}.`);
    this.name = "UnsignedInstallerError";
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (b) => h.update(b)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Windows' Authenticode verdict on a file, read through PowerShell (no window). */
export function readSignature(path: string): Promise<Signature> {
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:MKMN_SIG_PATH; " +
    "[pscustomobject]@{ status = [string]$s.Status; signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 60_000, env: { ...process.env, MKMN_SIG_PATH: path } },
      (err, stdout) => {
        if (err) return resolve({ status: "UnknownError", signer: null });
        try {
          const j = JSON.parse(String(stdout).trim()) as { status?: string; signer?: string | null };
          resolve({ status: j.status || "UnknownError", signer: j.signer ?? null });
        } catch { resolve({ status: "UnknownError", signer: null }); }
      });
  });
}
