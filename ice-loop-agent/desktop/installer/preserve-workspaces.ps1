# Keep working data outside old NSIS uninstallers' recursive removal of the program folder.
# Directory renames stay on the same volume; nothing in a workspace is read or rewritten.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Stage','Restore')][string]$Mode,
    [string]$InstallRoot,
    [string]$PreviousRoot,
    [string]$StageFile,
    [string]$ManifestPath
)
$ErrorActionPreference = 'Stop'
function Get-IceFull([string]$taskPath) {
    if(-not [IO.Path]::IsPathRooted($taskPath)) { throw 'A fully qualified path is required.' }
    [IO.Path]::GetFullPath($taskPath).TrimEnd('\','/')
}
function Test-IceWithin([string]$taskPath, [string]$taskRoot) {
    $taskPath.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Test-IceWorkspace([string]$taskPath) {
    (Test-Path -LiteralPath (Join-Path $taskPath 'app.db') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $taskPath 'settings.json') -PathType Leaf)
}
function Write-IceManifest($taskRecord, [string]$taskPath) {
    $taskPending = $taskPath + '.pending'
    [IO.File]::WriteAllText($taskPending, ($taskRecord | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    if(Test-Path -LiteralPath $taskPath) { [IO.File]::Replace($taskPending, $taskPath, $taskPath + '.previous') }
    else { [IO.File]::Move($taskPending, $taskPath) }
}
try {
    if($Mode -eq 'Stage') {
        if(-not $StageFile) { throw 'StageFile is required.' }
        if(Test-Path -LiteralPath $StageFile) { Write-Output 'Workspaces were already staged.'; exit 0 }
        $taskRoots = @($InstallRoot, $PreviousRoot | Where-Object { $_ } | ForEach-Object { Get-IceFull $_ } | Select-Object -Unique)
        $taskCandidates = @()
        foreach($taskRoot in $taskRoots) {
            if(-not (Test-Path -LiteralPath $taskRoot -PathType Container)) { continue }
            if((Get-Item -LiteralPath $taskRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation root cannot be a junction.' }
            foreach($taskDirectory in Get-ChildItem -LiteralPath $taskRoot -Directory -Force) {
                if($taskDirectory.Name -like 'ICE-Workspace-*' -and (Test-IceWorkspace $taskDirectory.FullName)) { $taskCandidates += $taskDirectory.FullName }
            }
        }
        $taskSelection = Join-Path $env:APPDATA 'ICE Loop Studio/workspace-path.json'
        if(Test-Path -LiteralPath $taskSelection -PathType Leaf) {
            $taskCurrent = (Get-Content -LiteralPath $taskSelection -Raw -Encoding UTF8 | ConvertFrom-Json).runtime_root
            if($taskCurrent) {
                $taskCurrent = Get-IceFull $taskCurrent
                if($taskRoots -contains $taskCurrent) { throw 'Working data cannot be the installation root itself.' }
                if(($taskRoots | Where-Object { Test-IceWithin $taskCurrent $_ }) -and (Test-IceWorkspace $taskCurrent)) { $taskCandidates += $taskCurrent }
            }
        }
        $taskCandidates = @($taskCandidates | Select-Object -Unique | Sort-Object Length)
        $taskRecord = [ordered]@{ schema=1; created=[DateTime]::UtcNow.ToString('o'); roots=$taskRoots; entries=@() }
        foreach($taskOriginal in $taskCandidates) {
            if($taskRecord.entries | Where-Object { Test-IceWithin $taskOriginal $_.original }) { continue }
            $taskOwnerRoot = @($taskRoots | Where-Object { Test-IceWithin $taskOriginal $_ })[0]
            if(-not $taskOwnerRoot) { throw 'Workspace is outside the validated installation roots.' }
            if((Get-Item -LiteralPath $taskOriginal).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Workspace cannot be a junction.' }
            $taskCheckParent = Split-Path -Parent $taskOriginal
            while($taskCheckParent -and $taskCheckParent -ne $taskOwnerRoot) {
                if((Get-Item -LiteralPath $taskCheckParent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Workspace parent cannot be a junction.' }
                $taskCheckParent = Split-Path -Parent $taskCheckParent
            }
            $taskRecord.entries += [ordered]@{ original=$taskOriginal; installation=$taskOwnerRoot; saved='' ; restored=$false }
        }
        if($taskRecord.entries.Count -eq 0) { Write-Output 'No workspaces inside program folders.'; exit 0 }
        $taskRecoveryRoot = Join-Path (Split-Path -Parent $taskRecord.entries[0].installation) '.ice-install-recovery'
        $taskRecovery = Join-Path $taskRecoveryRoot ([Guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Path $taskRecovery -Force)
        if((Get-Item -LiteralPath $taskRecoveryRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Recovery root cannot be a junction.' }
        $taskManifest = Join-Path $taskRecovery 'manifest.json'
        for($taskIndex=0; $taskIndex -lt $taskRecord.entries.Count; $taskIndex++) {
            $taskEntry = $taskRecord.entries[$taskIndex]
            # Each workspace's recovery directory must share its volume for an atomic rename.
            if([IO.Path]::GetPathRoot($taskEntry.original) -ine [IO.Path]::GetPathRoot($taskRecovery)) { throw 'Installation roots span different volumes; preserve workspaces with backup/restore first.' }
            $taskEntry.saved = Join-Path $taskRecovery ('workspace-' + $taskIndex)
        }
        Write-IceManifest $taskRecord $taskManifest
        [IO.File]::WriteAllText((Get-IceFull $StageFile), $taskManifest, [Text.UTF8Encoding]::new($false))
        foreach($taskEntry in $taskRecord.entries) {
            $taskOriginal = Get-IceFull $taskEntry.original; $taskSaved = Get-IceFull $taskEntry.saved
            if(-not (Test-IceWithin $taskOriginal $taskEntry.installation) -or -not (Test-IceWithin $taskSaved $taskRecovery)) { throw 'Invalid workspace move target.' }
            Move-Item -LiteralPath $taskOriginal -Destination $taskSaved -ErrorAction Stop
        }
        Write-Output "Workspaces preserved. Recovery manifest: $taskManifest"
    } else {
        if(-not $ManifestPath) {
            if(-not $StageFile -or -not (Test-Path -LiteralPath $StageFile -PathType Leaf)) { Write-Output 'No staged workspaces.'; exit 0 }
            $ManifestPath = Get-Content -LiteralPath $StageFile -Raw -Encoding UTF8
        }
        $taskManifest = Get-IceFull $ManifestPath
        $taskRecovery = Split-Path -Parent $taskManifest
        $taskRecord = Get-Content -LiteralPath $taskManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if($taskRecord.schema -ne 1 -or (Split-Path -Leaf (Split-Path -Parent $taskRecovery)) -ne '.ice-install-recovery') { throw 'Invalid recovery manifest.' }
        foreach($taskEntry in $taskRecord.entries) {
            $taskOriginal = Get-IceFull $taskEntry.original; $taskSaved = Get-IceFull $taskEntry.saved
            $taskInstall = Get-IceFull $taskEntry.installation
            if($taskRecord.roots -notcontains $taskInstall -or -not (Test-IceWithin $taskOriginal $taskInstall) -or -not (Test-IceWithin $taskSaved $taskRecovery)) { throw 'Invalid workspace restore target.' }
            if(Test-Path -LiteralPath $taskSaved -PathType Container) {
                if(Test-Path -LiteralPath $taskOriginal) { throw "Workspace destination already exists; preserved data retained at $taskSaved" }
                [void](New-Item -ItemType Directory -Path (Split-Path -Parent $taskOriginal) -Force)
                Move-Item -LiteralPath $taskSaved -Destination $taskOriginal -ErrorAction Stop
            } elseif(-not (Test-Path -LiteralPath $taskOriginal -PathType Container)) { throw "Workspace unavailable. See $taskManifest" }
            $taskEntry.restored = $true
            Write-IceManifest $taskRecord $taskManifest
        }
        Write-Output 'Workspaces restored to their original paths.'
    }
    exit 0
} catch { Write-Error $_ -ErrorAction Continue; exit 22 }
