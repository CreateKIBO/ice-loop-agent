# Delete only byte-identical files in a manifest embedded in the uninstaller.
# No recursive removal or junction/symlink traversal.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$ManifestPath,
    [Parameter(Mandatory=$true)][string]$ReportPath
)
$ErrorActionPreference = 'Stop'
$taskReport = [ordered]@{ schema=1; removed=@(); preserved_modified=@(); missing=@(); errors=@(); directories_removed=@() }
function Get-IceFull([string]$taskPath) {
    if($taskPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw 'A fully qualified directory is required.' }
    [IO.Path]::GetFullPath($taskPath).TrimEnd([char[]]'\/')
}
function Assert-IceNoLinks([string]$taskPath) {
    $taskCursor = $taskPath
    while($taskCursor) {
        if(Test-Path -LiteralPath $taskCursor) {
            $taskInfo = Get-Item -LiteralPath $taskCursor -Force
            if($taskInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path is not removable: $taskCursor" }
        }
        $taskParent = Split-Path -Parent $taskCursor
        if($taskParent -eq $taskCursor) { break }
        $taskCursor = $taskParent
    }
}
function Get-IceHash([string]$taskFile) {
    $taskStream = [IO.File]::Open($taskFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $taskHash = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($taskHash.ComputeHash($taskStream)).Replace('-','') }
    finally { $taskHash.Dispose(); $taskStream.Dispose() }
}
function Write-IceResult {
    [IO.File]::WriteAllText($ReportPath,($taskReport | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
try {
    $taskRoot = Get-IceFull $InstallRoot
    if($taskRoot -eq [IO.Path]::GetPathRoot($taskRoot).TrimEnd([char[]]'\/')) { throw 'A drive or share root is not an installation directory.' }
    Assert-IceNoLinks $taskRoot
    $taskManifestFile = Get-Item -LiteralPath $ManifestPath -Force
    if($taskManifestFile.Length -gt 8388608) { throw 'Installation manifest is too large.' }
    $taskManifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($taskManifest.schema -ne 1 -or -not $taskManifest.files -or $taskManifest.files.Count -gt 20000) { throw 'Invalid installation manifest.' }
    # The install receipt is generated metadata, removable only if it matches our embedded manifest.
    $taskReceipt = Join-Path $taskRoot 'ICE-INSTALL-FILES.json'
    if(Test-Path -LiteralPath $taskReceipt -PathType Leaf) {
        $taskReceiptInfo = Get-Item -LiteralPath $taskReceipt -Force
        if(-not ($taskReceiptInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $taskEmbeddedHash = Get-IceHash $ManifestPath
            if($taskReceiptInfo.Length -eq $taskManifestFile.Length -and (Get-IceHash $taskReceipt) -ieq $taskEmbeddedHash) {
                $taskManifest.files = @($taskManifest.files) + @([pscustomobject]@{path='ICE-INSTALL-FILES.json';bytes=$taskReceiptInfo.Length;sha256=$taskEmbeddedHash.ToLowerInvariant()})
            }
        }
    }
    $taskSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $taskDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $taskPending = @()
    foreach($taskRow in $taskManifest.files) {
        $taskRelative = [string]$taskRow.path
        if(-not $taskRelative -or $taskRelative -match '[\\:\x00-\x1f]' -or $taskRelative.StartsWith('/')) { throw 'Invalid relative install entry.' }
        foreach($taskSegment in $taskRelative.Split('/')) {
            if(-not $taskSegment -or $taskSegment -in @('.','..') -or $taskSegment -match '[ .]$' -or $taskSegment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Unsafe install entry segment.' }
        }
        if(-not $taskSeen.Add($taskRelative) -or $taskRow.sha256 -notmatch '^[0-9a-f]{64}$' -or $taskRow.bytes -isnot [ValueType] -or $taskRow.bytes -lt 0) { throw 'Invalid or duplicate install identity.' }
        $taskFull = Get-IceFull (Join-Path $taskRoot $taskRelative)
        if(-not $taskFull.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Install entry escaped its root.' }
        Assert-IceNoLinks $taskFull
        $taskDirectory = Split-Path -Parent $taskFull
        while($taskDirectory -and $taskDirectory -ne $taskRoot) {
            [void]$taskDirectories.Add($taskDirectory)
            $taskDirectory = Split-Path -Parent $taskDirectory
        }
        if(-not (Test-Path -LiteralPath $taskFull -PathType Leaf)) { $taskReport.missing += $taskRelative; continue }
        $taskInfo = Get-Item -LiteralPath $taskFull -Force
        if($taskInfo.Length -ne $taskRow.bytes -or (Get-IceHash $taskFull) -ine $taskRow.sha256) { $taskReport.preserved_modified += $taskRelative; continue }
        $taskPending += [pscustomobject]@{ relative=$taskRelative; full=$taskFull; bytes=$taskRow.bytes; hash=$taskRow.sha256 }
    }
    foreach($taskEntry in $taskPending) {
        Assert-IceNoLinks $taskEntry.full
        if(-not (Test-Path -LiteralPath $taskEntry.full -PathType Leaf)) { $taskReport.missing += $taskEntry.relative; continue }
        $taskInfo = Get-Item -LiteralPath $taskEntry.full -Force
        if($taskInfo.Length -ne $taskEntry.bytes -or (Get-IceHash $taskEntry.full) -ine $taskEntry.hash) { $taskReport.preserved_modified += $taskEntry.relative; continue }
        Remove-Item -LiteralPath $taskEntry.full -Force -ErrorAction Stop
        $taskReport.removed += $taskEntry.relative
    }
    foreach($taskDirectory in ($taskDirectories | Sort-Object Length -Descending)) {
        Assert-IceNoLinks $taskDirectory
        if((Test-Path -LiteralPath $taskDirectory -PathType Container) -and -not (Get-ChildItem -LiteralPath $taskDirectory -Force | Select-Object -First 1)) {
            Remove-Item -LiteralPath $taskDirectory -ErrorAction Stop
            $taskReport.directories_removed += $taskDirectory
        }
    }
    Write-IceResult
    exit 0
} catch {
    $taskReport.errors += $_.Exception.Message
    try { Write-IceResult } catch {}
    Write-Error $_ -ErrorAction Continue
    exit 23
}
