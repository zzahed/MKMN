import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { judgeSignature, UnsignedInstallerError } from "../src/core/installerTrust";
import { installGeniex, SetupService } from "../src/core/setupService";

/**
 * Setup ran the GenieX installer it had just downloaded with nothing checked but the
 * HTTPS host. It now asks Windows for the file's signature first: Qualcomm's valid
 * signature runs; a broken signature or another signer is refused; an unsigned file
 * is held, its SHA-256 shown, and run only after "Run it anyway" — that exact file.
 */

const QCOM = "CN=Qualcomm Technologies, Inc., O=Qualcomm Technologies, Inc., L=San Diego, S=California, C=US";

describe("judgeSignature", () => {
  it("runs Qualcomm's valid signature", () => {
    expect(judgeSignature({ status: "Valid", signer: QCOM })).toEqual({ verdict: "trusted" });
  });
  it("runs the real GenieX 0.11.0 installer, signed as QUALCOMM Inc. (read from the downloaded file)", () => {
    const real = "CN=QUALCOMM Inc., OU=Windows Mobile Integration, O=QUALCOMM Inc., L=San Diego, S=California, C=US, SERIALNUMBER=2271160, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US";
    expect(judgeSignature({ status: "Valid", signer: real })).toEqual({ verdict: "trusted" });
    expect(judgeSignature({ status: "Valid", signer: "CN=QUALCOMM Inc. Fans, O=QUALCOMM Inc. Fans, C=US" }).verdict).toBe("refused");
  });
  it("refuses a broken signature or another signer", () => {
    expect(judgeSignature({ status: "HashMismatch", signer: QCOM }).verdict).toBe("refused");
    expect(judgeSignature({ status: "NotTrusted", signer: QCOM }).verdict).toBe("refused");
    expect(judgeSignature({ status: "Valid", signer: "CN=Someone Else, O=Evil Corp" }).verdict).toBe("refused");
    // a name that only starts with the publisher's is another company
    expect(judgeSignature({ status: "Valid", signer: "CN=Qualcomm Tools LLC, O=Qualcomm Tools LLC, C=US" }).verdict).toBe("refused");
    expect(judgeSignature({ status: "Valid", signer: "CN=Qualcomm-Fans, O=Qualcomm Fans Ltd, C=GB" }).verdict).toBe("refused");
    expect(judgeSignature({ status: "Valid", signer: "CN=Qualcomm Technologies, Inc., O=\"Qualcomm Technologies, Inc.\", C=US" }).verdict).toBe("trusted");
    expect(judgeSignature({ status: "UnknownError", signer: null }).verdict).toBe("refused");
  });
  it("holds an unsigned file for the person", () => {
    expect(judgeSignature({ status: "NotSigned", signer: null })).toEqual({ verdict: "unsigned" });
  });
});

const deps = (over: any = {}) => ({
  download: async () => undefined,
  run: vi.fn(async () => ({ code: 0, output: "" })),
  exists: (p: string) => p.endsWith("geniex.exe"),
  env: { LOCALAPPDATA: "C:\\L" } as any,
  tmpDir: tmpdir() + "/mkmn-trust-test",
  signature: async () => ({ status: "NotSigned", signer: null }),
  sha256: async () => "d1g3st",
  probe: async () => "GenieX CLI Version: v0.11.0",
  ...over,
});

describe("installGeniex checks before it runs", () => {
  it("never runs an unsigned installer by itself, and names its digest", async () => {
    const d = deps();
    await expect(installGeniex(d, () => undefined)).rejects.toBeInstanceOf(UnsignedInstallerError);
    await expect(installGeniex(d, () => undefined)).rejects.toThrow(/SHA-256 d1g3st/);
    expect(d.run).not.toHaveBeenCalled();
  });
  it("runs the unsigned file the person approved, and only that one", async () => {
    const ok = deps({ allowUnsigned: "d1g3st" });
    await installGeniex(ok, () => undefined);
    expect(ok.run).toHaveBeenCalledTimes(1);
    const other = deps({ allowUnsigned: "an-older-file" });
    await expect(installGeniex(other, () => undefined)).rejects.toBeInstanceOf(UnsignedInstallerError);
    expect(other.run).not.toHaveBeenCalled();
  });
  it("refuses another signer without running anything", async () => {
    const d = deps({ signature: async () => ({ status: "Valid", signer: "CN=Someone Else" }) });
    await expect(installGeniex(d, () => undefined)).rejects.toThrow(/so it was not run\..*Details for support: it is signed by someone else/);
    expect(d.run).not.toHaveBeenCalled();
  });
});

describe("the setup step offers Run it anyway for that file", () => {
  it("an unsigned installer leaves the step in error with its digest, and Run it anyway passes it on", async () => {
    const allowed: (string | null | undefined)[] = [];
    const s = new SetupService({
      geniexPath: () => null,
      installGeniex: async (_p: any, allow?: string | null) => { allowed.push(allow); if (allow !== "d1g3st") throw new UnsignedInstallerError("d1g3st"); return "C:\\g\\geniex.exe"; },
      onGeniexInstalled: () => undefined,
      voiceNeeds: () => ({ stt: false, tts: false, sttName: "a", ttsName: "b" }),
      installVoice: async () => undefined,
    });
    s.check();
    await s.confirm();
    const step = s.status().steps.find((x) => x.id === "geniex")!;
    expect(step.state).toBe("error");
    expect(step.unsigned).toBe("d1g3st");
    s.runUnsigned("geniex");
    await new Promise((r) => setTimeout(r, 0));
    expect(allowed).toEqual([null, "d1g3st"]);
    expect(s.status().steps.find((x) => x.id === "geniex")!.state).toBe("done");
  });
});
