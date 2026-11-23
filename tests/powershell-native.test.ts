import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itWindows } from "./helpers/platform";

/**
 * A build is judged by the real exit code of each native command, never by text on its
 * stderr (a successful build was failed by a linker warning). Windows
 * PowerShell 5.1 turns a native command's stderr into error records when the stream is
 * redirected, and `$ErrorActionPreference = "Stop"` then throws even though the process
 * exited 0. The stand-in below reproduces exactly that: it prints LNK4099 to stderr and
 * exits 0. The helper must keep the warning in a log, return Ok, and write a result file;
 * a nonzero exit must still fail.
 */

const ROOT = process.cwd();
const PS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const HELPER = join(ROOT, "scripts", "lib", "NativeCommand.ps1");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function powershell(script: string): string {
  return execFileSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout: 60000,
  });
}

function standIn(dir: string, name: string, exit: number): string {
  const file = join(dir, name);
  writeFileSync(file, `@echo off\r\necho LNK4099: PDB file not found; linking continues 1>&2\r\nexit /b ${exit}\r\n`);
  return file;
}

describe("native commands are judged by their exit code", () => {
  itWindows("a warning on stderr from a successful command does not fail the build", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkmn-native-ok-"));
    const exe = standIn(dir, "warn-ok.cmd", 0);
    const log = join(dir, "ok.log");
    const out = powershell(`
      $ErrorActionPreference = 'Stop'
      . '${HELPER}'
      $r = Invoke-NativeCommand -FilePath '${exe}' -LogPath '${log}'
      if (-not $r.Ok) { exit 20 }
      if ($r.ExitCode -ne 0) { exit 21 }
      if ($ErrorActionPreference -ne 'Stop') { exit 22 }
      if (-not (Test-Path -LiteralPath $r.ResultPath)) { exit 23 }
      $r | ConvertTo-Json -Compress
    `);
    const r = JSON.parse(out.trim());
    expect(r).toMatchObject({ Ok: true, ExitCode: 0 });
    expect(readFileSync(log, "utf8")).toMatch(/LNK4099/);
    const result = JSON.parse(readFileSync(r.ResultPath, "utf8"));
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
  });

  itWindows("a real nonzero exit still fails, and the result file says the real code", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkmn-native-fail-"));
    const exe = standIn(dir, "warn-fail.cmd", 7);
    const log = join(dir, "fail.log");
    let status = 0;
    try {
      powershell(`
        $ErrorActionPreference = 'Stop'
        . '${HELPER}'
        $r = Invoke-NativeCommand -FilePath '${exe}' -LogPath '${log}'
        if ($r.Ok) { exit 30 }
        exit $r.ExitCode
      `);
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
    }
    expect(status).toBe(7);
    const result = JSON.parse(readFileSync(`${log}.result.json`, "utf8"));
    expect(result).toMatchObject({ ok: false, exitCode: 7 });
  });

  it("the build script sends every native command through the helper", () => {
    const build = read("scripts/Build-Windows.ps1");
    expect(build).toMatch(/NativeCommand\.ps1/);
    expect(build).toMatch(/Invoke-NativeCommand/);
    // A stray $LASTEXITCODE check is the bug: the helper owns the real exit code now.
    expect(build).not.toContain("$LASTEXITCODE");
    // No raw call operator for an external program may remain in the build script.
    expect(build).not.toMatch(/^\s*&\s+(node|pnpm|cargo|powershell|rustup)/m);
  });

  it("the build ends with an explicit exit code and one overall result", () => {
    const build = read("scripts/Build-Windows.ps1");
    // One file summarizes the run even when a later step fails.
    expect(build).toMatch(/build\.result\.json/);
    expect(build).toMatch(/Write-BuildResult/);
    // A caught failure still writes the summary, then leaves with a real code.
    expect(build).toMatch(/finally\s*\{/);
    expect(build).toMatch(/^\s*exit 0\s*$/m);
    expect(build).toMatch(/^\s*exit 1\s*$/m);
  });

  it("the build passes its accumulated step list without wrapping it again", () => {
    const build = read("scripts/Build-Windows.ps1");
    // Windows PowerShell 5.1 throws "Argument types do not match" when a generic
    // List is wrapped in @(...) in an argument position. The list already holds
    // every step, so it is passed as it is.
    expect(build).toMatch(/-Steps \$script:steps\b/);
    expect(build).not.toMatch(/-Steps @\(\$script:steps\)/);
  });

  itWindows("the overall build result is UTF-8 JSON without a BOM and carries every step", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkmn-build-result-"));
    const out = join(dir, "build.result.json");
    powershell(`
      . '${join(ROOT, "scripts", "lib", "BuildResult.ps1")}'
      $doc = New-BuildResultDocument -Ok $true -Version '9.9.9' -StartedAt ([datetime]'2026-01-01T00:00:00Z') -Steps @(
        [pscustomobject]@{ name = 'typecheck'; ok = $true; exitCode = 0; logPath = 'a.log'; resultPath = 'a.log.result.json' },
        [pscustomobject]@{ name = 'cargo-test'; ok = $true; exitCode = 0; logPath = 'b.log'; resultPath = 'b.log.result.json' }
      )
      Write-BuildResult -Path '${out}' -Document $doc
    `);
    const bytes = readFileSync(out);
    expect(bytes[0]).not.toBe(0xef);
    const doc = JSON.parse(bytes.toString("utf8"));
    expect(doc).toMatchObject({ ok: true, exitCode: 0, version: "9.9.9" });
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[1]).toMatchObject({ name: "cargo-test", ok: true, exitCode: 0 });
  });

  itWindows("a failed build result says so with a nonzero code", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkmn-build-result-fail-"));
    const out = join(dir, "build.result.json");
    powershell(`
      . '${join(ROOT, "scripts", "lib", "BuildResult.ps1")}'
      $doc = New-BuildResultDocument -Ok $false -Version '9.9.9' -StartedAt ([datetime]'2026-01-01T00:00:00Z') -Failure 'pnpm-typecheck failed with exit code 2.'
      Write-BuildResult -Path '${out}' -Document $doc
    `);
    const doc = JSON.parse(readFileSync(out, "utf8"));
    expect(doc).toMatchObject({ ok: false, exitCode: 1, failure: "pnpm-typecheck failed with exit code 2." });
    expect(doc.steps).toEqual([]);
  });
});
