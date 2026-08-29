#!/usr/bin/env node
/*
 * apply-patch.mjs (v2) — patch WorkBuddy extracted asar for native browser_cdp tool.
 *  1. main/server.js : builtin tool `browser_cdp`. v2 runs on PLAIN NODE
 *     (fetch + WebSocket to the local CDP port) because builtin tools execute
 *     in the daemon process, where require('electron') is unavailable.
 *  2. main/index.js  : (a) un-gate right-click "Inspect" on the built-in
 *     browser preview; (b) make the official CDP port ALWAYS-ON (default
 *     9222, env WORKBUDDY_REMOTE_DEBUGGING_PORT overrides, "0/off" disables).
 * Idempotent + upgrade-aware (v1 electron-based factory is replaced).
 * Usage: node apply-patch.mjs <extracted-asar-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root) { console.error('usage: node apply-patch.mjs <extracted-asar-dir>'); process.exit(2); }

// ---------- v2 tool factory: plain Node, daemon-safe (ASCII only) ----------
const FACTORY_V2 = `
function createBrowserCdpTool() {
	const PORT = 9222;
	const BASE = "http://127.0.0.1:" + PORT;
	const eventLog = [];
	let client = null;
	const ok = (t) => ({ content: [{ type: "text", text: String(t) }] });
	const fail = (t) => ({ content: [{ type: "text", text: "Error: " + t }], isError: true });
	function record(method, params) {
		if (!method) return;
		eventLog.push({ t: Date.now(), method, params });
		if (eventLog.length > 2000) eventLog.splice(0, 1000);
	}
	async function listTargets() {
		let res;
		try { res = await fetch(BASE + "/json/list", { signal: AbortSignal.timeout(4000) }); }
		catch { throw new Error("CDP port " + PORT + " not reachable (app still starting?). Retry in a few seconds."); }
		if (!res.ok) throw new Error("CDP /json/list HTTP " + res.status);
		return (await res.json()).filter((t) => (t.type === "page" || t.type === "webview") && !String(t.url).startsWith("devtools://"));
	}
	function pick(list) {
		const scored = list.map((t, i) => {
			const u = String(t.url);
			let s = 0;
			if (/^https?:/i.test(u)) s += 10;
			if (t.type === "webview") s += 6;
			if (u === "about:blank") s -= 5;
			if (/^file:/i.test(u)) s -= 10;
			return { t, i, s };
		});
		scored.sort((a, b) => b.s - a.s || b.i - a.i);
		return scored.length ? scored[0].t : null;
	}
	async function currentTarget() {
		const list = await listTargets();
		if (client) {
			const still = list.find((t) => t.id === client.targetId);
			if (still) return still;
			try { client.ws.close(); } catch {}
			client = null;
		}
		const t = pick(list);
		if (!t) throw new Error("built-in browser panel is not open. Open a URL first (present_files).");
		return t;
	}
	function connect(wsUrl) {
		return new Promise((resolve, reject) => {
			if (typeof WebSocket === "undefined") return reject(new Error("runtime lacks WebSocket (needs Node >= 22)"));
			const ws = new WebSocket(wsUrl);
			const tm = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("ws connect timeout")); }, 6000);
			ws.addEventListener("open", () => { clearTimeout(tm); resolve(ws); });
			ws.addEventListener("error", () => { clearTimeout(tm); reject(new Error("ws error")); });
		});
	}
	function makeSender(ws) {
		const pending = new Map();
		let seq = 0;
		ws.addEventListener("message", (m) => {
			let d; try { d = JSON.parse(m.data); } catch { return; }
			if (d.id && pending.has(d.id)) {
				const p = pending.get(d.id); pending.delete(d.id); clearTimeout(p.timer);
				d.error ? p.reject(new Error(d.error.message || JSON.stringify(d.error))) : p.resolve(d.result);
			} else if (d.method) record(d.method, d.params);
		});
		ws.addEventListener("close", () => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("ws closed")); } pending.clear(); });
		return function send(method, params) {
			return new Promise((resolve, reject) => {
				const id = ++seq;
				const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 20000);
				pending.set(id, { resolve, reject, timer });
				ws.send(JSON.stringify({ id, method, params: params || {} }));
			});
		};
	}
	async function exec(method, params) {
		const t = await currentTarget();
		if (!client || client.targetId !== t.id) {
			const ws = await connect(t.webSocketDebuggerUrl || ("ws://127.0.0.1:" + PORT + "/devtools/page/" + t.id));
			client = { ws, targetId: t.id, send: makeSender(ws) };
			ws.addEventListener("close", () => { if (client && client.targetId === t.id) client = null; });
			await client.send("Page.enable").catch(() => {});
			await client.send("Network.enable").catch(() => {});
			await client.send("Runtime.enable").catch(() => {});
		}
		return await client.send(method, params);
	}
	async function evalJs(expr) {
		const r = await exec("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page exception");
		return r.result.value;
	}
	return {
		name: "browser_cdp",
		description: "Drive the built-in browser preview panel (Chrome DevTools Protocol). Works on the panel opened via present_files. Actions: eval=run JS in the page and return the value (supports await); info=current url/title/readyState; shot=save full-page screenshot png; net=recent network requests; events=recent CDP events (filtered); send=raw CDP command; devtools=open a DevTools window.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["eval", "info", "shot", "net", "events", "send", "waitload", "devtools"], description: "What to do." },
				expression: { type: "string", description: "eval: JS expression, may use await." },
				path: { type: "string", description: "shot: output png path (absolute recommended)." },
				limit: { type: "number", description: "net/events: max entries (default 30)." },
				method_filter: { type: "string", description: "events: prefix filter like Network. or Runtime.consoleAPICalled." },
				method: { type: "string", description: "send: CDP method, e.g. Page.navigate or Emulation.setDeviceMetricsOverride." },
				params: { type: "object", description: "send: CDP params object." }
			},
			required: ["action"]
		},
		handler: async (args) => {
			const a = args || {};
			try {
				if (a.action === "devtools") {
					const list = await listTargets();
					const t = pick(list);
					if (!t) return fail("built-in browser panel is not open.");
					const ins = BASE + "/devtools/inspector.html?ws=127.0.0.1:" + PORT + "/devtools/page/" + t.id;
					const { spawn } = await import("node:child_process");
					spawn("cmd", ["/c", "start", "", ins], { detached: true, stdio: "ignore" }).unref();
					return ok("[ok] DevTools window opened for " + t.url + "\\n(in-app alternative: right-click inside the built-in browser -> Inspect)");
				}
				if (a.action === "info") {
					return ok(await evalJs("JSON.stringify({url:location.href,title:document.title,ready:document.readyState})"));
				}
				if (a.action === "eval") {
					if (typeof a.expression !== "string") return fail("expression required");
					const v = await evalJs(a.expression);
					return ok(typeof v === "string" ? v : JSON.stringify(v ?? null));
				}
				if (a.action === "shot") {
					const r = await exec("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
					const fs = await import("node:fs");
					const p = a.path || ("wb-cdp-shot-" + Date.now() + ".png");
					fs.writeFileSync(p, Buffer.from(r.data, "base64"));
					return ok("[ok] saved " + p);
				}
				if (a.action === "net") {
					const lim = Math.min(a.limit || 30, 200);
					const reqs = new Map();
					for (const e of eventLog) {
						if (e.method === "Network.requestWillBeSent") reqs.set(e.params.requestId, { method: e.params.request.method, url: e.params.request.url });
						else if (e.method === "Network.responseReceived") { const x = reqs.get(e.params.requestId) || { url: e.params.response.url }; x.status = e.params.response.status; reqs.set(e.params.requestId, x); }
						else if (e.method === "Network.loadingFailed") { const x = reqs.get(e.params.requestId) || {}; x.error = e.params.errorText; reqs.set(e.params.requestId, x); }
					}
					const rows = [...reqs.values()].slice(-lim);
					return ok(rows.map((r) => [r.status || "-", r.error || "", r.method || "", r.url].join(" ")).join("\\n") || "(no network events yet - net records from the first browser_cdp call; use action=send method=Page.reload then check again)");
				}
				if (a.action === "events") {
					const lim = Math.min(a.limit || 30, 500);
					let rows = eventLog;
					if (a.method_filter) rows = rows.filter((e) => e.method.startsWith(a.method_filter));
					return ok(rows.slice(-lim).map((e) => e.method + " " + JSON.stringify(e.params).slice(0, 300)).join("\\n") || "(no events yet)");
				}
				if (a.action === "waitload") {
					const st = await evalJs("document.readyState");
					if (st === "complete") return ok("[ok] complete");
					for (let i = 0; i < 30; i++) {
						await new Promise((r2) => setTimeout(r2, 500));
						if ((await evalJs("document.readyState")) === "complete") return ok("[ok] complete");
					}
					return ok("[warn] still loading after 15s");
				}
				if (a.action === "send") {
					if (typeof a.method !== "string") return fail("method required");
					const r = await exec(a.method, a.params || {});
					return ok(JSON.stringify(r).slice(0, 8000));
				}
				return fail("unknown action: " + a.action);
			} catch (e) {
				return fail(e?.message || String(e));
			}
		}
	};
}
`;

// ---------- 1) server.js : tool factory (insert or upgrade) ----------
const serverPath = path.join(root, 'main', 'server.js');
let server = fs.readFileSync(serverPath, 'utf8');
const ANCHOR_FN = 'function createWorkbuddyAppServerMcpTools(deps) {';
const ANCHOR_TAIL = `		isCloudMemoryEnabled: deps.isCloudMemoryEnabled
	}));
	return tools;
}`;
const TOOL_DEF_START = 'function createBrowserCdpTool()';
if (server.includes(TOOL_DEF_START)) {
  const start = server.indexOf(TOOL_DEF_START);
  const end = server.indexOf(ANCHOR_FN, start);
  if (end < 0) { console.error('[x] cannot find factory end anchor'); process.exit(1); }
  server = server.slice(0, start) + FACTORY_V2 + '\n' + server.slice(end);
  console.log('[ok] server.js: browser_cdp factory upgraded to v2 (daemon-safe, plain node)');
} else {
  const countOf = (s, sub) => s.split(sub).length - 1;
  if (countOf(server, ANCHOR_FN) !== 1) { console.error('[x] ANCHOR_FN not unique'); process.exit(1); }
  if (countOf(server, ANCHOR_TAIL) !== 1) { console.error('[x] ANCHOR_TAIL not unique'); process.exit(1); }
  server = server.replace(ANCHOR_FN, () => FACTORY_V2 + '\n' + ANCHOR_FN);
  server = server.replace(ANCHOR_TAIL, () => `		isCloudMemoryEnabled: deps.isCloudMemoryEnabled
	}));
	tools.push(createBrowserCdpTool());
	return tools;
}`);
  console.log('[ok] server.js: browser_cdp v2 injected + registered');
}
fs.writeFileSync(serverPath, server);

// ---------- 2) index.js : Inspect un-gate + always-on CDP port ----------
const indexPath = path.join(root, 'main', 'index.js');
let index = fs.readFileSync(indexPath, 'utf8');
const GATE = 'if (isDev) guestContents.on("context-menu", () => {';
if (index.includes(GATE)) {
  index = index.replace(GATE, 'guestContents.on("context-menu", () => {');
  console.log('[ok] index.js: right-click Inspect un-gated');
} else if (index.includes('guestContents.on("context-menu", () => {')) {
  console.log('[skip] index.js: Inspect already un-gated');
} else {
  console.error('[x] index.js Inspect anchor not found');
  process.exit(1);
}
const PORT_ANCHOR = 'const cdpPort = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;';
const PORT_NEW = 'const cdpPort = /^(0|off|false)$/i.test(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || "") ? "" : (process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || "9222");';
if (index.includes(PORT_NEW)) {
  console.log('[skip] index.js: CDP port already always-on');
} else if (index.includes(PORT_ANCHOR)) {
  index = index.replace(PORT_ANCHOR, () => PORT_NEW);
  console.log('[ok] index.js: official CDP port now always-on (default 9222, env override, 0/off disables)');
} else {
  console.error('[x] index.js cdpPort anchor not found');
  process.exit(1);
}
fs.writeFileSync(indexPath, index);

// ---------- 3) syntax check ----------
for (const f of [serverPath, indexPath]) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  console.log('[ok] syntax: ' + f);
}
console.log('[done] patch v2 applied to ' + root);
