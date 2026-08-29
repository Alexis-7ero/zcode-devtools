# WorkBuddy 支持（v1.2.0+ · 免补丁 · 官方预留通道）

## 结论先行

WorkBuddy 桌面端（5.4.4 实测）**不需要打补丁**：

- 官方在主进程 `applyCliCommandLineSwitches()` 里预留了环境变量开关 **`WORKBUDDY_REMOTE_DEBUGGING_PORT`**——设为合法端口后，应用自动 `appendSwitch("remote-debugging-port")` + `remote-allow-origins` 白名单，注释明确写着"供 super-workbuddy skill 等外部自动化工具连接"。
- 打开后，内置浏览器预览（`<webview partition="persist:agent-browser-preview-webview">`）就是标准 CDP target，出现在 `http://127.0.0.1:9222/json/list`。
- **不要尝试改它的 app.asar**：`EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` 双开，且 exe 的 `.rsrc` 已嵌入与当前 asar 头部哈希完全一致的 `INTEGRITY/ELECTRONASAR` 清单（实测匹配），任何重打包都会被拒绝启动。

因此本目录提供的是**启动器 + CDP 客户端**，而非补丁。

## 使用

1. 双击 `wb-start.cmd`（或 `wb-start.cmd 9333` 指定端口；加 `/persist` 永久写入用户环境变量）
2. WorkBuddy 启动后自动列出 CDP 目标（内置浏览器预览会标注出来）
3. 驱动内置浏览器（WorkBuddy 的 agent 可通过 shell 直接调用）：

```bash
node wb-cdp.mjs list                                  # 列出全部目标
node wb-cdp.mjs eval --url baidu --expr "1+1"         # 在预览面板执行 JS
node wb-cdp.mjs nav  --url baidu --to "https://example.com"   # 导航
node wb-cdp.mjs net  --url baidu --seconds 6          # 网络监听（自动刷新捕获）
node wb-cdp.mjs shot --url baidu --out shot.png       # 整页截图
node wb-cdp.mjs devtools --url baidu --open           # 打开 DevTools 页面
node wb-cdp.mjs wait --timeout 240                    # 等待端点就绪（进度条）
```

关闭方式：普通方式启动 WorkBuddy 即为原版（未加 `/persist` 时，环境变量只影响本次启动器派生的进程树）。

## 默认暴露给 agent（全局记忆）

WorkBuddy 内置 agent 引擎会读取全局记忆文件，安装脚本已写入：

```
%USERPROFILE%.codebuddyCODEBUDDY.md
```

内容是 wb-cdp.mjs 全部命令的说明。之后**每次新对话**，agent 自动知道如何驱动内置浏览器，无需再提醒。（若想撤销，删除该文件即可。）

## 与 ZCode 补丁的关系

| | ZCode（cdp-patch） | WorkBuddy（本目录） |
|---|---|---|
| 原理 | 修改 asar/Schema，把 CDP 接进命令分发 | 官方预留的环境变量开关，零修改 |
| AI 调用方式 | `tab.cdp.*` 对象 | agent 通过 shell 调 `wb-cdp.mjs` |
| 卸载 | Remove 还原 | 不装即卸 / 去掉 `/persist` |
| 失效风险 | ZCode 升级需重新适配 | 极低（官方通道） |

## 技术细节（逆向结论）

- 开关实现在 `main/index.js` 的 `applyCliCommandLineSwitches()`（仅 win32 分支额外 `no-sandbox` 等）；`remote-allow-origins` 自动放行 `127.0.0.1/localhost[:port]`。
- 预览面板：renderer `BrowserPreview` → `<webview partition="persist:agent-browser-preview-webview">`（sandbox + contextIsolation + 无 nodeintegration），主进程 `did-attach-webview` 按 partition 识别。
- 进程内另有 `cdp-profiler.js` 证明 `webContents.debugger` 路径可用（性能剖析用），未来若需"不开端口"的方案可参考。
