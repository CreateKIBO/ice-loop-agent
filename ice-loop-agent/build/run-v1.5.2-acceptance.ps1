$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $taskRoot
$taskNode = 'E:/Node/node.exe'
$taskPython = Join-Path $taskRoot '.venv/Scripts/python.exe'
function Invoke-Check($label, $executable, $arguments, $log) {
    Write-Output ('Starting ' + $label)
    & $executable @arguments *> $log
    if ($LASTEXITCODE -ne 0) { throw ($label + ' failed; see ' + $log) }
    Write-Output ('Passed ' + $label)
}
if (Test-Path -LiteralPath 'E:/Codex-ICE-Build-1.5.2-01a0f697/BUILD-STAGING.json') {
    Invoke-Check 'staged installer recovery' $taskNode @('build/recover-staged-installer.cjs') 'docs/v1.5.2-installer-recovery.log'
} elseif (-not (Test-Path -LiteralPath 'release/ICE-Loop-Studio-1.5.2-Setup.exe')) {
    throw 'Build the installer before running acceptance'
}
Invoke-Check 'packaged source audit' $taskNode @('build/verify-release.cjs') 'docs/v1.5.2-source-audit.log'
Invoke-Check 'installer and ZIP payload audit' $taskPython @('-X','utf8','build/verify_release.py') 'docs/v1.5.2-binary-audit.log'
$env:ICE_TEST_EXECUTABLE = Join-Path $taskRoot 'release/win-unpacked/ICE Loop Studio.exe'
$env:ICE_PACKAGED_EXE = $env:ICE_TEST_EXECUTABLE
try {
    Invoke-Check 'packaged prompt and budget UI' $taskNode @('desktop/tests/prompt-smoke.cjs') 'docs/v1.5.2-prompt-packaged.log'
    Invoke-Check 'packaged creative conversation UI' $taskNode @('desktop/tests/chat-smoke.cjs') 'docs/v1.5.2-chat-packaged.log'
    Invoke-Check 'packaged embedded browser UI' $taskNode @('desktop/tests/browser-smoke.cjs') 'docs/v1.5.2-browser-packaged.log'
} finally {
    Remove-Item Env:ICE_TEST_EXECUTABLE -ErrorAction SilentlyContinue
    Remove-Item Env:ICE_PACKAGED_EXE -ErrorAction SilentlyContinue
}
Invoke-Check 'final proof collection and brand asset audit' $taskPython @('-X','utf8','build/record-v1.5.2.py') 'docs/v1.5.2-proof-collection.log'
