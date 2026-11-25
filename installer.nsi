!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

; The version comes from package.json via the build script: makensis /DVERSION=x.y.z installer.nsi
; There is no fallback version: makensis must be given /DVERSION.
!ifndef VERSION
  !error "Pass the version from package.json: makensis /DVERSION=<version> installer.nsi (scripts\Build-Windows.ps1 does it for you)."
!endif

Name "MKMN AI"
Caption "MKMN AI — Private AI, powered by your PC (v${VERSION})"
OutFile "dist\MKMN-${VERSION}-arm64-Setup.exe"
RequestExecutionLevel highest
Unicode true

SetCompressor /SOLID lzma

!define MUI_ICON "build\icon.ico"
!define MUI_UNICON "build\icon.ico"
!define MUI_ABORTWARNING

; "Run MKMN" checkbox on the finish page (checked by default). The app is started
; THROUGH THE SHELL (explorer.exe), never directly: an admin install runs elevated,
; and a directly executed MKMN.exe would inherit that elevation. An elevated MKMN
; was exactly what once made an ordinary relaunch unable to restore its window
; (Windows privilege filtering, the 0x80070005 dialog). explorer.exe forwards the
; launch to the user's own (medium-integrity) shell process, so the app starts
; un-elevated the way a normal double-click would.
!define MUI_FINISHPAGE_RUN "$WINDIR\explorer.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "$INSTDIR\MKMN.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Run MKMN AI (recommended, un-elevated)"
!define MUI_WELCOMEPAGE_TEXT "This wizard installs MKMN AI.$\r$\n$\r$\nRequires: Windows 11 (build 22000 or later) on an ARM64 PC. Included: the app, its Node.js sidecar and dependencies, and the speech runtime. The Microsoft Edge WebView2 Runtime is installed from Microsoft if Windows has none.$\r$\n$\r$\nFor local inference on the Snapdragon NPU, MKMN also needs Qualcomm GenieX v0.11.0 or newer, the Qualcomm NPU driver (Windows Update) and a model. At first launch MKMN offers to install the latest stable GenieX from Qualcomm; that and model downloads need an internet connection. Cloud chat works without them."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ----------------------------------------------------------------------------
; Process handling
;
; The install directory travels to PowerShell through an environment variable
; (MKMN_INSTALL_DIR) instead of being interpolated into the script text: paths with
; spaces AND apostrophes (C:\Users\O'Brien\...\MKMN) survive unchanged, and no
; quoting rule can be gotten wrong. Every PowerShell call's exit code is checked.
;
; Only processes PROVEN to belong to THIS installation are ever touched:
;   - MKMN.exe        whose image path is exactly $INSTDIR\MKMN.exe
;   - node.exe        whose image path is exactly $INSTDIR\Runtime\node.exe
;                     (the Node sidecar, and orphaned voice workers started by it)
;   - msedgewebview2  whose command line carries THIS install's path, or whose
;                     parent is one of the processes stopped above
; A portable MKMN, another installation, the user's own Node, the GenieX CLI and
; any other WebView2 host are never matched.
; ----------------------------------------------------------------------------
Function SetInstallDirEnv
  System::Call 'kernel32::SetEnvironmentVariable(t "MKMN_INSTALL_DIR", t "$INSTDIR") i .r0'
FunctionEnd

Function un.SetInstallDirEnv
  System::Call 'kernel32::SetEnvironmentVariable(t "MKMN_INSTALL_DIR", t "$INSTDIR") i .r0'
FunctionEnd

; IMPORTANT WOW64 NOTE: NSIS executables are 32-bit, so a plain "powershell.exe"
; resolves through System32 redirection to the 32-bit (emulated) PowerShell — which
; CANNOT read the .Path of native ARM64 processes (Get-Process lists them, Path is
; null) and would silently match NOTHING. Sysnative is the virtual directory that
; reaches the native (ARM64) PowerShell from a 32-bit caller; it is always valid here.
!define PSEXE `$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe`

; Asks running MKMN.exe of THIS installation to close itself (WM_CLOSE): with the
; default close behavior this is the app's own orderly shutdown — the sidecar, the
; model server and the voice workers stop first.
!define GracefulStop `${PSEXE} -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:MKMN_INSTALL_DIR; $$mkmn = Join-Path $$d 'MKMN.exe'; Get-Process MKMN -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$mkmn } | ForEach-Object { [void]$$_.CloseMainWindow() }; exit 0"`

; Waits (up to 10 s) until MKMN.exe and the bundled node.exe of THIS installation are
; gone. Exit 0 = all stopped; exit 1 = something is still running.
!define WaitStopped `${PSEXE} -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:MKMN_INSTALL_DIR; $$mkmn = Join-Path $$d 'MKMN.exe'; $$node = Join-Path $$d 'Runtime\node.exe'; $$n = 0; while ($$n -lt 40) { $$c = @(Get-Process MKMN, node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$mkmn -or $$_.Path -eq $$node }).Count; if ($$c -eq 0) { exit 0 }; Start-Sleep -Milliseconds 250; $$n++ }; exit 1"`

; Force-stops ONLY the processes proven to belong to THIS installation (see the
; scoping rules above), including WebView2 children and orphaned node workers.
!define ForceStop `${PSEXE} -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:MKMN_INSTALL_DIR; $$mkmn = Join-Path $$d 'MKMN.exe'; $$node = Join-Path $$d 'Runtime\node.exe'; $$ours = @(Get-Process MKMN, node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$mkmn -or $$_.Path -eq $$node }); $$ids = @($$ours | ForEach-Object { $$_.Id }); $$ours | ForEach-Object { Stop-Process -Id $$_.Id -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter 'Name = ''msedgewebview2.exe''' -ErrorAction SilentlyContinue | Where-Object { $$_.CommandLine -and (($$_.CommandLine.IndexOf($$d, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($$ids -contains $$_.ParentProcessId)) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0"`

; Graceful first, then — only if something survived the 10 s grace — a force-stop,
; then a final wait so file handles are actually released before any File/Delete op.
; Pop the exit code of the LAST call (0 = all stopped). ${FN} is SetInstallDirEnv
; for the installer and un.SetInstallDirEnv for the uninstaller.
!macro StopThisInstall FN
  Call ${FN}
  nsExec::Exec `${GracefulStop}`
  Pop $0
  nsExec::Exec `${WaitStopped}`
  Pop $0
  ${If} $0 != 0
    nsExec::Exec `${ForceStop}`
    Pop $0
    nsExec::Exec `${WaitStopped}`
    Pop $0
  ${EndIf}
!macroend

; Shell notification (SHCNE_UPDATEITEM | SHCNF_PATH | SHCNF_FLUSH) for one exact
; path: after an in-place upgrade, Explorer and Task Manager resolve the shortcut
; and exe icons from their cached association, which can keep showing the PREVIOUS
; install's icon for these same paths. The notification makes the shell re-read the
; current files — targeted, no icon-cache deletion.
!macro NotifyShellPath FILE
  System::Call 'shell32::SHChangeNotify(i 0x02000000, i 0x1001, t "${FILE}", p 0)'
!macroend

; Deletion with retries while a file handle is still released; sets $R1 to 1 when
; the target still exists afterwards (the caller decides what a leftover means).
!macro DeleteRetry FILE LABEL
  StrCpy $R9 5
  ${LABEL}_loop:
    IfFileExists `${FILE}` 0 ${LABEL}_done
    ClearErrors
    Delete `${FILE}`
    IfErrors 0 ${LABEL}_recheck
    IntOp $R9 $R9 - 1
    IntCmp $R9 0 ${LABEL}_done ${LABEL}_sleep ${LABEL}_sleep
  ${LABEL}_sleep:
    Sleep 400
    Goto ${LABEL}_loop
  ${LABEL}_recheck:
    Goto ${LABEL}_loop
  ${LABEL}_done:
    IfFileExists `${FILE}` 0 +2
    StrCpy $R1 1
!macroend

!macro RMDirRetry DIR LABEL
  StrCpy $R9 5
  ${LABEL}_loop:
    IfFileExists `${DIR}` 0 ${LABEL}_done
    ClearErrors
    RMDir /r `${DIR}`
    IfErrors 0 ${LABEL}_recheck
    IntOp $R9 $R9 - 1
    IntCmp $R9 0 ${LABEL}_done ${LABEL}_sleep ${LABEL}_sleep
  ${LABEL}_sleep:
    Sleep 400
    Goto ${LABEL}_loop
  ${LABEL}_recheck:
    Goto ${LABEL}_loop
  ${LABEL}_done:
    IfFileExists `${DIR}` 0 +2
    StrCpy $R1 1
!macroend

Var RemoveData

Function .onInit
  SetRegView 64
  ; MKMN is built for Windows 11 on ARM64 only (the host, Node and speech binaries are ARM64):
  ; anything else is refused before a file is written, with the reason.
  ${IfNot} ${IsNativeARM64}
    MessageBox MB_ICONSTOP|MB_OK "MKMN AI needs a Windows 11 PC with an ARM64 processor (for example Snapdragon X). This PC is not ARM64, so nothing was installed." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastBuild} 22000
    MessageBox MB_ICONSTOP|MB_OK "MKMN AI needs Windows 11 (build 22000 or later). This PC runs an older Windows, so nothing was installed." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ; An explicit /D= command-line directory (silent installs, test harnesses) wins;
  ; otherwise the per-account default applies.
  StrCmp $INSTDIR "" 0 done
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 == "Admin"
    StrCpy $INSTDIR "$PROGRAMFILES64\MKMN"
  ${Else}
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\MKMN"
  ${EndIf}
  done:
