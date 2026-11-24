// Pins for the settings work: what the interface claims about hardware must never
// exceed the evidence, and the fixes from the settings review must stay
// fixed (honest statuses, no fake defaults, capability gating, one retention knob).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  budgetProblem, executionStatus, memoryEstimateView, observedExecutionTarget,
  retentionFromIdle, retentionPatch, speakerProblem, voiceDeviceCapable, voicePlacementWarning,
} from "../src/core/settingsUi";
import { searchSettings, SETTINGS_SEARCH, SETTINGS_SECTIONS, TAB_META } from "../src/renderer/settingsSearch";
import type { HardwareProfile, MemoryEstimate, ServerStatus, VoiceModel } from "../src/shared/types";

const ready = (v?: Partial<ServerStatus["hardwareVerification"]>): ServerStatus =>
  ({ state: "ready", endpoint: "", nctx: null, compute: "npu", restarts: 0, lastError: null, pid: null,
     hardwareVerification: { verifiedNpu: false, cpuFallbackDetected: false, executionTarget: "", powerModeActive: "", ...v } }) as ServerStatus;

const read = (p: string) => readFileSync(p, "utf8");
const sv = read("src/renderer/SettingsView.tsx") + read("src/renderer/HumainSettings.tsx");
const rp = read("src/renderer/RuntimePanel.tsx");
const css = read("src/renderer/styles.css");

describe("settings navigation sections", () => {
  it("lists every settings page exactly once", () => {
    expect(SETTINGS_SECTIONS.flatMap(({ tabs }) => tabs).sort()).toEqual([...TAB_META].sort());
  });

  it("shows where on-device and cloud settings live in search", () => {
    expect(searchSettings("local intelligence install model")).toContainEqual(expect.objectContaining({
      tab: "library", section: "sec-library", tabLabel: "Local Intelligence › Models",
    }));
    expect(searchSettings("cloud intelligence test connection")).toContainEqual(expect.objectContaining({
      tab: "fuse", section: "sec-humain-fuse", tabLabel: "Cloud Intelligence › HUMAIN Fuse",
    }));
    expect(searchSettings("version and updates")[0]).toMatchObject({ tab: "about", section: "sec-about-update" });
    expect(searchSettings("chat provider")[0]).toMatchObject({
      tab: "chats", section: "sec-chats-location", tabLabel: "General › Chats & answers",
    });
  });
});

const est = (v: Partial<MemoryEstimate>): MemoryEstimate =>
  ({ modelRef: "m", weightsGB: 4, kvCacheGB: 1, scratchpadGB: 0.5, totalRequiredGB: 5.5, availableRamGB: 12,
     totalRamGB: 16, npuBudgetGB: 8, fits: true, recommendedNctx: 4096, recommendedKvType: "f16", isQairt: false, note: "", ...v });

const sherpa: VoiceModel = { id: "s", kind: "stt", name: "Sherpa", family: "whisper", archive: "a", sizeMB: 1, languages: "en", note: "" };
const foundry: VoiceModel = { ...sherpa, id: "f", foundryAlias: "slm", device: "NPU" };
const hw: HardwareProfile = { ramGB: 32 } as HardwareProfile;

