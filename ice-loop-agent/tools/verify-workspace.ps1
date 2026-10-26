<#



verify-workspace.ps1 — ICE Loop Studio 统一只读验证入口（批次E，2026-10-20）







串行组合：UI 类型检查、Node 语法检查、Node 行为测试、UI 构建、构建后分块检查；



deep 范围追加 Electron 冒烟（ui-smoke / widths-smoke / dpi-smoke）与显式选择的原生专项。







约定（与任务单一致）：



- 任一步失败 → 总退出码非 0；后续独立步骤继续执行，依赖步骤记 skipped:dependency。



- 每步记录真实命令、退出码、耗时、日志文件；不吞子进程失败输出。



- 原生专项缺夹具时给出对应 seed 命令提示并记 skipped:missing-fixture，总验收不完整并返回非零；



  夹具/运行目录必须在仓库 .test-tmp 内（拒绝个人运行目录）。



- 不自动安装依赖、不删除其他目录、不调用付费模型、不生成安装器、不改写工作区选择。



- Python 全量默认不跑（不声明历史基线仍适用）；-IncludePython 显式选择才执行。







用法示例：



  powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-workspace.ps1



  powershell ... -Scope deep -Native onboarding,glm-review        # 拼写见 $nativeRegistry



  powershell ... -Scope deep -Native assets -NativeArg assets=--images-only



  # 多个共享夹具家族的专项：显式让每项先重新播种独立数据再执行（仅 prepare 标记项）



  powershell ... -Scope deep -Native interaction-lists,dialog-matrix,async-receipts,interaction-integrity -PrepareNativeFixtures



#>



[CmdletBinding()]



param(



  [ValidateSet('quick', 'deep')][string]$Scope = 'quick',



  # 显式选择的原生专项名（见 $nativeRegistry）；缺夹具会提示 seed 命令。



  [string[]]$Native = @(),



  # 附加参数映射，如 assets=--images-only（跳过真实 TapNow 站点部分）。



  [string[]]$NativeArg = @(),



  # 本轮独立输出目录；默认 .test-tmp\verify-workspace\<时间戳>，不覆盖历史。



  [string]$OutputDir = '',



  [switch]$IncludePython,



  # 审计钩子：人为插入一个必败步骤，验证失败传播与总退出码非 0（不触碰真实产物）。



  [switch]$InjectFailureForAudit,



  # 显式选择：为注册表标记 prepare=$true 的受控 mock 专项在每项前重新播种独立夹具。



  # 默认不播种（语义不变）；seed 命令只来自注册表，不拼接用户输入；不扩大网络权限。



  [switch]$PrepareNativeFixtures,



  # 依赖注入：覆盖默认 .venv 解释器（仅供隔离回归测试；缺省用项目 .venv）。



  [string]$PythonExe = ''



)







$ErrorActionPreference = 'Stop'



$repo = Split-Path -Parent $PSScriptRoot



$desktop = Join-Path $repo 'desktop'



$testTmp = Join-Path $repo '.test-tmp'



. (Join-Path $PSScriptRoot 'verify-workspace-guards.ps1')







if (-not $OutputDir) { $OutputDir = Join-Path $testTmp ("verify-workspace\" + ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))) }



# 步骤执行时 Push-Location 会改变当前目录；日志路径必须先锚定为绝对路径。



if (-not [System.IO.Path]::IsPathRooted($OutputDir)) { $OutputDir = Join-Path $repo $OutputDir }



$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)



if (-not (Test-WorkspaceChild $OutputDir $testTmp)) { throw 'OutputDir must be a non-reparse child of this workspace .test-tmp' }



if (Test-Path -LiteralPath $OutputDir) { throw 'OutputDir already exists; use a new directory to preserve evidence' }



New-Item -ItemType Directory -Path $OutputDir | Out-Null



$env:TEMP = Join-Path $OutputDir 'temp'; $env:TMP = $env:TEMP



New-Item -ItemType Directory -Path $env:TEMP | Out-Null



# Source acceptance never substitutes an installed executable or external engine.



if ($env:ICE_PACKAGED_EXE -or $env:ICE_PYTHON) { throw 'Unset ICE_PACKAGED_EXE / ICE_PYTHON for source verification' }







# ------------------------------------------------------------- 执行器选择



$nodeExe = 'E:\Node\node.exe'; if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }



