@echo off
rem WorkBuddy deep-integration uninstaller
chcp 65001 >nul
cd /d "%~dp0"
node wb-setup.mjs remove
pause
