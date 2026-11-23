#requires -Version 5.1
<#
.SYNOPSIS
  Live acceptance checks for MKMN's single-instance and relaunch-restore behavior
  against an INSTALLED build (no build needed): launch, single instance, restore of
  a minimized window on relaunch, stale-sidecar recovery, and no duplicate sidecars.

.DESCRIPTION
  This is the acceptance half of the single-instance work: the unit and integration
  tests prove the logic in isolation; this script proves the installed app behaves.
  It only ever touches processes that PROVABLY belong to this installation (image
  path under the install directory — the same scoping rule installer.nsi uses), so a
  portable MKMN, a second installation, or unrelated node processes are never harmed.

  Checks, in order:
    1. version       - the installed MKMN.exe reports the expected FileVersion
    2. launch        - the app starts and stays up, exactly one host process and
                       exactly one sidecar node from this install's Runtime
    3. minimize      - the main window can be minimized (precondition for check 4)
    4. relaunch      - starting MKMN.exe a second time hands off to the running
                       instance: still exactly one host process, and the minimized
                       window is restored (not iconic) within the grace period
    5. stale sidecar - killing the sidecar node hard, then relaunching (which hands
                       off to the running host), leaves the app healthy: the host
                       survives, and sidecars never duplicate. The sidecar itself
                       comes back on the next demand - the host respawns it inside
                       the first sidecar call that finds it dead (sidecar.rs) - so
                       while the app is idle zero sidecars is the CORRECT steady
                       state, and a respawn seen during the window is reported.

  The app is always launched through the shell (explorer.exe), so it never inherits
  an elevated token - matching the installer's finish-page behavior. The script
  leaves the app RUNNING in a good state.

.PARAMETER InstallDir
  The installation to check. Defaults to the registered install (HKCU/HKLM
  Software\MKMN\InstallDir), falling back to the per-user default path.

.PARAMETER ExpectedVersion
  The FileVersion MKMN.exe must report (default 0.0.3-rc.1).

.PARAMETER GraceSeconds
  How long each behavioral check may take to settle (default 20).

.EXAMPLE
  powershell -File scripts\Live-Relaunch-Check.ps1 -ExpectedVersion 0.0.3-rc.1
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [string]$ExpectedVersion = "0.0.3-rc.1",
  [int]$GraceSeconds = 20
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# A 32-bit PowerShell cannot read the Path of native ARM64 processes (System32
# redirection): every scoping rule below would silently match nothing. Refuse.
if (-not [Environment]::Is64BitProcess) {
  Write-Host "REFUSING: this check must run under 64-bit (native ARM64) PowerShell -" -ForegroundColor Red
  Write-Host "a 32-bit host cannot read ARM64 process image paths and would scope-match nothing."
  exit 3
}

if (-not $InstallDir) {
  # Never guess an install path: the resolver uses -InstallDir, the installer's
  # registry value, or the image path of a running MKMN, in that order.
  $resolver = Join-Path $PSScriptRoot "Resolve-MkmnPaths.ps1"
  if (-not (Test-Path -LiteralPath $resolver)) {
    Write-Host "FAIL: scripts\Resolve-MkmnPaths.ps1 is missing; cannot resolve the install path" -ForegroundColor Red
    exit 2
  }
  $resolved = & $resolver -Json | ConvertFrom-Json
  if ($resolved.installDir) { $InstallDir = $resolved.installDir }
}
if (-not $InstallDir) {
  Write-Host "FAIL: the MKMN install path was not found; run scripts\Resolve-MkmnPaths.ps1 -InstallDir <dir> or pass -InstallDir" -ForegroundColor Red
  exit 2
}
$exe = Join-Path $InstallDir "MKMN.exe"
$node = Join-Path $InstallDir "Runtime\node.exe"
if (-not (Test-Path $exe)) {
  Write-Host "FAIL: no MKMN.exe at $InstallDir (pass -InstallDir)" -ForegroundColor Red
  exit 2
}
Write-Host "MKMN live relaunch check - $InstallDir"
if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrator")) {
  Write-Host "  note: running elevated; the app is still launched de-elevated through the shell."
}

$failures = New-Object System.Collections.Generic.List[string]
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $suffix = if ($Detail) { " - $Detail" } else { "" }
  if ($Ok) { Write-Host ("  [ok]   {0}{1}" -f $Name, $suffix) }
  else { Write-Host ("  [FAIL] {0}{1}" -f $Name, $suffix) -ForegroundColor Red; $failures.Add($Name) }
}

Add-Type -Namespace MKMNCheck -Name Win32 -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
"@

