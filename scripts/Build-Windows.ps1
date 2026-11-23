#requires -Version 5.1
<#
.SYNOPSIS
  Builds the MKMN Windows ARM64 installer.

.DESCRIPTION
  The Tauri v2 build — TypeScript (renderer/sidecar), the Rust host,
  the bundled Node runtime, and the NSIS installer (dist\MKMN-<version>-arm64-Setup.exe).

  Every native command runs through scripts\lib\NativeCommand.ps1, which judges it by
  its real exit code. PowerShell 5.1 turns a native command's stderr into error records
  when the stream is redirected; with $ErrorActionPreference = "Stop" a harmless linker
  warning (LNK4099) then threw after a successful build. Nothing here reads stderr text:
  the helper owns the real exit code.

  The whole run is summarized once in dist\build-logs\build.result.json: ok/exitCode,
  the version, the failure message and every command with its own log and result file.
  The summary is written on success and on failure, and the script always ends with an
  explicit exit code.
#>
[CmdletBinding()]
param(
  [switch]$SkipTests
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
. (Join-Path $PSScriptRoot "lib\NativeCommand.ps1")
. (Join-Path $PSScriptRoot "lib\BuildResult.ps1")

# Every run keeps one log per command, plus <log>.result.json, under dist\build-logs.
# build.result.json is the one summary of the whole run, written on success and failure.
$logDir = Join-Path $root "dist\build-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$buildResultPath = Join-Path $logDir "build.result.json"
$buildStartedAt = Get-Date
$script:version = "unknown"
$script:steps = New-Object System.Collections.Generic.List[object]
$script:step = 0
function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [switch]$Echo
  )
  $script:step++
  $safe = ($Name -replace '[^\w.-]', '-').ToLowerInvariant()
  $log = Join-Path $logDir ("{0:d2}-{1}.log" -f $script:step, $safe)
  $r = Invoke-NativeCommand -FilePath $FilePath -Arguments $Arguments -LogPath $log -WorkingDirectory (Get-Location).Path -Echo:$Echo
  $script:steps.Add([pscustomobject]@{
    name = $Name
    ok = $r.Ok
    exitCode = $r.ExitCode
    logPath = $r.LogPath
    resultPath = $r.ResultPath
  })
  if (-not $r.Ok) {
    throw "$Name failed with exit code $($r.ExitCode). See $($r.LogPath) and $($r.ResultPath)."
  }
  return $r
}
function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )
  return (Invoke-Checked -Name $Name -FilePath $FilePath -Arguments $Arguments).Output.Trim()
}