$npmCmd = 'E:\Node\npm.cmd'; if (-not (Test-Path $npmCmd)) { $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }



if (-not $nodeExe -or -not $npmCmd) { Write-Error '没有可用的 node/npm 执行器（E:\Node 或 PATH）' }



$venvPython = Join-Path $repo '.venv\Scripts\python.exe'



if ($PythonExe) { $venvPython = $PythonExe }







# ------------------------------------------------------------- 前置守卫



# 个人运行目录守卫：ICE_DESKTOP_RUNTIME 指向仓库 .test-tmp 之外时拒绝原生/冒烟步骤。



$runtimeEnv = $env:ICE_DESKTOP_RUNTIME



$runtimeTainted = $runtimeEnv -and -not (Test-WorkspaceChild $runtimeEnv $testTmp)



if ($runtimeTainted) {



  Write-Warning "ICE_DESKTOP_RUNTIME=$runtimeEnv 不在 $testTmp 内；原生/冒烟步骤将记 blocked:personal-runtime。"



}







# 依赖已装守卫：未安装时相关步骤记 not-run:no-deps，不自动安装。



$depsPresent = (Test-Path (Join-Path $desktop 'node_modules')) -and (Test-Path (Join-Path $desktop 'ui\node_modules'))



if (-not $depsPresent) { Write-Warning 'node_modules 缺失（desktop 或 desktop/ui）；相关步骤记 not-run:no-deps，不自动安装。' }







# ------------------------------------------------------------- 源码摘要



function Get-SourceDigest {



  $roots = @('ice_agent','profiles','tests','tools','desktop/ui/src','desktop/ui/scripts','desktop/tests') | ForEach-Object { Join-Path $repo $_ }



  $files = @(Get-ChildItem -LiteralPath $roots -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.py','.js','.ts','.tsx','.cjs','.mjs','.ps1','.css','.html','.json','.toml','.yaml','.yml') -and $_.FullName -notmatch '[\\/]__pycache__[\\/]' })



  $files += @(Get-ChildItem -LiteralPath $repo,$desktop,(Join-Path $desktop 'ui') -File | Where-Object { $_.Extension -in @('.py','.js','.ts','.cjs','.mjs','.css','.html','.json','.toml','.yaml','.yml') })



  $lines = foreach ($file in ($files | Sort-Object FullName)) {



    $hasher = [Security.Cryptography.SHA256]::Create()



    try { $hash = ([BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($file.FullName))) -replace '-', '') } finally { $hasher.Dispose() }



    "$($file.FullName.Substring($repo.Length + 1))=$($hash)"



  }



  $joined = ($lines -join "`n")



  $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)



  $sha = [System.Security.Cryptography.SHA256]::Create()



  ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()



}



$sourceBefore = Get-SourceDigest



$gitHead = ''



try { $gitHead = git -C $repo rev-parse HEAD 2>$null } catch { $gitHead = 'git-unavailable' }



$gitDirty = 0



try { $gitDirty = @(git -C $repo status --porcelain 2>$null).Count } catch { $gitDirty = -1 }







# ------------------------------------------------------------- 原生专项注册表



# network: mock/loopback = 仅本地回环与隔离夹具；site = 会触碰真实站点（assets 全量含 TapNow）。



