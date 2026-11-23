// The single-model benchmark form: the form's layout and words, pinned
// where they can be tested — the two decisions that need judgement live in core as pure
// functions (when "Runs on" adds something, what a model option says), and the form's
// structure is pinned by source (grid, name-only options, plain-words result tile).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeBenchTarget, runsOnNote } from "../src/core/settingsUi";
import { badgePlacement, benchOptionLabel } from "../src/core/modelList";

const read = (p: string) => readFileSync(p, "utf8");
const sv = read("src/renderer/SettingsView.tsx");
const css = read("src/renderer/styles.css");

describe("when the Runs-on line adds something the select does not say", () => {
  it("is silent when it would only repeat the select (the form restated it every time)", () => {
    // a GGUF model, hybrid picked: the select itself shows "CPU + NPU (hybrid)"
    expect(runsOnNote("hybrid", "llama_cpp")).toBeNull();
    // the NPU pick, whatever the engine: the select says Hexagon NPU
    expect(runsOnNote("npu", "qairt")).toBeNull();
    expect(runsOnNote("npu", "llama_cpp")).toBeNull();
    expect(runsOnNote(null, "qairt")).toBeNull();
  });

  it("speaks only when a compiled bundle's stale hybrid pick is overridden", () => {
    // the picker cannot show WHY the select moved: this is the one case the line exists for
    expect(runsOnNote("hybrid", "qairt")).toMatch(/no CPU path/);
    expect(runsOnNote("hybrid", "qairt")).toMatch(/NPU/);
  });

  it("agrees with the normalization the Run button submits", () => {
    // the note exists exactly when a pick WAS made and the effective target differs from it
    for (const pick of ["npu", "hybrid", "bogus", null]) for (const eng of ["qairt", "llama_cpp", null]) {
      const effective = normalizeBenchTarget(pick, eng);
      const note = runsOnNote(pick, eng);
      expect(note !== null).toBe(pick !== null && pick !== effective);
    }
  });
});

describe("what a model option in the benchmark form says", () => {
  const item = (name: string, runsOn?: "npu" | "hybrid" | "gpu" | "cpu") =>
    ({ ref: `custom:repo/${name.toLowerCase()}:w4a16`, entry: { id: `custom:repo/${name.toLowerCase()}:w4a16`, name, repo: "repo/x", runsOn }, runsOn } as never);

  it("is the name only — the long ref never crowds the list", () => {
    const label = benchOptionLabel(item("Qwen3-4B"));
    expect(label).toContain("Qwen3-4B");
    expect(label).not.toContain("custom:");
    expect(label).not.toContain("w4a16");
  });

  it("marks a model that was already measured on this PC", () => {
    expect(benchOptionLabel(item("Qwen3-4B", "npu"))).toMatch(/Qwen3-4B — measured here/);
    expect(badgePlacement(item("Qwen3-4B", "npu")).here).toBe(true);
    expect(benchOptionLabel(item("Never-Benched"))).not.toMatch(/measured here/);
  });
});

describe("the form itself (source pins on SettingsView and styles)", () => {
  it("is a wrapping grid, not the flex-end row that let one column's note push the others up", () => {
    expect(css).toMatch(/\.bench-form\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/\.bench-form\s*\{[^}]*grid-template-columns/);
    // wraps on a narrow window (the ~900px breakpoint)
    expect(css).toMatch(/@media \(max-width:\s*900px\)\s*\{[^@]*\.bench-form/);
    expect(sv).toContain('className="bench-form"');
    expect(sv).not.toContain('alignItems: "flex-end"'); // the old bottom-aligned row
  });

  it("options come from the name-only label, with the ref in the tooltip", () => {
    expect(sv).toContain("benchOptionLabel(item)");
    expect(sv).toMatch(/<option[^>]*title=\{item\.ref\}/);
  });

  it("the Runs-on line is drawn only from the helper, never restated inline", () => {
    expect(sv).toContain("runsOnNote(");
    expect(sv).not.toContain('"Runs on: '); // no hand-restated line
    expect(sv).not.toContain(">Runs on:");
  });

  it("the TTFT tile speaks plain words beside the acronym", () => {
    expect(sv).toMatch(/First token time \(TTFT\)/);
    expect(sv).not.toMatch(/>TTFT</);
  });

  it("says where a result goes: the model card and the automatic performance mode", () => {
    expect(sv).toMatch(/automatic performance mode/);
    expect(sv).toMatch(/[Mm]odel card shows/);
  });
  it("results lead with first token time, generation speed and where it ran", () => {
    const ttft = sv.indexOf(">First token time (TTFT)<"), gen = sv.indexOf(">Generation speed<"), where = sv.indexOf(">Where it ran<"), prefill = sv.indexOf(">Prefill speed<");
    expect(ttft).toBeGreaterThan(0);
    expect(ttft).toBeLessThan(gen);
    expect(gen).toBeLessThan(where);
    expect(where).toBeLessThan(prefill);
  });

  it("says beside Run what a benchmark interrupts", () => {
    expect(sv).toMatch(/Unloads the chat model while it runs/);
  });

  it("names where a run went, verified or not", async () => {
    const { benchWhere } = await import("../src/renderer/SettingsView");
    expect(benchWhere({ compute: "npu", verifiedNpu: true })).toBe("NPU · verified");
    expect(benchWhere({ compute: "npu", verifiedNpu: false })).toBe("NPU · not verified");
    expect(benchWhere({ compute: "cpu", verifiedNpu: false })).toBe("CPU");
  });
});
