[中文说明](README.zh-CN.md)

# ZCode DevTools Patch — Windows

[中文说明](README.zh-CN.md)

Enable the hidden CDP (Chrome DevTools Protocol) debugging channel for the built-in browser of **ZCode Desktop 3.10.1** (Windows x64). After patching, the AI can use `tab.cdp.*` and `tab.openDevTools()` on in-app browser tabs: arbitrary CDP commands, event streams, breakpoints / pause / resume, and opening DevTools.

> Idea credits: `Almost-Zhangsan/zcode-cdp-patch-3.7.3`. Re-ported from scratch for the 3.10.1 build — the patch reuses official internals (`ensureGuest` / `sendGuestCdpCommand`, Electron `webContents.debugger`) and adds no external connections. CDP events are buffered in memory per tab (cap 5000). macOS version: [`zcode-devtools-macos`](https://github.com/Alexis-7ero/zcode-devtools-macos).

> **Why a file patch?** Experiments proved that `NODE_OPTIONS` injection is stripped by Electron's allowlist in packaged apps (`Most NODE_OPTIONs are not supported in packaged apps`), so a zero-file-modification route is impossible. Meanwhile this build embeds **no** `ElectronAsarIntegrity` manifest, so the asar can be modified safely. See `cdp-hook-archive/` for the full post-mortem.

## Usage (admin PowerShell)

The script auto-discovers the ZCode install dir (running process → registry → common paths). Non-default location: add `-ZcodePath 'D:AppsZCode'`.
```powershell
cd zcode-devtools-windows

.\cdp-patch.ps1 Status               # show state (no admin needed)
.\cdp-patch.ps1 Apply -WaitForExit   # enable; waits for ZCode to exit, then finishes in ~1-2 min
.\cdp-patch.ps1 Remove               # disable patch, restore originals
.\cdp-patch.ps1 Apply -Force         # force re-apply (mixed state)
```

Double-click `ZCodeCDPTool.exe` for an interactive menu (① install ② backup ③ remove ④ status) with a progress bar.

After enabling, **start a new conversation** and verify:

```text
Open https://www.baidu.com then run tab.cdp.evaluate("1+1") and tab.openDevTools()
```

Expected: `{"result":{"value":2,...}}` and a DevTools window pops up. The log at `%USERPROFILE%\.zcode\v2\logs\` should contain `method=cdp`.

## Exposed model-side API

```js
const tab = await (await agent.browsers.getDefault()).tabs.new();
await tab.cdp.enableDebugger();                     // Debugger.enable + allow pausing
await tab.cdp.send("Page.navigate", { url: "…" });  // any CDP command
await tab.cdp.evaluate("1+1");                      // Runtime.evaluate
await tab.cdp.networkEnable();                      // Network.enable
await tab.cdp.events({ limit: 50 });                // buffered CDP events

// breakpoints
await tab.cdp.setBreakpointByUrl({ urlRegex: "example", lineNumber: 10 });
await tab.cdp.pause();
const stack = await tab.cdp.getCallStack();          // latest Debugger.paused
await tab.cdp.resume();

await tab.openDevTools();                            // open DevTools window
```

## Layout

```
cdp-patch.ps1                 # single entry: Status / Apply / Remove (rules-engine)
../apply-asar.mjs             # shared rules-engine asar transformer
../rules.cjs                  # shared transform rules
../zcode.cjs.gz               # broker patch
../browser-client.mjs         # plugin: tab.cdp / openDevTools (0.4.1 baseline)
../api.json                   # plugin docs manifest
backup/                       # full asar backup generated on first Apply (not committed)
cdp-hook-archive/             # post-mortem of the dead NODE_OPTIONS injection approach
```

## How it works

| Layer | File | Change |
|-------|------|--------|
| Main executor | asar `out/main/index.js` | adds a `method === "cdp"` branch to the dispatch chain, delegating to official `sendGuestCdpCommand` |
| Main/Host/Scheduler schema | three asar chunks | method enum + discriminatedUnion entry for the cdp command (with optional `tabId`) |
| Broker | `resources\glm\zcode.cjs` | same schema relaxation |
| Model-side plugin | browser-use 0.4.x cache | `Tab.get cdp()` returns a bare object to bypass the `hideUnknown` allowlist |

## Notes

- Targets **3.10.1** only (the script verifies the version). After a ZCode auto-update, run `Status` first — a re-port is usually needed.
- `Apply` is idempotent: re-running on a patched install is skipped (`-Force` overrides).
- CDP is extremely powerful (read/write any page state, inject scripts). Use **only against authorized targets**.
