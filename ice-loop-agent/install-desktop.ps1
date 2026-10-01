$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
if ([IO.Path]::GetPathRoot($projectRoot).ToLowerInvariant() -eq 'c:\') { throw 'Put the project on a data drive, such as G:.' }
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
$uvPath = if ($uvCommand) { $uvCommand.Source } else { Join-Path $env:USERPROFILE '.local\bin\uv.exe' }
if (-not (Test-Path -LiteralPath $uvPath)) { throw 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.12+ first.' }
$previousCache = $env:UV_CACHE_DIR
$previousPythonDir = $env:UV_PYTHON_INSTALL_DIR
$previousElectronCache = $env:electron_config_cache
Push-Location $projectRoot
try {
    $env:UV_CACHE_DIR = Join-Path $projectRoot '.review-uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot '.tools\python'
    $env:electron_config_cache = Join-Path $projectRoot 'desktop\.electron-cache'
    & $uvPath venv .venv --python 3.12 --managed-python
    if ($LASTEXITCODE -ne 0) { throw 'Python environment preparation failed.' }
    & $uvPath pip install --python .venv\Scripts\python.exe -e '.[server,test]'
    if ($LASTEXITCODE -ne 0) { throw 'Python dependencies failed to install.' }
    Push-Location (Join-Path $projectRoot 'desktop')
    try {
        & npm.cmd ci --cache .npm-cache
        if ($LASTEXITCODE -ne 0) { throw 'npm dependencies failed to install.' }
        & node node_modules\electron\install.js
        if ($LASTEXITCODE -ne 0) { throw 'Electron download failed. See docs/v0.2-desktop-guide.md for the checksum-verified curl fallback.' }
    } finally { Pop-Location }
    Write-Host 'Ready. Double-click start-desktop.cmd.'
} finally {
    Pop-Location
    $env:UV_CACHE_DIR = $previousCache
    $env:UV_PYTHON_INSTALL_DIR = $previousPythonDir
    $env:electron_config_cache = $previousElectronCache
}
