// The installer must carry every package the sidecar, the core modules and the voice worker load at run time:
// the compiled code is not bundled, so a package missing from the staged closure fails only on the installed app.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import ts from "typescript";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Every package a runtime file of these folders imports (type-only imports leave nothing in the compiled code). */
function runtimePackages(dirs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (d: string) => {
    for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, f.name);
      if (f.isDirectory()) { walk(rel); continue; }
      if (!/\.tsx?$/.test(f.name) || f.name.endsWith(".d.ts")) continue;
      const src = read(rel);
      const file = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
      const names: string[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) names.push(n.moduleSpecifier.text);
        else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) names.push(n.moduleSpecifier.text);
        else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])
          && ((ts.isIdentifier(n.expression) && n.expression.text === "require") || n.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isPropertyAccessExpression(n.expression) && n.expression.getText() === "require.resolve"))) names.push(n.arguments[0].text);
        ts.forEachChild(n, visit);
      };
      visit(file);
      // a module name built from a template so the bundler leaves it alone (`${"onnxruntime-node"}`) is still a load
      for (const m of src.matchAll(/\$\{"([a-z@][\w@/.-]*)"\}/g)) names.push(m[1]);
      for (const n of names) {
        if (n.startsWith(".") || n.startsWith("node:") || builtinModules.includes(n.split("/")[0])) continue;
        const pkg = n.startsWith("@") ? n.split("/").slice(0, 2).join("/") : n.split("/")[0];
        out.set(pkg, [...(out.get(pkg) ?? []), rel]);
      }
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

describe("the packaged sidecar's dependencies", () => {
  it("stages every package the sidecar and core modules load, and the installer ships the voice runtime", () => {
    const roots = JSON.parse(read("scripts/stage-sidecar-closure.cjs").match(/const queue = (\[[^\]]*\]);/)![1]) as string[];
    const nsi = read("installer.nsi");
    const sidecar = runtimePackages(["src/sidecar", "src/core", "src/shared"]);
    // a package the installer writes to $INSTDIR\node_modules is found by Node walking up from Runtime\sidecar
    const shipped = (p: string) => roots.includes(p) || nsi.includes(`File /r "node_modules\\${p}\\*.*"`);
    const missing = [...sidecar.keys()].filter((p) => !shipped(p)).map((p) => `${p} (${sidecar.get(p)!.join(", ")})`);
    expect(missing, "add these to the closure roots in scripts/stage-sidecar-closure.cjs").toEqual([]);
    // the voice worker resolves its package from the installed node_modules the installer writes directly
    for (const p of runtimePackages(["src/voice"]).keys()) expect(nsi).toContain(`File /r "node_modules\\${p}\\*.*"`);
  });

  it("removes dependencies left by an older bundle when restaging", () => {
    const scratch = fs.mkdtempSync(path.join(tmpdir(), "mkmn-sidecar-closure-"));
    try {
      for (const name of ["acorn", "react", "react-dom", "ws", "onnxruntime-node"]) {
        const dir = path.join(scratch, "node_modules", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
      }
      const ort = path.join(scratch, "node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "arm64");
      fs.mkdirSync(ort, { recursive: true });
      fs.writeFileSync(path.join(ort, "onnxruntime_binding.node"), "");
      const staged = path.join(scratch, "dist", "sidecar-runtime", "node_modules");
      fs.mkdirSync(path.join(staged, "@old", "dependency"), { recursive: true });

      execFileSync(process.execPath, [path.join(ROOT, "scripts", "stage-sidecar-closure.cjs")], { cwd: scratch });
      expect(fs.readdirSync(staged).sort()).toEqual(["acorn", "onnxruntime-node", "react", "react-dom", "ws"]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("finds the runtime loads it must see (a dynamic import, a template-built name)", () => {
    const found = runtimePackages(["src/core/knowledge", "src/sidecar"]);
    expect(found.has("onnxruntime-node")).toBe(true);
    expect(found.has("ws")).toBe(true);
  });
});
