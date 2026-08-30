# WorkBuddy CDP Tool（内置浏览器原生调试）

[中文说明](README.zh-CN.md)

Give the WorkBuddy agent a **native `browser_cdp` tool** for driving its built-in browser (the preview panel opened via `present_files`): evaluate JS, full-page screenshots, network capture, CDP events, raw CDP, and DevTools — no MCP, no shell round-trips. Also unlocks the hidden right-click **Inspect** menu inside the built-in browser and turns the official CDP port always-on.

- Tested against **WorkBuddy 5.4.4 (Windows x64)**. The patch anchors on exact source strings; other versions may need anchor updates.
- Requirements: Node.js ≥ 22 (WorkBuddy's bundled node works too), internet access on first run (`npm install @electron/asar`).

## How it works

Reverse engineering found three load-bearing facts:

1. The built-in browser is a `<webview>` whose session partition is `persist:agent-browser-preview-webview`.
2. WorkBuddy has an **official CDP channel**: `WORKBUDDY_REMOTE_DEBUGGING_PORT` → `remote-debugging-port` + `remote-allow-origins` (their code comments say it exists "for the super-workbuddy skill and other external automation tools. Off by default.").
3. Agent builtin tools are registered in `server.js` (`createWorkbuddyAppServerMcpTools`), but they execute in the **daemon process (plain Node)** — `require('electron')` is unavailable there.

So the patch (v2):

- **Host side** (`main/index.js`): un-gates the dev-only right-click Inspect on the preview webview, and defaults the official CDP port to **always-on 9222** (env `WORKBUDDY_REMOTE_DEBUGGING_PORT` overrides; `0`/`off` disables).
- **Daemon side** (`main/server.js`): registers a native builtin tool `browser_cdp` implemented in plain Node (fetch + WebSocket against `127.0.0.1:9222`) — the model sees it in its tool list on every new conversation, zero setup, zero prompting.

Because Electron's asar-integrity fuse would reject a modified `app.asar`, the installer flips that single fuse byte in `WorkBuddy.exe` (a documented Electron fuse-wire format — same mechanism as `@electron/fuses`). This invalidates the Authenticode signature of the exe; it does not affect local execution. A WorkBuddy update replaces both files — re-run the installer afterwards.

## Quick start

Run the repo-root **`DevToolsTool.exe`** → `5` (switch target to WorkBuddy) → `1` (install). The script:

1. gracefully closes WorkBuddy (force after 15 s),
2. backs up `WorkBuddy.exe` + `app.asar` to `resources\cdp-patch-backup\`,
3. extracts the asar, injects the tool, repacks,
4. runs safety gates (unpacked-file count ≥ 98 % of original, full content verification) — **any mismatch aborts before touching a single byte**,
5. swaps files in, flips the fuse, relaunches WorkBuddy.

CLI equivalent: `wb-patch.cmd install` / `wb-patch.cmd remove` / `wb-patch.cmd status`.

## The `browser_cdp` tool

| action | effect |
|--------|--------|
| `eval` | run JS in the page, return value as JSON (`awaitPromise` supported) |
| `info` | current url / title / readyState |
| `shot` | full-page screenshot to png |
| `net` | recent network requests (method/status/url) |
| `events` | recent raw CDP events, optional prefix filter |
| `send` | raw CDP command (e.g. `Page.navigate`) |
| `waitload` | wait until `document.readyState === "complete"` |
| `devtools` | open a DevTools window (in-app alternative: right-click → Inspect) |

Typical flow in a conversation: `present_files` a URL, then `browser_cdp` on it — both share the same CDP session.

## CLI fallback

`wb-cdp.cmd` drives the same port from any terminal (also usable by other agents):

```text
wb-cdp.cmd status | list | use <n> | open <url> | eval "<js>" | shot [file] | net [ms] | devtools
```

`wb-setup.cmd install` additionally registers a `wb-cdp` **skill** under `~\.workbuddy\skills\` so the agent also knows the CLI path (useful before the asar patch is applied).

## Remove / restore

`wb-patch.cmd remove` (or menu `2`) restores the byte-identical original exe + asar from the backup. The `app.asar.unpacked` folder is left as-is on purpose — the installer only ever adds files to it and none of them are hash-checked.

## Safety notes

- Every write is gated: content verification runs **before** anything is swapped in; a failed gate aborts with originals untouched.
- The always-on CDP port is loopback-only (127.0.0.1) but ANY local process can talk to it — that is inherent to Chromium remote debugging. Only patch machines you control.
- CDP grants full control of the browser: use it for authorized debugging only.

## Files

| file | role |
|------|------|
| `../DevToolsTool.exe` / `../DevToolsTool.cs` / `../app-menu.ps1` | unified double-click menu for ZCode + WorkBuddy (source included, rebuildable with system csc) |
| `wb-patch.cmd` | install / remove / status orchestrator with safety gates |
| `apply-patch.mjs` | the actual injection (tool factory + Inspect + always-on port) |
| `verify-pack.mjs` | static verification of the repacked asar |
| `flip-fuse.mjs` / `fuse-scan.mjs` | Electron fuse flip / scan (documented wire format) |
| `count-files.mjs` | unpacked-file counter for the safety gate |
| `wb-setup.cmd` / `wb-start.cmd` / `wb-cdp.cmd` / `wb-cdp.mjs` / `SKILL.template.md` | optional skill + CLI layer |
