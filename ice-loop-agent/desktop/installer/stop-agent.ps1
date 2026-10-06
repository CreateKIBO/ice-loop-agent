# Stop only verified ICE Loop processes in this Windows session before replacing files.
# ASCII source for Windows PowerShell 5.1, invoked by the NSIS installer.
[CmdletBinding()]
param(
    [ValidateRange(1,30)][int]$GraceSeconds = 8,
    [ValidateRange(1,30)][int]$ForceSeconds = 12,
    [string]$ReportPath,
    [switch]$DiscoverOnly
)
$ErrorActionPreference = 'Stop'
$taskSession = (Get-Process -Id $PID).SessionId
$taskTracked = @{}
$taskClosed = @{}
$taskForced = @{}
$taskWindows = @{}
$taskFailures = @()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IceInstallerArguments {
    [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string text, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
    public static string CloseWindows(int process) {
        var seen = new StringBuilder();
        EnumWindows((window, parameter) => {
            uint owner; GetWindowThreadProcessId(window, out owner);
            if(owner == process) {
                var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
                seen.Append(name.ToString()).Append(";");
                if(name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
            }
            return true;
        }, IntPtr.Zero);
        return seen.ToString();
    }
    public static string[] Parse(string text) {
        int count; IntPtr pointer = CommandLineToArgvW(text, out count);
        if(pointer == IntPtr.Zero) return new string[0];
        try { var result = new string[count]; for(int index=0; index<count; index++) result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, index*IntPtr.Size)); return result; }
        finally { LocalFree(pointer); }
    }
}
'@

