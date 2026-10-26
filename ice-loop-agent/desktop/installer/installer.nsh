# Runs immediately before uninstalling/replacing application files, in install and uninstall.
# Replaces electron-builder's filename-only taskkill and repeated confirmation dialog.
!define ICE_INSTALLER_SOURCE "${__FILEDIR__}"
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\ice-stop-agent.ps1 "${ICE_INSTALLER_SOURCE}\stop-agent.ps1"
  StrCpy $R8 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ReadRegStr $R7 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R7 == ""
    StrCpy $R7 "$INSTDIR"
  ${EndIf}
  DetailPrint "Closing ICE Loop Studio and waiting for its engine/browser processes..."
  nsExec::ExecToLog /TIMEOUT=60000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-stop-agent.ps1" -InstallRoot "$INSTDIR\." -PreviousRoot "$R7\." -ReportPath "$TEMP\ICE-Loop-Install-Stop.json"'
  Pop $R9
  ${If} $R9 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法自动关闭 ICE Loop Studio，安装尚未替换程序文件。请先保存工作；如果 Agent 以管理员身份运行，请用相同权限重新运行安装包。错误码：$R9" /SD IDOK
    SetErrorLevel 20
    Quit
  ${EndIf}

!macroend

!ifndef BUILD_UNINSTALLER
!macro IceStageUpgrade
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=$PLUGINSDIR\ice-stop-agent.ps1 "${ICE_INSTALLER_SOURCE}\stop-agent.ps1"
  StrCpy $R8 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    File /oname=$PLUGINSDIR\ice-upgrade.ps1 "${ICE_INSTALLER_SOURCE}\upgrade-transaction.ps1"
    File /oname=$PLUGINSDIR\ice-install-files.json "${ICE_INSTALL_FILE_MANIFEST}"
    nsExec::ExecToLog /TIMEOUT=120000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-upgrade.ps1" -Mode Stage -InstallRoot "$INSTDIR\." -AppGuid "${APP_GUID}" -InstallMode "$installMode" -RegistryView 64'
    Pop $R9
    ${If} $R9 != 0
      MessageBox MB_OK|MB_ICONSTOP "无法准备安全升级，安装已停止。旧目录或恢复点已保留；日志：$TEMP\ICE-Loop-Upgrade.json。错误码：$R9" /SD IDOK
      SetErrorLevel 22
      Quit
    ${EndIf}
!macroend

!macro customInstall
  SetOutPath "$PLUGINSDIR"
  StrCpy $R8 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToLog /TIMEOUT=120000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-upgrade.ps1" -Mode Commit -InstallRoot "$INSTDIR\." -AppGuid "${APP_GUID}" -InstallMode "$installMode" -RegistryView 64'
  Pop $R9
  ${If} $R9 != 0
    StrCpy $R5 $R9
    Call IceRollbackUpgrade
    MessageBox MB_OK|MB_ICONSTOP "升级未完成，已尝试恢复旧目录。请保留旁边的 .ice-install-recovery；日志：$TEMP\ICE-Loop-Upgrade.json。升级错误码：$R5；恢复检查：$R9" /SD IDOK
    SetErrorLevel 22
    Quit
  ${EndIf}
!macroend

!macro customHeader
Function IceRollbackUpgrade
  SetOutPath "$PLUGINSDIR"
  StrCpy $R9 0
  IfFileExists "$PLUGINSDIR\ice-upgrade-stage.txt" 0 iceRollbackDone
  StrCpy $R8 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToLog /TIMEOUT=120000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-upgrade.ps1" -Mode Rollback -InstallRoot "$INSTDIR\." -AppGuid "${APP_GUID}" -InstallMode "$installMode" -RegistryView 64'
  Pop $R9
  iceRollbackDone:
FunctionEnd

# Successful commits are a no-op; interrupted extraction restores the old roots.
Function .onGUIEnd
  Call IceRollbackUpgrade
FunctionEnd
Function .onInstFailed
  Call IceRollbackUpgrade
  SetErrorLevel 22
FunctionEnd
!macroend
!endif

# Override recursive RMDir with a compile-time allowlist.
!macro customRemoveFiles
  InitPluginsDir
  !ifndef ICE_INSTALL_FILE_MANIFEST
    !error "Missing immutable install manifest; use build/build-release.ps1"
  !endif
  File /oname=$PLUGINSDIR\ice-install-files.json "${ICE_INSTALL_FILE_MANIFEST}"
  File /oname=$PLUGINSDIR\ice-remove-owned.ps1 "${ICE_INSTALLER_SOURCE}\remove-owned-files.ps1"
  StrCpy $R8 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  SetOutPath "$TEMP"
  nsExec::ExecToLog /TIMEOUT=120000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-remove-owned.ps1" -InstallRoot "$INSTDIR\." -ManifestPath "$PLUGINSDIR\ice-install-files.json" -ReportPath "$TEMP\ICE-Loop-Uninstall-Files.json"'
  Pop $R9
  ${If} $R9 != 0
    MessageBox MB_OK|MB_ICONSTOP "程序文件清理未完成，用户数据未递归删除。请保留安装目录并查看卸载日志。错误码：$R9" /SD IDOK
    SetErrorLevel 23
    Quit
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  RMDir "$INSTDIR"
!macroend
