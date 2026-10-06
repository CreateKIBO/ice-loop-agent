# Runs immediately before uninstalling/replacing application files, in install and uninstall.
# Replaces electron-builder's filename-only taskkill and repeated confirmation dialog.
!define ICE_INSTALLER_SOURCE "${__FILEDIR__}"
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\ice-stop-agent.ps1 "${ICE_INSTALLER_SOURCE}\stop-agent.ps1"
  StrCpy $R8 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  DetailPrint "Closing ICE Loop Studio and waiting for its engine/browser processes..."
  nsExec::ExecToLog /TIMEOUT=60000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-stop-agent.ps1" -ReportPath "$TEMP\ICE-Loop-Install-Stop.json"'
  Pop $R9
  ${If} $R9 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法自动关闭 ICE Loop Studio，安装尚未替换程序文件。请先保存工作；如果 Agent 以管理员身份运行，请用相同权限重新运行安装包。错误码：$R9" /SD IDOK
    SetErrorLevel 20
    Quit
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    File /oname=$PLUGINSDIR\ice-preserve-workspaces.ps1 "${ICE_INSTALLER_SOURCE}\preserve-workspaces.ps1"
    ReadRegStr $R7 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    nsExec::ExecToLog /TIMEOUT=60000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-preserve-workspaces.ps1" -Mode Stage -InstallRoot "$INSTDIR" -PreviousRoot "$R7" -StageFile "$PLUGINSDIR\ice-workspace-stage.txt"'
    Pop $R9
    ${If} $R9 != 0
      MessageBox MB_OK|MB_ICONSTOP "无法暂存旧版工作数据，安装已停止，尚未卸载旧版程序。错误码：$R9" /SD IDOK
      SetErrorLevel 22
      Quit
    ${EndIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
Function IceRestoreWorkspaces
  StrCpy $R9 0
  IfFileExists "$PLUGINSDIR\ice-workspace-stage.txt" 0 iceRestoreDone
  StrCpy $R8 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToLog /TIMEOUT=60000 '"$R8" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ice-preserve-workspaces.ps1" -Mode Restore -StageFile "$PLUGINSDIR\ice-workspace-stage.txt"'
  Pop $R9
  iceRestoreDone:
FunctionEnd

!macro customInstall
  Call IceRestoreWorkspaces
  ${If} $R9 != 0
    MessageBox MB_OK|MB_ICONSTOP "程序文件已安装，但工作区尚未放回原路径。数据保留在旧安装目录旁的 .ice-install-recovery 文件夹，请保留该目录。错误码：$R9" /SD IDOK
    SetErrorLevel 22
    Quit
  ${EndIf}
!macroend

# Also put data back if extraction fails or the installer exits before customInstall.
Function .onGUIEnd
  Call IceRestoreWorkspaces
FunctionEnd
!endif
