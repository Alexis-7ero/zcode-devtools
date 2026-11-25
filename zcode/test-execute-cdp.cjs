/*
 * test-execute-cdp.cjs — 注入代码的单元级运行时测试
 *
 * 目的：静态检查看不出「参数遮蔽模块级助手」这类问题（4.0 的命名戳助手就叫 i，
 * 与旧模板第三个参数 i 撞名 → 运行时 "i is not a function"）。
 * 本脚本从变换后的 main/index.js 里抠出注入的 executeCdp 方法，
 * 放进一个模拟宿主里真跑一遍，验证：
 *   1. 助手名与模板局部名不冲突（safe/stamp 用构建里的真实名字）
 *   2. op=send / events / openDevTools 三条路径都返回 ok
 *
 * 用法: node test-execute-cdp.cjs <变换后的 out/main/index.js> [safe名] [stamp名]
 *   不给 safe/stamp 时自动按 rules.cjs 的探测规则推断。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('用法: node test-execute-cdp.cjs <main/index.js> [safe] [stamp]'); process.exit(2); }
const src = fs.readFileSync(file, 'utf8');

if (!src.includes('async executeCdp(')) {
  console.error('[x] 目标文件里没有 executeCdp（未打补丁？）');
  process.exit(1);
}

// ---- 抽取注入的方法体 ----
function extractMethod(text, name) {
  const start = text.indexOf('async ' + name + '(');
  if (start < 0) return null;
  let i = text.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, j + 1); }
  }
  return null;
}
const methodSrc = extractMethod(src, 'executeCdp');
if (!methodSrc) { console.error('[x] 无法提取 executeCdp 方法'); process.exit(1); }

// ---- 探测助手名（与 rules.cjs 一致）----
function detectHelpers(content) {
  let safe = 'it';
  const m = content.match(/(\w+)\(\(\)=>[A-Za-z_$][\w$]*\.isDestroyed\(\),!0\)/);
  if (m) safe = m[1];
  const names = [...content.matchAll(/[^\w$](\w{1,3})\(\w+,"[a-zA-Z-]{4,}"\)/g)].map(x => x[1]);
  const freq = {};
  names.forEach(n => (freq[n] = (freq[n] || 0) + 1));
  const stamp = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || '';
  return { safe, stamp };
}
const detected = detectHelpers(src);
const safeName = process.argv[3] || detected.safe;
const stampName = process.argv[4] !== undefined ? process.argv[4] : detected.stamp;
console.log(`[i] safe 助手 = ${safeName} | stamp 助手 = ${stampName || '(none)'}`);

// ---- 模板局部名 vs 助手名：遮蔽检查 ----
const declared = new Set();
const pm = methodSrc.match(/async executeCdp\(([^)]*)\)/);
if (pm) pm[1].split(',').forEach(x => { const n = x.trim(); if (n) declared.add(n); });
for (const m of methodSrc.matchAll(/\b(?:let|const)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of methodSrc.matchAll(/\(([^()]*)\)\s*=>/g)) {
  m[1].split(',').forEach(x => { const n = x.trim(); if (n) declared.add(n); });
}
let shadow = null;
for (const h of [safeName, stampName]) {
  if (h && declared.has(h)) shadow = h;
}
if (shadow) {
  console.error(`[x] 模板声明了与助手同名的局部变量：${shadow} → 运行时会遮蔽助手`);
  process.exit(1);
}
console.log('[ok] 无遮蔽：模板局部名与助手名不冲突');

// ---- 构造模拟宿主 ----
const listeners = [];
const fakeGuest = {
  isDestroyed: () => false,
  openDevTools: () => { fakeGuest.devtoolsOpened = true; return true; },
  devtoolsOpened: false,
  debugger: {
    isAttached: () => true,
    attach: () => {},
    on: (ev, cb) => { listeners.push(cb); },
    sendCommand: async (method) => (method === 'Runtime.evaluate' ? { result: { value: 2 } } : {}),
  },
};

// 模块级助手（字面量定义，避免生成字符串时引入内层参数遮蔽）：
//   断言助手 Y(()=>expr, dflt)：expr 抛错时返回 dflt
//   命名助手 X(fn, "name")：返回包装函数，调用时转发参数
const helpers = {
  [safeName]: (fn, dflt) => { try { return fn(); } catch (e) { return dflt; } },
};
if (stampName) {
  helpers[stampName] = (fn, name) => (...args) => fn(...args);
}

const classBody = `
${methodSrc}
async ensureGuest(tab, signal) { return globalThis.__guest; }
async sendGuestCdpCommand(tab, guest, method, params, sessionId) {
  globalThis.__lastCall = { method, params, sessionId };
  return guest.debugger.sendCommand(method, params);
}
withMeta(res, ctx, tab) { return res; }
`;

// 组装：助手在模块作用域（与真实构建一致），方法在类里
const helperDecls = Object.keys(helpers).map(n =>
  n === safeName
    ? `function ${n}(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }`
    : `function ${n}(fn, name) { return function () { return fn.apply(null, arguments); }; }`
).join('\n');

const harness = `
${helperDecls}
class Harness {
${classBody}
}
globalThis.__Harness = Harness;
`;
try {
  new Function(harness)();
} catch (e) {
  console.error('[x] 模拟宿主构建失败: ' + e.message);
  process.exit(1);
}
globalThis.__guest = fakeGuest;
if (!globalThis.__guest) { console.error('[x] 模拟 guest 注入失败'); process.exit(1); }

const h = new globalThis.__Harness();
const ctx = { id: 'ctx' };
const tabRec = { tabId: 'tab-1', guest: fakeGuest };
const running = { controller: { signal: { aborted: false } }, tabId: 'tab-1' };

(async () => {
  let bad = 0;
  // 1) op=send
  const r1 = await h.executeCdp(ctx, { method: 'cdp', op: 'send', cdpMethod: 'Runtime.evaluate', params: { expression: '1+1' } }, tabRec, running, Date.now());
  const ok1 = r1 && r1.ok === true;
  console.log((ok1 ? '[ok] ' : '[x] ') + 'op=send → ok=' + (r1 && r1.ok) + ' value=' + JSON.stringify(r1 && r1.value));
  if (!ok1) bad++;

  // 2) op=events（缓冲为空应返回空数组，不应崩）
  const r2 = await h.executeCdp(ctx, { method: 'cdp', op: 'events', limit: 10 }, tabRec, running, Date.now());
  const ok2 = r2 && r2.ok === true && Array.isArray(r2.value.events);
  console.log((ok2 ? '[ok] ' : '[x] ') + 'op=events → ok=' + (r2 && r2.ok) + ' count=' + (r2 && r2.value && r2.value.count));
  if (!ok2) bad++;

  // 3) op=openDevTools
  const r3 = await h.executeCdp(ctx, { method: 'cdp', op: 'openDevTools' }, tabRec, running, Date.now());
  const ok3 = r3 && r3.ok === true && fakeGuest.devtoolsOpened === true;
  console.log((ok3 ? '[ok] ' : '[x] ') + 'op=openDevTools → ok=' + (r3 && r3.ok) + ' devtoolsOpened=' + fakeGuest.devtoolsOpened);
  if (!ok3) bad++;

  // 4) 缺 cdpMethod → invalid_request
  const r4 = await h.executeCdp(ctx, { method: 'cdp', op: 'send' }, tabRec, running, Date.now());
  const ok4 = r4 && r4.ok === false && r4.error && r4.error.code === 'invalid_request';
  console.log((ok4 ? '[ok] ' : '[x] ') + '缺 cdpMethod → ' + (r4 && r4.error && r4.error.code));
  if (!ok4) bad++;

  console.log(bad === 0 ? '[PASS] executeCdp 运行时测试通过' : '[FAIL] ' + bad + ' 项失败');
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('[x] 运行时异常: ' + e.message); process.exit(1); });
