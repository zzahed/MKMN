#requires -Version 5.1
# Copies a Node.js runtime AND the sidecar's complete runtime dependency closure next to
# the sidecar so the installed Tauri app can run it without requiring Node (or any npm
# package) on the user's machine. Run before `makensis installer.nsi`.
#
# The sidecar is compiled with tsc, NOT bundled: dist\sidecar\main.js requires("acorn"),
# and dist\core\page\*.js require("react") / "react-dom/server". The installer copies
# dist\core + dist\shared as plain files, so this closure MUST travel with them or the
# installed sidecar dies on startup with MODULE_NOT_FOUND (losing chat, setup, model
# installs and tasks).
#
# The closure is resolved by Node itself (require.resolve from the real package
# locations), so it works under pnpm's nested .pnpm layout, npm's flat layout, and
# follows future dependency changes without this script needing a hardcoded list.
#
# Usage: .\scripts\Bundle-Sidecar.ps1 [-NodeExe "C:\Program Files\nodejs\node.exe"]
param(
  [string]$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $NodeExe -or -not (Test-Path $NodeExe)) { throw "Node.js was not found. Pass -NodeExe <path to node.exe>." }
if (-not (Test-Path "dist\sidecar\main.js")) { throw "The sidecar is not built: run `pnpm run build:sidecar` first." }

# The installed app is ARM64-only: a bundled x64 node.exe would fail to load the ARM64
# speech modules and would run the sidecar under emulation at best. Fail loudly here.
$nodeArch = (& $NodeExe -p "process.arch").Trim()
if ($nodeArch -ne "arm64") { throw "The given Node.js is '$nodeArch', but MKMN ships an ARM64 runtime. Pass an arm64 node.exe." }

# Generated code runs under Node's permission model, which blocks network access only from
# Node 25 on; the project requires Node 26 (package.json "engines"). Never ship an older one.
$nodeMajor = [int](& $NodeExe -p "process.versions.node.split('.')[0]").Trim()
if ($nodeMajor -lt 26) { throw "The given Node.js is version $nodeMajor, but MKMN ships Node.js 26 or later. Pass a newer node.exe." }

New-Item -ItemType Directory -Force -Path "dist\sidecar-runtime" | Out-Null
Copy-Item $NodeExe "dist\sidecar-runtime\node.exe" -Force

# Stage the transitive runtime dependency closure of the compiled sidecar.
# (Kept in a .cjs file: PowerShell 5.1 strips embedded quotes from -e arguments.)
$closureScript = Join-Path $PSScriptRoot "stage-sidecar-closure.cjs"
$output = & $NodeExe $closureScript
if ($LASTEXITCODE -ne 0) {
  throw "Required runtime packages are missing from node_modules (run: pnpm install): $($output -join ' ')"
}
Write-Host "Bundled $NodeExe (arm64) as dist\sidecar-runtime\node.exe."
Write-Host "Staged runtime dependency closure into dist\sidecar-runtime\node_modules:"
Write-Host "  $($output -replace '^STAGED:', '')"
Write-Host "The installer copies both into the app's Runtime directory (node.exe and node_modules)."
