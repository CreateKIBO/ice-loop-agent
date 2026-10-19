$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$env:PATH='E:\Node;'+$env:PATH
& 'E:/Node/node.exe' desktop/build-components.cjs
if($LASTEXITCODE -ne 0){throw 'Local component bundle failed'}
# v2.0：新工作台产物先构建（Vite 离线 bundle 进 asar 的 ui/dist），失败即停。
& 'E:/Node/node.exe' build/build-new-ui.cjs
if($LASTEXITCODE -ne 0){throw 'New UI build failed'}
# 冻结前清掉源码树字节码缓存（可再生；否则 collect_data_files 会把 __pycache__ 收进引擎，
# verify_release 的"无生成缓存"审计会失败）。
$stalePycache = Get-ChildItem -LiteralPath (Join-Path $taskRoot 'ice_agent') -Recurse -Directory -Filter '__pycache__'
if($stalePycache){$stalePycache | Remove-Item -Recurse -Force}
& '.venv/Scripts/python.exe' -m PyInstaller --noconfirm --onedir --name ice-engine --distpath dist --workpath .test-tmp/pyinstaller --specpath build --paths . --collect-data ice_agent --collect-data pydantic --collect-data certifi --collect-submodules markdown_it --collect-submodules mdurl --collect-submodules httpx --collect-submodules httpcore --collect-submodules anyio build/engine_entry.py
if($LASTEXITCODE -ne 0){throw 'Python engine build failed'}
# PyInstaller 会把源码树的 __pycache__/*.pyc 当数据收进引擎（audit 零缓存要求）；
# 且命令行参数会回写 spec 文件，故排除逻辑只能放这里——冻结后清理 dist。
$enginePycache = Get-ChildItem -LiteralPath (Join-Path $taskRoot 'dist/ice-engine/_internal/ice_agent') -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue
Write-Host "[build-release] engine pycache dirs found: $($enginePycache.Count)"
if($enginePycache){$enginePycache | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue}
# verify_release 审计已区分 PyInstaller 托管字节码（.pyc.<magic> 放行，裸 .pyc 拦截），
# 故清理失败不阻断打包；剩余目录由审计裁决。
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
