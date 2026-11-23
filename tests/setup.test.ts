import { describe, expect, it } from "vitest";
import { geniexCandidates, locateGeniex, initialSteps } from "../src/core/setup";
import { SetupService, geniexNeedsFeed, geniexUpgradeOffer, installGeniex } from "../src/core/setupService";
import { canTransition } from "../src/shared/stateMachines";
import * as os from "os";

const gate = (state: "ok" | "missing" | "outdated" | "invalid", detected: string | null) => ({ state, path: state === "missing" ? null : "C:g.exe", detected, required: "0.11.0", message: `${state}` });

const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me", Path: "C:\\Windows;C:\\Tools" } as any;

describe("locating geniex after the installer", () => {
  it("prefers a path the installer printed", () => {
    const out = "Installed to C:\\Users\\me\\AppData\\Local\\GenieX CLI\nAdd to PATH: C:\\Users\\me\\bin\\geniex.exe\n";
    expect(geniexCandidates(out, env)).toContain("C:\\Users\\me\\bin\\geniex.exe");
    expect(geniexCandidates(out, env)).toContain("C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe");
  });
  it("falls back to the documented folder and PATH", () => {
    const have = new Set(["C:\\Tools\\geniex.exe"]);
    expect(locateGeniex("", env, (p) => have.has(p))).toBe("C:\\Tools\\geniex.exe");
    expect(locateGeniex("", env, () => false)).toBeNull();
  });
});

describe("installGeniex", () => {
  const mk = (over: any = {}) => ({
    download: async (_u: string, _d: string, cb: (p: number) => void) => { cb(50); cb(100); },
    run: async () => ({ code: 0, output: "ok C:\\Users\\me\\AppData\\Local\\GenieX CLI" }),
    exists: (p: string) => p === "C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe",
    signature: async () => ({ status: "Valid", signer: "CN=Qualcomm Technologies, Inc., O=Qualcomm Technologies, Inc." }),
    sha256: async () => "ab12",
    probe: async () => "GenieX CLI Version: v0.11.0",
    env, tmpDir: os.tmpdir() + "/opennpu-test", ...over
  });
  it("downloads, runs, and returns the found path with progress", async () => {
    const seen: any[] = [];
    expect(await installGeniex(mk(), (p, m) => seen.push([p, m]))).toMatch(/GenieX CLI\\geniex\.exe$/);
    expect(seen.some(([p]) => p === 50)).toBe(true);
  });
  it("refuses a published release older than the minimum before downloading it", async () => {
    let downloaded = false;
    const release = { tag: "v0.10.0", url: "https://example.invalid/geniex-v0.10.0.exe", sha256: "ab12", name: "geniex-v0.10.0.exe" } as any;
    await expect(installGeniex(mk({ release, download: async () => { downloaded = true; } }), () => undefined)).rejects.toThrow(/v0\.10\.0.*v0\.11\.0 or newer/);
    expect(downloaded).toBe(false);
  });
  it("explains when the installer ran but nothing was found, and when it failed", async () => {
    await expect(installGeniex(mk({ exists: () => false }), () => undefined)).rejects.toThrow(/Locate geniex\.exe/);
    await expect(installGeniex(mk({ run: async () => ({ code: 5, output: "boom" }) }), () => undefined)).rejects.toThrow(/code 5.*boom/);
    await expect(installGeniex(mk({ download: async () => { throw new Error("Download failed (HTTP 403)"); } }), () => undefined)).rejects.toThrow(/403/);
  });
});

