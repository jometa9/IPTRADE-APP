; Custom NSIS macros for IPTRADE installer.
; Registers iptrade:// protocol so that when the user opens a link, Windows passes:
;   IPTRADE.exe "$INSTDIR\IPTRADE.exe" "iptrade://...?apiKey=..."

; electron-builder upgrade path runs *old* Uninstall*.exe with --updated → un.atomicRMDir.
; Any locked file → silent uninstall fails → retry loop → "$(appCannotBeClosed)" forever.
; We skip that entire path: after killing processes, remove uninstall/install + InstallLocation
; registry keys so uninstallOldVersion() exits immediately, then RMDir the old tree ourselves.

!macro preparePriorInstallForOverwrite
  StrCpy $R9 ""
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R9 == ""
    ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endif}
  ${if} $R9 != ""
    nsExec::ExecToLog 'cmd.exe /c if exist "$R9" attrib -R -H -S "$R9\*" /S /D'
    nsExec::ExecToLog 'cmd.exe /c set "IPTRADE_INST=$R9" && powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if ($$env:IPTRADE_INST) { Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath).StartsWith($$env:IPTRADE_INST, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"'
  ${endif}
  nsExec::ExecToLog 'taskkill /IM "${PRODUCT_FILENAME}.exe" /F /T 2>nul'
  nsExec::ExecToLog 'taskkill /IM iptrade-api.exe /F /T 2>nul'
  nsExec::ExecToLog 'cmd.exe /c ping -n 2 127.0.0.1 >nul'
!macroend

; Do NOT call this from customInit — user could cancel the wizard after .onInit and we'd leave no uninstall entry.
!macro bypassBrokenOldUninstallerAndRemoveTree
  ; Drop registry so uninstallOldVersion finds empty UninstallString and never runs old Uninstall*.exe.
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
  ClearErrors
  ; $R9 still holds previous InstallLocation from preparePriorInstallForOverwrite.
  ${if} ${FileExists} "$R9\${APP_EXECUTABLE_FILENAME}"
    RMDir /r $R9
  ${endif}
  ClearErrors
  nsExec::ExecToLog 'cmd.exe /c ping -n 2 127.0.0.1 >nul'
!macroend

; nsis.artifactName must be ${productName}-Setup.${ext} so we are not the same image as IPTRADE.exe.
!macro customInit
  !insertmacro preparePriorInstallForOverwrite
  nsExec::ExecToLog 'cmd.exe /c if exist "$INSTDIR\resources" attrib -H -S "$INSTDIR\resources" /S /D'
!macroend

!macro customCheckAppRunning
  !insertmacro preparePriorInstallForOverwrite
  !insertmacro bypassBrokenOldUninstallerAndRemoveTree
  nsExec::ExecToLog 'cmd.exe /c if exist "$INSTDIR\resources" attrib -H -S "$INSTDIR\resources" /S /D'
  nsExec::ExecToLog 'cmd.exe /c if exist "$INSTDIR" attrib -R -H -S "$INSTDIR\*" /S /D'
!macroend

!macro customRemoveFiles
  nsExec::ExecToLog 'cmd.exe /c if exist "$INSTDIR" attrib -R -H -S "$INSTDIR\*" /S /D'
  nsExec::ExecToLog 'cmd.exe /c ping -n 2 127.0.0.1 >nul'
  RMDir /r $INSTDIR
!macroend

!macro customInstall
  WriteRegStr HKCR "iptrade" "" "URL:iptrade Protocol"
  WriteRegStr HKCR "iptrade" "URL Protocol" ""
  WriteRegStr HKCR "iptrade\shell\open\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" "$INSTDIR\${PRODUCT_FILENAME}.exe" "%1"'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'cmd.exe /c if exist "$INSTDIR\resources" attrib -H -S "$INSTDIR\resources" /S /D'
  DeleteRegKey HKCR "iptrade"
!macroend