$buildOk = $false
$failureText = ""
$installerPath = ""
try {
  if ($env:OS -ne "Windows_NT") { throw "Use this script on Windows 11 ARM64." }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Install native Windows ARM64 Node.js 26 LTS first." }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw "Install pnpm 10.26.1 first, as documented in README.md." }
  $arch = Invoke-Captured -Name "node-arch" -FilePath "node" -Arguments @("-p", "process.arch")
  if ($arch -ne "arm64") { throw "Native ARM64 Node.js is required; found $arch. Do not build under x64 emulation." }
  $nodeMajor = [int](Invoke-Captured -Name "node-version" -FilePath "node" -Arguments @("-p", "process.versions.node.split('.')[0]"))
  if ($nodeMajor -lt 26) { throw "Use native ARM64 Node.js 26 LTS or later." }

  Invoke-Checked -Name "pnpm-install" -FilePath "pnpm" -Arguments @("--ignore-workspace", "install", "--frozen-lockfile") -Echo
  # pnpm's allowlist is limited to esbuild. Never enable all scripts.
  Invoke-Checked -Name "pnpm-rebuild-esbuild" -FilePath "pnpm" -Arguments @("rebuild", "esbuild") -Echo
  Invoke-Checked -Name "pnpm-typecheck" -FilePath "pnpm" -Arguments @("typecheck") -Echo
  if (-not $SkipTests) { Invoke-Checked -Name "pnpm-test" -FilePath "pnpm" -Arguments @("test") -Echo }
  Invoke-Checked -Name "pnpm-licenses" -FilePath "pnpm" -Arguments @("run", "licenses") -Echo

  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw "Install the Rust toolchain (rustup) first: https://rustup.rs" }
  if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) { throw "Install the Rust toolchain (rustup) first: https://rustup.rs" }
  $target = "aarch64-pc-windows-msvc"
  $installed = Invoke-Captured -Name "rustup-targets" -FilePath "rustup" -Arguments @("target", "list", "--installed")
  if ($installed -notmatch [regex]::Escape($target)) { throw "The Rust target $target is missing. Run: rustup target add $target" }
  # The renderer is plain vite output; the Rust host compiles it in via beforeBuildCommand.
  Invoke-Checked -Name "pnpm-build" -FilePath "pnpm" -Arguments @("run", "build") -Echo
  # The sidecar bundle Bundle-Sidecar.ps1 packages (not part of `build`: only the
  # sidecar packaging needs it).
  Invoke-Checked -Name "pnpm-build-sidecar" -FilePath "pnpm" -Arguments @("run", "build:sidecar") -Echo
  # A Node.exe next to the sidecar so the installed app does not need Node on the PATH.
  Invoke-Checked -Name "bundle-sidecar" -FilePath "powershell" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "Bundle-Sidecar.ps1")) -Echo
  Invoke-Checked -Name "cargo-build" -FilePath "cargo" -Arguments @("build", "--release", "--target", $target, "--manifest-path", (Join-Path $root "src-tauri\Cargo.toml")) -Echo
  # Host tests are a release gate: the port-conflict classification, the supervisor
  # lifecycle and the Win32 owner lookup are pinned here, and a regression must fail the
  # build rather than reach an installer. Runs in release so it reuses the build above.
  if (-not $SkipTests) {
    Invoke-Checked -Name "cargo-test" -FilePath "cargo" -Arguments @("test", "--release", "--target", $target, "--manifest-path", (Join-Path $root "src-tauri\Cargo.toml")) -Echo
  }
  $nsis = Get-Command makensis -ErrorAction SilentlyContinue
  $nsisSource = $null
  if ($nsis) {
    $nsisSource = $nsis.Source
  } else {
    $candidate = "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
    if (-not (Test-Path $candidate)) { throw "Install NSIS 3 first (makensis must be on the PATH or in Program Files (x86)\NSIS)." }
    $nsisSource = $candidate
  }
  # The installer is named from package.json. The version is edited by hand in four files
  # (package.json, src-tauri/Cargo.toml, the app's own entry in src-tauri/Cargo.lock,
  # src-tauri/tauri.conf.json); tests/version.test.ts fails when they differ.
  $version = Invoke-Captured -Name "package-version" -FilePath "node" -Arguments @("-p", "require('./package.json').version")
  $script:version = $version
  Invoke-Checked -Name "makensis" -FilePath $nsisSource -Arguments @("/DVERSION=$version", (Join-Path $root "installer.nsi")) -Echo
  # Packaging gate: the installer must contain THIS build's host, sidecar and runtime,
  # and every version declaration must agree. -Release unpacks the payload read-only and
  # checks every packaged file byte for byte. Nothing is installed or started.
  Invoke-Checked -Name "validate-installer" -FilePath "powershell" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "Validate-Installer.ps1"), "-Release") -Echo
  $installerPath = "dist\MKMN-$version-arm64-Setup.exe"
  Write-Host "Tauri build finished: $installerPath"
  Write-Host "This does not verify installation, offline inference, NPU execution or signing."
  Write-Host "Install and check the build on a Windows ARM64 PC before distributing it."
  $buildOk = $true
}
catch {
  $failureText = $_.Exception.Message
  Write-Host "Build failed: $failureText"
}
finally {
  $document = New-BuildResultDocument -Ok $buildOk -Version $script:version -StartedAt $buildStartedAt -Steps $script:steps -Failure $failureText -Installer $installerPath
  Write-BuildResult -Path $buildResultPath -Document $document
  Write-Host "Build result: $buildResultPath"
}
if (-not $buildOk) {
  exit 1
}
exit 0
