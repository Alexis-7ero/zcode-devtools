@echo off
rem ============================================================
rem  ZCode 3.9.2 CDP 外置补丁启动器（不改任何程序文件）
rem
rem  用法：
rem    cdp-hook.cmd            以补丁模式启动 ZCode
rem    cdp-hook.cmd /debug     输出钩子日志到 %%TEMP%%\cdp-hook.log
rem  关闭补丁：直接使用桌面/开始菜单的官方 ZCode 快捷方式。
rem
rem  路径说明：NODE_OPTIONS 解析引号内反斜杠会吞字符，因此这里统一
rem  转 8.3 短路径且不加引号（要求所在卷启用短名，NTFS 默认开启）。
rem ============================================================
setlocal

set "HOOKDIR=%~sdp0"
if not exist "%HOOKDIR%hook.js" (
    echo [!] 短路径解析失败或 hook.js 不存在：%~dp0
    echo     请将本目录复制/联接到不含空格与中文的路径后重试。
    pause & exit /b 1
)

if /i "%~1"=="/debug" set "CDP_HOOK_DEBUG=1"
rem --import 的说明符用相对路径（cwd 已切到本目录），规避盘符路径在 Windows 的 URL 限制
pushd "%~dp0"
set "NODE_OPTIONS=--require ./hook.js --import ./bootstrap.mjs"
start "" /d "%~dp0" "C:\Program Files\ZCode\ZCode.exe" %*
popd
endlocal
