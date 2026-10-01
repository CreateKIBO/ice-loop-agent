$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$electronPath = Join-Path $projectRoot 'desktop\node_modules\electron\dist\electron.exe'
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run install-desktop.ps1 to prepare Python.' }
if (-not (Test-Path -LiteralPath $electronPath)) { throw 'Run install-desktop.ps1 to prepare Electron.' }
Push-Location $projectRoot
try { & $electronPath (Join-Path $projectRoot 'desktop') }
finally { Pop-Location }
