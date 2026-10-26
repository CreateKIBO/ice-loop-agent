# Reproduce the upstream recursive uninstaller, with test-only scoped process stopping.
# The witness is outside the program directory so recursive deletion cannot erase evidence.
!define ICE_INSTALLER_SOURCE "${__FILEDIR__}"
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop.ps1 "${ICE_INSTALLER_SOURCE}\stop-agent.ps1"
  nsExec::ExecToLog /TIMEOUT=60000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop.ps1" -InstallRoot "$INSTDIR\."'
  Pop $R9
  ${If} $R9 != 0
    SetErrorLevel 20
    Quit
  ${EndIf}
!macroend
!macro customUnInstall
  !ifndef ICE_LEGACY_WITNESS
    !error "Legacy fixture requires an owned witness path"
  !endif
  FileOpen $R4 "${ICE_LEGACY_WITNESS}" w
  FileWrite $R4 "legacy uninstaller executed"
  FileClose $R4
!macroend