$nativeRegistry = @{



  'onboarding'  = @{ seed = 'tests\seed_onboarding_native.py';      fixture = 'docs/上线准备/onboarding-fixture.json';  network = 'mock/loopback'; script = 'tests/onboarding-native.cjs'; family = 'release-onboarding' }



  'assets'      = @{ seed = 'tests\seed_assets_native.py';          fixture = 'docs/上线准备/assets-fixture.json';      network = 'site(--images-only 时跳过真实 TapNow 部分)'; script = 'tests/assets-native.cjs'; family = 'release-assets' }



  'glm-review'   = @{ seed = 'tests\seed_glm_review_native.py';      fixture = 'docs/上线准备/glm-review-fixture.json';  network = 'mock/loopback'; script = 'tests/glm-review-native.cjs'; family = 'release-glm-review' }



  'action-poll' = @{ seed = 'tests\seed_glm_review_native.py';      fixture = 'docs/上线准备/glm-review-fixture.json';  network = 'mock/loopback'; script = 'tests/action-poll-native.cjs'; family = 'release-glm-review' }



  'chat-window' = @{ prepare = $true; seed = 'tests\seed_chat_window_native.py';     fixture = 'docs/上线准备/chat-window-fixture.json'; network = 'mock/loopback'; script = 'tests/chat-window-native.cjs'; family = 'release-chat-window' }



  'editorial'   = @{ prepare = $true; seed = 'tests\seed_editorial_native.py';        fixture = 'docs/上线准备/editorial-fixture.json';   network = 'mock/loopback'; script = 'tests/editorial-native.cjs'; family = 'release-editorial' }



  # 2026-10-20 交互验收补齐轮新增：同一夹具家族（两账号/离线Mock/故障注入entry）。



  'interaction-lists' = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/interaction-lists-native.cjs'; family = 'release-interaction-lists' }



  'dialog-matrix'     = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback(本地拦截页)'; script = 'tests/dialog-matrix-native.cjs'; family = 'release-interaction-lists' }



  'async-receipts'    = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/async-receipts-native.cjs'; family = 'release-interaction-lists' }



  'interaction-integrity' = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/interaction-integrity-native.cjs'; family = 'release-interaction-lists' }



  # 2026-10-21 批B/批C 新增专项：同一受控 mock 夹具，每项独立播种。



  'dialog-focus'         = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/dialog-focus-native.cjs'; family = 'release-interaction-lists' }



  'proposal-pages'       = @{ prepare = $true; seed = 'tests\seed_patch_review_native.py'; fixture = 'docs/上线准备/patch-review-fixture.json'; network = 'mock/loopback'; script = 'tests/proposal-pages-native.cjs'; family = 'release-interaction-lists' }
  'editor-coordination' = @{ prepare = $true; seed = 'tests\seed_patch_review_native.py'; fixture = 'docs/上线准备/patch-review-fixture.json'; network = 'mock/loopback'; script = 'tests/editor-coordination-native.cjs'; family = 'release-interaction-lists' }
  'review-draft'         = @{ prepare = $true; seed = 'tests\seed_patch_review_native.py'; fixture = 'docs/上线准备/patch-review-fixture.json'; network = 'mock/loopback'; script = 'tests/review-draft-native.cjs'; family = 'release-interaction-lists' }
  'patch-review'         = @{ prepare = $true; seed = 'tests\seed_patch_review_native.py'; fixture = 'docs/上线准备/patch-review-fixture.json'; network = 'mock/loopback'; script = 'tests/patch-review-native.cjs'; family = 'release-interaction-lists' }

  'editor-outline'       = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/editor-outline-native.cjs'; family = 'release-interaction-lists' }


  'editor-debounce'      = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/editor-debounce-native.cjs'; family = 'release-interaction-lists' } # 旅程内自带逐旅程重播



  'editor-switch-block'  = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/editor-switch-block-native.cjs'; family = 'release-interaction-lists' }



  'download-target' = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/download-target-native.cjs'; family = 'release-interaction-lists' }



  'delivery-ready' = @{ prepare = $true; seed = 'tests\seed_delivery_ready_native.py'; fixture = 'docs/上线准备/delivery-ready-fixture.json'; network = 'mock/loopback(选择器与打开目录明确注入)'; script = 'tests/delivery-ready-native.cjs'; family = 'release-export' }



  'command-palette' = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/command-palette-native.cjs'; family = 'release-interaction-lists' }



  'backup' = @{ prepare = $true; seed = 'tests\seed_backup_native.py'; fixture = 'docs/上线准备/backup-fixture.json'; network = 'offline picker fixture'; script = 'tests/backup-native.cjs'; family = 'release-backup' }
  'backup-migration' = @{ prepare = $true; seed = 'tests\seed_backup_migration_native.py'; fixture = 'docs/上线准备/backup-migration-fixture.json'; network = 'offline synthetic schema-19'; script = 'tests/backup-migration-native.cjs'; family = 'release-backup' }
  'chat-delivery' = @{ prepare = $true; seed = 'tests\seed_chat_delivery_native.py'; fixture = 'docs/上线准备/chat-delivery-fixture.json'; network = 'offline model / injected IPC receipt loss'; script = 'tests/chat-delivery-native.cjs'; family = 'release-chat-delivery' }
  'recovery-points' = @{ prepare = $true; seed = 'tests\seed_recovery_points_native.py'; fixture = 'docs/上线准备/recovery-points-fixture.json'; network = 'offline complete upgrade points'; script = 'tests/recovery-points-native.cjs'; family = 'release-backup' }
  'startup-recovery' = @{ prepare = $true; seed = 'tests\seed_startup_recovery_native.py'; fixture = 'docs/上线准备/startup-recovery-fixture.json'; network = 'offline startup recovery'; script = 'tests/startup-recovery-native.cjs'; family = 'release-backup' }
  'original-images'      = @{ prepare = $true; seed = 'tests\seed_memory_workflow_native.py'; fixture = 'docs/上线准备/memory-workflow-fixture.json'; network = 'offline protocol canvas'; script = 'tests/original-images-native.cjs'; family = 'release-interaction-lists' }
  'memory-workflow'      = @{ prepare = $true; seed = 'tests\seed_memory_workflow_native.py'; fixture = 'docs/上线准备/memory-workflow-fixture.json'; network = 'offline protocol canvas'; script = 'tests/memory-workflow-native.cjs'; family = 'release-interaction-lists' }
  'image-lease'          = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/image-lease-native.cjs'; family = 'release-interaction-lists' }



  'workflow-views'       = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs/上线准备/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests/workflow-views-native.cjs'; family = 'release-interaction-lists' } # 2026-10-22 批F：制作流程新行为（筛选/下载箱/清单），seed 含 downloads.stage



  'start-guide'          = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs\/上线准备\/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests\start-guide-native.cjs'; family = 'release-interaction-lists' } # 2026-10-23 批A6/B2
  'ux-polish'           = @{ prepare = $true; seed = 'tests\seed_interaction_lists_native.py'; fixture = 'docs\/上线准备\/interaction-lists-fixture.json'; network = 'mock/loopback'; script = 'tests\ux-polish-native.cjs'; family = 'release-interaction-lists' } # 2026-10-25 界面打磨：截图+目录/提示词/复制旅程
  'reading-upgrade'     = @{ prepare = $true; seed = 'tests\seed_reading_upgrade_native.py'; fixture = 'docs\/上线准备\/reading-upgrade-fixture.json'; network = 'mock/loopback'; script = 'tests\reading-upgrade-native.cjs'; family = 'release-interaction-lists' } # 2026-10-25 复制与阅读升级：视图复位+参考图+历史候选（单一隔离夹具，运行期间不播种）
  'candidate-compare'    = @{ prepare = $true; seed = 'tests\seed_reading_upgrade_native.py'; fixture = 'docs\/上线准备\/reading-upgrade-fixture.json'; network = 'mock/loopback'; script = 'tests\candidate-compare-native.cjs'; family = 'release-interaction-lists' } # 2026-10-25 候选对照：seed 扩展同题对照候选+跨页历史


  # strict-mode 无需预置夹具（脚本自建 .test-tmp/release-strict-mode），单独运行：



  #   node desktop	ests\strict-mode-native.cjs



}







