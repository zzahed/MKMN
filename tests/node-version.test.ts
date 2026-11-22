// The project requires Node.js 26 (package.json "engines"). The version matters beyond pdf.js:
// generated code runs under Node's permission model, and only from Node 25 on does that model
// block network access. CI on Node 24 let a locked-down process open a connection. So CI, the
// release build and the runtime bundled into the installer must all use the same major version.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

const REQUIRED = 26;
const read = (p: string) => readFileSync(p, "utf8");

describe("one Node.js version everywhere", () => {
  it("package.json engines names the required major", () => {
    expect(JSON.parse(read("package.json")).engines?.node).toBe(`>=${REQUIRED}`);
  });

  it("every workflow sets up that major", () => {
    const dir = ".github/workflows";
    const versions = readdirSync(dir).filter((f) => f.endsWith(".yml"))
      .flatMap((f) => [...read(path.join(dir, f)).matchAll(/node-version:\s*([^\s,}]+)/g)].map((m) => `${f}: ${m[1]}`));
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v).toMatch(new RegExp(`: ${REQUIRED}$`));
  });

  it("the Windows build refuses an older Node", () => {
    const src = read("scripts/Build-Windows.ps1");
    expect(src).toMatch(new RegExp(`\\$nodeMajor -lt ${REQUIRED}\\b`));
    expect(src).not.toMatch(/Node\.js 24/);
  });

  it("the runtime bundled into the installer is checked for that major", () => {
    const src = read("scripts/Bundle-Sidecar.ps1");
    expect(src).toMatch(/process\.versions\.node/);
    expect(src).toMatch(new RegExp(`-lt ${REQUIRED}\\b`));
  });
});
