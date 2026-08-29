#!/usr/bin/env node
/*
 * Electron fuse 翻转工具（与 fuse-scan.mjs 同一套 wire v1 解析）
 * 用法：node flip-fuse.mjs <exe> <fuse名或序号> <on|off> [输出文件]
 *   不给输出文件时默认写到 <exe>.flipped；传 -i 或 --in-place 才原地覆盖
 * 注意：翻转会使 Authenticode 签名失效（不影响本机运行）；应用自更新会还原 exe，需重跑
 */
import fs from 'node:fs';

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];

const [file, fuseArg, stateArg, outArg] = process.argv.slice(2);
const inPlace = outArg === '-i' || outArg === '--in-place';
if (!file || fuseArg == null || !/^(on|off)$/i.test(stateArg || '')) {
  console.error('用法: node flip-fuse.mjs <exe> <fuse名或序号> <on|off> [输出文件|-i]');
  process.exit(2);
}
let index = /^\d+$/.test(fuseArg) ? Number(fuseArg) : NAMES.indexOf(fuseArg);
if (index < 0 || index >= NAMES.length) {
  console.error(`未知 fuse: ${fuseArg}。可用: ${NAMES.map((n, i) => `${i}=${n}`).join(', ')}`);
  process.exit(2);
}
const target = stateArg.toLowerCase() === 'on' ? 0x31 : 0x30;

const buf = fs.readFileSync(file);
let idx = buf.indexOf(SENTINEL);
let hits = 0;
while (idx !== -1) {
  const ver = buf[idx + SENTINEL.length];
  const cnt = buf[idx + SENTINEL.length + 1];
  if (ver === 1 && cnt > index) {
    const at = idx + SENTINEL.length + 2 + index;
    const cur = buf[at];
    if (cur !== 0x30 && cur !== 0x31) {
      console.error(`fuse 字节异常: 0x${cur.toString(16)}（非 ON/OFF，疑似非标准构建）`);
      process.exit(1);
    }
    buf[at] = target;
    hits++;
    console.log(`wire@0x${idx.toString(16)}: ${NAMES[index]} ${cur === 0x31 ? 'ON' : 'OFF'} -> ${stateArg.toUpperCase()}`);
  }
  idx = buf.indexOf(SENTINEL, idx + SENTINEL.length + 2 + cnt);
}
if (!hits) {
  console.error('未找到可翻转的 fuse wire（版本不符或序号越界）');
  process.exit(1);
}
const out = inPlace ? file : (outArg || `${file}.flipped`);
fs.writeFileSync(out, buf);
console.log(`[OK] 已写出: ${out}（共翻转 ${hits} 处）`);
