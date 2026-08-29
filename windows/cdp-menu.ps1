# ZCode DevTools 交互菜单（双击 ZCodeCDPTool.exe 即进入）
# 非管理员运行时自动弹出 UAC 提权重启

$ErrorActionPreference = 'Stop'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$Root = $PSScriptRoot
$Core = Join-Path $Root 'cdp-patch.ps1'
$Reinstall = Join-Path $Root 'reinstall.ps1'
if (-not (Test-Path $Core)) { Write-Host '缺少 cdp-patch.ps1' -ForegroundColor Red; Read-Host '回车退出'; exit 1 }

function Show-Menu {
    Clear-Host
    Write-Host '+------------------------------------------+' -ForegroundColor Cyan
    Write-Host '|   ZCode DevTools  -  CDP Patch Tool      |' -ForegroundColor Cyan
    Write-Host '+------------------------------------------+' -ForegroundColor Cyan
    Write-Host '|   [1] 安装 / 重装补丁（自动提权+进度）   |'
    Write-Host '|   [2] 备份当前原版文件                   |'
    Write-Host '|   [3] 卸载补丁（自动结束ZCode+还原）     |'
    Write-Host '|   [4] 查看补丁状态                       |'
    Write-Host '|   [5] WorkBuddy CDP 模式（免补丁官方通道） |
|   [0] 退出                               |'
    Write-Host '+------------------------------------------+' -ForegroundColor Cyan
}

function Pause-Back {
    Write-Host ''
    Read-Host '操作完成，按回车返回菜单' | Out-Null
}

while ($true) {
    Show-Menu
    $ch = Read-Host '请选择'
    try {
        switch ($ch) {
            '1' {
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Reinstall
            }
            '2' {
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Core Backup
            }
            '3' {
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Core Remove -WaitForExit
            }
            '0' { break }
            default { }
        }
    } catch {
        Write-Host "[x] $_" -ForegroundColor Red
    }
    if ($ch -eq '0') { break }
    Pause-Back
}