# ------------------------------------------------------------- 步骤执行器



$script:steps = New-Object System.Collections.Generic.List[object]



function Invoke-Step {



  param(



    [string]$Name, [string[]]$Command, [string]$WorkingDir, [string[]]$DependsOn = @(),



    [string]$Network = 'local-only', [scriptblock]$Precondition = $null



  )



  # 步骤名用于报告；日志文件名需净化（如 native:onboarding 的冒号在 Windows 非法）。



  $logName = ($Name -replace '[:*?"<>|]', '_') + '.log'



  $entry = [ordered]@{ name = $Name; status = $null; command = ($Command -join ' '); exitCode = $null



                       durationMs = $null; log = (Join-Path $OutputDir $logName); network = $Network }



  if (-not (Test-StepDependencies -Steps @($script:steps.ToArray()) -Names $DependsOn)) {



    $entry.status = 'skipped:dependency'; $script:steps.Add([pscustomobject]$entry); return



  }



  if ($Precondition) {



    $pre = & $Precondition



    if ($pre.status -ne 'ok') {



      $entry.status = $pre.status; $entry.note = $pre.note



      $script:steps.Add([pscustomobject]$entry); return



    }



  }



  Write-Host ("==> {0} (cwd={1}): {2}" -f $Name, (Get-Location).Path, $entry.command) -ForegroundColor Cyan



  $sw = [System.Diagnostics.Stopwatch]::StartNew()



  $exit = $null



  try {



    $pushed = $false



    if (-not (Get-Command $Command[0] -ErrorAction SilentlyContinue)) { throw "Executable missing: $($Command[0])" }



    Push-Location $WorkingDir



    $pushed = $true



    $global:LASTEXITCODE = $null



    ("[step-cwd] " + (Get-Location).Path) | Out-File -FilePath $entry.log -Append -Encoding utf8



    $argv = @($Command | Select-Object -Skip 1)



    # PS5.1：EAP=Stop 会把原生命令的 stderr 进度当终止错误；执行期间放宽，退出码才是真实结果。



    $previousEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'



    try { & $Command[0] @argv 2>&1 | ForEach-Object { Write-Host $_; $_ } | Out-File -FilePath $entry.log -Append -Encoding utf8 }



    finally { $ErrorActionPreference = $previousEap }



    $exit = $global:LASTEXITCODE



  }



  catch { $exit = -1; ($_ | Out-String) | Out-File -FilePath $entry.log -Append -Encoding utf8 }



  finally { if ($pushed) { Pop-Location } }



  $sw.Stop()



  $entry.exitCode = $exit; $entry.durationMs = $sw.ElapsedMilliseconds



  $entry.status = if ($exit -eq 0) { 'passed' } else { 'failed' }



  $script:steps.Add([pscustomobject]$entry)



  Write-Host ("<== {0}: {1} ({2}ms)" -f $Name, $entry.status, $entry.durationMs) -ForegroundColor $(if ($exit -eq 0) { 'Green' } else { 'Red' })



}







