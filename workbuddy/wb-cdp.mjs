#!/usr/bin/env node
/*
 * WorkBuddy 内置浏览器 CDP 客户端（零依赖，Node ≥ 22）
 * ------------------------------------------------
 * 前提：WorkBuddy 以 CDP 模式启动（环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT=端口，
 * 或直接运行 wb-start.cmd）。之后本工具即可列出/驱动其内置浏览器预览面板。
 *
 * 用法：
 *   node wb-cdp.mjs wait [--timeout 240]                        等待 CDP 端点就绪（进度条）
 *   node wb-cdp.mjs list [--url baidu]                          列出全部 CDP 目标
 *   node wb-cdp.mjs eval --url baidu --expr "1+1" [--await]     页内执行 JS
 *   node wb-cdp.mjs nav  --url baidu --to "https://..."         导航（等待加载完成）
 *   node wb-cdp.mjs net  --url baidu [--seconds 6] [--no-reload] 网络监听（默认自动刷新捕获）
 *   node wb-cdp.mjs shot --url baidu [--out shot.png]           整页截图
 *   node wb-cdp.mjs devtools --url baidu [--open]               打开该目标的 DevTools 页面
 *
 * 供 WorkBuddy 的 agent 通过 shell 调用（等价于 ZCode 的 tab.cdp.* 能力）。
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const port = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || '9222';
const base = `http://127.0.0.1:${port}`;

const argOf = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const has = (name) => args.includes(name);
const cmd = (args[0] || 'list').toLowerCase();
const urlSub = (argOf('--url') || '').toLowerCase();
const expr = argOf('--expr', '1+1');
const toUrl = argOf('--to');

function die(msg) {
  console.error('[x] ' + msg);
  console.error('    请先用 wb-start.cmd（或设置 WORKBUDDY_REMOTE_DEBUGGING_PORT 后）启动 WorkBuddy。');
  process.exit(1);
}

async function getTargets() {
  let r;
  try {
    r = await fetch(`${base}/json/list`);
  } catch {
    die(`无法连接 ${base} —— WorkBuddy 未以 CDP 模式运行。`);
  }
  if (!r.ok) die(`/json/list 返回 ${r.status}`);
  return r.json();
}

function matchTargets(ts, urlSub) {
  const m = ts.filter(
    (t) => ['page', 'webview', 'iframe', 'app'].includes(t.type) &&
      (!urlSub || (t.url + ' ' + (t.title || '')).toLowerCase().includes(urlSub.toLowerCase())),
  );
  if (m.length === 0) {
    console.error('[x] 没有匹配目标。全部目标：');
    for (const t of ts) console.error(`    [${t.type}] ${t.title || '(untitled)'} ${t.url}`);
    process.exit(1);
  }
  return m;
}

function cdp(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function withTarget(t, fn) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  try {
    let id = 0;
    await cdp(ws, ++id, 'Runtime.enable');
    return await fn(ws, () => ++id);
  } finally {
    try { ws.close(); } catch {}
  }
}

/* ---------- 进度条 ---------- */
function bar(pct, label, lastLenRef) {
  const b = '[' + '#'.repeat(Math.round(pct / 3.4)).padEnd(30, '·') + ']';
  const line = `${b} ${String(pct).padStart(3)}%  ${label}`;
  if (process.stdout.isTTY) {
    process.stdout.write('\r' + line + ' '.repeat(Math.max(0, lastLenRef.v - line.length)));
    lastLenRef.v = line.length;
  } else {
    console.log(`PROGRESS ${pct} ${label}`);
  }
}

