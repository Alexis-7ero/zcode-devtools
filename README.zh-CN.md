# ZCode DevTools

[English](README.md)

为 **ZCode Desktop 3.10.1 / 3.10.2** 的内置浏览器（IAB）启用隐藏的 CDP（Chrome DevTools 协议）调试通道。打上补丁后，模型可以通过 `tab.cdp.*` 和 `tab.openDevTools()` 对内置浏览器标签页做调试：任意 CDP 命令、事件流读取、断点/暂停/继续、打开 DevTools。

> 思路致谢：`Almost-Zhangsan/zcode-cdp-patch-3.7.3`。本仓库针对 3.10.1 构建从零重新移植，并已在 3.10.2 上前向验证（规则引擎按内容锚点自适应，规则零修改）——复用官方已有的 `ensureGuest` / `sendGuestCdpCommand`（Electron `webContents.debugger`），不引入任何外部连接，CDP 事件按 tabId 内存缓冲（上限 5000 条）。

## 选择你的平台

| 平台 | 入口 | 状态 |
|------|------|------|
| Windows x64 | [`zcode/windows/cdp-patch.ps1`](zcode/windows/) — 说明：[中文](zcode/windows/README.zh-CN.md) / [English](zcode/windows/README.md) | ✅ 实机验证通过 |
| macOS | [`zcode/macos/cdp-patch.sh`](zcode/macos/) — 说明：[中文](zcode/macos/README.zh-CN.md) / [English](zcode/macos/README.md) | ⚠️ 未经实机验证，欢迎反馈 |
| **WorkBuddy 5.4.4** (Windows x64) | [`DevToolsTool.exe`](workbuddy/) — 说明：[中文](workbuddy/README.zh-CN.md) / [English](workbuddy/README.md) | ✅ 实机验证通过 |

## 快速开始

### Windows（管理员 PowerShell）

```powershell
cd zcode/windows
.\cdp-patch.ps1 Status               # 查看状态（普通权限即可）
.\cdp-patch.ps1 Apply -WaitForExit   # 启用补丁；ZCode 未退出时自动等待，退出后约 1-2 分钟完成刷入
.\cdp-patch.ps1 Remove               # 停用补丁，还原原版
```

Windows 用户也可以直接双击根目录的 `DevToolsTool.exe` —— 统一交互菜单（① 安装 ② 备份 ③ 卸载 ④ 状态 ⑤ 切换目标 ZCode/WorkBuddy ⑥ 语言切换），默认中文界面，⑥ 可切换英文。`app-menu.ps1` / `DevToolsTool.cs` 为菜单源码，可用系统自带 csc 重新编译。


### macOS

双击 `macos/Menu.command` 进入交互菜单（① 安装 ② 备份 ③ 卸载 ④ 状态）——会自动退出 ZCode、还原纯净原版、规则引擎重新 hook、ad-hoc 重签名并自检。也有单独入口：`Install.command` / `Remove.command` / `Status.command`。

首次使用前先体检：

```bash
node zcode/fuse-scan.mjs /Applications/ZCode.app/Contents/MacOS/ZCode   # 检查 fuses / 完整性清单
```

## WorkBuddy 模块

[`workbuddy/`](workbuddy/) 目录是独立的 **腾讯 WorkBuddy 5.4.4** 模块：向 agent 注入原生 `browser_cdp` 内置工具（eval / 截图 / 抓网络 / CDP 事件 / 任意 CDP / DevTools），解锁内置浏览器隐藏的右键 Inspect，并把官方 CDP 端口改为默认常开。运行根目录 `DevToolsTool.exe`，按 `5` 切换目标到 WorkBuddy，再按 `1` 安装；`wb-patch.cmd remove` 一键还原。详细文档：[中文](workbuddy/README.zh-CN.md) / [English](workbuddy/README.md)。

## 验证（启用后新开对话）

```text
打开 https://www.baidu.com 然后执行 tab.cdp.evaluate("1+1") 和 tab.openDevTools()
```

预期返回 `{"result":{"value":2,...}}` 并弹出 DevTools 窗口。

## 补丁后的模型侧接口

```js
const tab = await (await agent.browsers.getDefault()).tabs.new();
await tab.cdp.enableDebugger();                     // Debugger.enable + 允许暂停
await tab.cdp.send("Page.navigate", { url: "…" });  // 任意 CDP 命令
await tab.cdp.evaluate("1+1");                      // Runtime.evaluate
await tab.cdp.networkEnable();                      // Network.enable
await tab.cdp.events({ limit: 50 });                // 读取缓冲事件

await tab.cdp.setBreakpointByUrl({ urlRegex: "example", lineNumber: 10 }); // 断点
await tab.cdp.pause();
const stack = await tab.cdp.getCallStack();          // 最近一次 Debugger.paused
await tab.cdp.resume();

await tab.openDevTools();                            // 打开 DevTools 窗口
```

## 工作原理

| 层 | 文件 | 改动 |
|----|------|------|
| Main 执行桥 | asar `out/main/index.js` | 命令分发链新增 `method === "cdp"` 分支，转调官方 `sendGuestCdpCommand` |
| Main/Host/Scheduler Schema | asar 三个 chunk | 方法枚举 + discriminatedUnion 注册 cdp 命令对象（含 `tabId` 可选字段） |
| Broker | `Resources/glm/zcode.cjs` | 同步放行 schema |
| 模型侧插件 | browser-use 0.4.0 缓存 | `Tab.get cdp()` 返回裸对象绕过 `hideUnknown` 白名单 |


## 注意

- 支持 **3.10.1 / 3.10.2**。规则引擎按内容锚点自适应，小版本构建变化自动吸收；ZCode 自动升级后先 `Status` 查看。
- `Apply` 幂等：重复执行检测到已打补丁会自动跳过（`-Force` 强制重刷）。
- 为什么走文件补丁：`NODE_OPTIONS` 注入被 Electron 打包白名单剥离，零文件改动路线不通（踩坑记录见 `zcode/windows/cdp-hook-archive/`）；且 Windows 构建未嵌入 asar 完整性清单，可安全修改——mac 用户务必先跑 `fuse-scan.mjs` 预检。
- CDP 权限极高（读写页面任意状态、注入脚本），仅用于**授权范围内**的安全测试与调试。
