---
name: wb-cdp
description: >-
  WorkBuddy 内置浏览器 CDP 控制技能。需要操作/调试内置浏览器（预览面板）时使用：
  在页面里执行 JS（eval）、打开网页（open）、整页截图（shot）、抓网络请求（net）、
  打开 DevTools（devtools）、等待加载完成（waitload）。触发词：内置浏览器、预览面板、
  调试网页、evaluate、执行 JS、页面截图、抓包、网络请求、DevTools、控制台、CDP。
---

# WorkBuddy 内置浏览器 CDP 控制

## 首选：原生 browser_cdp 工具（wb-patch.cmd 补丁后可用）

如果你（agent）的工具列表里有 `browser_cdp`，直接调用它，无需 shell：

- `browser_cdp {action:"info"}` — 当前页面 url/title/readyState
- `browser_cdp {action:"eval", expression:"1+1"}` — 页面内执行 JS（支持 await，返回值 JSON）
- `browser_cdp {action:"shot", path:"C:/abs/page.png"}` — 整页截图
- `browser_cdp {action:"net", limit:30}` — 最近的网络请求
- `browser_cdp {action:"devtools"}` — 打开原生 DevTools 窗口
- `browser_cdp {action:"send", method:"Page.navigate", params:{url:"https://..."}}` — 任意 CDP 命令

面板没开时它报错——先用 present_files 打开一个 URL 再调。

## 后备：wb-cdp 命令行工具（未打补丁或需要终端操作时）

WorkBuddy 通过官方环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT` 暴露 CDP 调试端口。
内置浏览器（预览面板）是一个 **type: "webview"** 的页面 target，与其他页面一起暴露在
`http://127.0.0.1:9222`。用下面的命令行工具控制（本地 CLI，非 MCP）。

工具位置：`__BRIDGE__`（下文简称 WB。cmd / PowerShell / bash 均可直接调用）。

## 使用流程

1. 先探测通道：`WB status`
   - 失败 → WorkBuddy 没带 CDP 启动。提示用户用 `wb-start.cmd` 启动 WorkBuddy，
     或手动设置环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT=9222` 后重启 WorkBuddy。
2. 列出页面：`WB list`（`*` 是当前目标，`#n` 是编号）
3. 选择目标：`WB use 1`（按编号、targetId 或 URL 子串）
4. 之后即可执行下述命令。

## 命令速查

| 命令 | 作用 |
|------|------|
| `WB status` | 通道是否可用、当前目标 |
| `WB list` | 列出所有页面 target |
| `WB use <n\|id\|url子串>` | 切换当前目标 |
| `WB open <url>` | 当前目标导航到 url 并等待加载完成 |
| `WB eval "<js>"` | 在页面里执行 JS，返回值以 JSON 输出（支持 `awaitPromise`） |
| `WB shot [out.png]` | 整页截图（含视口外部分），输出绝对路径 |
| `WB net [毫秒] [--reload]` | 抓网络请求，默认 8000ms；`--reload` 先刷新页面再抓 |
| `WB waitload [毫秒]` | 等待页面加载完成 |
| `WB devtools [n]` | 在本机 Chrome/Edge 打开该 target 的 DevTools 窗口 |

全局参数：`--port 9222`、`--target <n|id|url子串>`（单次指定目标）、`--json`（输出原始 JSON）、`--timeout 毫秒`。

## 典型用法

```text
WB open https://www.baidu.com
WB eval "1+1"
WB eval "document.title"
WB eval "JSON.stringify({url:location.href, inputs:document.querySelectorAll('input').length})"
WB shot page.png
WB net 8000 --reload
WB devtools
```

eval 支持从 stdin 读表达式（引号难写时）：`echo document.title | WB eval -`

## 注意事项

- 当前目标失效（页面被关闭）会自动回退到第一个 http(s) 页面 target。
- `file:` / `devtools:` 的 target 是 WorkBuddy 自身界面，会被自动排除，不要选。
- eval 大对象先取字段或 `JSON.stringify`，避免输出爆炸。
- 抓网络请求请在导航/刷新**之后**运行 `net`（侦听从命令开始；要用 `--reload`）。
- CDP 权限极高，只用于授权调试你自己的工作内容。