describe("executionStatus — the badge never claims more than the evidence", () => {
  it("is neutral 'Not running' for null, stopped and unloaded servers", () => {
    for (const s of [null, { state: "stopped" }, { state: "unloaded" }]) {
      const v = executionStatus(s as ServerStatus | null, "npu");
      expect(v.kind).toBe("not-running");
      expect(v.tone).toBe("neutral");
    }
  });

  it("stays neutral while the runtime is starting", () => {
    const v = executionStatus({ state: "starting" } as ServerStatus, "npu");
    expect(v.kind).toBe("starting");
    expect(v.tone).toBe("neutral");
  });

  it("says 'fallback' ONLY when the runtime reported one", () => {
    const v = executionStatus(ready({ cpuFallbackDetected: true }), "npu");
    expect(v.kind).toBe("cpu-fallback");
    expect(v.tone).toBe("warn");
  });

  it("treats a missing verification as unverified, not as a fallback", () => {
    const v = executionStatus(ready({ verifiedNpu: false, cpuFallbackDetected: false }), "npu");
    expect(v.kind).toBe("unverified");
    expect(v.tone).toBe("neutral");
    expect(v.label).not.toMatch(/fallback/i);
  });

  it("treats a missing hardwareVerification block the same way", () => {
    const v = executionStatus({ state: "ready", endpoint: "", nctx: null, compute: "npu", restarts: 0, lastError: null, pid: null }, "npu");
    expect(v.kind).toBe("unverified");
  });

  it("reports verified NPU execution as ok", () => {
    const v = executionStatus(ready({ verifiedNpu: true }), "npu");
    expect(v.kind).toBe("verified-npu");
    expect(v.tone).toBe("ok");
  });

  it("never calls an intentional cpu/gpu request a fallback", () => {
    for (const c of ["cpu", "gpu"] as const) {
      const v = executionStatus(ready({ cpuFallbackDetected: false }), c);
      expect(v.kind).toBe("intentional-off-npu");
      expect(v.label).toMatch(new RegExp(c === "gpu" ? "GPU" : "CPU", "i"));
      expect(v.detail).toMatch(/not a fallback/i);
    }
  });

  it("surfaces a failed start as a warning", () => {
    const v = executionStatus({ state: "failed", lastError: { title: "boom" } } as unknown as ServerStatus, "npu");
    expect(v.kind).toBe("not-running");
    expect(v.tone).toBe("warn");
  });
});

describe("observedExecutionTarget", () => {
  it("returns the runtime's own reported device, or null when it reported none", () => {
    expect(observedExecutionTarget(ready({ executionTarget: "HTP0" }))).toBe("HTP0");
    expect(observedExecutionTarget(ready({ executionTarget: "" }))).toBeNull();
    expect(observedExecutionTarget(ready({ executionTarget: "  " }))).toBeNull();
    expect(observedExecutionTarget(null)).toBeNull();
  });
});

describe("memoryEstimateView — honest empty states", () => {
  it("shows measuring, not numbers, before an estimate exists", () => {
    const v = memoryEstimateView(null);
    expect(v.phase).toBe("loading");
    expect(v.weightsGB).toBe("--");
    expect(v.totalRequiredGB).toBe("--");
    expect(v.barPercent).toBeNull();
  });

  it("never substitutes a default 32 GB total RAM", () => {
    const v = memoryEstimateView(est({ totalRamGB: 0, availableRamGB: 0, weightsGB: 0, totalRequiredGB: 0 }));
    expect(v.totalRamGB).toBeNull();
    expect(v.availableRamGB).toBeNull();
    expect(v.phase).toBe("unavailable");
    expect(v.barPercent).toBeNull();
  });

  it("draws no bar without both required and available numbers", () => {
    expect(memoryEstimateView(est({ availableRamGB: 0 })).barPercent).toBeNull();
    expect(memoryEstimateView(est({ weightsGB: 0, totalRequiredGB: 0 })).barPercent).toBeNull();
  });

  it("keeps a usable estimate intact and splits fits from over", () => {
    const ok = memoryEstimateView(est({}));
    expect(ok.phase).toBe("fits");
    expect(ok.totalRequiredGB).toBe("5.5");
    expect(ok.availableRamGB).toBe("12");
    expect(ok.barPercent).toBeCloseTo((5.5 / 12) * 100, 5);
    expect(memoryEstimateView(est({ fits: false })).phase).toBe("over");
  });

  it("shows the estimator's note when it wrote one and invents none otherwise", () => {
    expect(memoryEstimateView(est({ note: "Optimal NPU fit" })).note).toBe("Optimal NPU fit");
    expect(memoryEstimateView(est({ note: "   " })).note).toBeNull();
    expect(memoryEstimateView(est({ note: undefined as unknown as string })).note).toBeNull();
  });
});

