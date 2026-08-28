# ZCode Windows CDP 补丁开关（规则引擎式 · 跨构建自适应）
# ============================================================
# 用法（管理员 PowerShell）：
#   .\cdp-patch.ps1 Status                查看状态（普通权限即可）
#   .\cdp-patch.ps1 Apply                 启用补丁（需先退出 ZCode）
#   .\cdp-patch.ps1 Apply -WaitForExit    自动等待 ZCode 退出后执行，退出后约 1-2 分钟完成刷入
#   .\cdp-patch.ps1 Apply -Force          已启用时强制重刷
#   .\cdp-patch.ps1 Remove                停用补丁，整包还原原版
#
# 依赖：Node.js + npm。首次 Apply 整包备份原版 asar 到 backup\app.asar.original。
# 适配版本：3.10.1（Status 会显示实际版本；锚点未命中时变换器会安全中止）

param(
    [Parameter(Position = 0)]
    [ValidateSet('Apply', 'Remove', 'Status', 'Backup')]
    [string]$Action = 'Status',
    [switch]$WaitForExit,
    [switch]$Force,
    [string]$ZcodePath = ''              # 手动指定安装根目录（含 ZCode.exe 的目录）；缺省自动发现
)

$ErrorActionPreference = 'Stop'
$ROOT  = $PSScriptRoot                 # windows\
$REPO  = Split-Path $ROOT -Parent      # 仓库根
$APPLY = Join-Path $REPO 'apply-asar.mjs'
$BAK   = Join-Path $ROOT 'backup'

# ---------- 第一步：自动发现 ZCode 安装目录 ----------
function Resolve-ZcodeInstall {
    function Valid([string]$d) { $d -and (Test-Path (Join-Path $d 'resources\app.asar')) }

    # 0) 显式指定优先
    if ($ZcodePath) {
        if (-not (Valid $ZcodePath)) { throw "指定的 -ZcodePath 下未找到 resources\app.asar：$ZcodePath" }
        return (Resolve-Path $ZcodePath).Path
    }

    $candidates = New-Object System.Collections.Generic.List[string]

    # 1) 正在运行的 ZCode 进程路径（最可靠）
    Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object Path | ForEach-Object {
        $candidates.Add((Split-Path $_.Path -Parent))
    }

    # 2) 注册表卸载信息（DisplayIcon 指向 exe）
    Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                     'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match '^ZCode' -and $_.DisplayIcon } |
        ForEach-Object { $candidates.Add((Split-Path ($_.DisplayIcon -split ',')[0] -Parent)) }

    # 3) 常见安装位置兜底
    @("$env:ProgramFiles\ZCode",
      "${env:ProgramFiles(x86)}\ZCode",
      "$env:LOCALAPPDATA\Programs\ZCode",
      'C:\Program Files\ZCode',
      'D:\ZCode', 'E:\ZCode') | ForEach-Object { $candidates.Add($_) }

    foreach ($c in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (Valid $c) { return (Resolve-Path $c).Path }
    }

    throw @"
未能在常见位置自动发现 ZCode 安装目录（需存在 resources\app.asar）。
请用参数手动指定，例如：.\cdp-patch.ps1 Status -ZcodePath 'D:\Apps\ZCode'
"@
}

$ZCODE = Resolve-ZcodeInstall
Write-Host "[*] ZCode 安装目录：$ZCODE"
if (-not (Test-Path $APPLY)) { throw "缺少共享变换器 $APPLY" }

# ---------- 工具 ----------
function Test-ZcodeRunning { [bool](Get-Process | Where-Object { $_.Name -match '^ZCode' }) }

