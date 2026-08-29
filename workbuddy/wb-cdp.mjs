#!/usr/bin/env node
/*
 * wb-cdp.mjs — WorkBuddy built-in browser CDP CLI (no MCP, plain shell tool)
 * Requires Node >= 22 (global WebSocket + fetch). Bundled node:
 *   %USERPROFILE%\.workbuddy\binaries\node\versions\<ver>\node.exe
 *
 * Commands:
 *   status                 port reachable? version? target count
 *   list                   list page targets
 *   use <n|id|substr>      select current target (persisted)
 *   open|nav <url>         navigate current/best target, wait for load
 *   eval <expr|->          evaluate JS in page ('-' = read expression from stdin)
 *   shot [outfile.png]     capture screenshot
 *   net [ms] [--reload]    capture network events (default 8000ms)
 *   waitload [ms]          wait until document complete
 *   devtools [n]           open DevTools window for target in local browser
 * Global flags: --port N (default 9222)  --target <n|id|substr>  --json  --timeout ms
 * Exit codes: 0 ok | 3 port down | 4 no target | 5 command failed
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 9222;
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.workbuddy', 'cdp-bridge');
const STATE_FILE = path.join(STATE_DIR, '.current');

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
let port = DEFAULT_PORT, targetSel = null, jsonOut = false, timeoutMs = 15000;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') port = Number(argv[++i]);
  else if (a === '--target') targetSel = argv[++i];
  else if (a === '--json') jsonOut = true;
  else if (a === '--timeout') timeoutMs = Number(argv[++i]);
  else if (a === '--reload') rest.push('--reload');
  else rest.push(a);
}
const cmd = rest.shift() || 'status';
if (typeof WebSocket === 'undefined') {
  console.error('[x] Node >= 22 required (global WebSocket missing). Use WorkBuddy bundled node.');
  process.exit(5);
}

function fail(code, msg) { console.error('[x] ' + msg); process.exit(code); }
function out(o) { console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2)); }

// ---------- targets ----------
async function fetchTargets() {
  let res;
  try { res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) }); }
  catch { fail(3, `CDP port ${port} not reachable. Launch WorkBuddy via wb-start.cmd (sets WORKBUDDY_REMOTE_DEBUGGING_PORT).`); }
  if (!res.ok) fail(3, `CDP /json/list HTTP ${res.status}`);
  const all = await res.json();
  // built-in browser preview shows up as type "webview", IDE window as "page"
  return all.filter(t => (t.type === 'page' || t.type === 'webview' || t.type === 'iframe') && !String(t.url).startsWith('devtools://'));
}

function rankTargets(list) {
  const scored = list.map((t, i) => {
    const url = String(t.url);
    let s = 0;
    if (/^https?:/i.test(url)) s += 10;
    if (t.type === 'webview') s += 6;          // built-in browser panel = what we want
    if (url === 'about:blank') s -= 5;
    if (/^file:/i.test(url)) s -= 10;          // IDE renderer window
    if (/webbuddy|workbuddy|codebuddy/i.test(url)) s -= 8;
    return { t, i, s };
  });
  scored.sort((a, b) => b.s - a.s || b.i - a.i); // prefer browser-panel http(s), newest last
  return scored.map(x => x.t);
}

function loadCurrent() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveCurrent(t) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ id: t.id, url: t.url, ts: Date.now() }));
  } catch { /* best effort */ }
}

function resolveTarget(list, sel) {
  const ranked = rankTargets(list);
  if (sel != null) {
    if (/^\d+$/.test(sel)) {
      const t = list[Number(sel)];
      if (!t) fail(4, `no target #${sel}`);
      return t;
    }
    const byId = list.find(t => t.id === sel);
    if (byId) return byId;
    const bySub = ranked.find(t => String(t.url).includes(sel) || String(t.title).includes(sel));
    if (bySub) return bySub;
    fail(4, `no target matching "${sel}"`);
  }
  const cur = loadCurrent();
  if (cur) {
    const still = list.find(t => t.id === cur.id);
    if (still) return still;
  }
  if (!ranked.length) fail(4, 'no page target. Open a page in WorkBuddy built-in browser first.');
  return ranked[0];
}

function fmtIndex(list) {
  return list.map((t, i) => {
    const cur = loadCurrent();
    const mark = cur && cur.id === t.id ? '*' : ' ';
    return `${mark}#${i} ${t.id.slice(0, 8)} ${t.title || '-'} | ${t.url}`;
  });
}