describe("budgetProblem — the NPU memory override", () => {
  it("accepts empty input as 'use detected'", () => {
    expect(budgetProblem("", hw)).toBeNull();
    expect(budgetProblem("   ", hw)).toBeNull();
  });
  it("rejects non-numbers, zero and negatives", () => {
    expect(budgetProblem("abc", hw)).toMatch(/number/i);
    expect(budgetProblem("0", hw)).toMatch(/above zero/);
    expect(budgetProblem("-2", hw)).toMatch(/above zero/);
  });
  it("rejects more than the PC's RAM and accepts a plausible value", () => {
    expect(budgetProblem("64", hw)).toMatch(/32 GB of RAM/);
    expect(budgetProblem("7.5", hw)).toBeNull();
  });
});

describe("speakerProblem — read-aloud voice id", () => {
  it("accepts any id when no model constrains it", () => {
    expect(speakerProblem(9, null)).toBeNull();
    expect(speakerProblem(9, sherpa)).toBeNull();
  });
  it("checks a named voice list", () => {
    const m = { ...sherpa, voices: [{ sid: 0, name: "a" }, { sid: 1, name: "b" }] };
    expect(speakerProblem(1, m)).toBeNull();
    expect(speakerProblem(2, m)).toMatch(/voices 0 to 1/);
  });
  it("checks a numeric sid range", () => {
    const m = { ...sherpa, sidCount: 3 };
    expect(speakerProblem(2, m)).toBeNull();
    expect(speakerProblem(3, m)).toMatch(/speakers 0 to 2/);
    expect(speakerProblem(1.5, m)).toMatch(/speakers 0 to 2/);
  });
});

describe("voice capability gating — no NPU choice that silently does nothing", () => {
  it("marks Foundry Local builds and NPU-device models capable", () => {
    expect(voiceDeviceCapable(foundry)).toBe(true);
    expect(voiceDeviceCapable({ ...sherpa, device: "NPU" })).toBe(true);
  });
  it("marks downloaded sherpa-onnx models incapable (CPU-only builds)", () => {
    expect(voiceDeviceCapable(sherpa)).toBe(false);
    expect(voiceDeviceCapable({ ...sherpa, device: "CPU" })).toBe(false);
    expect(voiceDeviceCapable(null)).toBe(false);
  });
  it("keeps a saved 'npu' placement for an incapable model and explains it (never silently reverts)", () => {
    const w = voicePlacementWarning("stt", "npu", sherpa);
    expect(w).toMatch(/CPU/);
    expect(w).toMatch(/Dictation/);
    expect(voicePlacementWarning("tts", "npu", sherpa)).toMatch(/Read-aloud/);
  });
  it("warns nothing when the placement is valid", () => {
    expect(voicePlacementWarning("stt", "cpu", sherpa)).toBeNull();
    expect(voicePlacementWarning("stt", "npu", foundry)).toBeNull();
  });
});

describe("retention — one authority for the idle-release knob", () => {
  it("derives keepalive 86400 from idle 0 (never release)", () => {
    expect(retentionFromIdle(0, 600)).toEqual({ loadingStrategy: "always", idleReleaseSec: 0, keepaliveSec: 86_400 });
  });
  it("derives a demand strategy with equal idle/keepalive otherwise", () => {
    expect(retentionFromIdle(300, 600)).toEqual({ loadingStrategy: "demand", idleReleaseSec: 300, keepaliveSec: 300 });
  });
  it("falls back to the legacy keepalive when idle was never saved", () => {
    expect(retentionFromIdle(undefined, 900).idleReleaseSec).toBe(900);
    expect(retentionFromIdle(Number.NaN, 900).idleReleaseSec).toBe(900);
    expect(retentionFromIdle(-5, 900).idleReleaseSec).toBe(900);
  });
  it("writes both stored keys in one patch", () => {
    expect(retentionPatch(0)).toEqual({ loadingStrategy: "always", idleReleaseSec: 0, keepaliveSec: 86_400 });
    expect(retentionPatch(120)).toEqual({ loadingStrategy: "demand", idleReleaseSec: 120, keepaliveSec: 120 });
  });
});