$needDeps = { if (-not $depsPresent) { @{ status = 'not-run:no-deps'; note = 'node_modules 缺失；本工具不自动安装依赖' } } else { @{ status = 'ok' } } }







# ------------------------------------------------------------- 计划展示（执行前显示范围）



$planned = @('ui-typecheck', 'node-check-main', 'node-check-tools', 'node-tests', 'build-ui', 'check-bundle')



if ($Scope -eq 'deep') { $planned += @('smoke-ui', 'widths-smoke', 'dpi-smoke') }



foreach ($name in $Native) { $planned += "native:$name" }



if ($IncludePython) { $planned += 'python-full-baseline' } else { $planned += 'python-full-baseline(not-run:未执行，不声明基线有效)' }



Write-Host "verify-workspace 范围 [$Scope]：" -ForegroundColor Yellow



$planned | ForEach-Object { Write-Host "  - $_" }



Write-Host "输出目录：$OutputDir"



Write-Host "执行前后均计算源码摘要，结果写入 report.json（含后端、桌面入口、前端、测试、工具及配置）。"







# ------------------------------------------------------------- quick 步骤



if ($InjectFailureForAudit) {



  Write-Warning '已启用 -InjectFailureForAudit：插入必败步骤 audit-injected-failure，用于验证失败传播。'



  Invoke-Step 'audit-injected-failure' @('cmd.exe', '/c', 'exit 2') $repo -Network 'audit-only'



}



Invoke-Step 'ui-typecheck' @($npmCmd, '--prefix', 'desktop', 'run', 'check:ui') $repo -Precondition $needDeps



Invoke-Step 'node-check-main' @($npmCmd, '--prefix', 'desktop', 'run', 'check') $repo -Precondition $needDeps



Invoke-Step 'node-check-tools' @($npmCmd, '--prefix', 'desktop', 'run', 'check:tools') $repo -Precondition $needDeps



Invoke-Step 'node-tests' @($nodeExe, '--test', 'tests/*.test.cjs') $desktop -Precondition $needDeps



Invoke-Step 'build-ui' @($npmCmd, '--prefix', 'desktop', 'run', 'build:ui') $repo -Precondition $needDeps



# 构建后分块验收（批次E-23）：所有 JS/CSS、动态 import 与 CSS 预加载引用；



# 报告入口与静态依赖闭包分别多大（bundle-report 的输出里），不是只调阈值。



Invoke-Step 'check-bundle' @($npmCmd, '--prefix', 'desktop', 'run', 'check:bundle') $repo -DependsOn @('build-ui') -Precondition $needDeps







# ------------------------------------------------------------- deep 步骤



