/*
 * 就地变换工具：对目标文件应用 rules.cjs 规则引擎（幂等，doneIf 命中时原样写回）。
 * 独立成文件的原因：PowerShell 5.1 向原生进程传参时会吞掉内嵌双引号，
 * node -e "..." 内联脚本不可靠；macOS bash 单引号虽无此问题，也统一走本文件。
 * 用法: node transform-inplace.cjs <rules.cjs> <target-file>
 */
'use strict';
const path = require('path');
const fs = require('fs');
const [, , rulesPath, targetPath] = process.argv;
if (!rulesPath || !targetPath) {
  console.error('用法: node transform-inplace.cjs <rules.cjs> <target-file>');
  process.exit(2);
}
const { transform } = require(path.resolve(rulesPath));
const p = path.resolve(targetPath);
const s = fs.readFileSync(p, 'utf8');
const o = transform(s, p);
fs.writeFileSync(p, o);
console.log(o === s ? '[skip] already patched' : '[ok] transformed');
