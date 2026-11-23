import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How the installer's signature and digest are read. Windows is asked through PowerShell;
 * anything but a clean answer (a failed run, output that is not JSON, no status) must read
 * as "UnknownError", which judgeSignature refuses: a reader that cannot tell must never
 * pass for a valid signature or for "not signed" (which the person may run anyway).
 */

const execFile = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (orig) => ({ ...(await orig<typeof import("child_process")>()), execFile }));

const { judgeSignature, organisationOf, readSignature, sha256File } = await import("../src/core/installerTrust");

type Cb = (err: Error | null, stdout: string) => void;
const answer = (err: Error | null, stdout: string) =>
  execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: Cb) => cb(err, stdout));

afterEach(() => execFile.mockReset());

describe("readSignature", () => {
  it("reads Windows' status and signer, passing the path in the environment, not the script", async () => {
    answer(null, '{"status":"Valid","signer":"CN=QUALCOMM Inc., O=QUALCOMM Inc., C=US"}\r\n');
    const path = "C:\\T\\geniex'; Remove-Item -Recurse C:\\ ;'.exe";
    await expect(readSignature(path)).resolves.toEqual({ status: "Valid", signer: "CN=QUALCOMM Inc., O=QUALCOMM Inc., C=US" });
    const [file, args, opts] = execFile.mock.calls[0] as [string, string[], { env: Record<string, string>; windowsHide: boolean }];
    expect(file).toBe("powershell.exe");
    expect(args.join(" ")).not.toContain(path);
    expect(opts.env.MKMN_SIG_PATH).toBe(path);
    expect(opts.windowsHide).toBe(true);
  });
  it("reads an unsigned file as NotSigned with no signer", async () => {
    answer(null, '{"status":"NotSigned","signer":null}');
    await expect(readSignature("x.exe")).resolves.toEqual({ status: "NotSigned", signer: null });
    answer(null, '{"status":"NotSigned"}');
    await expect(readSignature("x.exe")).resolves.toEqual({ status: "NotSigned", signer: null });
  });
  it("reads a failed PowerShell run as UnknownError, which is refused", async () => {
    answer(new Error("powershell.exe not found"), '{"status":"Valid","signer":"CN=Q, O=QUALCOMM Inc."}');
    const sig = await readSignature("x.exe");
    expect(sig).toEqual({ status: "UnknownError", signer: null });
    expect(judgeSignature(sig).verdict).toBe("refused");
  });
  it("reads output that is not JSON as UnknownError", async () => {
    answer(null, "Get-AuthenticodeSignature : access denied");
    await expect(readSignature("x.exe")).resolves.toEqual({ status: "UnknownError", signer: null });
  });
  it("reads an answer without a status as UnknownError, never as NotSigned", async () => {
    answer(null, '{"status":"","signer":null}');
    const sig = await readSignature("x.exe");
    expect(sig.status).toBe("UnknownError");
    expect(judgeSignature(sig).verdict).toBe("refused");
    answer(null, "{}");
    await expect(readSignature("x.exe")).resolves.toEqual({ status: "UnknownError", signer: null });
  });
});

describe("sha256File", () => {
  it("hashes the file's bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mkmn-sha-"));
    try {
      const p = join(dir, "f.bin");
      writeFileSync(p, "abc");
      await expect(sha256File(p)).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects when the file cannot be read", async () => {
    await expect(sha256File(join(tmpdir(), "mkmn-sha-missing-" + Date.now(), "nope.exe"))).rejects.toThrow(/ENOENT/);
  });
});

describe("organisationOf", () => {
  it("reads a quoted O= value with an escaped quote", () => {
    expect(organisationOf('CN=x, O="Acme ""Q"" Ltd, Inc.", C=US')).toBe('Acme "Q" Ltd, Inc.');
  });
  it("reads O= as the first or last RDN", () => {
    expect(organisationOf("O=QUALCOMM Inc., C=US")).toBe("QUALCOMM Inc.");
    expect(organisationOf("CN=x, O=QUALCOMM Inc.")).toBe("QUALCOMM Inc.");
  });
  it("finds no organisation where there is no O= RDN (OU= is not O=)", () => {
    expect(organisationOf("CN=QUALCOMM Inc., OU=QUALCOMM Inc., C=US")).toBeNull();
  });
});

describe("judgeSignature without an organisation", () => {
  it("refuses a valid signature with no signer", () => {
    expect(judgeSignature({ status: "Valid", signer: null })).toEqual({ verdict: "refused", reason: "it is signed by someone else (no signer)" });
  });
  it("refuses a publisher's name that sits only in CN or OU", () => {
    expect(judgeSignature({ status: "Valid", signer: "CN=QUALCOMM Inc., OU=QUALCOMM Inc., C=US" }).verdict).toBe("refused");
  });
  it("checks against the publishers it is given", () => {
    expect(judgeSignature({ status: "Valid", signer: "CN=a, O=Other Co" }, ["Other Co"]).verdict).toBe("trusted");
    expect(judgeSignature({ status: "Valid", signer: "CN=a, O=QUALCOMM Inc." }, ["Other Co"]).verdict).toBe("refused");
  });
});
