@echo off
rem wb-patch.cmd - apply/remove the native browser_cdp patch for WorkBuddy.
rem  - flips the Electron asar-integrity fuse in WorkBuddy.exe (backup kept)
rem  - patches app.asar: native browser_cdp tool + right-click Inspect
rem Usage: wb-patch.cmd [install^|remove^|status]
setlocal EnableExtensions
set "SRC=%~dp0"
set "WB_HOME=%LocalAppData%\Programs\WorkBuddy"
if not exist "%WB_HOME%\WorkBuddy.exe" set "WB_HOME=E:\WorkBuddy"
set "WB_EXE=%WB_HOME%\WorkBuddy.exe"
set "WB_RES=%WB_HOME%\resources"
set "BK=%WB_RES%\cdp-patch-backup"
set "WORK=%SRC%wb-patch-work"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=install"

if /i "%MODE%"=="status" goto status
if /i "%MODE%"=="remove" goto remove
if /i "%MODE%"=="install" goto install
if /i "%MODE%"=="backup" goto backup
echo usage: wb-patch.cmd [install ^| remove ^| backup ^| status]
exit /b 2

:backup
echo ==============================================
echo  WorkBuddy native CDP patch - backup
echo ==============================================
if not exist "%WB_EXE%" (
  echo [x] WorkBuddy.exe not found at %WB_EXE%
  pause
  exit /b 1
)
if not exist "%BK%" mkdir "%BK%"
copy /y "%WB_EXE%" "%BK%\WorkBuddy.exe" >nul
copy /y "%WB_RES%\app.asar" "%BK%\app.asar" >nul
echo [OK] Backup ready: %BK%
pause
exit /b 0

:install
echo ==============================================
echo  WorkBuddy native CDP patch - install
echo ==============================================
if not exist "%WB_EXE%" (
  echo [x] WorkBuddy.exe not found at %WB_EXE%
  pause
  exit /b 1
)
call :picknode
if errorlevel 1 goto fail

echo [1/6] Closing WorkBuddy - graceful, up to 15s ...
taskkill /im WorkBuddy.exe >nul 2>&1
set /a WB_N=0
:waitclose
ping -n 2 127.0.0.1 >nul
tasklist /fi "imagename eq WorkBuddy.exe" 2>nul | findstr /i "WorkBuddy.exe" >nul
if errorlevel 1 goto closed
set /a WB_N+=1
<nul set /p=.
if %WB_N% lss 15 goto waitclose
echo.
echo       still running, force closing ...
taskkill /f /im WorkBuddy.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul
:closed
echo.

echo [2/6] Backup -^> %BK%
if not exist "%BK%" mkdir "%BK%"
if not exist "%BK%\WorkBuddy.exe" copy /y "%WB_EXE%" "%BK%\WorkBuddy.exe" >nul
if not exist "%BK%\app.asar" copy /y "%WB_RES%\app.asar" "%BK%\app.asar" >nul
if not exist "%BK%\WorkBuddy.exe" goto fail
if not exist "%BK%\app.asar" goto fail
echo        exe + asar backup ready

echo [3/6] Extract current app.asar ...
if exist "%WORK%" rmdir /s /q "%WORK%"
rem NOTE: original packages contain dangling unpacked entries (e.g. arm64
rem prebuilds not shipped for x64), so asar extract may exit non-zero while
rem having extracted everything that actually exists. Content checks decide.
"%NODE_EXE%" "%ASAR_JS%" extract "%WB_RES%\app.asar" "%WORK%" 2>nul
if not exist "%WORK%\main\server.js" goto fail
echo        extracted %WORK% (dangling-entry warnings ignored)
if exist "%WB_RES%\app.asar.unpacked" (
  "%NODE_EXE%" "%SRC%count-files.mjs" "%WB_RES%\app.asar.unpacked" > "%TMP%\wb-orig-unp.txt" 2>nul
  set /p ORIG_UNP=<"%TMP%\wb-orig-unp.txt"
) else (
  set /a ORIG_UNP=0
)
echo        original unpacked files: %ORIG_UNP%

echo [4/6] Inject browser_cdp tool + Inspect ...
"%NODE_EXE%" "%SRC%apply-patch.mjs" "%WORK%"
if errorlevel 1 goto fail

echo [5/6] Repack app.asar ...
if exist "%WORK%.asar" del /f /q "%WORK%.asar"
if exist "%WORK%.asar.unpacked" rmdir /s /q "%WORK%.asar.unpacked"
"%NODE_EXE%" "%ASAR_JS%" pack "%WORK%" "%WORK%.asar" --unpack "{**/cli/**,**/native/**,**/node_modules/**,**/resources/**,**/*.node,**/*.dll,**/*.exe}"
if errorlevel 1 goto fail
if not exist "%WORK%.asar" goto fail
set /a NEW_UNP=0
"%NODE_EXE%" "%SRC%count-files.mjs" "%WORK%.asar.unpacked" > "%TMP%\wb-new-unp.txt" 2>nul
set /p NEW_UNP=<"%TMP%\wb-new-unp.txt"
echo        new unpacked files: %NEW_UNP%
set /a MIN_UNP=%ORIG_UNP% * 98 / 100
if %NEW_UNP% lss %MIN_UNP% (
  echo [x] SAFETY GATE: new unpacked set is missing files - repack bug. Aborting, nothing was modified.
  goto fail
)
"%NODE_EXE%" "%SRC%verify-pack.mjs" "%WORK%.asar" "%WB_RES%\app.asar.unpacked"
if errorlevel 1 (
  echo [x] SAFETY GATE: verification failed. Aborting, nothing was modified.
  goto fail
)

