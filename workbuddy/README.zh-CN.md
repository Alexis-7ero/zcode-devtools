# WorkBuddy CDP Tool（内置浏览器原生调试）

[English](README.md)

给 WorkBuddy 的 agent 注入一个**原生 `browser_cdp` 内置工具**，用来驱动它的内置浏览器（`present_files` 打开的预览面板）：页面执行 JS、整页截图、抓网络请求、读 CDP 事件、发任意 CDP 命令、打开 DevTools——不是 MCP，不需要 shell 绕路。同时解锁内置浏览器里隐藏的右键 **Inspect** 菜单，并把官方 CDP 调试端口改为默认常开。

- 实测环境：**WorkBuddy 5.4.4（Windows x64）**。补丁锚定精确源码字符串，其他版本可能需要更新锚点。
- 依赖：打补丁本身**不要求预装任何东西**——没有 Node.js 时自动回退到 WorkBuddy 自带的 node + npm（`~/.workbuddy/binaries/node`）。首次运行需联网一次（`npm install @electron/asar`）。默认安装路径（`%LocalAppData%ProgramsWorkBuddy`）自动发现。

## 原理

逆向得到三个关键事实：

1. 内置浏览器是一个 `<webview>`，session 分区为 `persist:agent-browser-preview-webview`。
2. WorkBuddy 有**官方 CDP 通道**：环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT` → 自动追加 `remote-debugging-port` + `remote-allow-origins`（官方注释原话：供 super-workbuddy skill 等外部自动化工具连接，默认不开）。
3. agent 的内置工具注册在 `server.js` 的 `createWorkbuddyAppServerMcpTools`，但执行环境是 **daemon 纯 Node 进程**——那里没有 `require('electron')`。

因此补丁（v2）做了三件事：

- **宿主侧**（`main/index.js`）：解锁内置浏览器 webview 上仅开发模式可见的右键 Inspect；把官方 CDP 端口改为**默认常开 9222**（环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT` 可覆盖，`0`/`off` 关闭）。
- **daemon 侧**（`main/server.js`）：注册原生内置工具 `browser_cdp`，纯 Node 实现（fetch + WebSocket 连 `127.0.0.1:9222`）——模型每次新开对话都能在工具列表里直接看到它，零配置、零提醒。

因为 Electron 的 asar 完整性 fuse 会拒绝被修改的 `app.asar`，安装器会翻转 `WorkBuddy.exe` 里那一个 fuse 字节（Electron 文档化的 fuse wire 格式，与官方 `@electron/fuses` 同机制）。这会使 exe 的 Authenticode 签名失效，但不影响本机运行。WorkBuddy 自更新会覆盖补丁，更新后重新跑一遍安装即可。

## 快速开始

运行仓库根目录的 **`DevToolsTool.exe`** → 选 `5`（切换目标到 WorkBuddy）→ 选 `1`（安装）。脚本会：

1. 优雅关闭 WorkBuddy（15 秒后强杀），
2. 备份 `WorkBuddy.exe` + `app.asar` 到 `resources\cdp-patch-backup\`，
3. 解包 asar、注入工具、重新打包，
4. 执行安全闸门（外部文件数量 ≥ 原版 98%、完整内容校验）——**任何不一致都会在中止且不改动你一个字节**，
5. 换装文件、翻转 fuse、自动重启 WorkBuddy。

命令行等价：`wb-patch.cmd install` / `wb-patch.cmd remove` / `wb-patch.cmd status`。

## `browser_cdp` 工具动作

| 动作 | 作用 |
|------|------|
| `eval` | 页面内执行 JS，返回值 JSON 输出（支持 await） |
| `info` | 当前 url / title / readyState |
| `shot` | 整页截图存 png |
| `net` | 最近的网络请求（方法/状态/URL） |
| `events` | 最近的原始 CDP 事件，可按前缀过滤 |
| `send` | 任意 CDP 命令（如 `Page.navigate`） |
| `waitload` | 等待 `document.readyState === "complete"` |
| `devtools` | 打开 DevTools 窗口（应用内替代：右键 → Inspect） |

对话里的典型流程：先 `present_files` 打开 URL，再用 `browser_cdp` 操作——两者共享同一个 CDP 会话。

## 命令行后备

`wb-cdp.cmd` 让任何终端都能驱动同一个端口（也方便其他 agent 使用）：

```text
wb-cdp.cmd status | list | use <n> | open <url> | eval "<js>" | shot [file] | net [ms] | devtools
```

`wb-setup.cmd install` 还会在 `~\.workbuddy\skills\` 注册一个 `wb-cdp` **技能**，让 agent 也认识命令行这条路（在打 asar 补丁之前也能用）。

## 卸载 / 还原

`wb-patch.cmd remove`（或菜单 `2`）从备份还原字节一致的原版 exe + asar。`app.asar.unpacked` 目录刻意保持原样——安装器只往里加文件，且这些文件不参与哈希校验。

## 安全说明

- 所有写入都有闸门：内容校验**先于**任何换装，校验失败直接中止、原文件分毫未动。
- 常开的 CDP 端口只监听 127.0.0.1，但本机任何进程都能连——这是 Chromium 远程调试的固有属性，只在你自己控制的机器上打补丁。
- CDP 等于浏览器的完全控制权：仅用于授权范围内的调试。

## 文件说明

| 文件 | 作用 |
|------|------|
| `../DevToolsTool.exe` / `../DevToolsTool.cs` / `../app-menu.ps1` | ZCode + WorkBuddy 统一双击菜单（源码随附，系统 csc 可重编译） |
| `wb-patch.cmd` | 安装 / 卸载 / 状态 总控，带安全闸门 |
| `apply-patch.mjs` | 实际注入逻辑（工具工厂 + Inspect + 端口常开） |
| `verify-pack.mjs` | 重打包产物的静态验证 |
| `flip-fuse.mjs` / `fuse-scan.mjs` | Electron fuse 翻转 / 扫描（文档化 wire 格式） |
| `count-files.mjs` | 安全闸门用的文件计数 |
| `wb-setup.cmd` / `wb-start.cmd` / `wb-cdp.cmd` / `wb-cdp.mjs` / `SKILL.template.md` | 可选的技能 + 命令行层 |