function Stop-ZcodeProcesses {
    # 退出 UI 后仍可能有残留后台进程（crashpad/更新器/CLI 子进程），优雅关闭 → 强制结束
    $procs = @(Get-Process | Where-Object { $_.Name -match '^ZCode' })
    if ($procs.Count -eq 0) { return }
    Write-Host ("[*] 检测到 ZCode 相关进程 {0} 个，先尝试优雅关闭 ..." -f $procs.Count) -ForegroundColor Yellow
    $procs | ForEach-Object { try { $null = $_.CloseMainWindow() } catch {} }
    Start-Sleep -Seconds 4
    $left = @(Get-Process | Where-Object { $_.Name -match '^ZCode' })
    if ($left.Count -gt 0) {
        Write-Host "[*] 仍有 $($left.Count) 个进程，强制结束 ..."
        $left | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

function Wait-ZcodeExit {
    if (Test-ZcodeRunning) {
        if (-not $WaitForExit) { throw "ZCode 正在运行。请完全退出（含托盘）后重试；菜单方式会自动结束进程，或加参数 -WaitForExit" }
        while (Test-ZcodeRunning) {
            Stop-ZcodeProcesses
            if (Test-ZcodeRunning) { Start-Sleep -Seconds 3 }
        }
        Start-Sleep -Seconds 2
        Write-Host '[OK] ZCode 已全部退出'
    }
}

function Get-PluginTargets {
    $list = @()
    $res = "$ZCODE\resources\glm\packages\browser-use-plugin"
    if (Test-Path "$res\scripts\browser-client.mjs") { $list += $res }
    $cacheRoot = "$env:USERPROFILE\.zcode\cli\plugins\cache\zcode-plugins-official\browser-use"
    if (Test-Path $cacheRoot) {
        $list += Get-ChildItem $cacheRoot -Directory |
            Where-Object { $_.Name -like '0.4*' -and (Test-Path (Join-Path $_.FullName 'scripts\browser-client.mjs')) } |
            ForEach-Object { $_.FullName }
    }
    return $list
}

function Set-PluginFiles([string]$MjsSrc, [string]$JsonSrc, [string]$Label) {
    foreach ($t in (Get-PluginTargets)) {
        Copy-Item $MjsSrc  "$t\scripts\browser-client.mjs" -Force
        Copy-Item $JsonSrc "$t\docs\api.json" -Force
        Write-Host "[OK] $Label 插件: $t"
    }
}

# ---------- 动作 ----------
switch ($Action) {

    'Status' {
        Write-Host '== ZCode Windows CDP 补丁状态 ==' -ForegroundColor Cyan
        Write-Host ("安装目录   : " + $ZCODE)
        $run = Test-ZcodeRunning
        Write-Host ("ZCode 进程 : " + $(if ($run) { '运行中' } else { '未运行' }))
        $ver = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                                        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match '^ZCode' }).DisplayVersion
        Write-Host ("ZCode 版本 : " + $(if ($ver) { $ver } else { '未知' }) + "（锚点适配版本 3.10.1）")

        $mIdx = Select-String -LiteralPath "$ZCODE\resources\app.asar" -Pattern 'executeCdp' -Quiet
        $mSch = Select-String -LiteralPath "$ZCODE\resources\app.asar" -Pattern 'literal\("cdp"\)' -Quiet
        $a = if ($mIdx -and $mSch) { 'Patched' } elseif (-not $mIdx -and -not $mSch) { 'Clean' } else { 'Unknown' }
        Write-Host "  [$a] app.asar 主进程桥/schema"

        $hit = Select-String -LiteralPath "$ZCODE\resources\glm\zcode.cjs" -Pattern 'literal\("cdp"\)' -Quiet
        Write-Host "  [$(if ($hit) { 'Patched' } else { 'Clean' })] glm\zcode.cjs Broker"

        $first = (Get-PluginTargets | Select-Object -First 1)
        if ($first) {
            $pOk = (Get-FileHash "$first\scripts\browser-client.mjs" -Algorithm SHA256).Hash -eq
                   (Get-FileHash (Join-Path $REPO 'browser-client.mjs') -Algorithm SHA256).Hash
            Write-Host "  [$(if ($pOk) { 'Patched' } else { 'Clean' })] 插件(0.4.x)"
        }

        Write-Host ''
        Write-Host '结论：三项全为 Patched 即 CDP 可用；出现 Unknown/混合时建议 Remove 后重新 Apply'
    }

    'Apply' {
        if (-not $Force) {
            $already = (Select-String -LiteralPath "$ZCODE\resources\app.asar" -Pattern 'executeCdp' -Quiet)
            if ($already) { Write-Host '检测到已是补丁状态，跳过（-Force 可强制重刷）'; break }
        }
        Wait-ZcodeExit

        foreach ($f in @('rules.cjs', 'zcode.cjs.gz', 'browser-client.mjs', 'api.json')) {
            if (-not (Test-Path (Join-Path $REPO $f))) { throw "缺少共享文件 $f" }
        }
        $pluginPatched = Join-Path $REPO 'browser-client.mjs'

        # 首次：整包备份（Remove 的唯一依据）
        New-Item $BAK -ItemType Directory -Force | Out-Null
        if (-not (Test-Path "$BAK\app.asar.original")) {
            Write-Host '[*] 首次运行：整包备份原版 app.asar（约 300MB，一次性）...'
            Copy-Item "$ZCODE\resources\app.asar" "$BAK\app.asar.original"
        }
        if (-not (Test-Path "$BAK\zcode.cjs.original")) {
            Copy-Item "$ZCODE\resources\glm\zcode.cjs" "$BAK\zcode.cjs.original"
        }
        $firstPlugin = (Get-PluginTargets | Select-Object -First 1)
        if ($firstPlugin -and -not (Test-Path "$BAK\browser-client.mjs.original")) {
            Copy-Item "$firstPlugin\scripts\browser-client.mjs" "$BAK\browser-client.mjs.original"
            Copy-Item "$firstPlugin\docs\api.json" "$BAK\api.json.original"
        }

        Write-Host '[*] 应用 Main/Host/Scheduler asar 补丁（规则引擎）...'
        node $APPLY "$ZCODE\resources\app.asar" (Join-Path $REPO 'rules.cjs') (Join-Path $env:TEMP ('zcode-win-apply-' + [IO.Path]::GetRandomFileName()))
        if ($LASTEXITCODE -ne 0) { throw 'asar 变换失败' }

        Write-Host '[*] 应用 Broker zcode.cjs ...'
        $gz = [IO.File]::OpenRead((Join-Path $REPO 'zcode.cjs.gz'))
        $gs = New-Object IO.Compression.GZipStream($gz, [IO.Compression.CompressionMode]::Decompress)
        $out = [IO.File]::Create("$ZCODE\resources\glm\zcode.cjs")
        $gs.CopyTo($out); $out.Close(); $gs.Close(); $gz.Close()
        Write-Host '[OK] Broker 已替换'

        Set-PluginFiles $pluginPatched (Join-Path $REPO 'api.json') '应用'

        Write-Host ''
        Write-Host '✅ 补丁已启用。启动 ZCode 新开对话验证：tab.cdp.evaluate("1+1") / tab.openDevTools()'
    }

    'Backup' {
        New-Item $BAK -ItemType Directory -Force | Out-Null
        if (-not (Test-Path "$BAK\app.asar.original")) {
            Copy-Item "$ZCODE\resources\app.asar" "$BAK\app.asar.original"
            Write-Host '[OK] app.asar 已备份'
        } else { Write-Host '[跳过] app.asar 备份已存在' }
        if (-not (Test-Path "$BAK\zcode.cjs.original")) {
            Copy-Item "$ZCODE\resources\glm\zcode.cjs" "$BAK\zcode.cjs.original"
            Write-Host '[OK] Broker 已备份'
        }
        $fp = (Get-PluginTargets | Select-Object -First 1)
        if ($fp -and -not (Test-Path "$BAK\browser-client.mjs.original")) {
            Copy-Item "$fp\scripts\browser-client.mjs" "$BAK\browser-client.mjs.original"
            Copy-Item "$fp\docs\api.json" "$BAK\api.json.original"
            Write-Host '[OK] 插件已备份'
        }
        Write-Host '✅ 备份完成（backup 目录）'
    }

    'Remove' {
        Wait-ZcodeExit
        $asarBak = "$BAK\app.asar.original"
        if (-not (Test-Path $asarBak)) { throw "未找到 $asarBak，无法安全还原" }
        Write-Host '[*] 整包还原 app.asar ...'
        Copy-Item $asarBak "$ZCODE\resources\app.asar" -Force
        Write-Host '[OK] app.asar 已还原'
        if (Test-Path "$BAK\zcode.cjs.original") {
            Copy-Item "$BAK\zcode.cjs.original" "$ZCODE\resources\glm\zcode.cjs" -Force
            Write-Host '[OK] Broker 已还原'
        }
        if (Test-Path "$BAK\browser-client.mjs.original") {
            Set-PluginFiles "$BAK\browser-client.mjs.original" "$BAK\api.json.original" '还原'
        }
        Write-Host '✅ 已停用，ZCode 回到出厂状态'
    }
}
