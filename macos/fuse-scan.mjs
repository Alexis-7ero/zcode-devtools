/*
 * 跨平台 Electron fuses 检测器
 * 用法：node fuse-scan.mjs <Electron可执行文件路径>
 * macOS 二进制通常位于 /Applications/ZCode.app/Contents/MacOS/ZCode
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

let idx = buf.indexOf(SENTINEL);
let found = false;
while (idx !== -1) {
  found = true;
  console.log(`fuse wire @ 0x${idx.toString(16)}:`);
  for (let i = 0; i < NAMES.length; i++) {
    const b = buf[idx + SENTINEL.length + i];
    const state = b === 0x30 ? 'OFF' : b === 0x31 ? 'ON ' : `0x${b?.toString(16)}(默认)`;
    console.log(`  [${state}] ${NAMES[i]}`);
  }
  idx = buf.indexOf(SENTINEL, idx + 1);
}

const s = buf.toString('latin1');
const hasIntegrityManifest = s.includes('ElectronAsarIntegrity');
console.log(`\nasar 完整性清单嵌入: ${hasIntegrityManifest ? '是 —— 修改 asar 会被拒绝启动，本补丁不适用' : '否 —— asar 可自由修改'}`);
if (!found) console.log('未找到 fuse 线，可能为非 Electron 或加固二进制');