FunctionEnd

Function un.onInit
  SetRegView 64
  StrCpy $RemoveData 0
  ; Silent mode: an explicit /remove-data switch opts into data removal.
  ${un.GetOptions} $CMDLINE "/remove-data" $R9
  ${IfNot} ${Errors}
    StrCpy $RemoveData 1
  ${EndIf}
  ; A machine-wide install (under Program Files, i.e. registered in HKLM) needs
  ; elevation: its files and its HKLM registration are admin-owned. Self-elevate
  ; instead of failing halfway. The silent flag and the data-removal choice MUST be
  ; forwarded: the elevated child would otherwise open an INTERACTIVE wizard that
  ; hangs a silent uninstall forever. NEVER show a MessageBox in silent mode.
  UserInfo::GetAccountType
  Pop $0
  StrCmp $0 "Admin" done 0
  ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "UninstallString"
  IfErrors done 0
  StrCpy $R9 ""
  IfSilent 0 +2
    StrCpy $R9 "/S"
  ${If} $RemoveData == 1
    StrCpy $R9 "$R9 /remove-data"
  ${EndIf}
  IfSilent 0 interactive
  ExecShell runas "$INSTDIR\uninstall.exe" "$R9" SW_HIDE
  Quit
  interactive:
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "MKMN was installed for all users. The uninstaller needs administrator rights to remove its files and registration.$\n$\nContinue as administrator?" IDOK elevate
  Quit
  elevate:
  ExecShell runas "$INSTDIR\uninstall.exe" "$R9" SW_SHOW
  Quit
  done:
FunctionEnd

Section "Install" SecInstall
  SetOverwrite on
  ; Only THIS install's processes are stopped, graceful first (see the macro):
  ; a copy running from another directory (a portable build, a second install) and
  ; unrelated Node/GenieX/WebView2 processes must survive an install into $INSTDIR.
  !insertmacro StopThisInstall SetInstallDirEnv
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "MKMN is still running from $INSTDIR and could not be stopped. Close it (or end it from the tray icon), then run the installer again."
    Abort
  ${EndIf}
  Sleep 250 ; let the last file handles be released

  SetOutPath "$INSTDIR"
  
  File "src-tauri\target\aarch64-pc-windows-msvc\release\MKMN.exe"
  File "src-tauri\target\aarch64-pc-windows-msvc\release\comctl32.dll"
  File "src-tauri\target\aarch64-pc-windows-msvc\release\MKMN.exe.manifest"
  ; next to MKMN.exe: the shortcuts and the Apps list (DisplayIcon) point at $INSTDIR\icon.ico
  File "build\icon.ico"
  ; the pinned Computer Use driver, built by the SAME cargo invocation as the host
  ; (src-tauri\src\bin\agent-desktop.rs): the host looks for Runtime\agent-desktop.exe
  ; first when it is installed. Mandatory: an installer without the driver would ship
  ; a Window agent that can only report the driver missing.
  SetOutPath "$INSTDIR\Runtime"
  File "src-tauri\target\aarch64-pc-windows-msvc\release\agent-desktop.exe"
  File "build\tray.png"
  ; the app's own and its dependencies' licences travel with the installed files
  File "LICENSE"
  File "THIRD_PARTY_LICENSES.txt"
  File "THIRD_PARTY_NOTICES.md"
  
  ; Bundled Runtime directory (sidecars and runtimes)
  SetOutPath "$INSTDIR\Runtime\voice"
  ; the voice worker is loaded by the sidecar as Runtime\voice\worker.js, so it must sit
  ; in its own subdirectory (dist\voice\*.* lands here, one level down from Runtime).
  File /r "dist\voice\*.*"
  ; the Node sidecar and the core/shared modules its main.js requires
  SetOutPath "$INSTDIR\Runtime\sidecar"
  File /r "dist\sidecar\*.*"
  SetOutPath "$INSTDIR\Runtime\core"
  File /r "dist\core\*.*"
  SetOutPath "$INSTDIR\Runtime\shared"
  File /r "dist\shared\*.*"
  ; the Node runtime the sidecar needs, plus its runtime dependency closure
  ; (acorn, react, react-dom, scheduler), staged by scripts\Bundle-Sidecar.ps1.
  ; BOTH are mandatory: the sidecar is the whole application logic, and it cannot
  ; start without its dependencies — a missing node.exe must fail the install.
  SetOutPath "$INSTDIR\Runtime"
  File /oname=node.exe "dist\sidecar-runtime\node.exe"
  SetOutPath "$INSTDIR\Runtime\node_modules"
  File /r "dist\sidecar-runtime\node_modules\*.*"

  ; the speech library the voice worker requires (JS module + native ARM64 binaries);
  ; resolved from Runtime\voice by Node walking up to node_modules. Mandatory at BUILD
  ; time: a build machine without it must fail here, never ship an installer whose
  ; voice can only report a missing runtime it has no way to download.
  SetOutPath "$INSTDIR\node_modules\sherpa-onnx-node"
  File /r "node_modules\sherpa-onnx-node\*.*"
  SetOutPath "$INSTDIR\node_modules\sherpa-onnx-win-arm64"
  File /r "node_modules\sherpa-onnx-win-arm64\*.*"
  
  ; Static frontend assets
  SetOutPath "$INSTDIR\dist\renderer"
  File /r "dist\renderer\*.*"
  
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  
  CreateDirectory "$SMPROGRAMS\MKMN"
  CreateShortcut "$SMPROGRAMS\MKMN\MKMN.lnk" "$INSTDIR\MKMN.exe" "" "$INSTDIR\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\MKMN\Uninstall MKMN.lnk" "$INSTDIR\uninstall.exe"
  ; The shortcuts, icon and exe were just replaced under the SAME paths the previous
  ; version used: tell the shell exactly which items changed, so its cached icon
  ; associations are dropped for THESE files only (see NotifyShellPath above).
  !insertmacro NotifyShellPath "$SMPROGRAMS\MKMN\MKMN.lnk"
  !insertmacro NotifyShellPath "$INSTDIR\icon.ico"
  !insertmacro NotifyShellPath "$INSTDIR\MKMN.exe"
  
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 == "Admin"
    WriteRegStr HKLM "Software\MKMN" "InstallDir" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "DisplayName" "MKMN AI"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "DisplayIcon" "$INSTDIR\icon.ico"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "DisplayVersion" "${VERSION}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "Publisher" "MKMN Team"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "UninstallString" '"$INSTDIR\uninstall.exe"'
  ${Else}
    WriteRegStr HKCU "Software\MKMN" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "DisplayName" "MKMN AI"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "DisplayIcon" "$INSTDIR\icon.ico"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "Publisher" "MKMN Team"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN" "UninstallString" '"$INSTDIR\uninstall.exe"'
  ${EndIf}