describe("setup service", () => {
  const ops = (over: any = {}) => ({
    geniexPath: () => null as string | null,
    installGeniex: async (p: any) => { p(50, "x"); return "C:\\g\\geniex.exe"; },
    onGeniexInstalled: () => undefined,
    voiceNeeds: () => ({ stt: true, tts: true, sttName: "Whisper base", ttsName: "Kokoro" }),
    installVoice: async () => undefined,
    ...over
  });
  it("installs everything missing in order and finishes", async () => {
    const order: string[] = [];
    const s = new SetupService(ops({ installVoice: async (k: string) => { order.push(k); }, onGeniexInstalled: () => order.push("geniex") }));
    expect(s.check()).toBe(true);
    expect(s.status().awaitingConfirm).toBe(true);
    await s.confirm();
    expect(order).toEqual(["geniex", "stt", "tts"]);
    expect(s.status().steps.every((x) => x.state === "done")).toBe(true);
    expect(s.status().active).toBe(false);
  });
  it("does nothing when everything is already installed", () => {
    const s = new SetupService(ops({ geniexPath: () => "C:\\g.exe", voiceNeeds: () => ({ stt: false, tts: false, sttName: "a", ttsName: "b" }) }));
    expect(s.check()).toBe(false);
  });
  it("offers an optional update when a compatible GenieX has a newer stable release", async () => {
    const s = new SetupService(ops({ geniexPath: () => "C:g.exe" }));
    expect(s.check({ geniex: gate("ok", "0.11.0"), upgrade: "v0.12.0" })).toBe(true);
    expect(s.status().steps[0]).toMatchObject({ state: "pending", detail: expect.stringContaining("Optional update") });
    expect(s.status().steps[0].detail).toContain("v0.12.0");
    expect(s.status().awaitingConfirm).toBe(true);
    await s.confirm();
    expect(s.status().steps[0].state).toBe("done");
  });
  it("offers the install when GenieX is missing, older or reports no valid version, naming detected and required", () => {
    const missing = new SetupService(ops({ geniexPath: () => null }));
    missing.check({ geniex: gate("missing", null) });
    expect(missing.status().steps[0]).toMatchObject({ state: "pending", detail: expect.stringContaining("v0.11.0 or newer") });
    const old = new SetupService(ops({ geniexPath: () => "C:g.exe" }));
    old.check({ geniex: gate("outdated", "0.10.0") });
    expect(old.status().steps[0].state).toBe("pending");
    expect(old.status().steps[0].detail).toMatch(/Found v0\.10\.0\. MKMN needs GenieX v0\.11\.0 or newer/);
    const bad = new SetupService(ops({ geniexPath: () => "C:g.exe" }));
    bad.check({ geniex: gate("invalid", null) });
    expect(bad.status().steps[0].detail).toContain("no valid version");
  });
  it("leaves a compatible GenieX alone when no newer release is known (offline)", () => {
    const s = new SetupService(ops({ geniexPath: () => "C:g.exe", voiceNeeds: () => ({ stt: false, tts: false, sttName: "a", ttsName: "b" }) }));
    expect(s.check({ geniex: gate("ok", "0.11.0"), upgrade: null })).toBe(false);
    expect(s.status().steps[0].state).toBe("done");
  });
  it("asks the release feed only for a GenieX that already works", () => {
    expect(geniexNeedsFeed(gate("ok", "0.11.0"))).toBe(true);
    for (const st of ["missing", "outdated", "invalid"] as const) expect(geniexNeedsFeed(gate(st, st === "outdated" ? "0.10.0" : null))).toBe(false);
    expect(geniexNeedsFeed(null)).toBe(false);
  });
  it("offers an optional update only when it is newer and not the one the person skipped", () => {
    const ok = gate("ok", "0.11.0");
    expect(geniexUpgradeOffer(ok, "v0.12.0", null)).toBe("v0.12.0");
    expect(geniexUpgradeOffer(ok, "v0.11.0", null)).toBeNull();
    expect(geniexUpgradeOffer(ok, null, null)).toBeNull();
    expect(geniexUpgradeOffer(ok, "v0.12.0", "v0.12.0")).toBeNull();
    expect(geniexUpgradeOffer(ok, "v0.12.0", "0.12.0")).toBeNull();
    expect(geniexUpgradeOffer(ok, "v0.13.0", "v0.12.0")).toBe("v0.13.0");
    expect(geniexUpgradeOffer(gate("outdated", "0.10.0"), "v0.12.0", null)).toBeNull();
  });
  it("remembers a skipped optional update, never a skipped required install", () => {
    const seen: string[] = [];
    const opt = new SetupService(ops({ geniexPath: () => "C:g.exe", onGeniexUpdateSkipped: (t: string) => seen.push(t) }));
    opt.check({ geniex: gate("ok", "0.11.0"), upgrade: "v0.12.0" });
    opt.skip("geniex");
    expect(seen).toEqual(["v0.12.0"]);
    const declined = new SetupService(ops({ geniexPath: () => "C:g.exe", onGeniexUpdateSkipped: (t: string) => seen.push(t) }));
    declined.check({ geniex: gate("ok", "0.11.0"), upgrade: "v0.13.0" });
    declined.decline();
    expect(seen).toEqual(["v0.12.0", "v0.13.0"]);
    const required = new SetupService(ops({ geniexPath: () => "C:g.exe", onGeniexUpdateSkipped: (t: string) => seen.push(t) }));
    required.check({ geniex: gate("outdated", "0.10.0"), upgrade: "v0.12.0" });
    required.skip("geniex");
    required.decline();
    expect(seen).toEqual(["v0.12.0", "v0.13.0"]);
  });
  it("skipping setup leaves the GenieX step skipped (the gate keeps inference off) and the app opens", () => {
    const s = new SetupService(ops({ geniexPath: () => "C:g.exe" }));
    s.check({ geniex: gate("outdated", "0.10.0") });
    s.decline();
    expect(s.status()).toMatchObject({ active: false, awaitingConfirm: false });
    expect(s.status().steps[0].state).toBe("skipped");
    s.check({ geniex: gate("outdated", "0.10.0") });
    expect(s.status().steps[0].state).toBe("skipped");
  });
  it("keeps going after a failure, stays on screen, and retry works", async () => {
    let fail = true;
    const s = new SetupService(ops({ installGeniex: async () => { if (fail) throw new Error("no network"); return "C:\\g\\geniex.exe"; } }));
    s.check(); await s.confirm();
    const st = s.status();
    expect(st.steps[0].state).toBe("error");
    expect(st.steps[0].error).toMatch(/no network/);
    expect(st.steps[1].state).toBe("done");
    expect(st.active).toBe(true);
    fail = false;
    s.retry("geniex");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.status().steps[0].state).toBe("done");
    expect(s.status().active).toBe(false);
  });
  it("downloads nothing until the person confirms, and nothing at all when they decline", async () => {
    const calls: string[] = [];
    const s = new SetupService(ops({ installGeniex: async () => { calls.push("geniex"); return "C:\\g\\geniex.exe"; }, installVoice: async (k: string) => { calls.push(k); } }));
    s.check(); await s.run();
    expect(calls).toEqual([]);
    expect(s.status().awaitingConfirm).toBe(true);
    s.decline();
    await s.run();
    expect(calls).toEqual([]);
    expect(s.status().active).toBe(false);
    expect(s.status().steps.every((x) => x.state === "skipped" || x.id === "llama")).toBe(true); // llama.cpp is only a step when the GPU or CPU is chosen
    expect(s.check()).toBe(false);
  });
  it("skip removes a step from the work", async () => {
    const s = new SetupService(ops());
    s.check(); s.skip("voice-tts"); await s.confirm();
    expect(s.status().steps.find((x) => x.id === "voice-tts")!.state).toBe("skipped");
  });
  it("refuses a jump the setup machine does not allow", () => {
    const s = new SetupService(ops());
    s.check(); // the geniex step is pending
    expect(() => (s as unknown as { set(id: string, p: object): void }).set("geniex", { state: "done" })).toThrow(/cannot move from pending to done/);
  });
  it("only ever moves a step the way the setup machine allows", async () => {
    const s = new SetupService(ops({ installGeniex: async () => { throw new Error("no network"); } }));
    const seen: string[] = [];
    const prev = new Map<string, string>();
    s.on("state", (st: any) => {
      for (const step of st.steps) {
        const old = prev.get(step.id);
        if (old && old !== step.state) {
          seen.push(`${old}->${step.state}`);
          expect(canTransition("setup", old as never, step.state as never), `setup ${old} -> ${step.state}`).toBe(true);
        }
        prev.set(step.id, step.state);
      }
    });
    s.check();
    await s.confirm(); // the failure path goes running -> error
    s.retry("geniex"); // error -> pending, then pending -> running
    await new Promise((r) => setTimeout(r, 50));
    s.skip("voice-tts");
    expect(seen).toContain("error->pending");
    expect(seen).toContain("pending->running");
  });
});
void initialSteps;

