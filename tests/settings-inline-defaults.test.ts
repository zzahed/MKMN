import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_SCHEMA, settingDefault } from "../src/shared/settingsSchema";

const ROOT = process.cwd();
const srcFiles = (dir: string, acc: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!/(node_modules|target|dist|build)$/.test(name)) srcFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|generated)\./.test(name) && !/mock\.tsx?$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
};

/**
 * The schema is the ONE source of every default. This file pins the removal of
 * the old scattered inline defaults: a read of a stored key that falls back to a
 * literal beside the point of use (`settings.x ?? value`, `x !== false`,
 * `!!settings.x`) restates a default the schema already holds, and the two can
 * drift apart — three such disagreements were live before this test.
 */
describe("no inline settings default is left behind", () => {
  const leaves = new Set(SETTINGS_SCHEMA.map((d) => d.key.split(".").at(-1)!));
  const booleanLeaves = new Set(SETTINGS_SCHEMA.filter((d) => d.type === "boolean").map((d) => d.key.split(".").at(-1)!));

  it("leaves no inline settings default behind in the code", () => {
    const offenders: string[] = [];
    for (const f of srcFiles(join(ROOT, "src"))) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        const n = i + 1;
        // A `??`/`||` fallback beside the point of use restates a default the schema holds.
        for (const m of line.matchAll(/settings[?.)\w]*\.(\w+)[?.\w[\]'"]*\s*(\?\?|\|\|)\s*(".*?"|[\d_]+|true|false|\[\]|\{\})/g)) {
          const key = m[1];
          if (leaves.has(key)) offenders.push(`${f}:${n}: ${line.trim()}`);
        }
        // The boolean idioms that hide a default: `!!x` (false), `x !== false` (true),
        // `x === true` (false). Comparisons against enum values are reads, not defaults.
        for (const m of line.matchAll(/!!\s*settings[?.)\w]*\.(\w+)/g)) {
          const key = m[1];
          if (booleanLeaves.has(key)) offenders.push(`${f}:${n}: ${line.trim()}`);
        }
        for (const m of line.matchAll(/settings[?.)\w]*\.(\w+)[?.\w]*\s*!==\s*false|settings[?.)\w]*\.(\w+)[?.\w]*\s*===\s*true/g)) {
          const key = m[1] ?? m[2];
          if (key && booleanLeaves.has(key)) offenders.push(`${f}:${n}: ${line.trim()}`);
        }
      });
    }
    const allowed: Array<[RegExp, string]> = [
      // selectedModelId: the "no model chosen yet" pick of the preload path names a
      // model, not a settings default; the choice lives in the model menu.
      [/selectedModelId \|\| "qwen3-4b-thinking-2507"/, "preload's no-model pick"],
      // The memory estimate falls back to the DETECTED budget, not to a default.
      [/npuBudgetOverrideGB \?\? hw\.npuBudgetGB/, "hardware fallback"],
      // Display-only: a missing id renders as the words "none", not as a default.
      [/selectedModelId \?\? "none"/, "display of no selection"],
    ];
    const unallowed = offenders.filter((o) => !allowed.some(([re]) => re.test(o)));
    expect(unallowed, "inline defaults left in the code").toEqual([]);
  });

  it("reads the value the app acts on, where a control and a reader once disagreed", () => {
    // The power-mode control and its reset used to show "auto" while the start
    // request sent "burst" when the key was unset. The schema's one default is
    // what the control shows AND what the request sends.
    const bridge = readFileSync(join(ROOT, "src/renderer/tauriBridge.ts"), "utf8");
    const view = readFileSync(join(ROOT, "src/renderer/SettingsView.tsx"), "utf8");
    expect(settingDefault("powerProfile")).toBe("auto");
    expect(bridge).not.toMatch(/powerProfile\s*\|\|\s*"burst"/);
    expect(bridge).toMatch(/readSetting\(\s*\w+,\s*"powerProfile"/);
    expect(view).not.toMatch(/powerProfile\s*\?\?\s*"auto"/);
    // The auto-improve controls used to read the raw key while the loop acted on
    // its own defaults (6 rounds, 30 minutes): the control now reads the schema.
    expect(view).toMatch(/readNum\(settings, "agentRounds"\)/);
    expect(view).toMatch(/readNum\(settings, "agentMinutes"\)/);
    expect(settingDefault("agentRounds")).toBe(6);
    expect(settingDefault("agentMinutes")).toBe(30);
    expect(settingDefault("reviewRounds")).toBe(2);
  });
});
