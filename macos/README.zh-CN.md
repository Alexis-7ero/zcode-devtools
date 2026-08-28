[English](README.md)

# ZCode macOS CDP 补丁（3.10.1 · 一键开关）

在 **ZCode Desktop 3.10.1**（macOS）内嵌浏览器（IAB）的 Browser Use 通道上新增主机命令 `method: "cdp"`，模型可通过 `tab.cdp.*` / `tab.openDevTools()` 对当前标签页做 CDP 调试：任意 CDP 命令、事件流读取、断点/暂停/继续、打开 DevTools。Windows 版见姊妹仓库 `zcode-cdp-patch-windows`，已在 Windows 实机全链路验证通过）。Windows 版见姊妹仓库 [zcode-devtools-windows](https://github.com/Alexis-7ero/zcode-devtools-windows)。

> ⚠️ **未经实机验证声明**：作者无 macOS 设备，本目录由 Windows 实机验证过的变换规则 + 跨平台规则引擎编写，并在 Windows 侧对同源 asar 完成了全流程回归（变换命中、打包、幂等、直通均通过）。欢迎 mac 用户试用并反馈 Issue。

## 前置检查（必做）

安装 Node.js（`brew install node`），然后先做体检：

```bash
chmod +x cdp-patch.sh
node fuse-scan.mjs /Applications/ZCode.app/Contents/MacOS/ZCode
```

- 若输出 `asar 完整性清单嵌入: 是` → **本补丁不适用**，请勿继续（修改 asar 会被拒绝启动）；
- 若为 `否` → 放心继续。

## 使用

```bash
./cdp-patch.sh Status            # 查看状态
./cdp-patch.sh Apply --wait      # 启用补丁；自动等待 ZCode 退出，退出后约 1-2 分钟完成刷入
./cdp-patch.sh Remove            # 停用补丁，整包还原
```

启用后**新开对话**验证：

```text
打开 https://www.baidu.com 然后执行 tab.cdp.evaluate("1+1") 和 tab.openDevTools()
```

## 设计要点（mac 版 ≠ Windows 版的预烤文件式补丁）

mac 版采用**规则引擎式变换**，对构建差异更有韧性：

1. 运行时解包 `app.asar`，遍历 `out/` 下全部模块 JS；
2. 每个文件应用 `payload/rules.cjs` 的锚点规则（union 正则对 zod 别名字母自适应；`doneIf` 哨兵保证幂等）；
3. 关键锚点未命中 → 安全中止，不写任何文件，并打印命中报告（请提 Issue 附上输出）；
4. 重打包时原生模块（`*.node`/`*.dylib` 等）保持 unpacked 语义。

macOS 特有处理（脚本已内置）：

- **代码签名**：修改包内资源后签名失效，Apply/Remove 末尾自动 ad-hoc 重签（`codesign --force --deep --sign -`）并 `xattr -cr` 清除隔离属性；
- **整包备份**：首次 Apply 将完整原版 `app.asar` 备份到 `backup/app.asar.original`（约 300MB，不入库），Remove 整包还原；
- **幂等**：对已打补丁的 asar 重复 Apply 会检测哨兵并跳过。

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

## 目录结构

```
cdp-patch.sh                  # 唯一入口：Status / Apply / Remove
../apply-asar.mjs             # 共享规则引擎式 asar 变换器
../rules.cjs                  # 共享变换规则
../fuse-scan.mjs              # Electron fuses / asar 完整性预检
../zcode.cjs.gz               # Broker 补丁
../browser-client.mjs         # 插件：tab.cdp / openDevTools（0.4.1 基线）
../api.json                   # 插件文档清单
backup/                       # Apply 时生成的整包备份（不入库）
```

## 注意

- 仅适用于 **3.10.1**。ZCode 自动升级后请先 `Status` 查看。
- CDP 权限极高（读写页面任意状态、注入脚本），仅用于**授权范围内**的安全测试与调试。
