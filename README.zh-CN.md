# ZCode DevTools

[English](README.md)

为 **ZCode Desktop 3.10.1** 的内置浏览器（IAB）启用隐藏的 CDP（Chrome DevTools 协议）调试通道。打上补丁后，模型可以通过 `tab.cdp.*` 和 `tab.openDevTools()` 对内置浏览器标签页做调试：任意 CDP 命令、事件流读取、断点/暂停/继续、打开 DevTools。

> 思路致谢：`Almost-Zhangsan/zcode-cdp-patch-3.7.3`。本仓库针对 3.10.1 构建从零重新移植——复用官方已有的 `ensureGuest` / `sendGuestCdpCommand`（Electron `webContents.debugger`），不引入任何外部连接，CDP 事件按 tabId 内存缓冲（上限 5000 条）。

## 选择你的平台

| 平台 | 入口 | 状态 |
|------|------|------|
| Windows x64 | [`windows/cdp-patch.ps1`](windows/) — 说明：[中文](windows/README.zh-CN.md) / [English](windows/README.md) | ✅ 实机验证通过 |
| macOS | [`macos/cdp-patch.sh`](macos/) — 说明：[中文](macos/README.zh-CN.md) / [English](macos/README.md) | ⚠️ 未经实机验证，欢迎反馈 |

## 快速开始

### Windows（管理员 PowerShell）

```powershell
cd windows
.\cdp-patch.ps1 Status               # 查看状态（普通权限即可）
.\cdp-patch.ps1 Apply -WaitForExit   # 启用补丁；ZCode 未退出时自动等待，退出后约 1-2 分钟完成刷入
.\cdp-patch.ps1 Remove               # 停用补丁，还原原版
```

### macOS

```bash
chmod +x cdp-patch.sh
node fuse-scan.mjs /Applications/ZCode.app/Contents/MacOS/ZCode   # 前置体检：fuses / 完整性清单
cd macos
./cdp-patch.sh Status
./cdp-patch.sh Apply --wait        # 启用补丁；自动等待 ZCode 退出，退出后约 1-2 分钟完成刷入
./cdp-patch.sh Remove              # 停用补丁，整包还原
```

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

- 仅适用于 **3.10.1**（脚本会核对版本）。ZCode 自动升级后请先 `Status` 查看，通常需重新适配。
- `Apply` 幂等：重复执行检测到已打补丁会自动跳过（`-Force` 强制重刷）。
- 为什么走文件补丁：`NODE_OPTIONS` 注入被 Electron 打包白名单剥离，零文件改动路线不通（踩坑记录见 `windows/cdp-hook-archive/`）；且 Windows 构建未嵌入 asar 完整性清单，可安全修改——mac 用户务必先跑 `fuse-scan.mjs` 预检。
- CDP 权限极高（读写页面任意状态、注入脚本），仅用于**授权范围内**的安全测试与调试。
