// Stages the transitive runtime dependency closure of the compiled sidecar into
// dist\sidecar-runtime\node_modules. Invoked by scripts\Bundle-Sidecar.ps1 (kept as a
// separate .cjs file because PowerShell 5.1 mangles embedded quotes when passing -e
// scripts to node.exe).
//
// The closure is resolved by Node itself (require.resolve from the real package
// locations), so it works under pnpm's nested .pnpm layout, npm's flat layout, and
// follows future dependency changes without a hardcoded list.
"use strict";
const fs = require("fs");
const path = require("path");

const cwd = fs.realpathSync(process.cwd());
const output = path.join(cwd, "dist", "sidecar-runtime");
const dest = path.join(output, "node_modules");
// Roots: what the compiled sidecar/core modules require directly at runtime.
// onnxruntime-node: the multilingual search model's runtime (src/core/knowledge/embed.ts),
// loaded only when the person installed that model.
const queue = ["acorn", "react", "react-dom", "ws", "onnxruntime-node"];
// The installer is Windows ARM64 only: a package's binaries for other platforms are not shipped.
const ortBinaryRoot = path.join("bin", "napi-v6");
const KEEP_BINARIES = { "onnxruntime-node": path.join(ortBinaryRoot, "win32", "arm64") };
const seen = new Set();
const depParents = []; // real parent dirs of copied packages: where their deps resolve
const failures = [];

// Clear old bundles so packages removed from the lockfile cannot get into an installer.
fs.mkdirSync(output, { recursive: true });
if (fs.realpathSync(output) !== output) throw new Error("The sidecar output directory must be inside this checkout");
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest);

while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  let resolved = null;
  for (const from of [cwd, ...depParents]) {
    try {
      const p = require.resolve(name + "/package.json", { paths: [from] });
      resolved = p;
      break;
    } catch {
      /* a package whose "exports" hide package.json: resolve its entry and walk up to its folder */
    }
    try {
      let dir = path.dirname(require.resolve(name, { paths: [from] }));
      while (dir !== path.dirname(dir)) {
        const pj = path.join(dir, "package.json");
        if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, "utf8")).name === name) { resolved = pj; break; }
        dir = path.dirname(dir);
      }
      if (resolved) break;
    } catch {
      /* try the next search root */
    }
  }
  if (!resolved) {
    failures.push(name);
    continue;
  }
  // The real location (pnpm uses junctions into .pnpm): copy the package's real
  // directory, and the real sibling node_modules is where THIS package's own
  // dependencies resolve from.
  const real = fs.realpathSync(path.dirname(resolved));
  const realParent = path.dirname(real);
  const target = path.join(dest, name);
  fs.cpSync(real, target, { recursive: true });
  if (KEEP_BINARIES[name]) {
    const keep = path.join(target, KEEP_BINARIES[name]);
    if (!fs.existsSync(keep)) { failures.push(`${name} (no ${KEEP_BINARIES[name]})`); continue; }
    const root = path.join(target, ortBinaryRoot);
    for (const os of fs.readdirSync(root)) {
      for (const arch of fs.readdirSync(path.join(root, os))) {
        const dir = path.join(root, os, arch);
        if (path.relative(target, dir) !== KEEP_BINARIES[name]) fs.rmSync(dir, { recursive: true, force: true });
      }
      if (!fs.readdirSync(path.join(root, os)).length) fs.rmSync(path.join(root, os), { recursive: true, force: true });
    }
  }
  depParents.push(realParent);
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8"));
    for (const dep of Object.keys(pj.dependencies || {})) queue.push(dep);
  } catch {
    /* a package without a readable package.json was still copied */
  }
}

if (failures.length) {
  console.error("MISSING:" + failures.join(","));
  process.exit(1);
}
console.log("STAGED:" + [...seen].join(","));
