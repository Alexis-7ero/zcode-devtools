/*
 * [macos/cdp-patch.sh 与 cdp-hook 方案共用本规则的副本；修改时请同步 cdp-hook/rules.cjs]
 * 补丁规则单一来源：供 CJS 钩子(hook.js)与 ESM loader(loader.mjs) 共用。
 * 变换语义与 payload/ 静态补丁逐字一致；未命中特征串的模块原样直通。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function makeLogger() {
  return function log(msg) {
    if (!process.env.CDP_HOOK_DEBUG) return;
    try {
      fs.appendFileSync(path.join(process.env.TEMP || '.', 'cdp-hook.log'),
        new Date().toISOString() + ' ' + msg + '\n');
    } catch (_) {}
  };
}

function buildRules() {
  const log = makeLogger();

  const CDP_BRANCH =
    'if(o.tabId=i.tabId,this.refreshRuntimeProtection(i.tabId),r.method==="cdp")return await this.executeCdp(t,r,i,o,n);';
  function buildExecuteCdp(safe, stamp) {
    const tapArrow = '(f,h,m)=>{let g=this.cdpEventBuffers.get(d);g&&(g.push({method:h,params:m}),g.length>5e3&&g.splice(0,g.length-5e3))}';
    const taphandler = stamp ? stamp + '(' + tapArrow + ',"cdpTap")' : tapArrow;
    const tpl = (
    'async executeCdp(t,r,i,o,n){let a=await this.ensureGuest(i,o.controller.signal);' +
    'if(!a||__SAFE__(()=>a.isDestroyed(),!0))return this.withMeta({ok:!1,error:{code:"backend_unavailable",message:"browser guest unavailable for cdp"},elapsedMs:Date.now()-n},t,i);' +
    'try{a.debugger.isAttached()||a.debugger.attach("1.3")}catch{}i.cdpAttached=a.debugger.isAttached(),this.cdpEventBuffers??(this.cdpEventBuffers=new Map());' +
    'if(!this.cdpEventBuffers.has(i.tabId)){let d=i.tabId,c=__TAPHANDLER__;' +
    'a.debugger.on("message",c),this.cdpListeners??(this.cdpListeners=new Map()),this.cdpListeners.set(d,{guest:a,handler:c})}' +
    'let l=r.op??"send";try{if(l==="openDevTools")return typeof a.openDevTools=="function"&&a.openDevTools(),this.withMeta({ok:!0,value:{opened:!0},elapsedMs:Date.now()-n},t,i);' +
    'if(l==="events"){let d=this.cdpEventBuffers.get(i.tabId)??[],c=Math.min(r.limit??500,5e3),f=d.slice(-c);return r.clear===!0&&this.cdpEventBuffers.set(i.tabId,[]),' +
    'this.withMeta({ok:!0,value:{events:f,count:f.length,totalBuffered:d.length},elapsedMs:Date.now()-n},t,i)}' +
    'let d=r.cdpMethod;if(typeof d!="string"||d.length===0)return this.withMeta({ok:!1,error:{code:"invalid_request",message:"cdp send requires cdpMethod"},sideEffect:"none",elapsedMs:Date.now()-n},t,i);' +
    'let f=r.params??{};if(f===null||typeof f!="object"||Array.isArray(f))return this.withMeta({ok:!1,error:{code:"invalid_request",message:"cdp params must be an object"},sideEffect:"none",elapsedMs:Date.now()-n},t,i);' +
    'd==="Debugger.enable"&&Promise.race([a.debugger.sendCommand("Debugger.setSkipAllPauses",{skip:!1}),new Promise((h,m)=>setTimeout(()=>m(new Error("setSkipAllPauses timeout")),3e3))]).catch(()=>{});' +
    'let m=await this.sendGuestCdpCommand(i,a,d,f);return this.withMeta({ok:!0,value:m??null,elapsedMs:Date.now()-n},t,i)}' +
    'catch(c){return this.withMeta({ok:!1,error:{code:"execution_error",message:c instanceof Error?c.message:String(c)},elapsedMs:Date.now()-n},t,i)}}recordingNow(){');
    return tpl
      .split('__SAFE__').join(safe)
      .split('__TAPHANDLER__').join(taphandler);
  }

  function zodCdpObj(z) {
    return z + '.object({method:' + z + '.literal("cdp"),tabId:' + z + '.string().min(1).optional(),op:' + z + '.enum(["send","events","openDevTools"]).optional(),' +
      'cdpMethod:' + z + '.string().min(1).optional(),params:' + z + '.unknown().optional(),clear:' + z + '.boolean().optional(),' +
      'limit:' + z + '.number().int().nonnegative().max(5e3).optional()}).strict()';
  }

  const ESCAPE_GETTER = [
    '  /** [cdp-patch] 不走 wrapObject/hideUnknown：CdpAPI 不在出厂 api.json 白名单，包一层方法会变成 undefined */',
    '  get cdp() {',
    '    const self = this;',
    '    const runCdp = (payload) => self.run({ method: "cdp", ...payload });',
    '    return {',
    '      async send(method2, params = {}) {',
    '        const command = { method: "cdp", op: "send", cdpMethod: method2, params };',
    '        return expectOk(command, await runCdp(command)).value ?? null;',
    '      },',
    '      async events(options = {}) {',
    '        const command = { method: "cdp", op: "events" };',
    '        const payload = {',
    '          ...(options.clear !== void 0 ? { clear: options.clear } : {}),',
    '          ...(options.limit !== void 0 ? { limit: options.limit } : {})',
    '        };',
    '        return (expectOk(command, await runCdp({ op: "events", ...payload })).value) ?? { events: [], count: 0, totalBuffered: 0 };',
    '      },',
    '      async enableDebugger() {',
    '        await self.cdp.send("Debugger.enable", {});',
    '        try { await self.cdp.send("Debugger.setSkipAllPauses", { skip: false }); } catch {}',
    '        return true;',
    '      },',
    '      async evaluate(expression, options = {}) {',
    '        return self.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, includeCommandLineAPI: true, ...options });',
    '      },',
    '      async getCallStack() {',
    '        const { events } = await self.cdp.events({ clear: false, limit: 500 });',
    '        for (let i = events.length - 1; i >= 0; i -= 1) {',
    '          if (events[i].method === "Debugger.paused") return events[i].params;',
    '        }',
    '        return null;',
    '      },',
    '      async resume() { return self.cdp.send("Debugger.resume", {}); },',
    '      async pause() { return self.cdp.send("Debugger.pause", {}); },',
    '      async setBreakpointByUrl(options) { return self.cdp.send("Debugger.setBreakpointByUrl", options); },',
    '      async removeBreakpoint(breakpointId) { return self.cdp.send("Debugger.removeBreakpoint", breakpointId); },',
    '      async networkEnable() { return self.cdp.send("Network.enable", {}); },',
    '      async runtimeEnable() { return self.cdp.send("Runtime.enable", {}); },',
    '      async openDevTools() {',
    '        const command = { method: "cdp", op: "openDevTools" };',
    '        return (expectOk(command, await runCdp({ op: "openDevTools" })).value) ?? { opened: true };',
    '      }',
    '    };',
    '  }',
    '  /** [cdp-patch] 打开当前标签页的 DevTools 面板 */',
    '  async openDevTools() {',
    '    const command = { method: "cdp", op: "openDevTools" };',
    '    return (expectOk(command, await this.run(command)).value) ?? { opened: true };',
    '  }'
  ].join('\n');

  EXEC_BUILDER = buildExecuteCdp;
  return [
    {
      name: 'main-executor',            // asar out/main/index.js（混淆助手名按目标构建动态探测）
      dynamic: "main-executor",
      marker: ',r.method==="recordingStart"){',
    },
    {
      name: 'schema-union-generic',           // main chunk / host chunk / scheduler 三处 schema union（zod 别名自适应）
      doneIf: 'literal("cdp")',
      marker: '.strict()]);',
      reps: [
        {
          re: /([A-Za-z_$][\w$]*)\.object\(\{method:\1\.literal\("list"\)\}\)\.strict\(\)\]\)/g,
          fn: function (m0, z) { return m0.slice(0, -2) + ',' + zodCdpObj(z) + '])'; }
        }
      ]
    },
    {
      name: 'method-enum-tail',
      doneIf: "\"list\",\"cdp\"])",               // 方法枚举白名单（chunk 与 broker 共用同形数组）
      marker: '"cancelRequest","close","list"])',
      reps: [
        { from: '"cancelRequest","close","list"])', to: '"cancelRequest","close","list","cdp"])' }
      ]
    },
    {
      name: 'plugin-tab-class',
      doneIf: "get cdp()",               // browser-use 插件 browser-client.mjs（未压缩格式化代码）
      marker: 'get dom_cua() {',
      reps: [
        {
          from: 'keypress: ({ keys }) => this.action({ method: "cuaKeypress", keys })\n    }, "DomCUAAPI");\n  }\n};\nvar BrowserTabs = class {',
          to: 'keypress: ({ keys }) => this.action({ method: "cuaKeypress", keys })\n    }, "DomCUAAPI");\n  }\n' + ESCAPE_GETTER + '\n};\nvar BrowserTabs = class {'
        }
      ]
    }
  ];
}