if ($Scope -eq 'deep') {



  $electronOk = {



    if ($runtimeTainted) { @{ status = 'blocked:personal-runtime'; note = "ICE_DESKTOP_RUNTIME 指向个人运行目录 $runtimeEnv" } }



    elseif (-not (Test-Path (Join-Path $desktop 'ui\dist\index.html'))) { @{ status = 'skipped:no-dist'; note = '缺少 desktop/ui/dist（依赖 build-ui）' } }



    else { @{ status = 'ok' } }



  }



  Invoke-Step 'smoke-ui' @($nodeExe, 'tests/ui-smoke.cjs') $desktop -DependsOn @('build-ui') -Precondition $electronOk -Network 'local-only(Electron+ice 协议)'



  Invoke-Step 'widths-smoke' @($nodeExe, 'tests/widths-smoke.cjs') $desktop -DependsOn @('build-ui') -Precondition $electronOk -Network 'local-only(500/800/1024/1280 视口)'



  Invoke-Step 'dpi-smoke' @($nodeExe, 'tests/dpi-smoke.cjs') $desktop -DependsOn @('build-ui') -Precondition $electronOk -Network 'local-only(zoomFactor 缩放近似)'



}







# ------------------------------------------------------------- 原生专项（缺夹具提示 seed 命令）



