$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
& 'E:/Node/node.exe' 'build/refresh-ui.cjs'
if($LASTEXITCODE -ne 0){throw 'UI refresh failed'}
& (Join-Path $PSScriptRoot 'clean-python-cache.ps1') -PythonRuntime (Join-Path $taskRoot 'release/win-unpacked/resources/teaching-python')
$taskVersion=(Get-Content -LiteralPath 'desktop/package.json' -Raw | ConvertFrom-Json).version
$taskRelease=[IO.Path]::GetFullPath((Join-Path $taskRoot 'release'))
foreach($taskName in @("ICE-Loop-Studio-$taskVersion-x64.zip","ice-loop-studio-$taskVersion-x64.nsis.zip")){
    $taskArchive=[IO.Path]::GetFullPath((Join-Path $taskRelease $taskName))
    if(-not $taskArchive.StartsWith($taskRelease+[IO.Path]::DirectorySeparatorChar)){throw 'Invalid archive target'}
    if(Test-Path -LiteralPath $taskArchive){
        $taskSaved=Join-Path $taskRoot ('.test-tmp/previous-ui-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'-'+$taskName)
        Move-Item -LiteralPath $taskArchive -Destination $taskSaved
    }
}
Set-Location -LiteralPath (Join-Path $taskRoot 'desktop')
& 'E:/Node/node.exe' 'node_modules/electron-builder/cli.js' --config electron-builder.json --prepackaged (Join-Path $taskRelease 'win-unpacked') --win nsis zip --x64
if($LASTEXITCODE -ne 0){throw 'UI distributable packaging failed'}
Set-Location -LiteralPath $taskRoot
& 'E:/Node/node.exe' 'build/verify-release.cjs'
if($LASTEXITCODE -ne 0){throw 'Packaged source audit failed'}
& '.venv/Scripts/python.exe' 'build/verify_release.py'
if($LASTEXITCODE -ne 0){throw 'Distributable audit failed'}
