#!/usr/bin/env node
/*
 * WorkBuddy 内置浏览器 CDP 客户端（零依赖，Node ≥ 22）
 * ------------------------------------------------
 * 前提：WorkBuddy 以 CDP 模式启动（环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT=端口，
 * 或直接运行 wb-start.cmd）。之后本工具即可列出/驱动其内置浏览器预览面板。
 *
 * 用法：
 *   node wb-cdp.mjs list                                  列出全部 CDP 目标
 *   node wb-cdp.mjs list --url baidu                      按关键字过滤目标
 *   node wb-cdp.mjs eval --url baidu --expr "1+1"         在匹配目标里执行 JS
 *   node wb-cdp.mjs eval --url baidu --expr "location.href" --await   --expr 为 Promise 时等待
 *   node wb-cdp.mjs nav  --url baidu --to "https://example.com"       目标页导航
 *
 * 供 WorkBuddy 的 agent 通过 shell 调用（等价于 ZCode 的 tab.cdp.* 能力）。
 */
const args = process.argv.slice(2);
const port = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || '9222';
const base = `http://127.0.0.1:${port}`;

function argOf(name, def = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
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
    return await fn(ws, id);
  } finally {
    try { ws.close(); } catch {}
  }
}

(async () => {
  const ts = await getTargets();

  if (cmd === 'list') {
    const m = urlSub ? matchTargets(ts, urlSub) : ts;
    for (const t of m) {
      const tag = /agent-browser-preview|webview/i.test(t.type + ' ' + t.url) ? ' [内置浏览器预览]' : '';
      console.log(`[${t.type}] #${t.id}  ${t.title || '(untitled)'}`);
      console.log(`    ${t.url}${tag}`);
    }
    console.log(`\n共 ${m.length} 个目标（总计 ${ts.length}）。`);
    return;
  }

  if (cmd === 'eval') {
    const [t] = matchTargets(ts, urlSub);
    const out = await withTarget(t, async (ws, id) => {
      const r = await cdp(ws, ++id, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: args.includes('--await'),
        userGesture: true,
      });
      if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
      return r.result;
    });
    console.log('[eval 结果] ' + JSON.stringify(out.value ?? out, null, 2));
    return;
  }

  if (cmd === 'nav') {
    if (!toUrl) die('nav 需要 --to <url>');
    const [t] = matchTargets(ts, urlSub);
    await withTarget(t, async (ws, id) => {
      await cdp(ws, ++id, 'Page.enable');
      const done = new Promise((res) => {
        const onMsg = (ev) => {
          if (JSON.parse(ev.data).method === 'Page.loadEventFired') {
            ws.removeEventListener('message', onMsg); res();
          }
        };
        ws.addEventListener('message', onMsg);
        setTimeout(res, 15000);
      });
      await cdp(ws, ++id, 'Page.navigate', { url: toUrl });
      await done;
    });
    console.log('[nav 完成] ' + toUrl);
    return;
  }

  die(`未知命令: ${cmd}（可用: list / eval / nav）`);
})();