/* ---------- 等待 CDP 端点就绪（WorkBuddy 冷启动约 1-2 分钟）---------- */
async function waitReady(timeoutSec) {
  const t0 = Date.now();
  const ref = { v: 0 };
  for (;;) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    let ok = false;
    try { ok = (await fetch(`${base}/json/version`)).ok; } catch {}
    const pct = ok ? 100 : Math.min(99, Math.round((elapsed / timeoutSec) * 100));
    bar(pct, ok ? 'CDP 就绪！' : `等待 WorkBuddy 启动（已 ${elapsed}s / 预计 ${timeoutSec}s）`, ref);
    if (ok) {
      if (process.stdout.isTTY) process.stdout.write('\n');
      return elapsed;
    }
    if (elapsed >= timeoutSec) {
      if (process.stdout.isTTY) process.stdout.write('\n');
      die(`等待超时（${timeoutSec}s）。请确认 WorkBuddy 窗口已打开且加载完成。`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* ---------- 网络监听：enable → reload → 收集 ---------- */
async function captureNetwork(t, seconds, reload) {
  return withTarget(t, async (ws, nextId) => {
    const reqs = new Map();
    await cdp(ws, nextId(), 'Network.enable');
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.method === 'Network.requestWillBeSent') {
        reqs.set(m.params.requestId, { method: m.params.request.method, url: m.params.request.url, status: '' });
      } else if (m.method === 'Network.responseReceived') {
        const r = reqs.get(m.params.requestId);
        if (r) r.status = m.params.response.status;
      }
    };
    ws.addEventListener('message', onMsg);
    if (reload) {
      // 页面重新加载才能捕获完整流量（否则只能看到监听之后的新请求）
      await cdp(ws, nextId(), 'Page.enable');
      await cdp(ws, nextId(), 'Page.reload', { ignoreCache: false }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, seconds * 1000));
    ws.removeEventListener('message', onMsg);
    return [...reqs.values()];
  });
}

/* ---------- 主流程 ---------- */
(async () => {
  if (cmd === 'wait') {
    const timeout = parseInt(argOf('--timeout', '240'), 10);
    await waitReady(timeout);
    console.log(`[OK] CDP 端点就绪: ${base}`);
    return;
  }

  const ts = await getTargets();

  if (cmd === 'list') {
    const m = urlSub ? matchTargets(ts, urlSub) : ts;
    for (const t of m) {
      const tag = /agent-browser-preview|webview/i.test(t.type + ' ' + t.url) ? ' [内置浏览器预览]' : '';
      console.log(`[${t.type}] #${t.id}  ${t.title || '(untitled)'}`);
      console.log(`    ${t.url}${tag}`);
    }
    console.log(`\n共 ${m.length} 个目标（总计 ${ts.length} 个）。`);
    return;
  }

  if (cmd === 'eval') {
    const [t] = matchTargets(ts, urlSub);
    const out = await withTarget(t, async (ws, nextId) => {
      const r = await cdp(ws, nextId(), 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: has('--await'),
        userGesture: true,
      });
      if (r.exceptionDetails) throw new Error('页面异常: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
      return r.result;
    });
    console.log('[eval 结果] ' + JSON.stringify(out.value ?? out, null, 2));
    return;
  }

  if (cmd === 'nav') {
    if (!toUrl) die('nav 需要 --to <url>');
    const [t] = matchTargets(ts, urlSub);
    await withTarget(t, async (ws, nextId) => {
      await cdp(ws, nextId(), 'Page.enable');
      const loaded = new Promise((res) => {
        const onMsg = (ev) => {
          if (JSON.parse(ev.data).method === 'Page.loadEventFired') { ws.removeEventListener('message', onMsg); res(); }
        };
        ws.addEventListener('message', onMsg);
        setTimeout(res, 20000);
      });
      await cdp(ws, nextId(), 'Page.navigate', { url: toUrl });
      await loaded;
    });
    console.log('[nav 完成] ' + toUrl);
    return;
  }

  if (cmd === 'net') {
    const seconds = parseInt(argOf('--seconds', '6'), 10);
    const reload = !has('--no-reload');
    const [t] = matchTargets(ts, urlSub);
    console.log(`[*] 监听网络 ${seconds}s（${reload ? '自动刷新页面以捕获完整流量，' : ''}结束后输出）...`);
    const reqs = await captureNetwork(t, seconds, reload);
    console.log(`[*] 捕获 ${reqs.length} 个请求：`);
    for (const r of reqs.slice(0, 60)) {
      console.log(`  [${String(r.status || '...').padEnd(3)}] ${r.method.padEnd(5)} ${r.url.slice(0, 110)}`);
    }
    if (reqs.length > 60) console.log(`  ... 其余 ${reqs.length - 60} 条省略`);
    return;
  }

  if (cmd === 'shot') {
    const [t] = matchTargets(ts, urlSub);
    const png = await withTarget(t, async (ws, nextId) => {
      await cdp(ws, nextId(), 'Page.enable');
      const r = await cdp(ws, nextId(), 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      return Buffer.from(r.data, 'base64');
    });
    const out = argOf('--out', `wb-shot-${Date.now()}.png`);
    fs.writeFileSync(out, png);
    console.log(`[OK] 截图已保存: ${out}（${(png.length / 1024).toFixed(0)} KB）`);
    return;
  }

  if (cmd === 'devtools') {
    const [t] = matchTargets(ts, urlSub);
    // 正确方式：Chromium 的调试 HTTP 服务自带 DevTools 前端页面，
    // 用默认浏览器打开即可获得完整 DevTools（勿用 Target.createTarget，会挂起 webview）。
    let url = t.devToolsFrontendUrl || '';
    if (url && !url.startsWith('http')) url = base + url;
    if (!url) die('该目标没有 DevTools 前端地址');
    console.log('[DevTools 页面] ' + url);
    console.log('[目标列表页  ] ' + base + '/json');
    if (has('--open')) {
      try { execSync(process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`, { stdio: 'ignore', shell: true }); console.log('[OK] 已在默认浏览器打开'); } catch {}
    } else {
      console.log('（加 --open 自动在默认浏览器打开；需用 Chrome/Edge 打开）');
    }
    return;
  }

  die(`未知命令: ${cmd}（可用: wait / list / eval / nav / net / shot / devtools）`);
})();
