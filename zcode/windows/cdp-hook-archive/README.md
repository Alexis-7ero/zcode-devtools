# ⚠️ 方案二：外置启动器 —— 已验证不可行（存档）

> **结论：此方案死亡。** Electron 对打包应用在 node_bindings.cc 维护独立白名单，NODE_OPTIONS 中的 --require/--import 均被剥离（实测打印 Most NODE_OPTIONs are not supported in packaged apps），钩子无法加载，与 EnableNodeOptionsEnvironmentVariable fuse 状态无关。目录保留作为踩坑记录，勿尝试。

## 原理

```
cdp-hook.cmd  →  设置 NODE_OPTIONS=--require hook.js 后拉起 ZCode.exe
                    └─ 主进程 / Broker / 模型侧插件进程都会加载 hook.js
                        └─ hook.js 钩住 Module.prototype._compile
                            └─ 命中特征串的模块在「编译前」做内存源码变换
                                （变换语义与 payload/ 静态补丁逐字一致）
```

不写入任何程序文件。前提条件（已在本机核实）：

- fuse `EnableNodeOptionsEnvironmentVariable` = **ON**（ZCode.exe 0xb0dde60）

## 使用

| 操作 | 动作 |
|------|------|
| 开启补丁 | 双击 `cdp-hook.cmd`（或 `cmd /c cdp-hook.cmd`） |
| 调试钩子 | `cdp-hook.cmd /debug`，日志在 `%TEMP%\cdp-hook.log` |
| 回到原版 | 直接点桌面/开始菜单的官方 ZCode 快捷方式 |

两个模式可以并存使用；`NODE_OPTIONS` 只影响由本启动器派生的进程树。

## 建议生成桌面快捷方式

```powershell
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:USERPROFILE\Desktop\ZCode (CDP).lnk")
$s.TargetPath = "$PSScriptRoot\cdp-hook.cmd"
$s.WorkingDirectory = $PSScriptRoot
$s.IconLocation = "C:\Program Files\ZCode\ZCode.exe,0"
$s.Save()
```

## 升级与失效

- 锚点基于 3.9.2 构建；小版本更新若未改动分发链/枚举文本，大概率继续命中；
- 未命中时行为为**直通**（原样运行），日志可见 `[transform]` 缺失；
- 若官方将 fuse 烧成 OFF，此方案失效——届时回退方案一（`cdp-patch.ps1 Apply`），或按 README 主文件的说明做原生层分析。

## 与方案一的关系

两者语义相同、互不冲突（变换以"目标串存在与否"幂等）。方案一改磁盘文件、依赖管理员与完整性校验放行；本方案只活在进程内存里，随启随灭。
