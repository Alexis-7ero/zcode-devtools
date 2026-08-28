[English](README.md)

# ZCode Windows CDP 补丁（3.10.1 · 一键开关）

在 **ZCode Desktop 3.10.1**（Windows x64）内嵌浏览器（IAB）的 Browser Use 通道上新增主机命令 `method: "cdp"`，模型可通过 `tab.cdp.*` / `tab.openDevTools()` 对当前标签页做 CDP 调试：任意 CDP 命令、事件流读取、断点/暂停/继续、打开 DevTools。

思路源自 `Almost-Zhangsan/zcode-cdp-patch-3.7.3`，基于本机 3.10.1 安装包重新移植——复用官方已有的 `ensureGuest` / `sendGuestCdpCommand`（Electron `webContents.debugger`），不引入任何外部连接，CDP 事件按 tabId 内存缓冲（上限 5000 条）。macOS 版见姊妹仓库 [zcode-devtools-macos](https://github.com/Alexis-7ero/zcode-devtools-macos)。 `zcode-cdp-patch-macos`。

> **为什么走文件补丁**：实验证明 `NODE_OPTIONS` 外置注入在打包应用中被 Electron 白名单剥离（`Most NODE_OPTIONs are not supported in packaged apps`），零文件改动路线不通；而本机构建未嵌入 `ElectronAsarIntegrity` 校验清单，asar 可安全修改（详见 `cdp-hook-archive/` 踩坑记录）。

## 使用

管理员 PowerShell：

脚本会自动发现 ZCode 安装目录（运行中进程 → 注册表 → 常见路径依次探测）。装在非默认位置时加参数 `-ZcodePath 'D:AppsZCode'` 指定。
```powershell
cd zcode-cdp-patch-windows

.\cdp-patch.ps1 Status               # 查看状态（普通权限即可）
.\cdp-patch.ps1 Apply -WaitForExit   # 启用补丁；ZCode 未退出时自动等待，退出后约 1-2 分钟完成刷入
.\cdp-patch.ps1 Remove               # 停用补丁，还原原版
.\cdp-patch.ps1 Apply -Force         # 强制重刷（混合状态时）
```

一键重装：双击 `reinstall.cmd`（或菜单 [1]）——自动结束 ZCode、还原纯净原版、重新 hook 并自检，一步到位。

双击 `ZCodeCDPTool.exe` 进入交互菜单（① 安装 ② 备份 ③ 卸载 ④ 状态），自带进度条。

启用后**新开对话**验证：

```text
打开 https://www.baidu.com 然后执行 tab.cdp.evaluate("1+1") 和 tab.openDevTools()
```

预期返回 `{"result":{"value":2,...}}` 并弹出 DevTools 窗口。日志 `%USERPROFILE%\.zcode\v2\logs\` 应出现 `method=cdp`。

## 补丁后的模型侧接口

```js
const tab = await (await agent.browsers.getDefault()).tabs.new();
await tab.cdp.enableDebugger();                     // Debugger.enable + 允许暂停
await tab.cdp.send("Page.navigate", { url: "…" });  // 任意 CDP 命令
await tab.cdp.evaluate("1+1");                      // Runtime.evaluate
await tab.cdp.networkEnable();                      // Network.enable
await tab.cdp.events({ limit: 50 });                // 读取缓冲事件

// 断点调试
await tab.cdp.setBreakpointByUrl({ urlRegex: "example", lineNumber: 10 });
await tab.cdp.pause();
const stack = await tab.cdp.getCallStack();          // 最近一次 Debugger.paused
await tab.cdp.resume();

await tab.openDevTools();                            // 打开 DevTools 窗口
```

## 目录结构

```
cdp-patch.ps1                 # 唯一入口：Status / Apply / Remove（规则引擎）
../apply-asar.mjs             # 共享规则引擎式 asar 变换器
../rules.cjs                  # 共享变换规则
../zcode.cjs.gz               # Broker 补丁
../browser-client.mjs         # 插件：tab.cdp / openDevTools（0.4.1 基线）
../api.json                   # 插件文档清单
backup/                       # 首次 Apply 生成的整包备份（不入库）
cdp-hook-archive/             # NODE_OPTIONS 外置注入方案的死亡踩坑记录（勿尝试）
```

## 工作原理

| 层 | 文件 | 改动 |
|----|------|------|
| Main 执行桥 | asar `out/main/index.js` | 命令分发链新增 `method === "cdp"` 分支，转调官方 `sendGuestCdpCommand` |
| Main/Host/Scheduler Schema | asar 三个 chunk | 方法枚举 + discriminatedUnion 注册 cdp 命令对象（含 `tabId` 可选字段） |
| Broker | `resources\glm\zcode.cjs` | 同步放行 schema |
| 模型侧插件 | browser-use 0.4.x 缓存 | `Tab.get cdp()` 返回裸对象绕过 `hideUnknown` 白名单 |

## 注意

- 仅适用于 **3.10.1**（脚本会核对版本）。ZCode 自动升级后请先 `Status` 查看，通常需重新适配。
- `Apply` 幂等：重复执行检测到已打补丁会自动跳过（`-Force` 强制重刷）。
- CDP 权限极高（读写页面任意状态、注入脚本），仅用于**授权范围内**的安全测试与调试。
