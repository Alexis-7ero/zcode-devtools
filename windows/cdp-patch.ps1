# ZCode 3.9.2 CDP 补丁开关（一键外置管理）
# ============================================================
# 用法（管理员 PowerShell）：
#   .\cdp-patch.ps1 Status               查看当前状态（普通权限即可）
#   .\cdp-patch.ps1 Apply                启用补丁（需先退出 ZCode）
#   .\cdp-patch.ps1 Apply -WaitForExit   启用补丁；自动等待 ZCode 退出，退出后约 1-2 分钟完成刷入
#   .\cdp-patch.ps1 Remove               停用补丁，还原原版文件
#   .\cdp-patch.ps1 Apply -Force         已启用时强制重刷（如个别文件被覆盖）
#
# 补丁备份独立存放在本目录 backup\originals\ 下，Remove 不依赖系统盘残留。

param(
    [Parameter(Position = 0)]
    [ValidateSet('Apply', 'Remove', 'Status')]
    [string]$Action = 'Status',
    [switch]$WaitForExit,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ZCODE = 'C:\Program Files\ZCode'
$ROOT  = $PSScriptRoot
$PAYLOAD = Join-Path $ROOT 'payload'
$BAK   = Join-Path $ROOT 'backup'
$ORIG  = Join-Path $BAK 'originals'
$META  = Join-Path $BAK 'metadata.json'

if (-not (Test-Path "$ZCODE\resources\app.asar")) { throw "未找到 $ZCODE\resources\app.asar，请确认 ZCode 安装在默认路径" }

# ---------- 通用工具 ----------
function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}
function Test-ZcodeRunning {
    [bool](Get-Process | Where-Object { $_.Name -match '^ZCode' })
}
function Wait-ZcodeExit {
    if (Test-ZcodeRunning) {
        if (-not $WaitForExit) { throw "ZCode 正在运行。请完全退出（含托盘）后重试，或加参数 -WaitForExit" }
        Write-Host '[*] 等待 ZCode 退出...' -ForegroundColor Yellow
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

# 在 asar 二进制里流式查找标记串（JS 内容未压缩存储，可直接搜）
function Test-AsarMarker([string]$Needle) {
    $fs = [IO.File]::OpenRead("$ZCODE\resources\app.asar")
    try {
        $buf = New-Object byte[] (8MB)
        $tail = ''
        while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
            $text = $tail + [Text.Encoding]::ASCII.GetString($buf, 0, $n)
            if ($text.Contains($Needle)) { return $true }
            $tail = $text.Substring([Math]::Max(0, $text.Length - 256))
        }
        return $false
    } finally { $fs.Close() }
}

function Get-ManagedState {
    # 返回各受管文件的 状态：Clean / Patched / Unknown
    $r = [ordered]@{}
    $mIdx = Test-AsarMarker 'executeCdp'
    $mSch = Test-AsarMarker ('literal("cdp")')
    $r['app.asar(main桥/schema)'] =
        if ($mIdx -and $mSch) { 'Patched' } elseif (-not $mIdx -and -not $mSch) { 'Clean' } else { 'Unknown' }
    $zc = "$ZCODE\resources\glm\zcode.cjs"
    $hit = Select-String -LiteralPath $zc -Pattern 'literal\("cdp"\)' -Quiet -ErrorAction SilentlyContinue
    $r['glm\zcode.cjs(Broker)'] = if ($hit) { 'Patched' } else { 'Clean' }
    foreach ($t in (Get-PluginTargets)) {
        $rel = if ($t -notmatch 'plugins\\cache') { '插件(资源包)' } else { "插件缓存($([IO.Path]::GetFileName($t)))" }
        $same = (Get-Sha256 "$t\scripts\browser-client.mjs") -eq (Get-Sha256 "$PAYLOAD\browser-client.mjs")
        $r[$rel] = if ($same) { 'Patched' } else { 'Clean' }
    }
    return $r
}

# 解包当前 asar、按映射覆盖 JS、重打包并替换（App 需已退出）
function Update-AsarOverlay([hashtable]$Map) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $WORK = Join-Path $env:TEMP "zcode-cdp-asar-$stamp"
    New-Item $WORK -ItemType Directory | Out-Null
    try {
        New-Item -ItemType Junction -Path "$WORK\unpacked" -Target "$ZCODE\resources\app.asar.unpacked" | Out-Null
        Copy-Item "$ZCODE\resources\app.asar" "$WORK\app.asar"
        npx --yes @electron/asar extract "$WORK\app.asar" "$WORK\x" 2>$null
        if (-not (Test-Path "$WORK\x\out\main\index.js")) { throw "asar 解包失败" }

        # 将正斜杠形式的逻辑键映射为 asar 内实际使用的磁盘相对路径
        $realMap = @{}
        foreach ($k in $Map.Keys) {
            $parts = $k -split '/'
            $candidates = @(
                ($parts -join '\'),
                ($parts[0] + '\' + ($parts[1..($parts.Length-1)] -join '\'))
            )
            $found = $false
            foreach ($c in $candidates) {
                if (Test-Path (Join-Path "$WORK\x" $c)) { $realMap[$c] = $Map[$k]; $found = $true; break }
            }
            if (-not $found) { throw "无法定位内部文件 $k 的磁盘路径" }
        }
        foreach ($k in $realMap.Keys) {
            Copy-Item $realMap[$k] (Join-Path "$WORK\x" $k) -Force
            Write-Host "[OK] 覆盖 $k"
        }

        @'
const { createPackageWithOptions } = require("@electron/asar");
createPackageWithOptions(process.argv[2], process.argv[3], { unpack: "{**/*.node,**/*.dll,**/*.exe}" })
    .then(() => console.log("pack ok"))
    .catch((e) => { console.error(e); process.exit(1); });
'@ | Set-Content -Path "$WORK\pack.cjs" -Encoding UTF8
        npm install --prefix "$WORK" @electron/asar --no-audit --no-fund --loglevel=error
        Push-Location $WORK
        node "pack.cjs" "$WORK\x" "$WORK\app.asar.new"
        Pop-Location
        if (-not (Test-Path "$WORK\app.asar.new")) { throw "asar 打包失败（需要 Node.js 与 npm）" }
        if ((Get-Item "$WORK\app.asar.new").Length -lt 200MB) { throw "重打包产物异常偏小，中止替换" }

        Copy-Item "$WORK\app.asar.new" "$ZCODE\resources\app.asar" -Force
        Write-Host '[OK] app.asar 已替换'
    } finally {
        # 先移除 junction 本身（绝不递归进目标目录），再清理临时工作树
        cmd /c "rmdir /q `"$WORK\unpacked`"" 2>$null
        Remove-Item $WORK -Recurse -Force -ErrorAction SilentlyContinue
    }
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
        Write-Host "== ZCode CDP 补丁状态 ==" -ForegroundColor Cyan
        Write-Host ("ZCode 进程 : " + ($(if (Test-ZcodeRunning) { '运行中' } else { '未运行' })))
        $ver = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                                        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match "^ZCode" }).DisplayVersion
        Write-Host ("ZCode 版本 : " + $(if ($ver) { $ver } else { '未知' }) + "（补丁目标版本 3.9.2）")
        Write-Host ""
        $state = Get-ManagedState
        $patched = 0; $total = 0
        foreach ($k in $state.Keys) {
            $v = $state[$k]; $total++
            if ($v -eq 'Patched') { $patched++ }
            $color = switch ($v) { 'Patched' { 'Green' } 'Clean' { 'DarkGray' } default { 'Red' } }
            Write-Host ("  [{0}] {1}" -f $v.PadRight(7), $k) -ForegroundColor $color
        }
        Write-Host ""
        $verdict =
            if ($patched -eq 0) { '全部未打补丁（干净状态）' }
            elseif ($patched -eq $total) { '全部已打补丁（CDP 可用）' }
            else { '混合状态 —— 建议 -Force 重刷或先 Remove 再 Apply' }
        Write-Host "结论：$verdict" -ForegroundColor Cyan
    }

    'Apply' {
        if (-not $Force) {
            $s = Get-ManagedState
            $already = ($s.Values | Where-Object { $_ -eq 'Patched' }).Count
            if ($already -eq $s.Count) { Write-Host '已经是完整补丁状态，无需操作（加 -Force 可强制重刷）'; break }
        }
        Wait-ZcodeExit

        Write-Host '[*] 校验 payload 与备份完整性...'
        foreach ($f in @('main-index.js', 'main-chunk.js', 'host-chunk.js', 'scheduler-index.js', 'plugin-scripts/browser-client.mjs', 'plugin-docs/api.json', 'zcode.cjs')) {
            if (-not (Test-Path (Join-Path $ORIG $f))) { throw "缺少原版备份 $f，请勿删除 backup 目录" }
        }
        foreach ($f in @('main-index.js', 'main-chunk.js', 'host-chunk.js', 'zcode.cjs.gz', 'browser-client.mjs', 'api.json')) {
            if (-not (Test-Path (Join-Path $PAYLOAD $f))) { throw "缺少补丁文件 $f" }
        }

        Write-Host '[*] 记录原始指纹...'
        [IO.File]::WriteAllText($META, (@{
                appliedAt    = (Get-Date -Format 'o')
                targetVer    = '3.9.2'
                cleanAsar256 = (Get-Sha256 "$ZCODE\resources\app.asar").Substring(0, 16) + '...'
            } | ConvertTo-Json))

        Write-Host '[*] 应用 Main/Host asar 补丁...'
        Update-AsarOverlay @{
            'out/main/index.js'          = "$PAYLOAD\main-index.js"
            'out/main/chunk-UANQQ3DL.js' = "$PAYLOAD\main-chunk.js"
            'out/host/chunk-XTOW2S5X.js' = "$PAYLOAD\host-chunk.js"
            'out/scheduler/index.js'     = "$PAYLOAD\scheduler-index.js"
        }

        Write-Host '[*] 应用 Broker zcode.cjs...'
        $gz = [IO.File]::OpenRead((Join-Path $PAYLOAD 'zcode.cjs.gz'))
        $gs = New-Object IO.Compression.GZipStream($gz, [IO.Compression.CompressionMode]::Decompress)
        $out = [IO.File]::Create("$ZCODE\resources\glm\zcode.cjs")
        $gs.CopyTo($out); $out.Close(); $gs.Close(); $gz.Close()
        Write-Host '[OK] Broker 已替换'

        Set-PluginFiles "$PAYLOAD\browser-client.mjs" "$PAYLOAD\api.json" '应用'

        Write-Host ''
        Write-Host '✅ 补丁已启用。启动 ZCode 新开对话验证：tab.cdp.evaluate("1+1") / tab.openDevTools()' -ForegroundColor Green
    }

    'Remove' {
        Wait-ZcodeExit
        Write-Host '[*] 还原 Main/Host asar（使用 backup\originals 原版文件）...'
        Update-AsarOverlay @{
            'out/main/index.js'          = "$ORIG\main-index.js"
            'out/main/chunk-UANQQ3DL.js' = "$ORIG\main-chunk.js"
            'out/host/chunk-XTOW2S5X.js' = "$ORIG\host-chunk.js"
            'out/scheduler/index.js'     = "$ORIG\scheduler-index.js"
        }
        Write-Host '[*] 还原 Broker zcode.cjs...'
        Copy-Item "$ORIG\zcode.cjs" "$ZCODE\resources\glm\zcode.cjs" -Force
        Write-Host '[OK] Broker 已还原'
        Set-PluginFiles "$ORIG\plugin-scripts\browser-client.mjs" "$ORIG\plugin-docs\api.json" '还原'
        if (Test-Path $META) { Remove-Item $META -Force }

        Write-Host ''
        Write-Host '✅ 已停用，ZCode 回到出厂状态。backup\originals 保留，可随时重新 Apply' -ForegroundColor Green
    }
}