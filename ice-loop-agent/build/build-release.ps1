$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$env:PATH='E:\Node;'+$env:PATH
& 'E:/Node/node.exe' desktop/build-components.cjs
if($LASTEXITCODE -ne 0){throw 'Local component bundle failed'}
& '.venv/Scripts/python.exe' -m PyInstaller --noconfirm --onedir --name ice-engine --distpath dist --workpath .test-tmp/pyinstaller --specpath build --paths . --collect-data ice_agent build/engine_entry.py
if($LASTEXITCODE -ne 0){throw 'Python engine build failed'}
& 'E:/Node/node.exe' build/prepare-release.cjs
if($LASTEXITCODE -ne 0){throw 'Resource preparation failed'}
& (Join-Path $PSScriptRoot 'clean-python-cache.ps1') -PythonRuntime (Join-Path $taskRoot 'dist/teaching-python')
$releaseRoot=[IO.Path]::GetFullPath((Join-Path $taskRoot 'release'))
$releaseVersion=(Get-Content -LiteralPath 'desktop/package.json' -Raw | ConvertFrom-Json).version
$previousZip=[IO.Path]::GetFullPath((Join-Path $releaseRoot ('ICE-Loop-Studio-'+$releaseVersion+'-x64.zip')))
if(Test-Path -LiteralPath $previousZip){
    if(-not $previousZip.StartsWith($releaseRoot+[IO.Path]::DirectorySeparatorChar)){throw 'Invalid generated archive target'}
    $savedZip=Join-Path $taskRoot ('.test-tmp/previous-release-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.zip')
    Move-Item -LiteralPath $previousZip -Destination $savedZip
}
Set-Location -LiteralPath (Join-Path $taskRoot 'desktop')
& 'E:/Node/node.exe' node_modules/electron-builder/cli.js --config electron-builder.json --config.electronDist=./node_modules/electron/dist --win nsis zip --x64
if($LASTEXITCODE -ne 0){throw 'Windows package build failed'}
Set-Location -LiteralPath $taskRoot
& 'E:/Node/node.exe' build/verify-release.cjs
if($LASTEXITCODE -ne 0){throw 'Packaged desktop source audit failed'}
& '.venv/Scripts/python.exe' build/verify_release.py
if($LASTEXITCODE -ne 0){throw 'Distributable binary/data audit failed'}
