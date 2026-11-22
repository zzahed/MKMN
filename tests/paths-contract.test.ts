import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itWindows } from "./helpers/platform";

/**
 * One directory layout, read by everything (seen on an installed build): the Rust host keeps settings,
 * hardware and custom models in %LOCALAPPDATA%\MKMN\Config, while the sidecar wrote its own
 * custom-models.json to %APPDATA%\MKMN. The real file on the reporting machine was in
 * %APPDATA%\MKMN, so the host never saw it. Paths come from the real filesystem and the
 * registry (never a guessed default), and old files are copied, never moved or deleted.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const PS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

describe("the directory layout is one resolver", () => {
  it("mkmnPaths derives local data, config, workspace and the legacy roaming folder", async () => {
    const { mkmnPaths } = await import("../src/shared/paths");
    const local = "C:\\Users\\u\\AppData\\Local";
    const roaming = "C:\\Users\\u\\AppData\\Roaming";
    const p = mkmnPaths({ LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: "C:\\Users\\u" });
    expect(p.dataDir).toBe(join(local, "MKMN"));
    expect(p.configDir).toBe(join(local, "MKMN", "Config"));
    expect(p.settingsFile).toBe(join(local, "MKMN", "Config", "settings.json"));
    expect(p.hardwareFile).toBe(join(local, "MKMN", "Config", "hardware.json"));
    expect(p.customModelsFile).toBe(join(local, "MKMN", "Config", "custom-models.json"));
    expect(p.workspaceDir).toBe(join(local, "MKMN", "Workspace"));
    expect(p.logsDir).toBe(join(local, "MKMN", "Logs"));
    expect(p.legacyDataDir).toBe(join(roaming, "MKMN"));
    expect(p.sources.dataDir).toBe("LOCALAPPDATA");
    expect(p.sources.legacyDataDir).toBe("APPDATA");
  });

  it("falls back to the user profile only when LOCALAPPDATA is absent, and says so", async () => {
    const { mkmnPaths } = await import("../src/shared/paths");
    const p = mkmnPaths({ USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming" });
    expect(p.dataDir).toBe(join("C:\\Users\\u", "AppData", "Local", "MKMN"));
    expect(p.sources.dataDir).toBe("USERPROFILE");
  });

  it("the voice models live under the data dir, and the voice smoke puts them there", () => {
    const main = read("src/sidecar/main.ts");
    // the voice models folder is under the data dir (<dataDir>\Workspace\voice-models), so the
    // MKMN_DATA_DIR test override moves it with everything else; the smoke writes the same path
    expect(main).toMatch(/new VoiceService\(\s*path\.join\(dataDir\(\), "Workspace", "voice-models"\)/);
    const smoke = read("scripts/smoke-sidecar-voice.js");
    expect(smoke).toMatch(/path\.join\(tmp, "data", "Workspace", "voice-models"/);
  });

  it("the sidecar reads and writes the host's config files, never a second roaming copy", () => {
    const main = read("src/sidecar/main.ts");
    expect(main).toContain("mkmnPaths");
    expect(main).not.toMatch(/const dataDir = \(\) => process\.env\.MKMN_DATA_DIR \?\? path\.join\(process\.env\.APPDATA/);
    expect(main).toMatch(/customModelsFile[\s\S]{0,200}(configDir|mkmnPaths)/);
    expect(main).toMatch(/hardware\.json[\s\S]{0,200}(configDir|mkmnPaths)/);
  });

  it("the host copies a legacy roaming custom-models.json into Config and keeps the source", () => {
    const paths = read("src-tauri/src/paths.rs");
    expect(paths).toMatch(/APPDATA[\s\S]{0,1200}custom-models\.json/);
    expect(paths).toMatch(/copy/i);
    expect(paths).not.toMatch(/remove_(file|dir_all)\([^)]*(APPDATA|legacy)/i);
  });
});

describe("the scripts resolve paths instead of guessing them", () => {
  itWindows("Resolve-MkmnPaths.ps1 returns the real layout as JSON", () => {
    const local = mkdtempSync(join(tmpdir(), "mkmn-local-"));
    const roaming = mkdtempSync(join(tmpdir(), "mkmn-roaming-"));
    const install = mkdtempSync(join(tmpdir(), "mkmn-install-"));
    writeFileSync(join(install, "MKMN.exe"), "");
    const out = execFileSync(PS, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(ROOT, "scripts", "Resolve-MkmnPaths.ps1"),
      "-InstallDir", install, "-Json"
    ], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: local, APPDATA: roaming },
      timeout: 30000
    });
    const r = JSON.parse(out.replace(/^\uFEFF/, "").trim());
    expect(r.installDir.toLowerCase()).toBe(install.toLowerCase());
    expect(r.installSource).toBe("parameter");
    expect(r.exe.toLowerCase()).toBe(join(install, "MKMN.exe").toLowerCase());
    expect(r.dataDir.toLowerCase()).toBe(join(local, "MKMN").toLowerCase());
    expect(r.configDir.toLowerCase()).toBe(join(local, "MKMN", "Config").toLowerCase());
    expect(r.settingsFile.toLowerCase()).toBe(join(local, "MKMN", "Config", "settings.json").toLowerCase());
    expect(r.workspaceDir.toLowerCase()).toBe(join(local, "MKMN", "Workspace").toLowerCase());
    expect(r.logsDir.toLowerCase()).toBe(join(local, "MKMN", "Logs").toLowerCase());
    expect(r.legacyDataDir.toLowerCase()).toBe(join(roaming, "MKMN").toLowerCase());
  });

  itWindows("the resolver's JSON survives an in-script capture, not only a direct spawn", () => {
    // Live-Relaunch-Check.ps1 and Check-After-Close.ps1 call the resolver with
    // `& $resolver -Json | ConvertFrom-Json`. A direct console write bypasses that
    // pipeline, so the caller sees nothing and reports that the install is missing.
    const local = mkdtempSync(join(tmpdir(), "mkmn-local-"));
    const roaming = mkdtempSync(join(tmpdir(), "mkmn-roaming-"));
    const script = join(ROOT, "scripts", "Resolve-MkmnPaths.ps1").replace(/'/g, "''");
    const probe = [
      `$r = & '${script}' -Json`,
      "if (-not $r) { throw 'the resolver returned nothing to the pipeline' }",
      "$p = $r | ConvertFrom-Json",
      "[Console]::Out.WriteLine($p.dataDir)"
    ].join("; ");
    const out = execFileSync(PS, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe
    ], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: local, APPDATA: roaming },
      timeout: 30000
    });
    expect(out.trim().toLowerCase()).toBe(join(local, "MKMN").toLowerCase());
  });

  it("the live relaunch check calls the resolver; it no longer guesses Program Files", () => {
    const live = read("scripts/Live-Relaunch-Check.ps1");
    expect(live).toMatch(/Resolve-MkmnPaths\.ps1/);
    expect(live).not.toContain("Programs\\MKMN");
  });
});
