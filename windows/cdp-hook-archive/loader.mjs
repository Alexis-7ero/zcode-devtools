/*
 * ZCode 3.9.2 CDP 外置补丁 - ESM 通道 loader
 * 由 bootstrap.mjs 经 node:module register() 注册，覆盖 import 图中的模块。
 * 规则单一来源在 rules.cjs（CJS require 的模块默认走 hook.js）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform } = require('./rules.cjs');

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (process.env.CDP_HOOK_NOOP) return { ...result, shortCircuit: true };
  try {
    if ((result.format === 'module' || result.format === 'commonjs') && typeof result.source === 'string') {
      const out = transform(result.source, decodeURIComponent(new URL(url).pathname));
      if (out !== result.source) {
        return { ...result, source: out, shortCircuit: true };
      }
    }
  } catch (_) { /* 变换失败按原文加载 */ }
  return { ...result, shortCircuit: true };
}
