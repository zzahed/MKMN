// Generates from the ONE settings declaration (src/shared/settingsSchema.ts):
//   - src-tauri/src/settings_defaults.generated.rs — the defaults object the Rust
//     host serves when no file exists, and the validation table the read-time
//     value checks walk;
//   - docs/settings-inventory.md — every stored key, its default and its place.
// Nothing restates a default: change the schema, run this with --write, commit.
// `--check` (also pinned by tests/settings-schema.test.ts) fails when a generated
// file is stale.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_SCHEMA, SETTING_GROUPS } from "../src/shared/settingsSchema.ts";
import { schemaSearchEntries } from "../src/shared/settingsSchema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_OUT = join(ROOT, "src-tauri/src/settings_defaults.rs");
const DOCS_OUT = join(ROOT, "docs/settings-inventory.md");

/** The stored keys the Settings type can hold, parsed from src/shared/types.ts:
 *  top-level fields, the voice object expanded from VoiceSettings, and inline
 *  object types expanded to their leaves. The schema must cover every one. */
export function storedKeysFromTypes(text) {
  const iface = (name) => {
    const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(text);
    if (!m) throw new Error(`interface ${name} not found in types.ts`);
    return m[1];
  };
  // Object-typed fields whose leaves the schema declares individually.
  const expand = new Set(["speculativeDecoding", "dynamic", "turnBudget", "privacy"]);
  const stripRecords = (t) => {
    let prev;
    do { prev = t; t = t.replace(/Record<[^<>]*>/g, "R"); } while (t !== prev);
    return t;
  };
  const out = [];
  for (const m of iface("Settings").matchAll(/^ {2}(\w+)(\?)?: (.+);$/gm)) {
    const [, name, , type] = m;
    if (name === "voice") {
      for (const v of iface("VoiceSettings").matchAll(/^ {2}(\w+)(\?)?:/gm)) out.push(`voice.${v[1]}`);
      continue;
    }
    if (expand.has(name)) {
      const inline = /\{\s*(.+?)\s*\}/.exec(stripRecords(type));
      if (!inline) throw new Error(`expected an inline object type for ${name}`);
      for (const k of inline[1].matchAll(/(\w+)(\?)?:/g)) out.push(`${name}.${k[1]}`);
      continue;
    }
    out.push(name);
  }
  return out.sort();
}

/** The defaults as a nested object: dot keys nest, except where the parent path
 *  is itself a declared key — its default (often null) covers the whole object. */
function defaultsTree() {
  const declared = new Set(SETTINGS_SCHEMA.map((d) => d.key));
  const root = {};
  for (const d of SETTINGS_SCHEMA) {
    const parts = d.key.split(".");
    if (parts.length > 1 && declared.has(parts.slice(0, -1).join("."))) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (node[k] === null || typeof node[k] !== "object" || Array.isArray(node[k])) node[k] = {};
      node = node[k];
    }
    node[parts[parts.length - 1]] = structuredClone(d.default);
  }
  return root;
}

const rustStr = (v) => JSON.stringify(v);
// Rust integer literals do not fall back to f64 in every struct-literal position:
// every min/max is written as a decimal.
const rustF64 = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

function rustDeclRows() {
  return SETTINGS_SCHEMA.map((d) => {
    const values = d.values ? `&[${d.values.map(rustStr).join(", ")}]` : "&[]";
    const min = d.min === undefined ? "None" : `Some(${rustF64(d.min)})`;
    const max = d.max === undefined ? "None" : `Some(${rustF64(d.max)})`;
    return `    SchemaDecl { key: ${rustStr(d.key)}, kind: ${rustStr(d.type)}, values: ${values}, min: ${min}, max: ${max} },`;
  }).join("\n");
}

export function rustDefaultsText() {
  const tree = defaultsTree();
  const defaults = JSON.stringify(tree, null, 4).replace(/^/gm, "    ");
  return `// GENERATED from src/shared/settingsSchema.ts by scripts/generate-settings-schema.mjs.
// Do not edit by hand: change the schema, then run the generator with --write.
// The ONE defaults object the host serves when no settings file exists (the old
// hand-written json! block), and the validation table the read-time value checks
// walk: for every stored key its kind, allowed values and range.

use serde_json::Value;

pub struct SchemaDecl {
    pub key: &'static str,
    /// "boolean" | "string" | "number" | "enum" | "model-ref" | "string-list" | "object"
    pub kind: &'static str,
    /// The allowed values of an enum; empty otherwise.
    pub values: &'static [&'static str],
    pub min: Option<f64>,
    pub max: Option<f64>,
}

pub static SCHEMA_DECLS: &[SchemaDecl] = &[
${rustDeclRows()}
];

/// The schema's default for one stored key (a dot path), or None for an unknown key.
pub fn schema_default(key: &str) -> Option<Value> {
    let mut node = schema_defaults();
    for part in key.split('.') {
        node = node.get(part)?.clone();
    }
    Some(node)
}

static DEFAULTS_JSON: &str = r#"
${defaults}
"#;

/// The defaults object, built from the schema (was a hand-written json! block in
/// read_settings_file_at). A key the person stored is never replaced by these:
/// they serve only when the file is missing entirely.
pub fn schema_defaults() -> Value {
    serde_json::from_str(DEFAULTS_JSON).expect("the generated settings defaults are valid JSON")
}
`;
}

