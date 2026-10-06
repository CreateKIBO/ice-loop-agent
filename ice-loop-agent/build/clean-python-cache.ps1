param([Parameter(Mandatory=$true)][string]$PythonRuntime)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtimeRoot=(Resolve-Path -LiteralPath $PythonRuntime).Path
$allowedRoots=@(
    [IO.Path]::GetFullPath((Join-Path $taskRoot 'dist/teaching-python')),
    [IO.Path]::GetFullPath((Join-Path $taskRoot 'release/win-unpacked/resources/teaching-python'))
)
if($runtimeRoot -notin $allowedRoots){throw 'Cache cleanup is restricted to generated teaching runtimes'}
$taskCachePaths=@(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Recurse -Filter '__pycache__' | Select-Object -ExpandProperty FullName)
foreach($cachePath in $taskCachePaths){
    $resolvedCache=[IO.Path]::GetFullPath($cachePath)
    if(-not $resolvedCache.StartsWith($runtimeRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Cache path escaped runtime'}
    if((Get-Item -LiteralPath $resolvedCache).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing linked cache directory'}
    Remove-Item -LiteralPath $resolvedCache -Recurse -Force
}
Write-Output ('Removed generated Python cache directories: '+$taskCachePaths.Count)
