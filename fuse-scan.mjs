#!/usr/bin/env node
/*
 * 跨平台 Electron fuses / asar 完整性检测
 * 用法：node fuse-scan.mjs <Electron可执行文件路径>
 *   Windows: ZCode.exe / WorkBuddy.exe
 *   macOS:   /Applications/ZCode.app/Contents/MacOS/ZCode
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

const file = process.argv[2];
if (!file) {
  console.error('用法: node fuse-scan.mjs <Electron可执行文件>');
  process.exit(2);
}
const buf = fs.readFileSync(file);
console.log(`== ${file} (${(buf.length / 1048576).toFixed(1)} MB)`);

// fuse wire v1: 哨兵(32B) + 版本(1B) + 数量(1B) + N 个状态字节（0x30=OFF, 0x31=ON）
let idx = buf.indexOf(SENTINEL);
let found = false;
let integrityFuseOn = null; // EnableEmbeddedAsarIntegrityValidation 的状态
let wireCount = 0;
while (idx !== -1) {
  found = true;
  const ver = buf[idx + SENTINEL.length];
  const cnt = buf[idx + SENTINEL.length + 1];
  const base = idx + SENTINEL.length + 2;
  console.log(`fuse wire @ 0x${idx.toString(16)} (v${ver}, ${cnt} fuses):`);
  for (let i = 0; i < Math.min(cnt, NAMES.length); i++) {
    const b = buf[base + i];
    const state = b === 0x30 ? 'OFF' : b === 0x31 ? 'ON ' : `0x${b?.toString(16)}(默认)`;
    if (NAMES[i] === 'EnableEmbeddedAsarIntegrityValidation') {
      integrityFuseOn = state.trim() === 'ON';
    }
    console.log(`  [${state}] ${NAMES[i] || 'fuse#' + i}`);
  }
  wireCount = cnt;
  idx = buf.indexOf(SENTINEL, idx + SENTINEL.length + 2 + cnt);
}
if (!found) console.log('未找到 fuse 线（可能非 Electron 或已加固）');

// asar 完整性清单检测（Windows: PE 资源名 UTF-16；macOS: plist 键 latin1）
const hasStr = (str) =>
  buf.includes(Buffer.from(str, 'latin1')) || buf.includes(Buffer.from(str, 'utf16le'));
const manifest = hasStr('ElectronAsarIntegrity') || hasStr('ELECTRONASAR');

// 真正的判定：fuse ON 才会执行校验；fuse OFF 时即使有清单也不拦截
const verdict =
  integrityFuseOn === false ? '否 —— 完整性校验 fuse 未启用，asar 可自由修改'
  : integrityFuseOn === true && manifest ? '是 —— 修改 asar 会被拒绝启动，文件补丁不适用'
  : integrityFuseOn === true ? '未发现清单（可能不校验，建议实测）'
  : '未知（未找到 fuse 线）';
console.log(`\nasar 完整性清单嵌入: ${manifest ? '是' : '否'}；校验 fuse: ${integrityFuseOn === null ? '?' : integrityFuseOn ? 'ON' : 'OFF'}`);
console.log(`结论: ${verdict}`);