echo [6/6] Swap in files + flip integrity fuse ...
move /y "%WORK%.asar" "%WB_RES%\app.asar" >nul
if exist "%WB_RES%\app.asar.unpacked" rmdir /s /q "%WB_RES%\app.asar.unpacked"
if exist "%WORK%.asar.unpacked" move /y "%WORK%.asar.unpacked" "%WB_RES%\app.asar.unpacked" >nul
"%NODE_EXE%" "%SRC%flip-fuse.mjs" "%WB_EXE%" EnableEmbeddedAsarIntegrityValidation off -i
if errorlevel 1 goto fail
if exist "%WORK%" rmdir /s /q "%WORK%"

echo.
echo [OK] Patch applied. Starting WorkBuddy ...
start "" "%WB_EXE%"
echo.
echo      The agent now has a native tool: browser_cdp
echo      actions: eval / info / shot / net / events / send / devtools
echo      Right-click inside the built-in browser also shows Inspect.
echo      Restore anytime: wb-patch.cmd remove
echo.
pause
exit /b 0

:remove
echo ==============================================
echo  WorkBuddy native CDP patch - remove
echo ==============================================
if not exist "%BK%\WorkBuddy.exe" (
  echo [x] No backup found at %BK% - nothing to restore.
  pause
  exit /b 1
)
echo [1/2] Closing WorkBuddy ...
taskkill /im WorkBuddy.exe >nul 2>&1
ping -n 4 127.0.0.1 >nul
taskkill /f /im WorkBuddy.exe >nul 2>&1
echo [2/2] Restoring original exe + asar ...
copy /y "%BK%\WorkBuddy.exe" "%WB_EXE%" >nul
copy /y "%BK%\app.asar" "%WB_RES%\app.asar" >nul
echo.
echo [OK] Original restored. Note: app.asar.unpacked is left as-is on purpose -
echo      its files are byte-identical to the originals and are not hash-checked.
echo      Starting WorkBuddy ...
start "" "%WB_EXE%"
pause
exit /b 0

:status
echo ==============================================
echo  WorkBuddy native CDP patch - status
echo ==============================================
call :picknode
if errorlevel 1 exit /b 1
if not exist "%WB_EXE%" (
  echo [x] WorkBuddy not found
  exit /b 1
)
if exist "%BK%\WorkBuddy.exe" (echo [ok] Backup : %BK%) else (echo [..] Backup : none - patch not installed via wb-patch)
set "WB_ASAR=%WB_RES%\app.asar"
"%NODE_EXE%" -e "const fs=require('fs');const b=fs.readFileSync(process.env.WB_ASAR);const i=b.indexOf(Buffer.from('createBrowserCdpTool'));console.log(i>=0?'[ok] Patch  : browser_cdp PRESENT in app.asar':'[..] Patch  : not applied to app.asar');"
if errorlevel 1 echo [..] Patch  : check failed
"%NODE_EXE%" "%SRC%fuse-scan.mjs" "%WB_EXE%" 2>nul | findstr /c:"IntegrityValidation" 
exit /b 0

:fail
echo.
echo [x] FAILED - original files are intact; backup lives in %BK%
pause
exit /b 1

:picknode
set "NODE_EXE=node"
set "USE_BUNDLED=0"
where node >nul 2>&1
if errorlevel 1 goto picknode_bundled
goto picknode_ok
:picknode_bundled
rem no system node: fall back to the runtime WorkBuddy itself ships (node + npm.cmd)
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "NODE_EXE=%%~fD\node.exe"
if not exist "%NODE_EXE%" goto node_missing
set "USE_BUNDLED=1"
goto picknode_ok
:node_missing
echo [x] node not found - install Node.js first
exit /b 1
:picknode_ok
set "ASAR_JS=%SRC%node_modules\@electron\asar\bin\asar.mjs"
if exist "%ASAR_JS%" exit /b 0
echo        first run: fetching @electron/asar via npm ...
if "%USE_BUNDLED%"=="1" goto npm_bundled
where npm >nul 2>&1
if errorlevel 1 goto npm_missing
call npm install --no-audit --no-fund --loglevel=error
goto npm_check
:npm_bundled
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "NPM_CMD=%%~fD\npm.cmd"
call "%NPM_CMD%" install --no-audit --no-fund --loglevel=error
:npm_check
if exist "%ASAR_JS%" goto picknode_ok
:npm_missing
echo [x] @electron/asar unavailable - open a terminal in this folder and run: npm install
exit /b 1
