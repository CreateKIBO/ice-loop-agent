param([Parameter(Mandatory=$true)][int]$RootProcessId)
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$root = $all | Where-Object { $_.ProcessId -eq $RootProcessId }
if ($null -eq $root -or $root.Name -ne 'electron.exe' -or $root.CommandLine -notlike '*ice-loop-agent*--remote-debugging-port*') {
    throw 'The requested root is not the owned Electron test instance'
}
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($RootProcessId)
$born = @{}
$born[$RootProcessId] = $root.CreationDate
do {
    $grew = $false
    foreach ($item in $all) {
        # Exclude this measurement shell; its descendants must not inflate the app.
        if ([int]$item.ProcessId -eq $PID) { continue }
        # Windows reuses PIDs: an old process can name our fresh PID as its
        # historical parent. Include descendants only when born after their
        # currently observed parent, otherwise memory totals include other apps.
        if ($owned.Contains([int]$item.ParentProcessId) -and $null -ne $item.CreationDate -and
            $item.CreationDate -ge $born[[int]$item.ParentProcessId] -and $owned.Add([int]$item.ProcessId)) {
            $born[[int]$item.ProcessId] = $item.CreationDate
            $grew = $true
        }
    }
} while ($grew)
$rows = @(Get-Process -Id @($owned) -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, WorkingSet64, PrivateMemorySize64, HandleCount)
[pscustomobject]@{
    root_pid = $RootProcessId
    excluded_sampler_pid = $PID
    processes = $rows
    working_set_total = ($rows | Measure-Object WorkingSet64 -Sum).Sum
    private_bytes_total = ($rows | Measure-Object PrivateMemorySize64 -Sum).Sum
} | ConvertTo-Json -Depth 4 -Compress
