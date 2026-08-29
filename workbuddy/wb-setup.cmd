@echo off
rem wb-setup.cmd - install / remove / status for the WorkBuddy CDP bridge.
rem Installs:  %USERPROFILE%\.workbuddy\cdp-bridge\  (wb-cdp.mjs/.cmd/wb-start.cmd)
rem            %USERPROFILE%\.workbuddy\skills\wb-cdp\  (native skill so the agent knows)
rem Does NOT modify WorkBuddy files. Usage: wb-setup.cmd [install^|remove^|status]
setlocal EnableExtensions
set "SRC=%~dp0"
set "BRIDGE=%USERPROFILE%\.workbuddy\cdp-bridge"
set "SKILL=%USERPROFILE%\.workbuddy\skills\wb-cdp"
set "NODE_EXE=node"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=install"

if /i "%MODE%"=="status" goto status
if /i "%MODE%"=="remove" goto remove
if /i "%MODE%"=="install" goto install
echo usage: wb-setup.cmd [install ^| remove ^| status]
exit /b 2

:install
echo ==============================================
echo  WorkBuddy CDP bridge - install
echo ==============================================
if not exist "%SRC%wb-cdp.mjs" (
  echo [x] wb-cdp.mjs not found next to wb-setup.cmd
  exit /b 1
)
call :picknode
if errorlevel 1 exit /b 1

echo [1/4] CLI files -^> %BRIDGE%
if not exist "%BRIDGE%" mkdir "%BRIDGE%"
copy /y "%SRC%wb-cdp.mjs"    "%BRIDGE%\wb-cdp.mjs"    >nul
copy /y "%SRC%wb-cdp.cmd"    "%BRIDGE%\wb-cdp.cmd"    >nul
copy /y "%SRC%wb-start.cmd"  "%BRIDGE%\wb-start.cmd"  >nul
copy /y "%SRC%wb-setup.cmd"  "%BRIDGE%\wb-setup.cmd"  >nul

echo [2/4] Skill -^> %SKILL%
if not exist "%SKILL%" mkdir "%SKILL%"
set "SKILL_META=%SKILL%\_user_meta.json"
set "SKILL_OUT=%SKILL%\SKILL.md"
set "SKILL_TPL=%SRC%SKILL.template.md"
"%NODE_EXE%" -e "const fs=require('fs');let s=fs.readFileSync(process.env.SKILL_TPL,'utf8');s=s.split('__BRIDGE__').join(process.env.BRIDGE+'\\wb-cdp.cmd');fs.writeFileSync(process.env.SKILL_OUT,s);fs.writeFileSync(process.env.SKILL_META,JSON.stringify({name:'wb-cdp',installedAt:Date.now(),source:'userImport'},null,2));console.log('       skill written: '+process.env.SKILL_OUT)"
if errorlevel 1 (
  echo [x] failed to write skill files
  exit /b 1
)

echo [3/4] Self-test CLI ...
call "%BRIDGE%\wb-cdp.cmd" status
if errorlevel 3 (
  echo        CDP not running right now - that is OK.
  echo        Start WorkBuddy via: %BRIDGE%\wb-start.cmd
) else (
  echo        CDP channel is live.
)

echo [4/4] Done.
echo.
echo [OK] Installed. For the agent to see the skill, restart WorkBuddy.
echo      Launch WorkBuddy with CDP: "%BRIDGE%\wb-start.cmd"
echo      Quick test in any terminal:
echo        "%BRIDGE%\wb-cdp.cmd" status
echo.
pause
exit /b 0

:remove
echo Removing skill and CLI bridge ...
if exist "%SKILL%" rmdir /s /q "%SKILL%"
if exist "%BRIDGE%" rmdir /s /q "%BRIDGE%"
echo [OK] Removed. WorkBuddy itself was NOT modified.
pause
exit /b 0

:status
echo ==============================================
echo  WorkBuddy CDP bridge - status
echo ==============================================
if exist "%BRIDGE%\wb-cdp.cmd" (echo [ok] CLI      : %BRIDGE%\wb-cdp.cmd) else (echo [..] CLI      : not installed)
if exist "%SKILL%\SKILL.md"   (echo [ok] Skill    : %SKILL%) else (echo [..] Skill    : not installed)
if exist "%BRIDGE%\wb-cdp.cmd" call "%BRIDGE%\wb-cdp.cmd" status
exit /b 0

:picknode
where node >nul 2>&1
if not errorlevel 1 exit /b 0
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "NODE_EXE=%%~fD\node.exe"
if exist "%NODE_EXE%" (
  echo        using bundled node: %NODE_EXE%
  exit /b 0
)
echo [x] node not found - install Node.js or check .workbuddy\binaries
exit /b 1
