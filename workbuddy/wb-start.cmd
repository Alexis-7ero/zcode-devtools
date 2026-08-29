@echo off
rem ============================================================
rem  WorkBuddy CDP 模式启动器（免补丁 · 官方预留通道）
rem  原理：WorkBuddy 读取环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT，
rem  自动 appendSwitch 打开 CDP 并放行本机来源。
rem  用法：
rem    wb-start.cmd            以 CDP 模式启动 WorkBuddy（端口 9222）
rem    wb-start.cmd 9333       指定端口
rem    wb-start.cmd /persist   写入用户环境变量（永久生效）
rem ============================================================
setlocal enabledelayedexpansion
set "PORT=9222"
set "PERSIST=0"
if not "%~1"=="" if /i "%~1"=="/persist" ( set "PERSIST=1" ) else ( set "PORT=%~1" )
if /i "%~2"=="/persist" set "PERSIST=1"

rem 自动发现安装目录（注册表 DisplayIcon → 常见位置）
set "WB_EXE="
for /f "tokens=2 delims=," %%a in ('powershell -NoProfile -Command "(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -imatch '^WorkBuddy' } | Select-Object -First 1).DisplayIcon"') do set "WB_EXE=%%a"
if "%WB_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe" set "WB_EXE=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe"
if "%WB_EXE%"=="" (
    echo [x] 未找到 WorkBuddy 安装位置
    pause & exit /b 1
)

set "WORKBUDDY_REMOTE_DEBUGGING_PORT=%PORT%"
if "%PERSIST%"=="1" setx WORKBUDDY_REMOTE_DEBUGGING_PORT "%PORT%" >nul && echo [OK] 已永久写入用户环境变量

echo [*] 以 CDP 模式启动 WorkBuddy（端口 %PORT%）...
start "" "%WB_EXE%"

echo [*] 等待 CDP 端点就绪 ...
set /a TRY=0
:waitloop
timeout /t 2 /nobreak >nul
set /a TRY+=1
node "%~dp0wb-cdp.mjs" list >nul 2>&1
if errorlevel 1 (
    if %TRY% lss 15 goto waitloop
    echo [x] 等待超时：CDP 端点未就绪。请确认 WorkBuddy 已启动。
    pause & exit /b 1
)
node "%~dp0wb-cdp.mjs" list
echo.
echo ✅ CDP 模式已就绪。WorkBuddy 的 agent 可用以下命令驱动内置浏览器：
echo    node "%~dp0wb-cdp.mjs" eval --url baidu --expr "1+1"
echo    node "%~dp0wb-cdp.mjs" nav  --url baidu --to "https://example.com"
echo 说明：未加 /persist 时，仅本次以 CDP 模式生效；普通方式启动即为原版。
pause
