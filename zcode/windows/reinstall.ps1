# 一键重装：结束进程 → 还原纯净原版 → 规则引擎重新 hook → Broker/插件 → 自检
# 可直接右键“使用 PowerShell 运行”，或由 Install.cmd / 菜单调用；自动提权。
$ErrorActionPreference = 'Stop'

# ---------- 自动提权 ----------
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$REPO  = Split-Path $PSScriptRoot -Parent   # 仓库根（含 apply-asar.mjs / rules.cjs / zcode.cjs.gz）
$ZCODE = 'C:\Program Files\ZCode'
$RES   = "$ZCODE\resources"
$BAK   = Join-Path $PSScriptRoot 'backup'

# ---------- 0) 兜底定位安装目录 ----------
if (-not (Test-Path "$RES\app.asar")) {
    $proc = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1
    if ($proc) { $ZCODE = Split-Path $proc.Path -Parent; $RES = "$ZCODE\resources" }
}
if (-not (Test-Path "$RES\app.asar")) {
    foreach ($c in @("$env:ProgramFiles\ZCode", "${env:ProgramFiles(x86)}\ZCode", "$env:LOCALAPPDATA\Programs\ZCode", 'D:\ZCode')) {
        if (Test-Path "$c\resources\app.asar") { $ZCODE = $c; $RES = "$c\resources"; break }
    }
}
Write-Host "[*] 安装目录: $ZCODE"

# ---------- 1) 结束 ZCode ----------
$procs = @(Get-Process ZCode -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
    Write-Host ("[*] 结束 ZCode 进程 {0} 个 ..." -f $procs.Count)
    $procs | ForEach-Object { try { $null = $_.CloseMainWindow() } catch {} }
    Start-Sleep -Seconds 4
    Get-Process ZCode -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
} else { Write-Host '[*] ZCode 未运行' }

# ---------- 2) 备份 / 还原纯净原版 ----------
New-Item $BAK -ItemType Directory -Force | Out-Null
$pristine = Join-Path $BAK 'app.asar.original'
if (-not (Test-Path $pristine)) {
    Write-Host '[*] 无历史备份：把当前 asar 存为原版备份 ...'
    Copy-Item "$RES\app.asar" $pristine
}
if (-not (Test-Path "$BAK\zcode.cjs.original")) {
    Copy-Item "$RES\glm\zcode.cjs" "$BAK\zcode.cjs.original"
}
# 关键：先把【纯净原版】写回运行位，保证规则引擎面对的是干净输入
Write-Host '[*] 还原纯净原版 ...'
Copy-Item $pristine "$RES\app.asar" -Force

# ---------- 3) 规则引擎重新 hook（含进度条）----------
Write-Host '[*] 规则引擎 hook main/host/scheduler + schema ...'
node (Join-Path $REPO 'apply-asar.mjs') "$RES\app.asar" (Join-Path $REPO 'rules.cjs') (Join-Path $env:TEMP ('zcode-rt-' + [IO.Path]::GetRandomFileName()))
if ($LASTEXITCODE -ne 0) {
    Write-Host '[x] hook 失败，正在还原原版 ...' -ForegroundColor Red
    Copy-Item $pristine "$RES\app.asar" -Force
    Read-Host '已还原为原版。按回车退出'
    exit 1
}

# ---------- 4) Broker / 插件 ----------
Write-Host '[*] 替换 Broker ...'
$gz = [IO.File]::OpenRead((Join-Path $REPO 'zcode.cjs.gz'))
$gs = New-Object IO.Compression.GZipStream($gz, [IO.Compression.CompressionMode]::Decompress)
$o  = [IO.File]::Create("$RES\glm\zcode.cjs")
$gs.CopyTo($o); $o.Close(); $gs.Close(); $gz.Close()

Write-Host '[*] 覆盖插件 (0.4.x) ...'
$targets = @("$RES\glm\packages\browser-use-plugin")
$cache = "$env:USERPROFILE\.zcode\cli\plugins\cache\zcode-plugins-official\browser-use"
if (Test-Path $cache) {
    Get-ChildItem $cache -Directory | Where-Object { $_.Name -like '0.4*' } |
        ForEach-Object { $targets += $_.FullName }
}
foreach ($t in $targets) {
    if (Test-Path "$t\scripts\browser-client.mjs") {
        Copy-Item (Join-Path $REPO 'browser-client.mjs') "$t\scripts\browser-client.mjs" -Force
        Copy-Item (Join-Path $REPO 'api.json') "$t\docs\api.json" -Force
        Write-Host "    [OK] $t"
    }
}

# ---------- 5) 自检 ----------
Write-Host '[*] 自检 ...'
$ok1 = Select-String -LiteralPath "$RES\app.asar" -Pattern 'executeCdp' -Quiet
$ok2 = Select-String -LiteralPath "$RES\app.asar" -Pattern 'literal\("cdp"\)' -Quiet
$ok3 = Select-String -LiteralPath "$RES\glm\zcode.cjs" -Pattern 'literal\("cdp"\)' -Quiet
$ok4 = (Select-String -LiteralPath (Join-Path $REPO 'browser-client.mjs') -Pattern 'get cdp\(\)' -Quiet)
Write-Host ("  asar 主进程桥 : " + $(if ($ok1) { 'Patched' } else { 'FAIL' }))
Write-Host ("  asar schema   : " + $(if ($ok2) { 'Patched' } else { 'FAIL' }))
Write-Host ("  Broker        : " + $(if ($ok3) { 'Patched' } else { 'FAIL' }))
Write-Host ("  插件          : " + $(if ($ok4) { 'Patched' } else { 'FAIL' }))

if ($ok1 -and $ok2 -and $ok3 -and $ok4) {
    Write-Host ''
    Write-Host '✅ 重装完成！启动 ZCode，新开对话验证：' -ForegroundColor Green
    Write-Host '   打开 https://www.baidu.com 然后执行 tab.cdp.evaluate("1+1") 和 tab.openDevTools()'
} else {
    Write-Host ''
    Write-Host '❌ 存在未通过项，请截图反馈' -ForegroundColor Red
}