// ---------- CDP client ----------
class CDP {
  constructor(ws) { this.ws = ws; this.mid = 0; this.pending = new Map(); this.handlers = new Map(); }
  static connect(wsUrl, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws connect timeout')); }, timeout);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CDP(ws)); });
      ws.addEventListener('error', e => { clearTimeout(timer); reject(new Error('ws error: ' + (e.message || 'unknown'))); });
    });
  }
  on(ev, fn) {
    if (!this.handlers.has(ev)) {
      this.handlers.set(ev, []);
      this.ws.addEventListener('message', m => {
        let d; try { d = JSON.parse(m.data); } catch { return; }
        if (d.method) for (const f of this.handlers.get(d.method) || []) f(d.params, d);
      });
    }
    this.handlers.get(ev).push(fn);
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.mid;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
  start() {
    if (this._started) return; this._started = true;
    this.ws.addEventListener('message', m => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d.id && this.pending.has(d.id)) {
        const p = this.pending.get(d.id);
        this.pending.delete(d.id); clearTimeout(p.timer);
        if (d.error) p.reject(new Error(d.error.message || JSON.stringify(d.error)));
        else p.resolve(d.result);
      }
    });
    this.ws.addEventListener('close', () => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('ws closed')); }
      this.pending.clear();
    });
  }
  async waitEvent(ev, ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(null), ms);
      this.on(ev, p => { clearTimeout(t); resolve(p); });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function withTarget(fn, sel = targetSel) {
  const list = await fetchTargets();
  const t = resolveTarget(list, sel);
  const wsUrl = t.webSocketDebuggerUrl || `ws://127.0.0.1:${port}/devtools/page/${t.id}`;
  const cdp = await CDP.connect(wsUrl);
  cdp.start();
  try { return await fn(t, cdp, list); } finally { cdp.close(); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- commands ----------
async function cmdStatus() {
  let ver;
  try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json(); }
  catch { fail(3, `CDP port ${port} not reachable. Launch via wb-start.cmd or set WORKBUDDY_REMOTE_DEBUGGING_PORT.`); }
  const list = await fetchTargets();
  if (jsonOut) { out({ ok: true, browser: ver.Browser, port, targets: list }); return; }
  console.log(`[ok] ${ver.Browser} | CDP port ${port}`);
  console.log(`[ok] ${list.length} page target(s)`);
  for (const l of fmtIndex(list)) console.log('  ' + l);
}

async function cmdList() {
  const list = await fetchTargets();
  if (jsonOut) { out({ ok: true, targets: list }); return; }
  if (!list.length) { console.log('(no page targets)'); return; }
  for (const l of fmtIndex(list)) console.log(l);
}

async function cmdUse() {
  const sel = rest[0];
  if (!sel) fail(5, 'usage: use <n|id|url-substr>');
  const list = await fetchTargets();
  const t = resolveTarget(list, sel);
  saveCurrent(t);
  console.log(`[ok] current -> #${list.indexOf(t)} ${t.url}`);
}

async function cmdOpen() {
  const url = rest.find(a => !a.startsWith('--'));
  if (!url) fail(5, 'usage: open <url>');
  const full = /^https?:/i.test(url) ? url : 'https://' + url;
  await withTarget(async (t, cdp, list) => {
    await cdp.send('Page.enable');
    const loaded = cdp.waitEvent('Page.loadEventFired', timeoutMs);
    await cdp.send('Page.navigate', { url: full });
    await loaded;
    saveCurrent(t);
    const st = await cdp.send('Runtime.evaluate', { expression: 'document.readyState+" "+location.href', returnByValue: true });
    if (jsonOut) out({ ok: true, targetId: t.id, url: full, state: st.result.value });
    else console.log(`[ok] ${full} -> ${st.result.value}`);
  });
}

async function cmdEval() {
  let expr = rest.join(' ');
  if (expr === '-' || !expr) {
    expr = '';
    for await (const chunk of process.stdin) expr += chunk;
    expr = expr.trim();
  }
  if (!expr) fail(5, 'usage: eval "<js>" (or echo js | eval -)');
  await withTarget(async (t, cdp) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      const txt = e.exception?.description || e.exception?.value || e.text || 'exception';
      fail(5, 'eval exception: ' + txt);
    }
    const v = r.result.value;
    saveCurrent(t);
    if (jsonOut) out({ ok: true, value: v });
    else if (v === undefined) console.log(r.result.description || 'undefined');
    else if (typeof v === 'string') console.log(v);
    else out(v);
  });
}

async function cmdShot() {
  const file = rest.find(a => !a.startsWith('--')) || `wb-shot-${Date.now()}.png`;
  const abs = path.resolve(file);
  await withTarget(async (t, cdp) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(abs, Buffer.from(r.data, 'base64'));
    if (jsonOut) out({ ok: true, file: abs, targetId: t.id });
    else console.log('[ok] saved ' + abs);
  });
}