describe("settings search — every preference findable", () => {
  it("is empty for nothing typed", () => expect(searchSettings("  ")).toEqual([]));

  it("finds the microphone by task words", () => {
    const hits = searchSettings("microphone");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].tab).toBe("voice");
    expect(hits[0].section).toBe("sec-voice-mic");
  });

  it("finds theme and retention by alias", () => {
    expect(searchSettings("dark")[0].tab).toBe("general");
    expect(searchSettings("keep alive")[0].section).toBe("sec-models-retention");
  });

  it("requires every word to match and caps results", () => {
    expect(searchSettings("microphone banana")).toEqual([]);
    const hits = searchSettings("voice");
    expect(hits.length).toBeLessThanOrEqual(8);
    for (const h of hits) if (h.tab) expect(TAB_META).toContain(h.tab);
  });

  it("deep-links resolve: every entry's section id exists in SettingsView (dest entries name another page instead)", () => {
    for (const e of SETTINGS_SEARCH) {
      if (e.dest) {
        expect(e.dest, `${e.label}: a dest entry opens a known page`).toBe("customize");
        continue;
      }
      expect(e.section, `${e.label} has no section`).toBeTruthy();
      expect(sv).toContain(`"${e.section}"`);
    }
  });

  it("removed the UI-zoom entry (not applied by the Tauri build)", () => {
    expect(SETTINGS_SEARCH.some((e) => /zoom/i.test(e.label))).toBe(false);
  });

  it("finds the turn budget by its task words", () => {
    expect(searchSettings("budget")[0].section).toBe("sec-build-behavior");
  });
});

describe("the turn-budget Settings row — a tuned cap, never a disabled guard", () => {
  it("both knobs sit in the Conversation behavior section, with a Default that saves null", () => {
    // the row exists in the section the search index names
    expect(sv).toContain("Model calls per turn, at most");
    expect(sv).toContain("Output tokens per turn, at most");
    // Default saves null (the policy default stands), a number saves the pair —
    // never a way to save 0 or a disabled guard. The knobs read and complete the
    // pair through the schema, not literals restated beside the control.
    for (const knob of ["tb()?.maxCalls", "tb()?.maxOutputTokens"]) {
      expect(sv).toContain(knob);
    }
    expect(sv).toContain("settingDefault(\"turnBudget.maxCalls\")"); // the pair stays whole when only one knob changes
    expect(sv).toContain("settingDefault(\"turnBudget.maxOutputTokens\")");
  });
});

describe("source pins — the review's fixes stay fixed", () => {
  it("keeps raw hex status colors out of the settings and runtime components", () => {
    for (const src of [sv, rp]) {
      expect(src).not.toMatch(/#10b981/i);
      expect(src).not.toMatch(/#e5a93c/i);
      expect(src).not.toMatch(/rgba\(0,\s*0,\s*0,\s*0\.4\)/);
    }
    expect(css).toMatch(/\.npu-note\b/);
    expect(css).toMatch(/\.telemetry-log\b/);
    expect(css).toMatch(/\.status-ok\b/);
    expect(css).toMatch(/\.status-warn\b/);
    expect(css).toMatch(/\.stat\b/);
    expect(css).toMatch(/\.save-line\b/);
    expect(css).toMatch(/\.fill\.indeterminate\b/);
  });

  it("keeps NavButton at module scope (no remount per render)", () => {
    expect(sv).not.toMatch(/const NavButton|function NavButton\(\)\s*\{/);
  });

  it("offers no silent-revert CPU option in the QAIRT benchmark", () => {
    expect(sv).not.toContain('<option value="cpu"');
  });

  it("does not promise a future installer in About", () => {
    expect(sv).not.toMatch(/future installer|installer will/i);
  });

  it("remembers the last visited category", () => {
    expect(sv).toMatch(/mkmn\.settings\.tab/);
  });

  it("wires HUMAIN model discovery through every bridge", () => {
    expect(read("src/shared/api.ts")).toMatch(/humainModels/);
    expect(read("src/renderer/tauriBridge.ts")).toMatch(/humainModels/);
    expect(read("src/sidecar/humain.ts")).toMatch(/humainModels/);
    expect(read("src/renderer/mock.ts")).toMatch(/humainModels/);
  });
});

describe("retention with no stored value", () => {
  it("falls back to the 5-minute default instead of NaN", () => {
    expect(retentionFromIdle(undefined, undefined).idleReleaseSec).toBe(300);
    expect(retentionFromIdle(undefined, Number.NaN).idleReleaseSec).toBe(300);
  });
});