SectionEnd

; The WebView2 runtime draws the whole window. Windows 11 ships it, but a stripped or
; LTSC image may not: when Windows records no version of it, Microsoft's evergreen
; bootstrapper is downloaded, run only when its Authenticode signature is valid and
; Microsoft's, and installs the runtime silently. A failure does not undo the install:
; the person is told where to get it (MKMN cannot draw its window without it).
!define WEBVIEW2_CLIENT "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WEBVIEW2_CLIENT32 "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WEBVIEW2_BOOTSTRAPPER "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
Section "-WebView2 runtime" SecWebView2
  ReadRegStr $1 HKLM "${WEBVIEW2_CLIENT32}" "pv"
  ${If} $1 == ""
  ${OrIf} $1 == "0.0.0.0"
    ReadRegStr $1 HKLM "${WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  ${If} $1 == ""
  ${OrIf} $1 == "0.0.0.0"
    ReadRegStr $1 HKCU "${WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $1 != "0.0.0.0"
    DetailPrint "WebView2 runtime $1 is installed."
  ${Else}
    DetailPrint "WebView2 runtime not found: downloading it from Microsoft..."
    nsExec::Exec `${PSEXE} -NoProfile -ExecutionPolicy Bypass -Command "$$f = Join-Path $$env:TEMP 'MicrosoftEdgeWebview2Setup.exe'; try { Invoke-WebRequest -UseBasicParsing -Uri '${WEBVIEW2_BOOTSTRAPPER}' -OutFile $$f } catch { exit 2 }; $$s = Get-AuthenticodeSignature -LiteralPath $$f; if ($$s.Status -ne 'Valid' -or $$s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { Remove-Item -LiteralPath $$f -Force -ErrorAction SilentlyContinue; exit 3 }; $$p = Start-Process -FilePath $$f -ArgumentList '/silent','/install' -Wait -PassThru; Remove-Item -LiteralPath $$f -Force -ErrorAction SilentlyContinue; exit $$p.ExitCode"`
    Pop $0
    ${If} $0 != 0
      DetailPrint "The WebView2 runtime could not be installed (code $0)."
      MessageBox MB_ICONEXCLAMATION|MB_OK "MKMN needs the Microsoft Edge WebView2 Runtime to draw its window, and it could not be installed (code $0). Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start MKMN again." /SD IDOK
    ${Else}
      DetailPrint "WebView2 runtime installed."
    ${EndIf}
  ${EndIf}
