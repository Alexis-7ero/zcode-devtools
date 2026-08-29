#!/usr/bin/env node
/*
 * WorkBuddy 内置浏览器 CDP —— MCP stdio 服务器（零依赖，Node ≥ 22）
 * ------------------------------------------------
 * 注册进 CodeBuddy（WorkBuddy 内置 agent）后，agent 的工具列表原生出现：
 *   wb_list    列出内置浏览器 CDP 目标
 *   wb_eval    在预览面板执行 JS
 *   wb_nav     导航
 *   wb_net     网络监听
 *   wb_shot    整页截图
 *   wb_devtools 获取 DevTools 页面地址
 * 前提：WorkBuddy 以 CDP 模式运行（wb-start.cmd，或已设置
 * WORKBUDDY_REMOTE_DEBUGGING_PORT 环境变量）。
 */
import {
  getTargets, matchOrReport, cdp, withTarget, captureNetwork, captureShot, devtoolsUrl,
} from './wb-lib.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const urlSubOf = (a) => a?.url_kw || '';

const TOOLS = [
  {
    name: 'wb_list',
    description: '列出 WorkBuddy 内置浏览器的全部 CDP 目标（预览面板会标注）',
    inputSchema: { type: 'object', properties: { url_kw: { type: 'string', description: '按 URL/标题关键字过滤' } } },
  },
  {
    name: 'wb_eval',
    description: '在内置浏览器预览页执行 JavaScript 并返回结果',
    inputSchema: {
      type: 'object',
      required: ['expr'],
      properties: {
        url_kw: { type: 'string', description: '按 URL/标题关键字选择目标（如 baidu）' },
        expr: { type: 'string', description: '要执行的 JS 表达式' },
        await_promise: { type: 'boolean', description: '表达式返回 Promise 时等待完成' },
      },
    },
  },
  {
    name: 'wb_nav',
    description: '让内置浏览器预览页导航到指定 URL（等待加载完成）',
    inputSchema: {
      type: 'object',
      required: ['to'],
      properties: { url_kw: { type: 'string' }, to: { type: 'string', description: '目标 URL' } },
    },
  },
  {
    name: 'wb_net',
    description: '监听内置浏览器预览页的网络请求（自动刷新页面以捕获完整流量）',
    inputSchema: {
      type: 'object',
      properties: {
        url_kw: { type: 'string' },
        seconds: { type: 'number', description: '监听时长，默认 6 秒' },
      },
    },
  },
  {
    name: 'wb_shot',
    description: '对内置浏览器预览页整页截图，返回保存路径',
    inputSchema: { type: 'object', properties: { url_kw: { type: 'string' }, out: { type: 'string' } } },
  },
  {
    name: 'wb_devtools',
    description: '返回内置浏览器预览页的 DevTools 前端页面 URL（用 Chrome/Edge 打开即得完整 DevTools）',
    inputSchema: { type: 'object', properties: { url_kw: { type: 'string' } } },
  },
];

async function callTool(name, a = {}) {
  const ts = await getTargets();
  const kw = a.url_kw || '';
  switch (name) {
    case 'wb_list': {
      const m = kw ? matchOrReport(ts, kw) : ts;
      return m.map((t) => `[${t.type}] ${t.title || '(untitled)'}\n  ${t.url}`).join('\n');
    }
    case 'wb_eval': {
      const [t] = matchOrReport(ts, kw);
      const r = await withTarget(t, async (ws, nextId) => {
        const res = await cdp(ws, nextId(), 'Runtime.evaluate', {
          expression: a.expr || '1+1',
          returnByValue: true,
          awaitPromise: !!a.await_promise,
          userGesture: true,
        });
        if (res.exceptionDetails) throw new Error(String(res.exceptionDetails.exception?.description || res.exceptionDetails.text).slice(0, 400));
        return res.result;
      });
      return JSON.stringify(r.value ?? r);
    }
    case 'wb_nav': {
      if (!a.to) throw new Error('缺少 to');
      const [t] = matchOrReport(ts, kw);
      await withTarget(t, async (ws, nextId) => {
        await cdp(ws, nextId(), 'Page.enable');
        const loaded = new Promise((res) => {
          const onMsg = (ev) => {
            if (JSON.parse(ev.data).method === 'Page.loadEventFired') { ws.removeEventListener('message', onMsg); res(); }
          };
          ws.addEventListener('message', onMsg);
          setTimeout(res, 20000);
        });
        await cdp(ws, nextId(), 'Page.navigate', { url: a.to });
        await loaded;
      });
      return '已导航: ' + a.to;
    }
    case 'wb_net': {
      const [t] = matchOrReport(ts, kw);
      const { count, requests } = await captureNetwork(t, a.seconds || 6, true);
      return `捕获 ${count} 个请求：\n` +
        requests.slice(0, 60).map((r) => `[${String(r.status || '...').padEnd(3)}] ${r.method} ${r.url}`).join('\n');
    }
    case 'wb_shot': {
      const [t] = matchOrReport(ts, kw);
      const png = await captureShot(t);
      const out = a.out || `wb-shot-${Date.now()}.png`;
      fs.writeFileSync(out, png);
      return `截图已保存: ${out}（${(png.length / 1024).toFixed(0)} KB）`;
    }
    case 'wb_devtools': {
      const [t] = matchOrReport(ts, kw);
      const u = t.devToolsFrontendUrl
        ? (t.devToolsFrontendUrl.startsWith('http') ? t.devToolsFrontendUrl : `http://127.0.0.1:9222${t.devToolsFrontendUrl}`)
        : 'http://127.0.0.1:9222/json';
      return '用 Chrome/Edge 打开: ' + u;
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

function toText(result) {
  return { content: [{ type: 'text', text: String(result) }] };
}

// ---- stdio JSON-RPC ----
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.id) return; // notification
  let result;
  try {
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workbuddy-cdp', version: '1.0.0' },
      };
    } else if (msg.method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (msg.method === 'tools/call') {
      result = toText(await callTool(msg.params.name, msg.params.arguments || {}));
    } else {
      result = {};
    }
  } catch (e) {
    result = { content: [{ type: 'text', text: '错误: ' + (e?.message || e) }], isError: true };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
}
