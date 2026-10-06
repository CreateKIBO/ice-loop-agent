$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Set-Location -LiteralPath $taskRoot
$env:PATH='E:\Node;'+$env:PATH
& '.venv/Scripts/python.exe' -m PyInstaller --noconfirm --onedir --name ice-engine --distpath dist --workpath .test-tmp/pyinstaller --specpath build --paths . --collect-data ice_agent build/engine_entry.py
if($LASTEXITCODE -ne 0){throw 'Engine build failed'}
$taskTarget=[IO.Path]::GetFullPath((Join-Path $taskRoot 'release/win-unpacked/resources/engine'))
$taskParent=[IO.Path]::GetFullPath((Join-Path $taskRoot 'release/win-unpacked/resources'))
if($taskTarget -ne (Join-Path $taskParent 'engine') -or -not $taskTarget.StartsWith($taskRoot+[IO.Path]::DirectorySeparatorChar)){throw 'Unsafe generated engine target'}
if(Test-Path -LiteralPath $taskTarget){Remove-Item -LiteralPath $taskTarget -Recurse -Force}
Copy-Item -LiteralPath (Join-Path $taskRoot 'dist/ice-engine') -Destination $taskTarget -Recurse
& (Join-Path $PSScriptRoot 'repack-ui.ps1')
