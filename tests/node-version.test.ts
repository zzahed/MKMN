import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

const read = (p: string) => readFileSync(p, "utf8");
const manifest = JSON.parse(read("package.json"));

describe("one Node.js version everywhere", () => {
  it("the version file, package engine and README agree on the security floor", () => {
    const version = read(".node-version").trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.engines?.node).toBe(">=" + version);
    expect(read("README.md")).toContain("Node.js " + version);
  });

  it("all setup-node steps in CI and release use the version file", () => {
    const dir = ".github/workflows";
    const workflows = readdirSync(dir).filter((f) => f.endsWith(".yml")).map((f) => read(path.join(dir, f)));
    const steps = workflows.join("\n");
    const actions = [...steps.matchAll(/uses:\s*actions\/setup-node@/g)];
    expect(actions.length).toBeGreaterThan(0);
    expect([...steps.matchAll(/node-version-file:\s*\.node-version(?=[\s,}])/g)]).toHaveLength(actions.length);
    expect(steps).not.toMatch(/node-version:\s*/);
  });

  it.each(["Build-Windows", "Bundle-Sidecar"])("the %s script checks the full Node version", (name) => {
    const script = read("scripts/" + name + ".ps1");
    expect(script).toContain(".node-version");
    expect(script).toMatch(/process\.versions\.node[\x22]/);
    expect(script).toMatch(/\$nodeVersion -lt \$minimumNodeVersion/);
  });

  it("the Windows build and README follow the exact pnpm pin", () => {
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(read("README.md")).toContain("pnpm " + manifest.packageManager.slice(5));
    const script = read("scripts/Build-Windows.ps1");
    expect(script).toContain(".packageManager");
    expect(script).toMatch(/\$pnpmVersion -ne \$requiredPnpmVersion/);
  });
});