const jsonCell = (v) => (v === undefined ? "" : JSON.stringify(v));
const allowedCell = (d) => {
  if (d.values) return d.values.map((v) => `\`${v}\``).join(" · ");
  if (d.min !== undefined || d.max !== undefined) return `${d.min ?? "-∞"} – ${d.max ?? "∞"}`;
  if (d.type === "model-ref") return "a model id, or empty";
  return "";
};

function inventoryRows() {
  const groupOrder = SETTING_GROUPS.map((g) => g.id);
  const sorted = [...SETTINGS_SCHEMA].sort(
    (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.key.localeCompare(b.key),
  );
  return sorted.map((d) => {
    const control = d.hidden ? `hidden — ${d.hidden}` : `yes — ${d.legacy?.tab ?? "?"}${d.legacy?.section ? ` (${d.legacy.section})` : ""}`;
    return `| \`${d.key}\` | ${d.type} | ${`\`${jsonCell(d.default)}\``} | ${allowedCell(d)} | ${d.scope} | ${d.level} | ${d.group} | ${d.label} | ${d.applies} | ${control} |`;
  });
}

export function inventoryMarkdown(existing = null) {
  const groups = SETTING_GROUPS.map((g) => {
    const keys = SETTINGS_SCHEMA.filter((d) => d.group === g.id);
    const everyday = keys.filter((d) => d.level === "everyday").length;
    return `| ${g.label} | ${keys.length} | ${everyday} |`;
  });
  const findings = (() => {
    if (!existing) return "_(none recorded)_";
    const m = /<!-- FINDINGS:START -->\n([\s\S]*?)<!-- FINDINGS:END -->/.exec(existing);
    return m ? m[1].trimEnd() : "_(none recorded)_";
  })();
  return `# Settings inventory

Generated from \`src/shared/settingsSchema.ts\` — the ONE declaration of every
stored key. Regenerate with \`node scripts/generate-settings-schema.mjs --write\`;
\`--check\` fails when this file is stale (pinned by \`tests/settings-schema.test.ts\`).

${SETTINGS_SCHEMA.length} stored keys, ${SETTING_GROUPS.length} groups. A key with **hidden** in its
last column has no control of its own, for the reason recorded there; the schema
still declares its default, so nothing restates one.

## Groups

| Group | Keys | Everyday |
| --- | --- | --- |
${groups.join("\n")}

## Every stored key

| Key | Type | Default | Allowed | Scope | Level | Group | Label | Applies | Control |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${inventoryRows().join("\n")}

## Findings

<!-- FINDINGS:START -->
${findings}
<!-- FINDINGS:END -->
`;
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const previous = (() => {
    try { return readFileSync(file, "utf8"); } catch { return null; }
  })();
  if (previous === content) return false;
  writeFileSync(file, content, "utf8");
  return true;
}

function main() {
  const check = process.argv.includes("--check");
  const existing = (() => {
    // read with its line endings normalized: a Windows checkout holds CRLF
    try { return readFileSync(DOCS_OUT, "utf8").replace(/\r\n/g, "\n"); } catch { return null; }
  })();
  const files = [
    [RUST_OUT, rustDefaultsText()],
    [DOCS_OUT, inventoryMarkdown(existing)],
  ];
  if (check) {
    const stale = files.filter(([file, content]) => {
      try { return readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== content; } catch { return true; }
    });
    if (stale.length) {
      for (const [file] of stale) console.error(`out of date: ${relative(ROOT, file)}`);
      console.error("run: node scripts/generate-settings-schema.mjs --write");
      process.exit(1);
    }
    console.log(`settings schema is up to date (${SETTINGS_SCHEMA.length} keys)`);
    return;
  }
  const changed = files.filter(([file, content]) => write(file, content)).map(([file]) => relative(ROOT, file));
  console.log(changed.length ? `wrote ${changed.join(", ")}` : "settings schema outputs are already up to date");
}

export { schemaSearchEntries as searchEntriesFromSchema };

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) main();