let EXEC_BUILDER = null;
const RULES = buildRules();
const LOG = makeLogger();

// 从目标构建里探测混淆后的助手函数名（不同版本构建的 mangle 结果不同）
function detectHelpers(content) {
  let safe = 'it';
  const m = content.match(/(\w+)\(\(\)=>[A-Za-z_$][\w$]*\.isDestroyed\(\),!0\)/);
  if (m) safe = m[1];
  // 命名戳助手：形如 X(标识符,"短横线名") 的调用，出现频次最高的短名
  const names = [...content.matchAll(/[^\w$](\w{1,3})\(\w+,"[a-zA-Z-]{4,}"\)/g)].map(x => x[1]);
  const freq = {};
  names.forEach(n => (freq[n] = (freq[n] || 0) + 1));
  const stamp = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || '';
  return { safe, stamp };
}

/** 对源码做内存变换；未命中任何规则的输入原样返回 */
function transform(content, filename) {
  if (typeof content !== 'string' || content.length < 65536) return content;
  const base = path.basename(String(filename || '')).toLowerCase();
  if (base === 'hook.js' || base === 'hook.cjs' || base === 'rules.cjs' || base === 'loader.mjs' || base === 'bootstrap.mjs') return content;
  let out = content;
  for (let ri = 0; ri < RULES.length; ri++) {
    const rule = RULES[ri];
    if (rule.doneIf && out.includes(rule.doneIf)) continue;
    if (!out.includes(rule.marker)) continue;

    if (rule.dynamic === 'main-executor') {
      // 混淆助手名动态探测后构建替换文本
      const { safe, stamp } = detectHelpers(out);
      const branchTo =
        'if(o.tabId=i.tabId,this.refreshRuntimeProtection(i.tabId),r.method==="cdp")return await this.executeCdp(t,r,i,o,n);' +
        'if(o.tabId=i.tabId,this.refreshRuntimeProtection(i.tabId),r.method==="recordingStart"){';
      const execTo = EXEC_BUILDER(safe, stamp);
      out = out.split(
        'if(o.tabId=i.tabId,this.refreshRuntimeProtection(i.tabId),r.method==="recordingStart"){'
      ).join(branchTo);
      out = out.split('recordingNow(){').join(execTo);
      LOG('[transform] main-executor (safe=' + safe + ', stamp=' + (stamp || 'none') + ') <- ' + filename);
      continue;
    }

    for (const rep of rule.reps) {
      if (rep.re) out = out.replace(rep.re, rep.fn);
      else if (out.includes(rep.from)) out = out.split(rep.from).join(rep.to);
    }
    LOG('[transform] ' + rule.name + ' <- ' + filename);
  }
  return out;
}

module.exports = { transform, RULES };
