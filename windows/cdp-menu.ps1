# ZCode DevTools 交互菜单（双击 ZCodeCDPTool.exe 即进入）
# 非管理员运行时自动弹出 UAC 提权重启

$ErrorActionPreference = 'Stop'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$Core = Join-Path $PSScriptRoot 'cdp-patch.ps1'
if (-not (Test-Path $Core)) { Write-Host "缺少 cdp-patch.ps1" -ForegroundColor Red; Read-Host '回车退出'; exit 1 }

function Show-Menu {
    Clear-Host
    Write-Host '╔══════════════════════════════════════════╗' -ForegroundColor Cyan
    Write-Host '║   ZCode DevTools  ·  CDP 补丁工具         ║' -ForegroundColor Cyan
    Write-Host '╠══════════════════════════════════════════╣' -ForegroundColor Cyan
    Write-Host '║   [1] 安装 / 重刷补丁（自动退出ZCode+进度）  ║'
    Write-Host '║   [2] 备份当前原版文件                     ║'
    Write-Host '║   [3] 卸载补丁（自动退出ZCode+还原）        ║'
    Write-Host '║   [4] 查看补丁状态                         ║'
    Write-Host '║   [0] 退出                                 ║'
    Write-Host '╚══════════════════════════════════════════╝' -ForegroundColor Cyan
}

function Pause-Back {
    Write-Host ''
    Read-Host '操作完成，按回车返回菜单'
}

while ($true) {
    Show-Menu
    $ch = Read-Host '请选择'
    switch ($ch) {
        '1' {
            Write-Host ''
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Core Apply -WaitForExit -Force
            Pause-Back
        }
        '2' {
            Write-Host ''
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Core Backup
            Pause-Back
        }
        '3' {
            Write-Host ''
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Core Remove -WaitForExit
            Pause-Back
        }
        '4' {
            Write-Host ''
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Core Status
            Pause-Back
        }
        '0' { break }
        default { }
    }
    if ($ch -eq '0') { break }
}
