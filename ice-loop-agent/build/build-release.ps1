# Build into a new owned candidate directory. Never replace prior releases or user data.
[CmdletBinding()]
param([switch]$SkipDesktopVerification)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location -LiteralPath $taskRoot
try {
    $taskArguments = @('build/build-candidate.cjs', '--installer')
    if(-not $SkipDesktopVerification) { $taskArguments += '--verify-desktop' }
    & $taskNode @taskArguments
    $taskCode = $LASTEXITCODE
    if($taskCode -ne 0) { throw 'Candidate build or acceptance failed. Inspect the candidate logs.' }
} finally { Pop-Location }
