@echo off
rem wb-start.cmd - start WorkBuddy with the OFFICIAL CDP channel enabled.
rem Session-scoped env only; nothing is written to registry / user config.
rem Usage: wb-start.cmd [dev]
rem   dev = also set ELECTRON_RENDERER_URL to the packaged renderer,
rem         which flips WorkBuddy into dev mode (right-click Inspect inside
rem         the built-in browser). Pure experiment: if UI misbehaves,
rem         just start WorkBuddy normally next time.
setlocal EnableExtensions
title WorkBuddy CDP Launcher

rem ---- locate install ----
set "WB_EXE=%LocalAppData%\Programs\WorkBuddy\WorkBuddy.exe"
if not exist "%WB_EXE%" set "WB_EXE=E:\WorkBuddy\WorkBuddy.exe"
if not exist "%WB_EXE%" (
  echo [x] WorkBuddy.exe not found.
  echo     Edit this file and set WB_EXE to your install path.
  pause
  exit /b 1
)
for %%I in ("%WB_EXE%") do set "WB_HOME=%%~dpI"
set "WB_RENDERER_URL=file:///%WB_HOME:\=/%resources/app.asar/renderer/index.html"
set "WB_MODE=%~1"
set "WB_MODE_TEXT=%WB_MODE%"
if "%WB_MODE_TEXT%"=="" set "WB_MODE_TEXT=normal"

echo ==============================================
echo  WorkBuddy CDP Launcher   mode: %WB_MODE_TEXT%
echo ==============================================
echo.
echo [1/4] Closing running WorkBuddy - graceful, up to 15s ...
taskkill /im WorkBuddy.exe >nul 2>&1
set /a WB_N=0
:waitclose
timeout /t 1 /nobreak >nul
tasklist /fi "imagename eq WorkBuddy.exe" 2>nul | find /i "WorkBuddy.exe" >nul
if errorlevel 1 goto closed
set /a WB_N+=1
<nul set /p=.
if %WB_N% lss 15 goto waitclose
echo.
echo       still running, force closing ...
taskkill /f /im WorkBuddy.exe >nul 2>&1
timeout /t 2 /nobreak >nul
:closed
echo.
echo [2/4] Session env for this launch - nothing persistent:
set "WORKBUDDY_REMOTE_DEBUGGING_PORT=9222"
echo        WORKBUDDY_REMOTE_DEBUGGING_PORT=9222
if /i "%WB_MODE%"=="dev" (
  if exist "%WB_HOME%resources\app.asar" (
    set "ELECTRON_RENDERER_URL=%WB_RENDERER_URL%"
    echo        ELECTRON_RENDERER_URL=...app.asar/renderer/index.html   [dev mode]
  ) else (
    echo [!] dev mode skipped: app.asar not found under %WB_HOME%
  )
)
echo.
echo [3/4] Starting WorkBuddy ...
start "" "%WB_EXE%"
echo.
echo [4/4] Waiting for CDP port 9222
set /a WB_N=0
:waitport
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":9222" | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 goto portok
set /a WB_N+=1
<nul set /p=.
if %WB_N% lss 40 goto waitport
echo.
echo [!] Port 9222 not listening yet - app may still be starting.
echo     Verify later with:  wb-cdp status
echo.
pause
exit /b 0

:portok
echo.
echo.
echo [OK] WorkBuddy is running WITH CDP on port 9222.
echo.
echo      Try:
echo        wb-cdp status
echo        wb-cdp list
echo        wb-cdp open https://www.baidu.com
echo        wb-cdp eval "1+1"
echo        wb-cdp shot
echo        wb-cdp devtools
echo.
echo      Open the built-in browser panel first - it appears in wb-cdp list.
echo.
pause