describe("the setup screen says what each part is for", () => {
  // The first launch asked "Install all" or "Not now" without saying what each part
  // enables, what still works without it, or how big it is.
  it("every step names what it enables and what is left without it", () => {
    const steps = initialSteps({ geniex: true, llama: true, stt: true, tts: true }, { stt: "Whisper", tts: "Kokoro", sttMB: 160, ttsMB: 350 });
    for (const s of steps) {
      expect(s.enables.length).toBeGreaterThan(5);
      expect(s.withoutIt).toMatch(/^Without it/);
    }
  });
  it("gives a size only where it is known", () => {
    const steps = initialSteps({ geniex: true, stt: true, tts: true }, { stt: "Whisper", tts: "Kokoro", sttMB: 160, ttsMB: 350 });
    expect(steps.find((s) => s.id === "voice-stt")?.sizeMB).toBe(160);
    expect(steps.find((s) => s.id === "voice-tts")?.sizeMB).toBe(350);
    expect(steps.find((s) => s.id === "geniex")?.sizeMB).toBeNull();
  });
  it("the service passes the voice sizes through", () => {
    const s = new SetupService({ geniexPath: () => null, voiceNeeds: () => ({ stt: true, tts: false, sttName: "W", ttsName: "K", sttMB: 110 }) } as any);
    s.check();
    expect(s.state.steps.find((x) => x.id === "voice-stt")?.sizeMB).toBe(110);
  });
});
