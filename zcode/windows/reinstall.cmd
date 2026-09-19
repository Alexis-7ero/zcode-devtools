@echo off
rem one-click reinstall (elevate + kill ZCode + restore originals + re-hook)
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
    exit /b
)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reinstall.ps1"
pause
