# DevTools Tool - unified interactive menu for ZCode + WorkBuddy.
# UI language auto-detected from system locale (zh* -> Chinese, else English).
$ErrorActionPreference = "Continue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = "ZCode"

$ui = [System.Globalization.CultureInfo]::CurrentUICulture.Name
if ($ui -like "zh*") {
    $T = @{
        header  = " DevTools 强开工具    当前目标: [{0}]"
        install = " [1] 安装补丁"
        backup  = " [2] 备份"
        remove  = " [3] 卸载 / 还原"
        status  = " [4] 状态"
        switch  = " [5] 切换目标  (ZCode <-> WorkBuddy)"
        exit    = " [0] 退出"
        select  = "请选择"
        toWb    = "已切换目标: WorkBuddy"
        toZc    = "已切换目标: ZCode"
    }
} else {
    $T = @{
        header  = " DevTools Tool    target: [{0}]"
        install = " [1] Install patch"
        backup  = " [2] Backup"
        remove  = " [3] Remove patch (restore originals)"
        status  = " [4] Status"
        switch  = " [5] Switch target  (ZCode <-> WorkBuddy)"
        exit    = " [0] Exit"
        select  = "Select"
        toWb    = "target switched: WorkBuddy"
        toZc    = "target switched: ZCode"
    }
}

function Invoke-Zcode($action, $wait) {
    $extra = ""
    if ($wait) { $extra = " -WaitForExit" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dir\zcode\windows\cdp-patch.ps1" $action$extra
}
function Invoke-Workbuddy($action) {
    & cmd.exe /c "`"$dir\workbuddy\wb-patch.cmd`" $action"
}

while ($true) {
    Write-Host ""
    Write-Host "=============================================="
    Write-Host ($T.header -f $target)
    Write-Host "=============================================="
    Write-Host $T.install
    Write-Host $T.backup
    Write-Host $T.remove
    Write-Host $T.status
    Write-Host $T.switch
    Write-Host $T.exit
    $choice = Read-Host $T.select
    switch ($choice) {
        "1" { if ($target -eq "ZCode") { Invoke-Zcode "Apply" $true } else { Invoke-Workbuddy "install" } }
        "2" { if ($target -eq "ZCode") { Invoke-Zcode "Backup" $false } else { Invoke-Workbuddy "backup" } }
        "3" { if ($target -eq "ZCode") { Invoke-Zcode "Remove" $true } else { Invoke-Workbuddy "remove" } }
        "4" { if ($target -eq "ZCode") { Invoke-Zcode "Status" $false } else { Invoke-Workbuddy "status" } }
        "5" { if ($target -eq "ZCode") { $target = "WorkBuddy"; Write-Host $T.toWb } else { $target = "ZCode"; Write-Host $T.toZc } }
        "0" { break }
        default { }
    }
    if ($choice -eq "0") { break }
}
