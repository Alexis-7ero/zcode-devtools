@echo off
rem WorkBuddy deep-integration installer (env + MCP tools + global memory)
chcp 65001 >nul
cd /d "%~dp0"
node wb-setup.mjs install
pause
