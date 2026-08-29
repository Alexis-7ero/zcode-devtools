@echo off
rem wb-cdp.cmd - resolve node and run wb-cdp.mjs (ASCII only)
setlocal
set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=node"
where node >nul 2>&1
if errorlevel 1 call :findnode
"%NODE_EXE%" "%SCRIPT_DIR%wb-cdp.mjs" %*
exit /b %errorlevel%

:findnode
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "NODE_EXE=%%~fD\node.exe"
if exist "%NODE_EXE%" exit /b 0
echo [x] node not found in PATH and no bundled node under .workbuddy
exit /b 5
