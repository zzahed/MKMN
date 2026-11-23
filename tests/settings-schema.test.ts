import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SETTINGS_SCHEMA,
  settingDefault,
  readBool,
  readSetting,
} from "../src/shared/settingsSchema";
import { SETTINGS_SEARCH, searchSettings } from "../src/renderer/settingsSearch";
import {
  inventoryMarkdown,
  rustDefaultsText,
  storedKeysFromTypes,
  searchEntriesFromSchema,
} from "../scripts/generate-settings-schema.mjs";

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
 * The settings schema is the ONE declaration of every stored key: its type, its
 * single default, its place and its words. Rust, the search index and the docs
 * are generated from it, so the tests here pin the three ways it can rot:
 * a stored key without an entry, an entry nobody reads, and an inline default
 * left behind in the code.
 */
describe("the settings schema (one source of truth)", () => {
  it("has an entry for every stored key of the Settings type", () => {
    const stored = storedKeysFromTypes(readFileSync(join(ROOT, "src/shared/types.ts"), "utf8"));
    const declared = new Set(SETTINGS_SCHEMA.map((d) => d.key));
    const missing = stored.filter((k) => !declared.has(k));
    expect(missing, "stored keys with no schema entry").toEqual([]);
  });

  it("has exactly one entry per key", () => {
    const keys = SETTINGS_SCHEMA.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps labels short and descriptions one line, in plain words", () => {
    const banned = /\b(fold|lane|nctx|qairt|sidecar|kv cache|kvtype)\b/i;
    for (const d of SETTINGS_SCHEMA) {
      expect(d.label.split(/\s+/).length, `label of ${d.key} is more than 4 words`).toBeLessThanOrEqual(4);
      expect(d.description.length, `description of ${d.key} is too long`).toBeLessThanOrEqual(72);
      expect(d.description, `description of ${d.key} names internals`).not.toMatch(banned);
      if (d.label) expect(d.label, `label of ${d.key} names internals`).not.toMatch(banned);
    }
  });

  it("has a reader (or a recorded reason) for every entry", () => {
    const files = [...srcFiles(join(ROOT, "src")), ...srcFiles(join(ROOT, "src-tauri/src"))];
    const bodies = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));
    const unread = [];
    for (const d of SETTINGS_SCHEMA) {
      const leaf = d.key.split(".").at(-1)!;
      const used = bodies.some(({ text }) => text.includes(leaf));
      if (!used && !d.hidden) unread.push(d.key);
    }
    expect(unread, "schema entries nothing reads (add a hidden reason or a reader)").toEqual([]);
  });

  it("is the one source of the voice defaults", () => {
    // DEFAULT_VOICE_SETTINGS re-states the voice defaults no more: it is built
    // from the schema, and the Rust defaults object is generated from it too.
    const rust = rustDefaultsText();
    expect(rust).toContain('"allowInterrupt"');
    expect(settingDefault("voice.allowInterrupt")).toBe(true);
    expect(settingDefault("voice.waitMs")).toBe(2500);
    expect(readBool({ voice: { allowInterrupt: false } as never }, "voice.allowInterrupt")).toBe(false);
    expect(readBool({}, "voice.allowInterrupt")).toBe(true);
  });

  it("validates a value of the wrong type or out of range at read time", () => {
    expect(readSetting({ startupTimeoutSec: 5000 as never }, "startupTimeoutSec")).toBe(90);
    expect(readSetting({ effort: "maximum" as never }, "effort")).toBe("auto");
    expect(readSetting({ keepaliveSec: "soon" as never }, "keepaliveSec")).toBe(300);
    expect(readSetting({ keepaliveSec: 42 as never }, "keepaliveSec")).toBe(42);
    expect(readSetting(null, "subagents")).toBe(false);
  });

  it("generates the inventory, and the committed file is fresh", () => {
    const committed = readFileSync(join(ROOT, "docs/settings-inventory.md"), "utf8").replace(/\r\n/g, "\n");
    // The FINDINGS block is written by hand between the markers; the generator
    // preserves it (the way the --write path does), everything else must match.
    expect(committed).toBe(inventoryMarkdown(committed));
  });

  it("generates the search index entries, and settingsSearch carries them", () => {
    const generated = searchEntriesFromSchema();
    expect(generated.length).toBeGreaterThan(40);
    const search = SETTINGS_SEARCH;
    for (const e of generated) {
      const found = search.find((s) => s.label === e.label && s.tab === e.tab);
      expect(found, `search entry for "${e.label}"`).toBeTruthy();
    }
    // The search keeps the old words: every old label's words find their setting.
    for (const words of [["theme"], ["tray"], ["keepalive"], ["kv"], ["draft tokens"], ["auto send"]]) {
      expect(searchSettings(words[0]).length, `search by old word "${words[0]}"`).toBeGreaterThan(0);
    }
  });
});
