/* Collect license texts from the actual installed dependency graph. No network. */
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const visited = new Set();
const packages = new Map();
function visit(dir) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return; }
  if (visited.has(real)) return;
  visited.add(real);
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8")); } catch { return; }
  const texts = fs.readdirSync(real).filter((f) => /^(licen[sc]e|copying|notice)([._-]|$)/i.test(f))
    .filter((f) => fs.statSync(path.join(real, f)).isFile())
    .map((f) => `${f}\n${fs.readFileSync(path.join(real, f), "utf8")}`);
  packages.set(`${p.name}@${p.version}`, [
    `${p.name}@${p.version}`, `License: ${JSON.stringify(p.license ?? "SEE PACKAGE")}`,
    typeof p.repository === "string" ? p.repository : p.repository?.url ?? "",
    ...texts.length ? texts : ["No license text found at package root; review the package before distribution."]
  ].join("\n"));
  for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) {
    let cursor = real;
    while (true) {
      const candidate = path.join(cursor, "node_modules", dep);
      if (fs.existsSync(path.join(candidate, "package.json"))) { visit(candidate); break; }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies })) {
  visit(path.join(root, "node_modules", dep));
}
fs.writeFileSync(path.join(root, "THIRD_PARTY_LICENSES.txt"),
  "MKMN dependency notices — generated from the installed graph.\n" +
  "Includes development/build dependencies. This is not a legal compliance certification.\n\n" +
  [...packages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => t).join("\n\n" + "=".repeat(72) + "\n\n"));
console.info(`Collected notices for ${packages.size} packages.`);
