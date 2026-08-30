/*
 * ZCode 3.9.2 CDP 外置补丁 - CJS 通道钩子
 * 由 NODE_OPTIONS --require 加载；拦截 require 图中的模块编译。
 * ESM 通道见 loader.mjs（经 bootstrap.mjs 注册）。
 * 规则单一来源在 rules.cjs。不修改任何磁盘文件。
 */
(function () {
  'use strict';
  try {
    if (process.env.ZCODE_CDP_HOOK_LOADED) return;
    process.env.ZCODE_CDP_HOOK_LOADED = '1';

    const Module = require('module');
    const { transform } = require('./rules.cjs');
    const origCompile = Module.prototype._compile;

    Module.prototype._compile = function (content, filename) {
      if (!process.env.CDP_HOOK_NOOP) {
        try { content = transform(content, filename); }
        catch (_) { /* 变换失败按原文编译 */ }
      }
      return origCompile.call(this, content, filename);
    };

    if (process.env.CDP_HOOK_DEBUG) {
      try {
        const fs = require('fs');
        fs.appendFileSync(require('path').join(process.env.TEMP || '.', 'cdp-hook.log'),
          new Date().toISOString() + ` [cjs-loaded] pid=${process.pid}\n`);
      } catch (_) {}
    }

    globalThis.__CDP_HOOK_TEST__ = { transform };
  } catch (_e) {
    /* 绝不让宿主进程因钩子失败而崩溃 */
  }
})();
