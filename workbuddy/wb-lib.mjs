// WorkBuddy CDP 共享库（wb-cdp.mjs / wb-mcp.mjs 共用）
// 前提：WorkBuddy 以 CDP 模式运行（WORKBUDDY_REMOTE_DEBUGGING_PORT，默认 9222）

export const port = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || '9222';
export const base = `http://127.0.0.1:${port}`;

export async function getTargets() {
  let r;
  try {
    r = await fetch(`${base}/json/list`);
  } catch {
    throw new Error(
      `无法连接 ${base} —— WorkBuddy 未以 CDP 模式运行（先用 wb-start.cmd 启动，或设置 WORKBUDDY_REMOTE_DEBUGGING_PORT）`,
    );
  }
  if (!r.ok) throw new Error(`/json/list 返回 ${r.status}`);
  return r.json();
}

export function matchTargets(ts, urlSub) {
  const m = ts.filter(
    (t) =>
      ['page', 'webview', 'iframe', 'app'].includes(t.type) &&
      (!urlSub || (t.url + ' ' + (t.title || '')).toLowerCase().includes(String(urlSub).toLowerCase())),
  );
  return m;
}

export function matchOrReport(ts, urlSub) {
  const m = matchTargets(ts, urlSub);
  if (m.length === 0) {
    const lines = ts.map((t) => `    [${t.type}] ${t.title || '(untitled)'}  ${t.url}`);
    throw new Error('没有匹配目标。全部目标：\n' + lines.join('\n'));
  }
  return m;
}

export function cdp(ws, id, method, params) {
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

export async function withTarget(t, fn) {
  if (!t.webSocketDebuggerUrl) throw new Error('该目标没有 webSocketDebuggerUrl（可能已关闭）');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  try {
    let id = 0;
    await cdp(ws, ++id, 'Runtime.enable');
    return await fn(ws, (n = 1) => ++id);
  } finally {
    try { ws.close(); } catch {}
  }
}

// 等待 CDP 端点就绪；onTick(elapsedSec, pct) 用于绘制进度条
export async function waitReady(timeoutSec = 240, onTick) {
  const t0 = Date.now();
  for (;;) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    let ok = false;
    try {
      const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(3000) });
      ok = r.ok;
    } catch {}
    if (ok) {
      onTick?.(elapsed, 100, true);
      return elapsed;
    }
    if (onTick) onTick(elapsed, Math.min(99, Math.round((elapsed / timeoutSec) * 100)), false);
    if (elapsed >= timeoutSec) throw new Error(`等待超时（${timeoutSec}s）：CDP 端点未就绪`);
    await new Promise((r2) => setTimeout(r2, 1000));
  }
}

// 网络监听：enable Network → （可选 reload）→ 收集 seconds 秒 → 返回 {requests, responses}
export async function captureNetwork(t, seconds = 6, reload = true) {
  return withTarget(t, async (ws, nextId) => {
    const reqs = new Map();
    const done = [];
    await cdp(ws, nextId(), 'Network.enable');
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.requestWillBeSent') {
        reqs.set(m.params.requestId, {
          method: m.params.request.method,
          url: m.params.request.url,
          status: '',
        });
      } else if (m.method === 'Network.responseReceived') {
        const r = reqs.get(m.params.requestId);
        if (r) r.status = m.params.response.status;
      }
    };
    ws.addEventListener('message', onMsg);
    if (reload) await cdp(ws, nextId(), 'Page.reload', { ignoreCache: false }).catch(() => {});
    await new Promise((r) => setTimeout(r, seconds * 1000));
    ws.removeEventListener('message', onMsg);
    for (const v of reqs.values()) done.push(v);
    return { count: done.length, requests: done };
  });
}

// 截图
export async function captureShot(t) {
  return withTarget(t, async (ws, nextId) => {
    await cdp(ws, nextId(), 'Page.enable');
    const r = await cdp(ws, nextId(), 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    return Buffer.from(r.data, 'base64');
  });
}

// DevTools 前端 URL（由目标自带的 HTTP 服务托管，浏览器直接打开即可）
export function devtoolsUrl(t) {
  return t.devToolsFrontendUrl
    ? (t.devToolsFrontendUrl.startsWith('http') ? t.devToolsFrontendUrl : base + t.devToolsFrontendUrl)
    : `${base}/json`;
}
