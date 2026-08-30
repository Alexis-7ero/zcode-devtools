# ZCode DevTools Patch — macOS

[中文说明](README.zh-CN.md)

Enable the hidden CDP (Chrome DevTools Protocol) debugging channel for the built-in browser of **ZCode Desktop 3.10.1** (macOS). After patching, the AI can use `tab.cdp.*` and `tab.openDevTools()` on in-app browser tabs: arbitrary CDP commands, event streams, breakpoints / pause / resume, and opening DevTools. Windows version (verified end-to-end on a real machine): [`zcode-devtools-windows`](https://github.com/Alexis-7ero/zcode-devtools-windows).

> ⚠️ **Untested on a real Mac** — the author has no macOS device. This port is built from the Windows-verified transform rules plus a cross-platform rules engine, and was regression-tested on Windows against the same-origin asar (transform hits, packing, idempotency, passthrough all pass). Mac users are welcome to try and file issues with the reported output.

## Preflight check (required)

Install Node.js (`brew install node`), then run the health check:

```bash
chmod +x cdp-patch.sh
node ../fuse-scan.mjs /Applications/ZCode.app/Contents/MacOS/ZCode
```

- If it prints the **integrity manifest embedded: yes** → this patch does **not** apply; modifying the asar would be rejected at launch. Stop here.
- If `no` → you are safe to continue.

## Usage

Double-click **Menu.command** in Finder — interactive menu (① install ② backup ③ remove ④ status). Install auto-quits ZCode, restores the pristine baseline, re-hooks via the rules engine, re-signs ad-hoc and self-checks. Single-action wrappers: `Install.command`, `Remove.command`, `Status.command`.
The script auto-discovers ZCode.app (/Applications → ~/Applications → Spotlight). Custom location: `--app /path/ZCode.app` or `ZCODE_APP` env var.
```bash
./cdp-patch.sh Status            # show state
./cdp-patch.sh Apply --wait      # enable; waits for ZCode to exit, then finishes in ~1-2 min
./cdp-patch.sh Remove            # disable patch, full-file restore
```

After enabling, **start a new conversation** and verify:

```text
Open https://www.baidu.com then run tab.cdp.evaluate("1+1") and tab.openDevTools()
```

## Design (mac ≠ the Windows pre-baked-file patch)

The mac version uses a **rules-engine transform**, resilient to build differences:

1. Unpack `app.asar` at runtime and walk every module JS under `out/`;
2. Apply the anchor rules from `payload/rules.cjs` (the union regex adapts to any zod alias letter; `doneIf` sentinels keep it idempotent);
3. If a key anchor is missed → abort safely without writing anything, and print a hit report (please attach it to your Issue);
4. Repack keeping native modules (`*.node` / `*.dylib`) unpacked.

macOS-specific handling (built into the script):

- **Code signing**: modifying bundle resources invalidates the signature. Apply/Remove automatically re-signs ad-hoc (`codesign --force --deep --sign -`) and clears quarantine (`xattr -cr`);
- **Full-file backup**: the first Apply copies the whole pristine `app.asar` to `backup/app.asar.original` (~300 MB, not committed); Remove restores it wholesale;
- **Idempotent**: re-Apply on a patched asar detects the sentinel and skips.

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

## Layout

```
cdp-patch.sh                  # single entry: Status / Apply / Remove
../apply-asar.mjs             # shared rules-engine asar transformer
../rules.cjs                  # shared transform rules
../fuse-scan.mjs              # Electron fuses / asar integrity preflight
../zcode.cjs.gz               # broker patch
../browser-client.mjs         # plugin: tab.cdp / openDevTools (0.4.1 baseline)
../api.json                   # plugin docs manifest
backup/                       # full backup generated on first Apply (not committed)
```

## Notes

- Targets **3.10.1** only. After a ZCode auto-update, run `Status` first.
- CDP is extremely powerful (read/write any page state, inject scripts). Use **only against authorized targets**.