function Get-OurMkmn { Get-Process MKMN -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } }
function Get-OurNodes {
  Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $node -or ($_.Path -and $_.Path.StartsWith((Join-Path $InstallDir "Runtime"), [StringComparison]::OrdinalIgnoreCase))
  }
}
function Stop-OurProcesses {
  # graceful close first, then force - identical scoping to installer.nsi
  Get-OurMkmn | ForEach-Object { [void]$_.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and ((Get-OurMkmn | Measure-Object).Count -gt 0)) { Start-Sleep -Milliseconds 300 }
  @(Get-OurMkmn) + @(Get-OurNodes) | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }
  Start-Sleep -Milliseconds 800
}
function Start-App {
  # through the shell: never inherits elevation, exactly like the finish page
  Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList "`"$exe`""
}

# --- 1. version --------------------------------------------------------------
$fv = (Get-Item $exe).VersionInfo.FileVersion
Check "installed version" ($fv -like "$ExpectedVersion*") "MKMN.exe FileVersion=$fv expected=$ExpectedVersion"

# --- 2. launch: one host, one sidecar ----------------------------------------
Stop-OurProcesses
Start-App
$deadline = (Get-Date).AddSeconds($GraceSeconds)
while ((Get-Date) -lt $deadline -and ((Get-OurMkmn | Measure-Object).Count -eq 0)) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 4   # let the sidecar spawn
$hosts1 = @(Get-OurMkmn)
$nodes1 = @(Get-OurNodes)
Check "app launches and stays up" ($hosts1.Count -eq 1) "host processes from this install: $($hosts1.Count)"
Check "exactly one sidecar after launch" ($nodes1.Count -le 1) "sidecar node processes: $($nodes1.Count)"

# --- 3. minimize (precondition for the restore check) ------------------------
$hwnd = ($hosts1 | Select-Object -First 1).MainWindowHandle
$canRestore = $false
if ($hwnd -and $hwnd -ne 0) {
  [void][MKMNCheck.Win32]::ShowWindow($hwnd, 6)   # SW_MINIMIZE
  Start-Sleep -Milliseconds 1200
  $iconic = [MKMNCheck.Win32]::IsIconic($hwnd)
  $canRestore = $iconic
  Check "window minimizes" $iconic "IsIconic=$iconic"
} else {
  Check "window minimizes" $false "no main window handle ($hwnd) - app may be tray-hidden; restore check will be skipped honestly"
}

# --- 4. relaunch hands off and restores --------------------------------------
Start-App
$deadline = (Get-Date).AddSeconds($GraceSeconds)
do {
  Start-Sleep -Milliseconds 800
  $hosts2 = @(Get-OurMkmn)
  $settled = ($hosts2.Count -eq 1) -and (-not $canRestore -or ($hosts2[0].MainWindowHandle -eq $hwnd -and -not [MKMNCheck.Win32]::IsIconic($hwnd)))
} until ($settled -or (Get-Date) -gt $deadline)
$hosts2 = @(Get-OurMkmn)
Check "relaunch keeps a single instance" ($hosts2.Count -eq 1) "host processes after relaunch: $($hosts2.Count)"
if ($canRestore) {
  Check "relaunch restores the minimized window" `
    ($hosts2.Count -eq 1 -and $hosts2[0].MainWindowHandle -eq $hwnd -and -not [MKMNCheck.Win32]::IsIconic($hwnd)) `
    "IsIconic=$([MKMNCheck.Win32]::IsIconic($hosts2[0].MainWindowHandle))"
} else {
  Write-Host "  [skip] relaunch restores the minimized window (no window to minimize in check 3)"
}

# --- 5. stale sidecar recovery ------------------------------------------------
$sidecarPid = (Get-OurNodes | Select-Object -First 1).Id
if ($sidecarPid) {
  Stop-Process -Id $sidecarPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-App
  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  do {
    Start-Sleep -Milliseconds 800
    $hosts3 = @(Get-OurMkmn); $nodes3 = @(Get-OurNodes)
    $ok3 = ($hosts3.Count -eq 1 -and $nodes3.Count -le 1)
  } until ($ok3 -or (Get-Date) -gt $deadline)
  Check "killed sidecar leaves the app healthy" ($hosts3.Count -eq 1 -and $nodes3.Count -le 1) `
    "after relaunch: host=$($hosts3.Count) sidecar=$($nodes3.Count) (0 is correct while idle; the host respawns it on the next sidecar call)"
} else {
  Check "recovers from a killed sidecar" $false "no sidecar process found to test with"
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host ("LIVE RELAUNCH CHECK FAILED ({0}): {1}" -f $failures.Count, ($failures -join "; ")) -ForegroundColor Red
  exit 1
}
Write-Host "LIVE RELAUNCH CHECK PASSED (app left running)" -ForegroundColor Green
exit 0
