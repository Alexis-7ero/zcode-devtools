# WorkBuddy CDP Tool - interactive menu (ASCII only on purpose)
$ErrorActionPreference = "Continue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-Tool($script, $arg) {
    Write-Host ""
    & cmd.exe /c "`"$dir\$script`" $arg"
    Write-Host ""
}

while ($true) {
    Write-Host "=============================================="
    Write-Host " WorkBuddy CDP Tool"
    Write-Host "=============================================="
    Write-Host " [1] Install native browser_cdp patch"
    Write-Host " [2] Remove patch (restore originals)"
    Write-Host " [3] Patch status"
    Write-Host " [4] Launch WorkBuddy (explicit CDP mode)"
    Write-Host " [5] Install agent skill + CLI bridge"
    Write-Host " [6] Remove agent skill + CLI bridge"
    Write-Host " [0] Exit"
    $choice = Read-Host "Select"
    switch ($choice) {
        "1" { Invoke-Tool "wb-patch.cmd" "install" }
        "2" { Invoke-Tool "wb-patch.cmd" "remove" }
        "3" { Invoke-Tool "wb-patch.cmd" "status" }
        "4" { Invoke-Tool "wb-start.cmd" "" }
        "5" { Invoke-Tool "wb-setup.cmd" "install" }
        "6" { Invoke-Tool "wb-setup.cmd" "remove" }
        "0" { break }
        default { }
    }
    if ($choice -eq "0") { break }
}
