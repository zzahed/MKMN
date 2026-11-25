// The source-side inventory behind docs/MKMN_FEATURE_TEST_MATRIX_0.0.3-rc.3.md.
// A feature is not "tested" because this file says so: every name below must
// appear in the matrix, so a new command, method, setting, screen or script
// cannot ship without a row that says how it was checked.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_SCHEMA } from "../src/shared/settingsSchema.ts";

const read = (root, path) => readFileSync(join(root, path), "utf8");
const unique = (values) => [...new Set(values)];

/** The commands registered by the Rust host in `generate_handler!`. */
export function tauriCommands(root = process.cwd()) {
  const text = read(root, "src-tauri/src/lib.rs");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
  return unique([...block.matchAll(/commands::([a-z0-9_]+)/g)].map((m) => m[1]));
}

/** Every .ts file under `dir` (relative to `root`), sub-folders included, in a stable order. */
const sourcesUnder = (root, dir) =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? sourcesUnder(root, `${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));

/** The methods the Node sidecar answers on its dispatcher: main.ts, humain.ts and the area
 *  files under src/sidecar/register register them. Sorted by name, so a method moved from
 *  one file to another keeps its row in the matrix. */
export function sidecarMethods(root = process.cwd()) {
  const text = sourcesUnder(root, "src/sidecar").map((f) => read(root, f)).join("\n");
  return unique([...text.matchAll(/dispatcher\.register\("([^"]+)"/g)].map((m) => m[1])).sort();
}

/** The Settings categories (primary and advanced). */
export function settingsTabs(root = process.cwd()) {
  const text = read(root, "src/renderer/settingsSearch.ts");
  return unique([...text.matchAll(/^\s*\{ id: "([^"]+)", label:/gm)].map((m) => m[1]));
}

/** Every section a Settings category can scroll to. */
export function settingsSections(root = process.cwd()) {
  const text = read(root, "src/renderer/SettingsView.tsx") + "\n" + read(root, "src/renderer/HumainSettings.tsx");
  return unique([...text.matchAll(/(?:<section id|section)="(sec-[^"]+)"/g)].map((m) => m[1]));
}

/** Every row the Settings search knows, so a row cannot exist unlisted: the
 *  schema's labels (generated) plus the literal rows in settingsSearch.ts. */
export function settingsRows(root = process.cwd()) {
  const text = read(root, "src/renderer/settingsSearch.ts");
  const literal = [...text.matchAll(/\{ label: "([^"]+)"/g)].map((m) => m[1]);
  const fromSchema = SETTINGS_SCHEMA.filter((d) => "legacy" in d && d.legacy).map((d) => d.label);
  return unique([...fromSchema, ...literal]);
}

/** The switches in the chat's Smart functions menu. */
export function smartRows(root = process.cwd()) {
  const text = read(root, "src/renderer/ToolsMenu.tsx");
  const names = [...text.matchAll(/\blabel="([^"]+)"/g)].map((m) => m[1]);
  if (text.includes(">Thinking<")) names.push("Thinking");
  return unique(names);
}

/** The five main views and the four overlays the window can show. */
export function screens(root = process.cwd()) {
  const text = read(root, "src/renderer/App.tsx");
  const tabs = /export type Tab = ([^;]+);/.exec(text)?.[1] ?? "";
  const names = [...tabs.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return unique([...names, "Settings", "Models", "Search", "Setup screen"]);
}

/** Tracked scripts, including the shared library files. */
export function scripts(root = process.cwd()) {
  const out = execFileSync("git", ["ls-files", "scripts"], { cwd: root, encoding: "utf8" });
  return unique(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

export function featureInventory(root = process.cwd()) {
  return {
    tauri: tauriCommands(root),
    sidecar: sidecarMethods(root),
    tabs: settingsTabs(root),
    sections: settingsSections(root),
    rows: settingsRows(root),
    smart: smartRows(root),
    screens: screens(root),
    scripts: scripts(root)
  };
}

/** Names the matrix does not list, or lists without its backticks. */
export function missingFromMatrix(matrix, inventory = featureInventory()) {
  const flat = matrix.replace(/\\\|/g, "|");
  const missing = [];
  for (const [kind, names] of Object.entries(inventory)) {
    for (const name of names) {
      const shown = flat.includes(`\`${name}\``);
      if (!shown) missing.push(`${kind}: ${name}`);
    }
  }
  return missing;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const inv = featureInventory();
  for (const [kind, names] of Object.entries(inv)) console.log(`${kind}: ${names.length}`);
}
