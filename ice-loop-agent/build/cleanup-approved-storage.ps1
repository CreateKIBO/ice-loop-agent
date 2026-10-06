$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$testRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot '.test-tmp')).Path
$releaseRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'release')).Path
$validationRoot = (Resolve-Path -LiteralPath 'G:\ICE-Installer-Validation').Path
$docsRoot = Join-Path $projectRoot 'docs'
if ($projectRoot -ne 'G:\05-兴趣项目\gonzhonhao\wechat_agent\ice-loop-agent') { throw 'Unexpected project root' }
if ($testRoot -ne (Join-Path $projectRoot '.test-tmp') -or $releaseRoot -ne (Join-Path $projectRoot 'release') -or $validationRoot -ne 'G:\ICE-Installer-Validation') { throw 'Unexpected deletion boundary' }
$before = Get-PSDrive -Name G
$kept = @()
$targets = @()
foreach ($item in Get-ChildItem -LiteralPath $testRoot -Directory -Force) {
    $recent = @([regex]::Matches($item.Name, '\d{13}') | Where-Object { [long]$_.Value -ge 1791180000000 }).Count -gt 0
    if ($recent -or $item.Name.StartsWith('budget-')) { $kept += $item.FullName }
    else { $targets += $item.FullName }
}
$oldReleases = @(Get-ChildItem -LiteralPath $releaseRoot -File -Force | Where-Object {
    $_.Name -match '^ICE-Loop-Studio-(1\.0\.0|1\.1\.0|1\.1\.1|1\.2\.0|1\.3\.0|1\.4\.0|1\.4\.1|1\.5\.0)-(Setup\.exe|x64\.zip)$'
})
if ($oldReleases.Count -ne 16) { throw 'Historical release set differs from approved report' }
$plan = @{ approved = @('A','B','C'); kept_current_test_directories = $kept; historical_test_directories = $targets; validation = $validationRoot; old_releases = @($oldReleases.FullName) }
$plan | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $docsRoot 'G盘清理-2026-10-05-计划.json') -Encoding utf8
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $docsRoot 'G盘清理-2026-10-05-历史测试截图.zip'
if (Test-Path -LiteralPath $archivePath) { throw 'Evidence archive already exists' }
$archive = [System.IO.Compression.ZipFile]::Open($archivePath, [System.IO.Compression.ZipArchiveMode]::Create)
$archivedCount = 0
try {
    foreach ($target in $targets) {
        foreach ($file in Get-ChildItem -LiteralPath $target -File -Force | Where-Object { $_.Extension -eq '.png' -or $_.Name -like '*trace.log' }) {
            $relative = (Split-Path -Leaf $target) + '/' + $file.Name
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $archivedCount++
        }
    }
} finally { $archive.Dispose() }
$verify = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try { if ($verify.Entries.Count -ne $archivedCount) { throw 'Evidence archive incomplete' } } finally { $verify.Dispose() }
Write-Output "Archived $archivedCount historical screenshots and traces; preserved $($kept.Count) current test directories."
$removed = 0
$failures = @()
foreach ($target in $targets) {
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Parent $resolved) -ne $testRoot) { throw 'Out-of-bound test deletion' }
    try { Remove-Item -LiteralPath $resolved -Recurse -Force; $removed++ }
    catch { $failures += @{path=$resolved; error=$_.Exception.Message} }
    if (($removed % 500) -eq 0) { Write-Output "Historical test directories removed: $removed" }
}
if ((Resolve-Path -LiteralPath $validationRoot).Path -ne 'G:\ICE-Installer-Validation') { throw 'Out-of-bound validation deletion' }
try { Remove-Item -LiteralPath $validationRoot -Recurse -Force } catch { $failures += @{path=$validationRoot; error=$_.Exception.Message} }
foreach ($file in $oldReleases) {
    $resolved = (Resolve-Path -LiteralPath $file.FullName).Path
    if ((Split-Path -Parent $resolved) -ne $releaseRoot) { throw 'Out-of-bound release deletion' }
    try { Remove-Item -LiteralPath $resolved -Force } catch { $failures += @{path=$resolved; error=$_.Exception.Message} }
}
$after = Get-PSDrive -Name G
$result = @{ approved=@('A','B','C'); before_free_bytes=$before.Free; after_free_bytes=$after.Free; freed_bytes=$after.Free-$before.Free; historical_directories_removed=$removed; historical_directories_kept=$kept.Count; historical_release_files_removed=@($oldReleases | Where-Object { -not (Test-Path -LiteralPath $_.FullName) }).Count; archived_evidence_count=$archivedCount; archive=$archivePath; failures=$failures; validation_removed= -not (Test-Path -LiteralPath $validationRoot) }
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $docsRoot 'G盘清理-2026-10-05-结果.json') -Encoding utf8
$result | ConvertTo-Json -Depth 5