foreach ($name in $Native) {



  if ($name -eq 'gm-review') { $name = 'glm-review' } # compatibility for the initial documented typo



  $info = $nativeRegistry[$name]



  $stepName = "native:$name"



  if (-not $info) {



    $script:steps.Add([pscustomobject][ordered]@{ name = $stepName; status = 'not-run:unknown-native'; command = ''; exitCode = $null



      durationMs = $null; log = $null; network = 'n/a'; note = "未登记的原生专项：$name（可用：$($nativeRegistry.Keys -join ', '))" })



    continue



  }



  $extraArg = $null



  foreach ($pair in $NativeArg) { $k, $v = $pair -split '=', 2; if ($k -eq $name) { $extraArg = $v } }



  $command = @($nodeExe, $info.script); if ($extraArg) { $command += $extraArg }



  if ($extraArg -and -not ($name -eq 'assets' -and $extraArg -eq '--images-only')) {



    $script:steps.Add([pscustomobject]@{ name=$stepName; status='blocked:invalid-argument'; command=($command -join ' '); exitCode=$null; durationMs=$null; log=$null; network='n/a'; note='Only assets=--images-only is supported; baseline modes are not acceptance.' })



    continue



  }



  $fixtureAbs = Join-Path $repo $info.fixture



  # 显式播种（2026-10-21 批A）：仅注册表 prepare 标记的受控 mock 专项在每项前生成新夹具；



  # seed 命令只来自注册表（不拼接用户输入），不扩大网络权限；默认不开关时本块整体不执行。



  $seedStep = $null; $seedFailed = $false; $seedGuard = $null; $evidenceDir = $null



  $seeded = $null



  if ($PrepareNativeFixtures -and $info.prepare) {



    $seedStep = 'seed:' + $name



    $fixtureBefore = $null; $previousRuntime = $null



    if (Test-WorkspaceChild $fixtureAbs $repo) {



      $fixtureBefore = Get-EvidenceStamp $fixtureAbs



      try { $previousRuntime = (Get-Content -LiteralPath $fixtureAbs -Raw -Encoding UTF8 | ConvertFrom-Json).runtime } catch { }



    }



    $seedPre = {



      if (-not (Test-WorkspaceChild $fixtureAbs $repo)) { @{ status='blocked:invalid-fixture'; note='Fixture path contains a reparse point' } }



      elseif ($runtimeTainted) { @{ status='blocked:personal-runtime'; note='Unset external ICE_DESKTOP_RUNTIME before source acceptance' } }



      else { @{ status='ok' } }



    }



    Invoke-Step $seedStep @($venvPython, '-X', 'utf8', '-B', $info.seed, '-NativeName', $name) $repo -DependsOn @('build-ui') -Precondition $seedPre -Network 'local-only(隔离夹具，阻止外网)'



    $seedEntry = @($script:steps | Where-Object { $_.name -eq $seedStep })[-1]



    if ($seedEntry.status -eq 'passed') {



      if (-not (Test-WorkspaceChild $fixtureAbs $repo)) {



        $seedGuard = @{status='blocked:invalid-fixture';note='Fixture path contains a reparse point'}



      } else {



        $seedGuard = Get-FixtureGuard -Fixture $fixtureAbs -TestRoot $testTmp -Family $info.family



      }



      if ($seedGuard.status -eq 'ok') {



        $seeded = Get-Content -LiteralPath $fixtureAbs -Raw -Encoding UTF8 | ConvertFrom-Json



        if ((Get-EvidenceStamp $fixtureAbs) -eq $fixtureBefore -or $seeded.runtime -eq $previousRuntime) {



          $seedGuard = @{status='blocked:stale-fixture';note='Seed exited zero without creating a new owned runtime; refusing previous fixture'}



        } else {



          $evidenceDir = Join-Path $OutputDir ('native-evidence\' + $name)



          New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null



          Copy-Item -LiteralPath $fixtureAbs -Destination (Join-Path $evidenceDir 'fixture.json')



          $seedEntry | Add-Member -Force NoteProperty note ('seeded runtime: ' + $seeded.runtime)



        }



      }



    } else { $seedFailed = $true }



  }



  $pre = {



    if ($seedFailed) { @{ status = 'blocked:seed-failed'; note = "seed:$name 未成功，对应专项已阻断（其他独立项继续）" } }



    elseif ($seedGuard -and $seedGuard.status -ne 'ok') { $seedGuard }



    elseif (-not (Test-WorkspaceChild $fixtureAbs $repo)) { @{ status='blocked:invalid-fixture'; note='Fixture path contains a reparse point' } }



    elseif ($runtimeTainted) { @{ status = 'blocked:personal-runtime'; note = "ICE_DESKTOP_RUNTIME 指向个人运行目录" } }



    elseif (-not (Test-Path $fixtureAbs)) {



      @{ status = 'skipped:missing-fixture'



         note = "缺少夹具 $($info.fixture)。生成命令（在本仓库根目录，使用项目 .venv，创建新的隔离夹具，不复用个人运行目录）：`r`n  .\.venv\Scripts\python.exe -X utf8 -B $($info.seed)" }



    }



    else { Get-FixtureGuard -Fixture $fixtureAbs -TestRoot $testTmp -Family $info.family }



  }



  # 依赖只挂 build-ui：seed 失败要让 precondition 报 blocked:seed-failed（比 skipped:dependency



  # 更指向原因）；seed→native 的先后顺序由本循环串行保证（同一迭代内先 seed 后 native）。



  $depends = @('build-ui')



  $nativeJson = Join-Path $repo (('docs/上线准备/' + (Split-Path -Leaf $info.script)) -replace '\.cjs$', '.json')



  $resultBefore = $null



  $resultPathSafe = Test-WorkspaceChild $nativeJson $repo



  if ($evidenceDir -and $resultPathSafe) { $resultBefore = Get-EvidenceStamp $nativeJson }



  Invoke-Step $stepName $command $desktop -DependsOn $depends -Precondition $pre -Network $info.network



  $nativeEntry = @($script:steps | Where-Object { $_.name -eq $stepName })[-1]



  # Archive only results actually produced by this invocation, never an earlier successful report.



  if ($evidenceDir -and $nativeEntry.status -in @('passed','failed')) {



    $evidenceStatus = 'ok'; $resultAfter = $null



    if (-not $resultPathSafe -or -not (Test-WorkspaceChild $nativeJson $repo)) { $evidenceStatus = 'unsafe-result' }



    else {



      $resultAfter = Get-EvidenceStamp $nativeJson



      if (-not $resultAfter) { $evidenceStatus = 'missing-result' }



      elseif ($resultAfter -eq $resultBefore) { $evidenceStatus = 'stale-result' }



      else {



        try {



          $nativeResult = Get-Content -LiteralPath $nativeJson -Raw -Encoding UTF8 | ConvertFrom-Json



          if ($nativeResult.runtime -ne $seeded.runtime) { $evidenceStatus = 'runtime-mismatch-result' }



          elseif ($nativeEntry.status -eq 'passed' -and $nativeResult.state -ne 'finished') { $evidenceStatus = 'incomplete-result' }



          elseif ($nativeEntry.status -eq 'passed' -and -not $nativeResult.checks) { $evidenceStatus = 'incomplete-result' }



          elseif ($nativeEntry.status -eq 'passed' -and @($nativeResult.checks.PSObject.Properties | Where-Object { $_.Value -isnot [bool] -or $_.Value -ne $true }).Count -gt 0) { $evidenceStatus = 'incomplete-result' }



          Copy-Item -LiteralPath $nativeJson -Destination (Join-Path $evidenceDir 'result.json')



        } catch { $evidenceStatus = 'invalid-result' }



      }



    }



    $nativeEntry | Add-Member -Force NoteProperty evidenceStatus $evidenceStatus



    if ($evidenceStatus -ne 'ok') {



      # Preserve the subprocess exitCode; evidence failure is a separate acceptance failure.



      if ($nativeEntry.status -eq 'passed') { $nativeEntry.status = 'failed' }



      $nativeEntry | Add-Member -Force NoteProperty note ('Native evidence rejected: ' + $evidenceStatus)



    }



    @{runtime=$seeded.runtime;source=$nativeJson;before=$resultBefore;after=$resultAfter;status=$evidenceStatus;stepStatus=$nativeEntry.status;exitCode=$nativeEntry.exitCode} |



      ConvertTo-Json -Depth 4 | Out-File -LiteralPath (Join-Path $evidenceDir 'evidence.json') -Encoding utf8



  }







}







# ------------------------------------------------------------- Python 全量（默认不跑）



if ($IncludePython) {



  Invoke-Step 'python-full-baseline' @($venvPython, '-X', 'utf8', '-B', 'docs/上线准备/run_full_checks.py') $repo -Network 'local-only(离线基线，阻止外网)'



} else {



  $script:steps.Add([pscustomobject][ordered]@{ name = 'python-full-baseline'; status = 'not-run:default-off'; command = '.venv\Scripts\python.exe -X utf8 -B docs/上线准备/run_full_checks.py'



    exitCode = $null; durationMs = $null; log = $null; network = 'local-only'



    note = 'Python was not executed in this run. No claim about historical test counts or unchanged backend. Use -IncludePython.' })



}







# ------------------------------------------------------------- 报告



$failed = @($script:steps | Where-Object { $_.status -eq 'failed' })



$incomplete = @($script:steps | Where-Object { $_.status -ne 'passed' -and $_.status -ne 'not-run:default-off' -and $_.status -ne 'failed' })



$sourceAfter = Get-SourceDigest



$sourceChanged = $sourceBefore -ne $sourceAfter



$report = [ordered]@{



  generatedAt = (Get-Date).ToString('s')



  scope = $Scope; repo = $repo; gitHead = $gitHead; gitDirtyFiles = $gitDirty



  sourceDigest = $sourceAfter; sourceDigestBefore = $sourceBefore; sourceChangedDuringRun = $sourceChanged



  complete = ($failed.Count -eq 0 -and $incomplete.Count -eq 0 -and -not $sourceChanged)



  node = $nodeExe; npm = $npmCmd



  passed = @($script:steps | Where-Object { $_.status -eq 'passed' }).Count



  failed = $failed.Count



  notRunOrSkipped = @($script:steps | Where-Object { $_.status -notin @('passed', 'failed') } | ForEach-Object { "$($_.name)=$($_.status)" })



  steps = $script:steps



}



$reportJson = Join-Path $OutputDir 'report.json'



$report | ConvertTo-Json -Depth 5 | Out-File -FilePath $reportJson -Encoding utf8







$summary = @()



$summary += "# verify-workspace 报告（$Scope，$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')）"



$summary += ""



$summary += "| 步骤 | 状态 | 退出码 | 耗时(ms) | 说明 |"



$summary += "|---|---|---|---|---|"



foreach ($step in $script:steps) {



  $summary += "| $($step.name) | $($step.status) | $($step.exitCode) | $($step.durationMs) | $($step.note) |"



}



$summary += ""



$summary += "git HEAD: $gitHead；脏文件数: $gitDirty；源码摘要: $($report.sourceDigest.Substring(0, 16))…"



$summary | Out-File -FilePath (Join-Path $OutputDir 'summary.md') -Encoding utf8







Write-Host ''



Write-Host "==== 汇总：passed=$($report.passed) failed=$($report.failed) incomplete=$($incomplete.Count) sourceChanged=$sourceChanged not-run/skipped=$($report.notRunOrSkipped.Count) ====" -ForegroundColor $(if ($report.complete) { 'Green' } else { 'Red' })



$script:steps | Format-Table name, status, exitCode, durationMs -AutoSize



Write-Host "报告：$reportJson"



if (-not $report.complete) { Write-Warning 'Verification failed or incomplete (including requested steps not run / source changed).'; exit 1 } else { exit 0 }