function Get-IceSnapshot {
    @(Get-CimInstance Win32_Process -Filter "SessionId = $taskSession" -ErrorAction Stop)
}
function Get-IceIdentity($taskProcess) {
    '{0}|{1}' -f $taskProcess.ProcessId, $taskProcess.CreationDate.ToUniversalTime().Ticks
}
function Test-IcePackagedRoot([string]$taskDirectory) {
    if(-not $taskDirectory) { return $false }
    (Test-Path -LiteralPath (Join-Path $taskDirectory 'ICE Loop Studio.exe') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $taskDirectory 'resources/app.asar') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $taskDirectory 'resources/engine/ice-engine.exe') -PathType Leaf)
}
function Test-IceRoot($taskProcess) {
    if(-not $taskProcess.ExecutablePath) { return $false }
    $taskPath = $taskProcess.ExecutablePath
    if($taskProcess.Name -ieq 'ICE Loop Studio.exe') {
        return Test-IcePackagedRoot (Split-Path -Parent $taskPath)
    }
    if($taskProcess.Name -ieq 'ice-engine.exe') {
        $taskDirectory = Split-Path -Parent $taskPath
        if((Split-Path -Leaf $taskDirectory) -ine 'engine') { return $false }
        $taskResources = Split-Path -Parent $taskDirectory
        if((Split-Path -Leaf $taskResources) -ine 'resources') { return $false }
        return Test-IcePackagedRoot (Split-Path -Parent $taskResources)
    }
    if($taskProcess.Name -ine 'electron.exe' -or -not $taskProcess.CommandLine) { return $false }
    foreach($taskArgument in [IceInstallerArguments]::Parse($taskProcess.CommandLine)) {
        if($taskArgument -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') { continue }
        $taskSource = $taskArgument
        if((Split-Path -Leaf $taskSource) -ieq 'main.cjs') { $taskSource = Split-Path -Parent $taskSource }
        $taskPackage = Join-Path $taskSource 'package.json'
        if(-not (Test-Path -LiteralPath $taskPackage -PathType Leaf)) { continue }
        try { $taskMetadata = Get-Content -LiteralPath $taskPackage -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
        if($taskMetadata.name -eq 'ice-loop-studio' -and $taskMetadata.main -eq 'main.cjs' -and
           (Test-Path -LiteralPath (Join-Path $taskSource 'main.cjs') -PathType Leaf)) { return $true }
    }
    return $false
}
function Update-IceTracked($taskSnapshot) {
    foreach($taskProcess in $taskSnapshot) {
        if(Test-IceRoot $taskProcess) { $taskTracked[[int]$taskProcess.ProcessId] = Get-IceIdentity $taskProcess }
    }
    # Include only descendants whose parent identity is still in this exact snapshot.
    $taskById = @{}; foreach($taskProcess in $taskSnapshot) { $taskById[[int]$taskProcess.ProcessId] = $taskProcess }
    do {
        $taskAdded = $false
        foreach($taskProcess in $taskSnapshot) {
            $taskId = [int]$taskProcess.ProcessId; $taskParentId = [int]$taskProcess.ParentProcessId
            if($taskTracked.ContainsKey($taskId)) { continue }
            if($taskTracked.ContainsKey($taskParentId) -and $taskById.ContainsKey($taskParentId) -and
               $taskTracked[$taskParentId] -eq (Get-IceIdentity $taskById[$taskParentId])) {
                $taskTracked[$taskId] = Get-IceIdentity $taskProcess; $taskAdded = $true
            }
        }
    } while($taskAdded)
}
function Get-IceAlive($taskSnapshot) {
    @($taskSnapshot | Where-Object {
        $taskTracked.ContainsKey([int]$_.ProcessId) -and $taskTracked[[int]$_.ProcessId] -eq (Get-IceIdentity $_)
    })
}
function Write-IceReport([int]$taskExitCode, $taskRemaining) {
    $taskResult = [ordered]@{
        exit_code = $taskExitCode; session = $taskSession; discovered = @($taskTracked.Keys | Sort-Object)
        close_requested = @($taskClosed.Keys | Sort-Object); force_stopped = @($taskForced.Keys | Sort-Object)
        window_classes = $taskWindows
        remaining = @($taskRemaining | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_.ProcessId }); failures = @($taskFailures)
    }
    $taskJson = $taskResult | ConvertTo-Json -Depth 4 -Compress
    if($ReportPath) { [IO.File]::WriteAllText($ReportPath, $taskJson, [Text.UTF8Encoding]::new($false)) }
    Write-Output $taskJson
}
try {
    $taskSnapshot = Get-IceSnapshot
    # ExecutablePath can disappear while a known process exits. Only diagnose a stable,
    # inaccessible instance before tracking; subsequent ownership uses PID + creation time.
    foreach($taskProcess in @($taskSnapshot | Where-Object { $_.Name -in @('ICE Loop Studio.exe','ice-engine.exe') -and -not $_.ExecutablePath })) {
        Start-Sleep -Milliseconds 250
        $taskCurrent = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskProcess.ProcessId)" -ErrorAction Stop
        if(-not $taskCurrent -or $taskCurrent.ExecutablePath) { continue }
        $taskNative = Get-Process -Id $taskCurrent.ProcessId -ErrorAction SilentlyContinue
        if($taskNative -and -not $taskNative.HasExited) { throw 'ICE process identity is inaccessible. Run this installer with the same privileges as the application.' }
    }
    $taskSnapshot = Get-IceSnapshot; Update-IceTracked $taskSnapshot
    if($DiscoverOnly) { Write-IceReport 0 (Get-IceAlive $taskSnapshot); exit 0 }
    $taskDeadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
    do {
        $taskSnapshot = Get-IceSnapshot; Update-IceTracked $taskSnapshot
        $taskAlive = Get-IceAlive $taskSnapshot
        foreach($taskProcess in $taskAlive) {
            $taskId = [int]$taskProcess.ProcessId
            if($taskClosed.ContainsKey($taskId)) { continue }
            $taskClosed[$taskId] = $true
            try {
                $taskNative = Get-Process -Id $taskId -ErrorAction Stop
                $taskCurrent = Get-CimInstance Win32_Process -Filter "ProcessId = $taskId" -ErrorAction Stop
                if($taskCurrent -and (Get-IceIdentity $taskCurrent) -eq $taskTracked[$taskId]) {
                    [void]$taskNative.CloseMainWindow()
                    $taskWindows[[string]$taskId] = [IceInstallerArguments]::CloseWindows($taskId)
                }
            } catch { }
        }
        if($taskAlive.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while([DateTime]::UtcNow -lt $taskDeadline)

    $taskDeadline = [DateTime]::UtcNow.AddSeconds($ForceSeconds)
    $taskQuiet = 0
    do {
        $taskSnapshot = Get-IceSnapshot; Update-IceTracked $taskSnapshot
        $taskAlive = Get-IceAlive $taskSnapshot
        if($taskAlive.Count -eq 0) { $taskQuiet++ } else { $taskQuiet = 0 }
        if($taskQuiet -ge 2) { Write-IceReport 0 @(); exit 0 }
        foreach($taskProcess in $taskAlive) {
            $taskId = [int]$taskProcess.ProcessId
            # Re-read exact process identity immediately before termination to reject PID reuse.
            $taskCurrent = Get-CimInstance Win32_Process -Filter "ProcessId = $taskId" -ErrorAction Stop
            if(-not $taskCurrent -or (Get-IceIdentity $taskCurrent) -ne $taskTracked[$taskId]) { continue }
            try {
                Stop-Process -Id $taskId -Force -ErrorAction Stop
                $taskForced[$taskId] = $true
            } catch {
                if(Get-Process -Id $taskId -ErrorAction SilentlyContinue) { $taskFailures += "PID ${taskId}: $($_.Exception.Message)" }
            }
        }
        Start-Sleep -Milliseconds 250
    } while([DateTime]::UtcNow -lt $taskDeadline)
    Write-IceReport 20 (Get-IceAlive (Get-IceSnapshot)); exit 20
} catch {
    $taskFailures += $_.Exception.Message
    Write-IceReport 21 @(); exit 21
}
