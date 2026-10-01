@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment missing. Run install-desktop.ps1 first.
  pause
  exit /b 1
)
if not exist "desktop\node_modules\electron\dist\electron.exe" (
  echo Electron runtime missing. Run install-desktop.ps1 first.
  pause
  exit /b 1
)
start "" "%~dp0desktop\node_modules\electron\dist\electron.exe" "%~dp0desktop"
