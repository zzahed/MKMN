import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(__dirname, "..", file), "utf8");

describe("native starts enter the sidecar's engine admission boundary", () => {
  it("routes model selection, preload, tray restart and the standalone benchmark through admission", () => {
    const commands = read("src-tauri/src/commands.rs");
    const tray = read("src-tauri/src/tray.rs");
    const sidecar = read("src/sidecar/main.ts");
    for (const method of ["startGeniexModel", "preloadGeniexModel", "benchmarkGeniexModel"]) {
      expect(commands).toContain(`sidecar.call("${method}"`);
      expect(sidecar).toContain(`"${method}"`);
    }
    expect(tray).toContain('host.call("restartGeniexModel"');
    expect(sidecar).toContain('return npuOwner.run("geniex", () => engineHostCall(method, args))');
    expect(read("src/renderer/tauriBridge.ts")).not.toContain('sidecarCall("releaseFoundry")');
  });

  it("uses the same gate for chat and Foundry loads", () => {
    const sidecar = read("src/sidecar/main.ts");
    expect(sidecar).toMatch(/npuOwner\.run\("geniex", async \(\) => \{[\s\S]{0,500}"startChatServer"/);
    expect(sidecar).toContain('npuOwner.run("foundry", () => f.load(');
    // the Developer settings' Foundry load (src/sidecar/register/foundry.ts) takes the same gate
    expect(read("src/sidecar/register/foundry.ts")).toContain('npuOwner.run("foundry", () => f.loadModel(');
  });
});
