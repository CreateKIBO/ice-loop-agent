$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$testRoot = (Resolve-Path -LiteralPath (Join-Path $taskRoot '.test-tmp')).Path
$resultPath = Join-Path $taskRoot 'docs/G盘清理-2026-10-05-结果.json'
$plan = Get-Content -LiteralPath (Join-Path $taskRoot 'docs/G盘清理-2026-10-05-计划.json') -Raw | ConvertFrom-Json
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -AsHashtable
$initialFailures = @($result.failures)
foreach ($failure in $initialFailures) {
    if (-not (Test-Path -LiteralPath $failure.path)) { continue }
    $target = (Resolve-Path -LiteralPath $failure.path).Path
    if ((Split-Path -Parent $target) -ne $testRoot -or $target -notin $plan.historical_test_directories) { throw 'Unapproved retry boundary' }
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Output ('Removed readonly historical fixture: ' + (Split-Path -Leaf $target))
}
$remaining = @($plan.historical_test_directories | Where-Object { Test-Path -LiteralPath $_ })
if ($remaining.Count -gt 0) { throw ('Historical fixtures remain: ' + ($remaining -join ', ')) }
if (Test-Path -LiteralPath 'G:\ICE-Installer-Validation') { throw 'Validation directory remains' }
if (@($plan.old_releases | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0) { throw 'Historical installers remain' }
foreach ($target in $plan.kept_current_test_directories) { if (-not (Test-Path -LiteralPath $target)) { throw 'Current test fixture missing' } }
foreach ($name in @('ICE-Loop-Studio-1.5.1-Setup.exe','ICE-Loop-Studio-1.5.1-x64.zip','ICE-Loop-Studio-1.5.2-x64.zip','win-unpacked')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot ('release/' + $name)))) { throw 'Preserved release missing' }
}
$disk = Get-PSDrive -Name G
$scan = Get-Content -LiteralPath (Join-Path $taskRoot 'docs/G盘存储分析-2026-10-05.json') -Raw | ConvertFrom-Json
$result.initial_readonly_failures = $initialFailures
$result.failures = @()
$result.approved_targets_verified_removed = $true
$result.total_historical_test_directories_removed = $plan.historical_test_directories.Count
$result.after_free_bytes = $disk.Free
$result.net_free_space_increase_since_scan = $disk.Free - $scan.disk_after.free
$result.finalized_at = (Get-Date).ToString('o')
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
@{ historical_test_directories_removed=$result.total_historical_test_directories_removed; old_installers_removed=$result.historical_release_files_removed; evidence_archived=$result.archived_evidence_count; free_GiB=[math]::Round($disk.Free/1GB,2); net_increase_GiB=[math]::Round($result.net_free_space_increase_since_scan/1GB,2); failures=0 } | ConvertTo-Json
