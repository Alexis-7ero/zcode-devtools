@echo off
rem ============================================================
rem  WorkBuddy CDP-mode launcher (zero-patch, official env switch)
rem  It terminates any running WorkBuddy first (single-instance apps
rem  cannot pick up new env vars without a restart).
rem  Usage:
rem    wb-start.cmd            CDP mode, port 9222
rem    wb-start.cmd 9333       custom port
rem    wb-start.cmd /persist   write port to user env (permanent)
rem ============================================================
setlocal enabledelayedexpansion
set "PORT=9222"
set "PERSIST=0"
if not "%~1"=="" if /i "%~1"=="/persist" ( set "PERSIST=1" ) else ( set "PORT=%~1" )
if /i "%~2"=="/persist" set "PERSIST=1"

rem --- locate WorkBuddy (running process path -> registry -> common dirs) ---
set "WB_EXE="
for /f "delims=" %%a in ('powershell -NoProfile -Command "$p = Get-Process WorkBuddy -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1; if ($p) { $p.Path } else { $i = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -imatch '^WorkBuddy' } | Select-Object -First 1).DisplayIcon; if ($i) { ($i -split ',')[0] } }"') do set "WB_EXE=%%a"
if "%WB_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe" set "WB_EXE=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe"
if "%WB_EXE%"=="" (
    echo [x] WorkBuddy install location not found.
    pause
    exit /b 1
)
echo [*] WorkBuddy: %WB_EXE%
echo [*] CDP port : %PORT%
if "%PERSIST%"=="1" echo [*] Port will be persisted to user env.

rem --- kill existing instance (env vars never reach a running app) ---
tasklist | find /i "WorkBuddy.exe" >nul && (
    echo [*] Terminating running WorkBuddy ...
    taskkill /im WorkBuddy.exe /f >nul 2>&1
    timeout /t 2 /nobreak >nul
)

set "WORKBUDDY_REMOTE_DEBUGGING_PORT=%PORT%"
if "%PERSIST%"=="1" setx WORKBUDDY_REMOTE_DEBUGGING_PORT "%PORT%" >nul

echo [*] Starting WorkBuddy in CDP mode ...
start "" "%WB_EXE%"

echo [*] Waiting for CDP endpoint (up to 30s) ...
set /a TRY=0
:waitloop
timeout /t 2 /nobreak >nul
set /a TRY+=1
echo     checking ... (%TRY%/15)
node "%~dp0wb-cdp.mjs" list >nul 2>&1
if errorlevel 1 (
    if %TRY% lss 15 goto waitloop
    echo [x] Timeout: CDP endpoint not ready.
    pause
    exit /b 1
)

chcp 65001 >nul
echo.
node "%~dp0wb-cdp.mjs" list
echo.
echo [OK] CDP mode is ready. In the WorkBuddy chat, ask the agent to run:
echo      node "%~dp0wb-cdp.mjs" eval --url baidu --expr "1+1"
echo      node "%~dp0wb-cdp.mjs" nav  --url baidu --to "https://example.com"
echo (Open any page in the WorkBuddy preview and it shows up as a webview target)
pause