SectionEnd

; Optional desktop shortcut: unticked in the components page when not wanted.
; Ticked by default — most users launch from the desktop.
Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\MKMN.lnk" "$INSTDIR\MKMN.exe" "" "$INSTDIR\icon.ico" 0
  ; Same staleness as above for the desktop shortcut (absent when the section is
  ; unticked: SHChangeNotify on a missing path is a no-op).
  !insertmacro NotifyShellPath "$DESKTOP\MKMN.lnk"
SectionEnd

Section "Uninstall"
  ; 1. Ask the user once (interactive, non-silent) whether to also remove the data.
  ;    Silent installs decide with the /remove-data switch (un.onInit). The GenieX
  ;    model cache under %USERPROFILE%\.cache\geniex (or $GENIEX_DATADIR) is SHARED
  ;    with the GenieX CLI and is never removed here.
  IfSilent silent 0
  ${If} $RemoveData == 0
    MessageBox MB_YESNO|MB_ICONQUESTION "Also remove all MKMN data?$\n$\nThis deletes your chats, settings, logs, caches and the voice models MKMN downloaded (in %LOCALAPPDATA%\MKMN).$\n$\nModel files shared with the GenieX CLI are kept." IDYES remove
    Goto silent
    remove:
    StrCpy $RemoveData 1
  ${EndIf}
  silent:

  ; 2. Graceful shutdown first, then a scoped force-stop, then wait for termination
  ;    and file-lock release (see StopThisInstall; its last Pop is the exit code).
  ;    Every step is journaled to %TEMP%\mkmn-uninstall.log: a failed stop must be
  ;    diagnosable afterwards, not silent.
  !insertmacro StopThisInstall un.SetInstallDirEnv
  FileOpen $R8 "$TEMP\mkmn-uninstall.log" a
  FileWrite $R8 "stop sequence exit code: [$0]$\r$\nMKMN.exe still present: "
  IfFileExists "$INSTDIR\MKMN.exe" 0 +2
    FileWrite $R8 "yes"
  FileWrite $R8 "$\r$\n"
  FileClose $R8

  ; 3. Shortcuts.
  Delete "$DESKTOP\MKMN.lnk"
  Delete "$SMPROGRAMS\MKMN\MKMN.lnk"
  Delete "$SMPROGRAMS\MKMN\Uninstall MKMN.lnk"
  RMDir "$SMPROGRAMS\MKMN"

  ; 4. Remove the installed files with retries; every result is checked. $R1 counts
  ;    leftovers; a leftover REQUIRED file means the uninstall must NOT claim
  ;    success and the registration must stay (so the entry can be retried).
  StrCpy $R1 0
  !insertmacro RMDirRetry "$INSTDIR\dist" unDist
  !insertmacro RMDirRetry "$INSTDIR\Runtime" unRuntime
  !insertmacro RMDirRetry "$INSTDIR\node_modules" unNodeModules
  !insertmacro DeleteRetry "$INSTDIR\LICENSE" unLicense
  !insertmacro DeleteRetry "$INSTDIR\THIRD_PARTY_LICENSES.txt" unTpl
  !insertmacro DeleteRetry "$INSTDIR\THIRD_PARTY_NOTICES.md" unTpn
  !insertmacro DeleteRetry "$INSTDIR\MKMN.exe" unExe
  !insertmacro DeleteRetry "$INSTDIR\comctl32.dll" unComctl
  !insertmacro DeleteRetry "$INSTDIR\MKMN.exe.manifest" unManifest
  !insertmacro DeleteRetry "$INSTDIR\icon.ico" unIcon
  !insertmacro DeleteRetry "$INSTDIR\tray.png" unTray

  ; 5. The optional data removal (chats, settings, logs, caches, app-owned models,
  ;    and the WebView2 profile of the bundle id). Reparse-point safe: a junction's
  ;    TARGET (e.g. a shared model cache) is never followed — only the link goes.
  ${If} $RemoveData == 1
    System::Call 'kernel32::SetEnvironmentVariable(t "MKMN_WEBVIEW_ID", t "app.mkmn.desktop") i .r0'
    nsExec::Exec `${PSEXE} -NoProfile -ExecutionPolicy Bypass -Command "$$root = Join-Path $$env:LOCALAPPDATA 'MKMN'; if (Test-Path $$root) { Get-ChildItem -LiteralPath $$root -Force -ErrorAction SilentlyContinue | ForEach-Object { if ($$_.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($$_.FullName) } else { Remove-Item -LiteralPath $$_.FullName -Recurse -Force -ErrorAction SilentlyContinue } } }; Remove-Item -LiteralPath $$root -Recurse -Force -ErrorAction SilentlyContinue; $$wv = Join-Path $$env:LOCALAPPDATA $$env:MKMN_WEBVIEW_ID; if (Test-Path $$wv) { Remove-Item -LiteralPath $$wv -Recurse -Force -ErrorAction SilentlyContinue }; if ((Test-Path $$root) -or (Test-Path $$wv)) { exit 1 }; exit 0"`
    Pop $0
    ; The script exits 1 when a data folder is still there (a file held open, a
    ; protected one): the person is told where, and the uninstall does not end as
    ; a plain success. In silent mode there is no dialog (/SD), only the exit code.
    ${If} $0 != 0
      SetErrorLevel 3
      MessageBox MB_ICONEXCLAMATION "MKMN was removed, but some of your MKMN data could not be deleted (a file may still be open). What remains is in $LOCALAPPDATA\MKMN — delete it yourself once MKMN is closed." /SD IDOK
    ${EndIf}
  ${EndIf}

  ; 6. Required files must be gone before the registration is touched. In silent
  ;    mode there must be NO dialog: set the error flag and quit with a failure
  ;    exit code instead (a MessageBox without /SD would hang the uninstaller).
  ${If} $R1 != 0
    SetErrors
    IfSilent 0 interactive
    Quit
    interactive:
    MessageBox MB_ICONEXCLAMATION "MKMN could not be removed completely: some files in $INSTDIR are still in use (or protected).$\n$\nNothing was unregistered — close MKMN and any of its background work, then run the uninstaller again."
    Abort
  ${EndIf}

  ; 7. Registration: both hives are attempted (HKLM needs the elevation granted in
  ;    un.onInit; a per-user uninstall simply cannot delete HKLM and moves on).
  ClearErrors
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN"
  DeleteRegKey HKLM "Software\MKMN"
  ClearErrors
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MKMN"
  DeleteRegKey HKCU "Software\MKMN"

  ; 8. The uninstaller itself (it runs from a temp copy) and the install directory.
  !insertmacro DeleteRetry "$INSTDIR\uninstall.exe" unUninstaller
  RMDir "$INSTDIR"

  ; 9. Final honesty check: only an empty (or absent) directory may remain.
  ${If} ${FileExists} "$INSTDIR\*.*"
    SetErrors
    IfSilent 0 interactive2
    Quit
    interactive2:
    MessageBox MB_ICONEXCLAMATION "MKMN was unregistered, but the folder $INSTDIR could not be removed completely (it is empty except for files Windows still holds open). You can delete it manually once the handles are released."
  ${EndIf}
SectionEnd