async function cmdNet() {
  let ms = 8000, reload = rest.includes('--reload');
  const msArg = rest.find(a => /^\d+$/.test(a));
  if (msArg) ms = Math.min(Number(msArg), 60000);
  const events = [];
  await withTarget(async (t, cdp) => {
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    cdp.on('Network.requestWillBeSent', p => events.push({ ts: p.timestamp, kind: 'req', method: p.request.method, url: p.request.url, id: p.requestId, type: p.type }));
    cdp.on('Network.responseReceived', p => events.push({ ts: p.timestamp, kind: 'res', status: p.response.status, mime: p.response.mimeType, url: p.response.url, id: p.requestId, type: p.type }));
    cdp.on('Network.loadingFailed', p => events.push({ ts: p.timestamp, kind: 'fail', error: p.errorText, url: '', id: p.requestId, type: p.type }));
    if (reload) await cdp.send('Page.reload').catch(() => {});
    await sleep(ms);
  });
  // merge req+res by id
  const byId = new Map();
  for (const e of events) {
    if (e.kind === 'fail') { const x = byId.get(e.id) || { url: '(unknown)' }; x.failed = e.error; byId.set(e.id, x); continue; }
    if (e.kind === 'req') { byId.set(e.id, { method: e.method, url: e.url, type: e.type }); continue; }
    const x = byId.get(e.id) || { method: '?', url: e.url, type: e.type };
    x.status = e.status; x.mime = e.mime; byId.set(e.id, x);
  }
  const rows = [...byId.entries()].map(([id, x]) => ({ id: id.slice(0, 8), method: x.method, status: x.failed ? 'FAIL' : (x.status || '-'), type: x.type || '-', failed: x.failed || '', url: x.url }));
  if (jsonOut) { out({ ok: true, ms, count: rows.length, requests: rows }); return; }
  console.log(`[ok] ${rows.length} request(s) in ${ms}ms${reload ? ' (reloaded)' : ''}`);
  for (const r of rows) {
    const u = r.url.length > 96 ? r.url.slice(0, 93) + '...' : r.url;
    console.log(`  ${String(r.status).padEnd(4)} ${String(r.method).padEnd(5)} ${String(r.type).padEnd(8)} ${r.failed ? r.failed + ' ' : ''}${u}`);
  }
}

async function cmdWaitload() {
  let ms = timeoutMs;
  const msArg = rest.find(a => /^\d+$/.test(a));
  if (msArg) ms = Number(msArg);
  await withTarget(async (t, cdp) => {
    const r0 = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (r0.result.value === 'complete') { console.log('[ok] already complete'); return; }
    await cdp.send('Page.enable');
    const ok = await cdp.waitEvent('Page.loadEventFired', ms);
    if (jsonOut) out({ ok: !!ok });
    else console.log(ok ? '[ok] loaded' : '[warn] timeout, readyState=' + (await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result.value);
  });
}

async function cmdDevtools() {
  const list = await fetchTargets();
  const t = resolveTarget(list, rest[0] ?? targetSel);
  const ins = `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${t.id}`;
  // verify the frontend is served; if not, fall back to devtools:// hint
  let served = false;
  try { const r = await fetch(ins.replace('?ws=', '?ws=').split('?')[0], { signal: AbortSignal.timeout(3000) }); served = r.ok; } catch {}
  saveCurrent(t);
  const candidates = [
    process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LocalAppData'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['LocalAppData'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const browser = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!served && !jsonOut) console.log('[warn] inspector.html not served by CDP server, trying browser anyway');
  try {
    if (browser) {
      const { spawn } = await import('node:child_process');
      spawn(browser, [ins], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const { spawn } = await import('node:child_process');
      spawn('cmd', ['/c', 'start', '', ins], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) { fail(5, 'failed to open browser: ' + e.message); }
  if (jsonOut) out({ ok: true, url: ins, targetId: t.id, browser: browser || 'default' });
  else console.log(`[ok] DevTools -> ${t.url}\n     ${ins}`);
}

// ---------- dispatch ----------
const handlers = { status: cmdStatus, list: cmdList, ls: cmdList, use: cmdUse, open: cmdOpen, nav: cmdOpen, eval: cmdEval, shot: cmdShot, net: cmdNet, waitload: cmdWaitload, devtools: cmdDevtools };
const fn = handlers[cmd];
if (!fn) fail(5, `unknown command "${cmd}". commands: ${Object.keys(handlers).join(' ')}`);
fn().catch(e => fail(5, e.message));
