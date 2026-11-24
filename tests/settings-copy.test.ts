import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AUTO_GOALS } from "../src/core/adaptiveCompute";
import { wordsPerSec } from "../src/renderer/Models";

/**
 * Speed & memory and the Models library in plain English (docs/design/usability-audit.md,
 * phase 2, M1–M6 and L1–L3): the part a first-time user sees first carries no engine
 * words, and the advanced keys sit in the Advanced fold.
 */
const settings = readFileSync("src/renderer/SettingsView.tsx", "utf8");
const runtime = readFileSync("src/renderer/RuntimePanel.tsx", "utf8");
const models = readFileSync("src/renderer/Models.tsx", "utf8");

/** Visible text: string literals and JSX text, comments removed. */
function copyOf(code: string): string {
  const noComments = code.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...noComments.matchAll(/"([^"\n]{3,})"|`([^`\n]{3,})`|>([^<>{}\n]{3,})</g)].map((m) => m[1] ?? m[2] ?? m[3]).join("\n");
}

/** The Speed & memory page up to its Advanced fold: what shows before anything is opened. */
const speedEveryday = (() => {
  const start = settings.indexOf('{view === "models" && <>');
  const fold = settings.indexOf('<details className="set-adv">', start);
  return settings.slice(start, fold);
})();
const speedAdvanced = (() => {
  const start = settings.indexOf('{view === "models" && <>');
  const fold = settings.indexOf('<details className="set-adv">', start);
  return settings.slice(fold, settings.indexOf('{view === "voice"', fold));
})();

const JARGON = /\btokens?\b|\bcache\b|\bKV\b|W4A16|Q4_0|\bquants?\b|\bHTP\b|\blatency\b|\bcontext window\b|\bfit rules\b|\bthroughput\b|\bclocks\b/i;

describe("Speed & memory: the everyday part speaks plain English", () => {
  it("has no engine words before the Advanced fold", () => {
    expect(copyOf(speedEveryday)).not.toMatch(JARGON);
  });

  it("the compute picker's visible copy has no engine words", () => {
    // the hybrid note and the NPU card were the worst offenders (W4A16, HTP, GGUF, QAIRT)
    const visible = runtime.slice(0, runtime.indexOf("{off && info && ("));
    expect(copyOf(visible)).not.toMatch(JARGON);
    expect(copyOf(visible)).not.toMatch(/GGUF|QAIRT|GenieX's/);
  });

  it("memory, conversation length and power sit inside the Advanced fold", () => {
    for (const id of ["sec-models-memory", "sec-models-plan", "sec-models-context", "sec-models-power"]) {
      expect(speedAdvanced, id).toContain(`id="${id}"`);
      expect(speedEveryday, id).not.toContain(`id="${id}"`);
    }
  });

  it("offers conversation length in words, keeping the stored values", () => {
    for (const v of ["auto", "2048", "4096", "8192"]) expect(speedAdvanced).toContain(`<option value="${v}">`);
    expect(speedAdvanced).toMatch(/about 3,000 words/);
  });

  it("keeps all nine power modes, with the common four first", () => {
    for (const v of ["auto", "burst", "high_performance", "sustained_high_performance", "balanced", "low_balanced", "power_saver", "high_power_saver", "low_power_saver"]) {
      expect(speedAdvanced).toContain(`<option value="${v}">`);
    }
    expect(speedAdvanced.indexOf('value="power_saver"')).toBeLessThan(speedAdvanced.indexOf('<optgroup label="More modes">'));
  });

  it("each automatic goal is plain and still says it is measured, never promised", () => {
    for (const g of AUTO_GOALS) {
      expect(g.why).toMatch(/measured on this PC/);
      expect(g.why).not.toMatch(/end-to-end|whole-task|explicit limits/);
    }
  });
});

describe("Models library cards", () => {
  it("fit badges say Should fit / Might not fit / Too large, with no fit-rule words", () => {
    const badge = models.slice(models.indexOf("function Badge"), models.indexOf("return <span className={`badge ${level}`}"));
    expect(badge).toContain('"Should fit"');
    expect(badge).toContain('"Might not fit"');
    expect(badge).toContain('"Too large"');
    expect(copyOf(badge)).not.toMatch(JARGON);
  });

  it("the file format and the fit reasons are behind Details, not on every card", () => {
    const details = models.slice(models.indexOf('<details className="small model-details">'), models.indexOf("</details>", models.indexOf("model-details")));
    expect(details).toContain("verdict.reasons");
    expect(details).toContain("native NPU bundle");
    const outside = models.replace(details, "");
    expect(outside).not.toMatch(/verdict\.reasons\.filter/);
  });
});

describe("Models library rows", () => {
  it("show the reference speed in words a second, labelled as the test PC's", () => {
    expect(models).toContain("test PC · about ${wordsPerSec(sc.tokPerSec)} words/s");
    expect(models).not.toContain("tok/s`");
    expect(wordsPerSec(40)).toBe(30);
    expect(wordsPerSec(0.4)).toBe(1);
  });
});

describe("phase 2, round 2: what a first-time user meets by default", () => {
  it("the Auto box leads with one plain line; the raw decision is under Technical details", async () => {
    const { plainLastChoice } = await import("../src/renderer/RuntimePanel");
    expect(plainLastChoice({ config: { compute: "npu" }, reason: ["provisional: no latency or throughput measurement exists"], provisional: true }))
      .toEqual({ where: "Ran on the NPU", why: "Not tested on this PC yet, so MKMN used the usual choice." });
    expect(plainLastChoice({ config: { compute: "hybrid" }, reason: ["already resident: no switch, no reload"], provisional: false }).why).toBe("Already loaded, so nothing changed.");
    expect(plainLastChoice({ config: { compute: "gpu" }, reason: ["staying resident: GenieX · NPU (switching would save less than 10%)"], provisional: false }).where).toBe("Ran on the graphics card");
    expect(runtime).toMatch(/<summary className="muted">Technical details<\/summary>\s*<div className="muted small">\{adaptive\.last\.label\}/);
  });

  it("the Auto power mode says what power.rs does: steady on battery, saving below 25%", () => {
    const rust = readFileSync("src-tauri/src/power.rs", "utf8");
    expect(rust).toMatch(/battery_percent\.is_some_and\(\|b\| b <= 25\)/);
    expect(speedAdvanced).toContain("steady on battery, saves power below 25%");
  });

  it("no tokens-per-second on the model rows, cards or speed chip outside Details and tooltips", () => {
    const visible = copyOf(models.replace(/title=\{[^}]*\}/g, "").replace(/<details className="small model-details">[\s\S]*?<\/details>/, ""));
    expect(visible).not.toMatch(/tok\/s|tokens\/s/);
  });

  it("placement badges say Built for the NPU and tested elsewhere, never a bare asterisk", () => {
    const badge = readFileSync("src/renderer/RunsBadge.tsx", "utf8");
    expect(badge).toContain(">Built for the NPU<");
    expect(badge).toContain('" (tested elsewhere)"');
    expect(badge).not.toContain('" *"');
  });
});
