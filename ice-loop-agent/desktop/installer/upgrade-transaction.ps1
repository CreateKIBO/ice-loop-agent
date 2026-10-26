# Legacy-safe upgrade: stage complete installations and never execute their uninstallers.
# All moves are same-volume, no-replace Win32 renames. Unknown data is journalled.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Stage','Commit','Rollback')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$AppGuid,
    [ValidateSet('currentuser','all')][string]$InstallMode='currentuser',
    [ValidateSet('32','64')][string]$RegistryView='64',
    [string]$StageFile,
    [string]$ManifestPath,
    [string]$PayloadManifest,
    [string]$StopScript,
    [string]$ReportPath=(Join-Path $env:TEMP 'ICE-Loop-Upgrade.json')
)
$ErrorActionPreference='Stop'
# PSScriptRoot is not populated while PowerShell 5.1 binds parameter defaults.
if(-not $StageFile){$StageFile=Join-Path $PSScriptRoot 'ice-upgrade-stage.txt'}
if(-not $PayloadManifest){$PayloadManifest=Join-Path $PSScriptRoot 'ice-install-files.json'}
if(-not $StopScript){$StopScript=Join-Path $PSScriptRoot 'ice-stop-agent.ps1'}
$taskRecord=$null; $taskManifest=$null; $taskRecoveryTrusted=$false
# NSIS uses a native System.dll in its working directory. Bind the managed reference
# by its already-loaded framework location, never by a relative assembly name.
Add-Type -ReferencedAssemblies ([System.ComponentModel.Win32Exception].Assembly.Location) -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class IceUpgradeRename {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool MoveFileW(string source, string target);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool MoveFileExW(string source, string target, uint flags);
    public static void Replace(string source, string target) {
        if(!MoveFileExW(source,target,0x1 | 0x8)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Move(string source, string target) {
        if(!MoveFileW(source,target)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
}
"@
function Full([string]$p) {
    if($p -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw 'A fully qualified path is required.' }
    $v=[IO.Path]::GetFullPath($p).TrimEnd([char[]]'\/')
    if($v -eq [IO.Path]::GetPathRoot($v).TrimEnd([char[]]'\/')) { throw 'A volume/share root is not an installation.' }
    $v
}
function Long([string]$p) {
    if($p.StartsWith('\\?\')) { return $p }
    if($p.StartsWith('\\')) { return '\\?\UNC\'+$p.Substring(2) }
    '\\?\'+$p
}
function Normal([string]$p) {
    if($p.StartsWith('\\?\UNC\')) { return '\\'+$p.Substring(8) }
    if($p.StartsWith('\\?\')) { return $p.Substring(4) }
    $p
}
function Attr([string]$p) {
    try { [IO.File]::GetAttributes((Long $p)) }
    catch [IO.FileNotFoundException] { $null }
    catch [IO.DirectoryNotFoundException] { $null }
}
function Exists([string]$p) { $null -ne (Attr $p) }
function Within([string]$p,[string]$root) { $p.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) }
function NoLinks([string]$p) {
    $cursor=$p
    while($cursor) {
        $a=Attr $cursor
        if($null -ne $a -and ($a -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked ancestor: $cursor" }
        $parent=[IO.Path]::GetDirectoryName($cursor)
        if($parent -eq $cursor) { break }
        $cursor=$parent
    }
}
function MakeDir([string]$p) { NoLinks $p; [void][IO.Directory]::CreateDirectory((Long $p)) }
function Rename([string]$source,[string]$target) {
    NoLinks ([IO.Path]::GetDirectoryName($source)); NoLinks ([IO.Path]::GetDirectoryName($target))
    if([IO.Path]::GetPathRoot($source) -ine [IO.Path]::GetPathRoot($target)) { throw 'Recovery rename must stay on its original volume.' }
    if(Exists $target) { throw "Rename destination already exists: $target" }
    MakeDir ([IO.Path]::GetDirectoryName($target))
    [IceUpgradeRename]::Move((Long $source),(Long $target))
}
function ReadJson([string]$p) { [IO.File]::ReadAllText((Long $p),[Text.Encoding]::UTF8) | ConvertFrom-Json }
function WriteJson([string]$p,$v) {
    $pending=$p+'.pending'
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($v | ConvertTo-Json -Depth 24))
    $stream=[IO.File]::Open((Long $pending),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    # ReplaceFile can leave only backup/pending files when killed mid-operation.
    # Same-volume MoveFileEx replaces the name without first moving it out of the way.
    [IceUpgradeRename]::Replace((Long $pending),(Long $p))
}
function Save { WriteJson $taskManifest $taskRecord }
function Hash([string]$p) {
    $s=[IO.File]::Open((Long $p),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $h=[Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($h.ComputeHash($s)).Replace('-','').ToLowerInvariant() }
    finally { $h.Dispose();$s.Dispose() }
}
function Relative([string]$p) {
    if(-not $p -or $p -match '[\\:\x00-\x1f]' -or $p.StartsWith('/')) { throw 'Invalid payload path.' }
    foreach($segment in $p.Split('/')) {
        if(-not $segment -or $segment -in @('.','..') -or $segment -match '[ .]$') { throw 'Invalid payload path segment.' }
    }
    $p
}
$guidValue=[Guid]::Empty
if(-not [Guid]::TryParse($AppGuid,[ref]$guidValue)) { throw 'Invalid application GUID.' }
$AppGuid=$guidValue.ToString()
$InstallRoot=Full $InstallRoot
$taskView=if($RegistryView -eq '64'){[Microsoft.Win32.RegistryView]::Registry64}else{[Microsoft.Win32.RegistryView]::Registry32}
$taskSelected=if($InstallMode -eq 'all'){'LocalMachine'}else{'CurrentUser'}
$taskRecoveryKey='Software\'+$AppGuid+'.Upgrade'
$taskKeyNames=@(('Software\'+$AppGuid),('Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$AppGuid))
function Hive([string]$name) {
    if($name -notin @('CurrentUser','LocalMachine')) { throw 'Invalid registry hive.' }
    [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$name,$taskView)
}
function RegistrySnapshot([string]$hiveName,[string]$keyName) {
    $base=Hive $hiveName
    try {
        $key=$base.OpenSubKey($keyName)
        if(-not $key) { return [pscustomobject]@{hive=$hiveName;key=$keyName;existed=$false;values=@()} }
        try {
            if($key.GetSubKeyNames().Length) { throw 'Unexpected nested installation registration.' }
            $values=@()
            foreach($name in $key.GetValueNames()) {
                $kind=$key.GetValueKind($name).ToString();$data=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if($kind -in @('Binary','None')) { $data=[Convert]::ToBase64String($data) }
                elseif($kind -in @('DWord','QWord')) { $data=$data.ToString([Globalization.CultureInfo]::InvariantCulture) }
                $values += [pscustomobject]@{name=$name;kind=$kind;data=$data}
            }
            [pscustomobject]@{hive=$hiveName;key=$keyName;existed=$true;values=$values}
        } finally { $key.Dispose() }
    } finally { $base.Dispose() }
}
function RegValue($snapshot,[string]$name) {
    $row=@($snapshot.values | Where-Object {$_.name -eq $name})
    if($row.Count) { return $row[0].data }
    $null
}
function SetHidden($snapshot) {
    if(-not $snapshot.existed -or $snapshot.key -ne $taskKeyNames[1]) { return }
    $base=Hive $snapshot.hive
    try { $key=$base.OpenSubKey($snapshot.key,$true);try { if($key){$key.DeleteValue('UninstallString',$false)} }finally{if($key){$key.Dispose()}} }finally{$base.Dispose()}
}
function RestoreRegistry {
    foreach($snapshot in $taskRecord.registry) {
        if($snapshot.key -notin $taskKeyNames) { throw 'Recovery key escaped the app identity.' }
        $base=Hive $snapshot.hive
        try {
            if(-not $snapshot.existed) { $base.DeleteSubKeyTree($snapshot.key,$false);continue }
            $key=$base.CreateSubKey($snapshot.key)
            try {
                foreach($name in $key.GetValueNames()) { $key.DeleteValue($name,$false) }
                foreach($row in $snapshot.values) {
                    $data=$row.data
                    if($row.kind -in @('Binary','None')) {$data=[Convert]::FromBase64String([string]$data)}
                    elseif($row.kind -eq 'DWord') {$data=[int]::Parse([string]$data,[Globalization.CultureInfo]::InvariantCulture)}
                    elseif($row.kind -eq 'QWord') {$data=[long]::Parse([string]$data,[Globalization.CultureInfo]::InvariantCulture)}
                    elseif($row.kind -eq 'MultiString') {$data=[string[]]@($data)}
                    $key.SetValue([string]$row.name,$data,[Microsoft.Win32.RegistryValueKind]::$($row.kind))
                }
            }finally{$key.Dispose()}
        }finally{$base.Dispose()}
    }
}
function LoadRecord {
    $script:taskRecoveryTrusted=$false
    $script:taskRecord=$null
    if(-not $ManifestPath) {
        if(-not $StageFile -or -not (Exists $StageFile)) { return $false }
        $script:taskManifest=Full ([IO.File]::ReadAllText((Long $StageFile),[Text.Encoding]::UTF8))
    }else{$script:taskManifest=Full $ManifestPath}
    # Recover records written by the older ReplaceFile writer too. A complete
    # pending record is safe: move intents are persisted before filesystem moves.
    $recordError=$null
    foreach($candidate in @($taskManifest,($taskManifest+'.pending'),($taskManifest+'.previous'))) {
        if(-not (Exists $candidate)){continue}
        try { $script:taskRecord=ReadJson $candidate;break } catch { $recordError=$_.Exception.Message }
    }
    if(-not $taskRecord){throw ("No complete recovery record: "+$recordError)}
    if($taskRecord.schema -ne 2 -or $taskRecord.app_guid -ne $AppGuid -or $taskRecord.target -ine $InstallRoot -or $taskRecord.hive -ne $taskSelected -or $taskRecord.registry_view -ne $RegistryView) { throw 'Recovery identity does not match this install.' }
    foreach($root in $taskRecord.roots) {
        $original=Full $root.original;$backup=Full $root.backup
        if($original -ine $root.original -or $backup -ine $root.backup -or [IO.Path]::GetPathRoot($original) -ine [IO.Path]::GetPathRoot($backup)) { throw 'Invalid recovery root.' }
        $holder=[IO.Path]::GetDirectoryName($backup)
        if([IO.Path]::GetFileName([IO.Path]::GetDirectoryName($holder)) -ne '.ice-install-recovery') { throw 'Invalid recovery container.' }
        $owner=ReadJson (Join-Path $holder 'OWNER.json')
        if($owner.transaction -ne $taskRecord.transaction -or $owner.app_guid -ne $AppGuid) { throw 'Unowned recovery container.' }
        NoLinks $holder
    }
    foreach($snapshot in $taskRecord.registry) {
        if($snapshot.key -notin $taskKeyNames -or ($snapshot.hive -ne $taskSelected -and -not ($taskSelected -eq 'LocalMachine' -and $snapshot.hive -eq 'CurrentUser'))){throw 'Recovery registry escaped its identity.'}
    }
    foreach($entry in $taskRecord.moves) {
        if((Full $entry.source) -ine $entry.source -or (Full $entry.target) -ine $entry.target){throw 'Recovery move escaped its canonical path.'}
        $root=@($taskRecord.roots | Where-Object {(Within $entry.source $_.backup) -and (Within $entry.target $_.original)})
        if($root.Count -ne 1) { throw 'Recovery move escaped its installation.' }
    }
    $script:taskRecoveryTrusted=$true
    $true
}
function ClearRecoveryPointer {
    $base=Hive $taskSelected
    try {
        $key=$base.OpenSubKey($taskRecoveryKey,$true)
        if($key){
            try{$key.DeleteValue('RecoveryManifest',$false);$empty=($key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0)}finally{$key.Dispose()}
            if($empty){$base.DeleteSubKey($taskRecoveryKey,$false)}
        }
    }finally{$base.Dispose()}
}
function StopRecoveryProcesses {
    if(-not $taskRecord.roots.Count){return}
    if(-not $StopScript){throw 'A verified stop helper is required for recovery.'}
    $paths=@(@($taskRecord.target)+@($taskRecord.roots | ForEach-Object {$_.original}) | Select-Object -Unique)
    foreach($root in $paths){
        & (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopScript -InstallRoot $root
        if($LASTEXITCODE -ne 0){throw 'A recovery process could not be stopped.'}
    }
}
function Rollback {
    if($taskRecord.phase -in @('committed','rolled_back','fresh')) { return }
    StopRecoveryProcesses
    $taskRecord.phase='rolling_back';Save
    foreach($root in @($taskRecord.roots)) {
        # A prior rollback may have restored this whole root before it was killed.
        # Replaying its move journal would recreate an incomplete backup.
        if(-not (Exists $root.backup)){
            if(-not (Exists $root.original)){throw 'Original installation and recovery are both missing.'}
            continue
        }
        $moves=@($taskRecord.moves | Where-Object { Within $_.source $root.backup })
        for($i=$moves.Count-1;$i -ge 0;$i--) {
            $m=$moves[$i]
            if((Exists $m.target) -and -not (Exists $m.source)) { Rename $m.target $m.source }
            elseif(-not (Exists $m.target) -and -not (Exists $m.source)) { throw "Both recovery copies are missing: $($m.target)" }
        }
        if(Exists $root.original) {
            $failed=Join-Path ([IO.Path]::GetDirectoryName($root.backup)) ('failed-new-'+[Guid]::NewGuid().ToString('N'))
            Rename $root.original $failed
            $taskRecord.failed_directories+=@($failed);Save
        }
        Rename $root.backup $root.original
    }
    RestoreRegistry
    $taskRecord.phase='rolled_back';Save
    ClearRecoveryPointer
}
function LooksLikeIce([string]$root) {
    foreach($relative in @('ICE Loop Studio.exe','Uninstall ICE Loop Studio.exe','resources/app.asar','resources/engine/ice-engine.exe')) {
        $p=Join-Path $root $relative;$a=Attr $p
        if($null -ne $a -and -not ($a -band [IO.FileAttributes]::ReparsePoint) -and -not ($a -band [IO.FileAttributes]::Directory)) { return $true }
    }
    $false
}
function QueueMove([string]$source,[string]$target) {
    NoLinks ([IO.Path]::GetDirectoryName($target))
    if(Exists $target) {
        $taskRecord.conflicts+=@([pscustomobject]@{saved=$source;target=$target;reason='Destination already exists; no overwrite.'});Save;return
    }
    $entry=[pscustomobject]@{source=$source;target=$target;performed=$false}
    $taskRecord.moves+=@($entry);Save
    Rename $source $target
    $entry.performed=$true;Save
}
function MergeUnknown($root,[string]$source,[string]$relative) {
    $target=Join-Path $root.original $relative
    $portable=$relative.Replace('\','/')
    $a=Attr $source
    if($null -eq $a) { throw 'Staged data disappeared.' }
    if($taskPayloadFiles.Contains($portable)) { return }
    if($taskOldFiles.ContainsKey($portable) -and -not ($a -band [IO.FileAttributes]::ReparsePoint) -and -not ($a -band [IO.FileAttributes]::Directory)) {
        if((Hash $source) -eq $taskOldFiles[$portable]) { return }
    }
    if(($a -band [IO.FileAttributes]::ReparsePoint) -or -not ($a -band [IO.FileAttributes]::Directory)) { QueueMove $source $target;return }
    if(-not $taskPayloadParents.Contains($portable) -and -not (Exists $target)) { QueueMove $source $target;return }
    if(Exists $target) {
        $targetAttr=Attr $target
        if(($targetAttr -band [IO.FileAttributes]::ReparsePoint) -or -not ($targetAttr -band [IO.FileAttributes]::Directory)) {
            $taskRecord.conflicts+=@([pscustomobject]@{saved=$source;target=$target;reason='Directory conflict; no traversal.'});Save;return
        }
    }
    foreach($child in [IO.Directory]::EnumerateFileSystemEntries((Long $source))) {
        $plain=Normal $child;MergeUnknown $root $plain (Join-Path $relative ([IO.Path]::GetFileName($plain)))
    }
}
try {
    if($Mode -eq 'Stage') {
        if(-not $StageFile -or -not $PayloadManifest) { throw 'StageFile and payload manifest are required.' }
        if(Exists $StageFile) {
            if(-not (LoadRecord)) { throw 'Cannot load existing upgrade.' }
            if($taskRecord.phase -ne 'staged' -and $taskRecord.phase -ne 'fresh') { throw 'An interrupted upgrade requires rollback before retry.' }
            foreach($root in $taskRecord.roots) { if(-not (Exists $root.backup) -or (Exists $root.original)){throw 'Staged directory no longer matches the recorded state.'} }
            foreach($snapshot in $taskRecord.registry) {
                if($snapshot.key -eq $taskKeyNames[1]) { if(RegValue (RegistrySnapshot $snapshot.hive $snapshot.key) 'UninstallString'){throw 'Old uninstaller registration returned unexpectedly.'} }
            }
            Write-Output 'Upgrade is already staged.';exit 0
        }
        # A new installer has a new PLUGINSDIR. The registry pointer survives it.
        $pending=RegValue (RegistrySnapshot $taskSelected $taskRecoveryKey) 'RecoveryManifest'
        if($pending){
            $ManifestPath=[string]$pending
            [void](LoadRecord)
            Rollback
            ClearRecoveryPointer
            $ManifestPath=$null;$taskRecord=$null;$taskManifest=$null
        }
        NoLinks $InstallRoot
        $payload=ReadJson $PayloadManifest
        if($payload.schema -ne 1 -or -not $payload.files) { throw 'Invalid payload manifest.' }
        foreach($row in $payload.files) {[void](Relative ([string]$row.path));if($row.sha256 -notmatch '^[0-9a-f]{64}$'){throw 'Invalid payload hash.'}}
        $snapshots=@();$hives=@($taskSelected);if($taskSelected -eq 'LocalMachine'){$hives+=@('CurrentUser')}
        $roots=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach($hiveName in $hives) {
            $installSnapshot=RegistrySnapshot $hiveName $taskKeyNames[0]
            $snapshots+=@($installSnapshot);$snapshots+=@(RegistrySnapshot $hiveName $taskKeyNames[1])
            $oldRoot=RegValue $installSnapshot 'InstallLocation'
            if($oldRoot) {
                $oldRoot=Full ([string]$oldRoot);NoLinks $oldRoot
                if(Exists $oldRoot) { if(-not (LooksLikeIce $oldRoot)){throw 'Registered directory lacks ICE program markers.'};[void]$roots.Add($oldRoot) }
            }
        }
        if(Exists $InstallRoot) {
            if(@([IO.Directory]::EnumerateFileSystemEntries((Long $InstallRoot))).Count) {
                if(-not (LooksLikeIce $InstallRoot)) { throw 'Choose an empty directory or an existing ICE installation.' }
                [void]$roots.Add($InstallRoot)
            }
        }
        $rootList=@($roots)
        foreach($a in $rootList){foreach($b in @($rootList)+@($InstallRoot)){if($a -ine $b -and ((Within $a $b) -or (Within $b $a))){throw 'Nested installation directories cannot be migrated.'}}}
        if($roots.Count -and -not $StopScript) { throw 'A verified stop helper is required.' }
        foreach($oldRoot in $rootList) {
            & (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopScript -InstallRoot $oldRoot -ReportPath (Join-Path ([IO.Path]::GetDirectoryName($StageFile)) ('stop-'+[Guid]::NewGuid().ToString('N')+'.json'))
            if($LASTEXITCODE -ne 0){throw 'An installation process could not be stopped.'}
        }
        $transaction=[Guid]::NewGuid().ToString('N')
        $hasHistory=$rootList.Count -or @($snapshots | Where-Object {$_.existed}).Count
        $records=@()
        foreach($oldRoot in $rootList) {
            $container=Join-Path ([IO.Path]::GetDirectoryName($oldRoot)) ('.ice-install-recovery\'+$transaction)
            MakeDir $container
            WriteJson (Join-Path $container 'OWNER.json') ([pscustomobject]@{schema=2;transaction=$transaction;app_guid=$AppGuid})
            $records+=@([pscustomobject]@{original=$oldRoot;backup=(Join-Path $container ('program-'+$records.Count));staged=$false})
        }
        if($records.Count){$holder=[IO.Path]::GetDirectoryName($records[0].backup)}
        elseif($hasHistory){
            $parent=[IO.Path]::GetDirectoryName($InstallRoot);while(-not (Exists $parent)){$parent=[IO.Path]::GetDirectoryName($parent)}
            $holder=Join-Path $parent ('.ice-install-recovery\'+$transaction);MakeDir $holder
            WriteJson (Join-Path $holder 'OWNER.json') ([pscustomobject]@{schema=2;transaction=$transaction;app_guid=$AppGuid})
        }else{$holder=[IO.Path]::GetDirectoryName((Full $StageFile))}
        $taskManifest=Join-Path $holder 'manifest.json'
        $payloadCopy=Join-Path $holder 'payload.json';[IO.File]::Copy((Long $PayloadManifest),(Long $payloadCopy),$false)
        $taskRecord=[pscustomobject]@{schema=2;transaction=$transaction;app_guid=$AppGuid;target=$InstallRoot;hive=$taskSelected;registry_view=$RegistryView;phase=$(if($hasHistory){'staging'}else{'fresh'});roots=$records;registry=$snapshots;payload=$payloadCopy;payload_hash=(Hash $payloadCopy);moves=@();conflicts=@();failed_directories=@();created=[DateTime]::UtcNow.ToString('o')}
        $taskRecoveryTrusted=$true
        Save
        [IO.File]::WriteAllText((Long (Full $StageFile)),$taskManifest,[Text.UTF8Encoding]::new($false))
        if($hasHistory){
            $base=Hive $taskSelected
            try{$key=$base.CreateSubKey($taskRecoveryKey);try{$key.SetValue('RecoveryManifest',$taskManifest)}finally{$key.Dispose()}}finally{$base.Dispose()}
        }
        foreach($root in $taskRecord.roots){Rename $root.original $root.backup;$root.staged=$true;Save}
        foreach($snapshot in $taskRecord.registry){SetHidden $snapshot}
        if($hasHistory){$taskRecord.phase='staged';Save}
        Write-Output "Upgrade prepared. Recovery: $taskManifest"
    }else{
        if(-not (LoadRecord)){Write-Output 'No upgrade transaction.';exit 0}
        if($Mode -eq 'Rollback'){Rollback;Write-Output 'Upgrade rollback checked.';exit 0}
        if($taskRecord.phase -eq 'committed'){Write-Output 'Upgrade already committed.';exit 0}
        if($taskRecord.phase -notin @('staged','fresh')){throw 'Upgrade is not ready to commit.'}
        NoLinks $InstallRoot
        if((Hash $taskRecord.payload) -ne $taskRecord.payload_hash){throw 'Payload manifest changed.'}
        $payload=ReadJson $taskRecord.payload
        $taskPayloadFiles=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $taskPayloadParents=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach($row in $payload.files){
            $relative=Relative ([string]$row.path);$file=Join-Path $InstallRoot $relative
            NoLinks $file
            if(-not (Exists $file)){if($row.optional){continue};throw "Extracted program file is missing: $relative"}
            if((Hash $file) -ne $row.sha256){throw "Extracted program file differs: $relative"}
            [void]$taskPayloadFiles.Add($relative)
            $parent=[IO.Path]::GetDirectoryName($relative.Replace('/','\'))
            while($parent){[void]$taskPayloadParents.Add($parent.Replace('\','/'));$parent=[IO.Path]::GetDirectoryName($parent)}
        }
        [void]$taskPayloadFiles.Add('Uninstall ICE Loop Studio.exe');[void]$taskPayloadFiles.Add('ICE-INSTALL-FILES.json');[void]$taskPayloadFiles.Add('ICE-UPGRADE-REPORT.json')
        $current=RegistrySnapshot $taskSelected $taskKeyNames[0]
        if((Full ([string](RegValue $current 'InstallLocation'))) -ine $InstallRoot){throw 'New installation registration does not match its target.'}
        foreach($root in $taskRecord.roots){
            $taskOldFiles=@{}
            $oldReceipt=Join-Path $root.backup 'ICE-INSTALL-FILES.json'
            $owner=@($taskRecord.registry | Where-Object {$_.key -eq $taskKeyNames[0] -and (RegValue $_ 'InstallLocation') -and (Full ([string](RegValue $_ 'InstallLocation'))) -ieq $root.original})
            if($owner.Count -and (Exists $oldReceipt) -and -not ((Attr $oldReceipt) -band [IO.FileAttributes]::ReparsePoint)){
                $expected=RegValue $owner[0] 'InstallFilesSha256'
                if($expected -and (Hash $oldReceipt) -eq $expected){
                    $oldPayload=ReadJson $oldReceipt
                    if($oldPayload.schema -eq 1){foreach($row in $oldPayload.files){$taskOldFiles[(Relative ([string]$row.path))]=$row.sha256}}
                }
            }
            foreach($child in [IO.Directory]::EnumerateFileSystemEntries((Long $root.backup))){
                $plain=Normal $child;MergeUnknown $root $plain ([IO.Path]::GetFileName($plain))
            }
        }
        [IO.File]::Copy((Long $taskRecord.payload),(Long (Join-Path $InstallRoot 'ICE-INSTALL-FILES.json')),$true)
        $base=Hive $taskSelected
        try{$key=$base.OpenSubKey($taskKeyNames[0],$true);try{$key.SetValue('InstallFilesSha256',(Hash $taskRecord.payload),[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}}finally{$base.Dispose()}
        # All data moves succeeded. Other-hive registrations can now be retired.
        foreach($snapshot in $taskRecord.registry){if($snapshot.hive -ne $taskSelected){$base=Hive $snapshot.hive;try{$base.DeleteSubKeyTree($snapshot.key,$false)}finally{$base.Dispose()}}}
        $taskRecord.phase='committed';$taskRecord | Add-Member -NotePropertyName completed -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force;Save
        if($taskRecord.roots.Count){
            WriteJson (Join-Path $InstallRoot 'ICE-UPGRADE-REPORT.json') ([pscustomobject]@{schema=1;app_guid=$AppGuid;manifest=$taskManifest;backup_roots=@($taskRecord.roots | ForEach-Object {$_.backup});preserved_moves=$taskRecord.moves.Count;conflicts=$taskRecord.conflicts;completed=$taskRecord.completed})
        }
        ClearRecoveryPointer
        Write-Output "Upgrade committed. Preserved moves: $($taskRecord.moves.Count); conflicts: $($taskRecord.conflicts.Count)"
    }
    if($ReportPath){WriteJson $ReportPath ([pscustomobject]@{phase=$taskRecord.phase;manifest=$taskManifest;preserved_moves=$taskRecord.moves.Count;conflicts=$taskRecord.conflicts.Count})}
    exit 0
}catch{
    $failure=$_.Exception.Message
    if($taskRecoveryTrusted -and $taskRecord -and $Mode -ne 'Rollback' -and $taskRecord.phase -notin @('committed','fresh','rolled_back')){
        try{Rollback}catch{$failure+='; rollback retained recovery: '+$_.Exception.Message}
    }
    if($ReportPath){try{WriteJson $ReportPath ([pscustomobject]@{phase=$(if($taskRecord){$taskRecord.phase}else{'not_prepared'});manifest=$taskManifest;error=$failure})}catch{}}
    Write-Error $failure -ErrorAction Continue
    exit 22
}
