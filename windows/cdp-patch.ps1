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
    [ValidateSet('Apply', 'Remove', 'Status')]
    [string]$Action = 'Status',
    [switch]$WaitForExit,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ZCODE = 'C:\Program Files\ZCode'
$ROOT  = $PSScriptRoot                 # windows\
$REPO  = Split-Path $ROOT -Parent      # 仓库根
$APPLY = Join-Path $REPO 'apply-asar.mjs'
$BAK   = Join-Path $ROOT 'backup'

if (-not (Test-Path "$ZCODE\resources\app.asar")) { throw "未找到 $ZCODE\resources\app.asar，请确认 ZCode 安装在默认路径" }
if (-not (Test-Path $APPLY)) { throw "缺少共享变换器 $APPLY" }

# ---------- 工具 ----------
function Test-ZcodeRunning { [bool](Get-Process | Where-Object { $_.Name -match '^ZCode' }) }

function Wait-ZcodeExit {
    if (Test-ZcodeRunning) {
        if (-not $WaitForExit) { throw "ZCode 正在运行。请完全退出（含托盘）后重试，或加参数 -WaitForExit" }
        Write-Host '[*] 等待 ZCode 退出 ...' -ForegroundColor Yellow
        while (Test-ZcodeRunning) { Start-Sleep -Seconds 3 }
        Start-Sleep -Seconds 2
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
                   (Get-FileHash (Join-Path $REPO 'payload\browser-client.mjs') -Algorithm SHA256).Hash
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
        $pluginPatched = Join-Path $REPO 'payload\browser-client.mjs'

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
