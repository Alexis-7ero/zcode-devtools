# ZCode DevTools

[中文说明](README.zh-CN.md)

Enable the hidden CDP (Chrome DevTools Protocol) debugging channel for the built-in browser (IAB) of **ZCode Desktop 3.10.1**. After patching, the AI can use `tab.cdp.*` and `tab.openDevTools()` on in-app browser tabs: arbitrary CDP commands, event streams, breakpoints / pause / resume, and opening DevTools.

> Idea credits: `Almost-Zhangsan/zcode-cdp-patch-3.7.3`. Re-ported from scratch for the 3.10.1 build — the patch reuses official internals (`ensureGuest` / `sendGuestCdpCommand`, Electron `webContents.debugger`) and adds no external connections. CDP events are buffered in memory per tab (cap 5000).

## Choose your platform

| Platform | Entry | Status |
|----------|-------|--------|
| Windows x64 | [`windows/cdp-patch.ps1`](windows/) — docs: [EN](windows/README.md) / [中文](windows/README.zh-CN.md) | ✅ verified on a real machine |
| macOS | [`macos/cdp-patch.sh`](macos/) — docs: [EN](macos/README.md) / [中文](macos/README.zh-CN.md) | ⚠️ untested on a real Mac, feedback welcome |

## Quick start

> Both scripts auto-discover the ZCode install dir. Custom location: `-ZcodePath` (Windows) / `--app` (macOS).

### Windows (admin PowerShell)

```powershell
cd windows
.\cdp-patch.ps1 Status               # show state (no admin needed)
.\cdp-patch.ps1 Apply -WaitForExit   # enable; waits for ZCode to exit, then finishes in ~1-2 min
.\cdp-patch.ps1 Remove               # disable patch, restore originals
```

Windows users can also just double-click `windows/ZCodeCDPTool.exe` — an interactive menu (① install ② backup ③ remove ④ status) with a progress bar. `cdp-menu.ps1` / `launcher.cs` are the menu source, rebuildable with the system csc.


### macOS

```bash
chmod +x cdp-patch.sh
node fuse-scan.mjs /Applications/ZCode.app/Contents/MacOS/ZCode   # preflight: check fuses / integrity manifest
cd macos
./cdp-patch.sh Status
./cdp-patch.sh Apply --wait        # enable; waits for ZCode to exit, then finishes in ~1-2 min
./cdp-patch.sh Remove              # disable, full-file restore
```

## Verify (new conversation after enabling)

```text
Open https://www.baidu.com then run tab.cdp.evaluate("1+1") and tab.openDevTools()
```

Expected: `{"result":{"value":2,...}}` and a DevTools window pops up.

## Exposed model-side API

```js
const tab = await (await agent.browsers.getDefault()).tabs.new();
await tab.cdp.enableDebugger();                     // Debugger.enable + allow pausing
await tab.cdp.send("Page.navigate", { url: "…" });  // any CDP command
await tab.cdp.evaluate("1+1");                      // Runtime.evaluate
await tab.cdp.networkEnable();                      // Network.enable
await tab.cdp.events({ limit: 50 });                // buffered CDP events

await tab.cdp.setBreakpointByUrl({ urlRegex: "example", lineNumber: 10 }); // breakpoints
await tab.cdp.pause();
const stack = await tab.cdp.getCallStack();          // latest Debugger.paused
await tab.cdp.resume();

await tab.openDevTools();                            // open DevTools window
```

## How it works

| Layer | File | Change |
|-------|------|--------|
| Main executor | asar `out/main/index.js` | adds a `method === "cdp"` branch to the dispatch chain, delegating to official `sendGuestCdpCommand` |
| Main/Host/Scheduler schema | three asar chunks | method enum + discriminatedUnion entry for the cdp command (with optional `tabId`) |
| Broker | `Resources/glm/zcode.cjs` | same schema relaxation |
| Model-side plugin | browser-use 0.4.0 cache | `Tab.get cdp()` returns a bare object to bypass the `hideUnknown` allowlist |

## Notes

- Targets **3.10.1** only (scripts verify the version). After a ZCode auto-update, run `Status` first — a re-port is usually needed.
- `Apply` is idempotent: re-running on a patched install is skipped (`-Force` overrides).
- Why a file patch? `NODE_OPTIONS` injection is stripped by Electron's allowlist in packaged apps, so zero-file-modification is impossible (post-mortem in `windows/cdp-hook-archive/`). And the Windows build embeds no `ElectronAsarIntegrity` manifest, so the asar can be modified safely — mac users must run `fuse-scan.mjs` preflight first.
- CDP is extremely powerful (read/write any page state, inject scripts). Use **only against authorized targets**.
