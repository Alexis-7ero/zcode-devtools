@echo off
rem 一键卸载（自动提权 + 结束 ZCode + 整包还原原版）
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
    exit /b
)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cdp-patch.ps1" Remove -WaitForExit
pause
