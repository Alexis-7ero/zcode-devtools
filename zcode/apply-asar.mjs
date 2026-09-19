/*
 * macOS asar 规则引擎式变换器（跨平台自适应，不依赖具体 chunk 文件名）
 * ------------------------------------------------
 * 用法：node apply-asar.mjs <app.asar路径> <rules.cjs路径> <工作目录>
 *
 * 流程：解包 asar → 遍历 out 目录下全部 .js 应用 rules.cjs 变换 → 校验关键命中 → 重打包 → 替换
 * 规则未命中的文件原样保留；关键锚点未命中则整体失败退出，不写入任何文件。
 * 原生模块（node/dll/exe/dylib）保持 unpacked 语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let [, , asarPath, rulesPath, workDir] = process.argv;
if (!asarPath || !rulesPath || !workDir) {
  if (/[.]original([.][a-z0-9]+)?$/i.test(asarPath)) {
    console.error('[x] 拒绝执行：目标路径是备份文件（*.original）。请指向实际安装的 app.asar。');
    process.exit(2);
  }
  console.error('用法: node apply-asar.mjs <app.asar> <rules.cjs> <工作目录>');
  process.exit(2);
}
// 工作目录统一转绝对：pack 阶段以 workDir 为子进程 cwd，相对路径会被翻倍解析
workDir = path.resolve(workDir);

const { transform } = await import(pathToFileURL(path.resolve(rulesPath)).href);

// 进度打点：TTY 时画进度条，重定向时打 PROGRESS 行（供菜单读取）
const STAGES = { extract: [5, 35], rules: [38, 48], npm: [50, 62], pack: [64, 90], replace: [93, 99] };
function PROGRESS(stage, label) {
  const [from, to] = STAGES[stage] || [0, 100];
  const cur = stage === 'done' ? 100 : from;
  if (process.stdout.isTTY) {
    process.stdout.write('\r[' + '#'.repeat(Math.round(cur / 5)).padEnd(20, '-') + '] ' + String(cur).padStart(3) + '%  ' + (label || ''));
  } else {
    console.log('PROGRESS ' + cur + ' ' + (label || ''));
  }
}

// 哨兵：变换成功的判定标记
const SENTINELS = {
  mainExecutor: 'r.method==="cdp")return await this.executeCdp',
  cdpSchema: 'literal("cdp")',
  enumTail: '"close","list","cdp"])',
};

function npmCliJs() {
  if (process.platform !== 'win32') return null;
  const cand = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(cand) ? cand : null;
}
// 统一经 process.execPath 执行 Node 工具脚本，规避 .cmd shim 的 CVE 限制与空格路径问题
function runNode(jsFile, args) {
  execFileSync(process.execPath, [jsFile, ...args], { stdio: 'inherit' });
}
function installAsar(dir) {
  const cli = npmCliJs();
  // 锁 4.x：打包走 CLI（bin/asar.mjs）+ 相对路径，WorkBuddy 5.5.6 构建实测的组合。
  // API createPackageWithOptions 在 Windows 绝对路径 src 下 glob 判定失效（.unpacked 产出为 0）
  const args = ['install', '--prefix', dir, '@electron/asar@^4.3.0', '--no-audit', '--no-fund', '--loglevel=error'];
  if (cli) runNode(cli, args);
  else execFileSync('npm', args, { stdio: 'inherit' });
}
function asarBin(dir) {
  // 3.x 的 CLI 是 bin/asar.js，4.x 改名 bin/asar.mjs —— 两者都探测
  for (const name of ['asar.js', 'asar.mjs']) {
    const p = path.join(dir, 'node_modules', '@electron', 'asar', 'bin', name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('asar CLI 未找到: ' + path.join(dir, 'node_modules', '@electron', 'asar', 'bin'));
}

const X = path.join(workDir, 'extracted');
const PACKED = path.join(workDir, 'app.asar.new');
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

async function main(){
// unpacked 原生文件目录（mac: 同级 app.asar.unpacked；缺失则跳过——只影响原生模块解析）
const unpackedSibling = asarPath + '.unpacked';
if (fs.existsSync(unpackedSibling)) {
  try {
    fs.symlinkSync(unpackedSibling, path.join(workDir, 'app.asar.unpacked'), 'dir');
    console.log('[*] 已链接 app.asar.unpacked');
  } catch (_) {}
}

PROGRESS('extract','解包中');
console.log('[*] 解包 asar ...');
installAsar(workDir);
try {
  runNode(asarBin(workDir), ['extract', asarPath, X]);
} catch (e) {
  if (!fs.existsSync(path.join(X, 'out', 'main', 'index.js'))) {
    console.error('[!] asar 解包失败且 JS 未解出：' + e.message);
    process.exit(3);
  }
  console.log('[!] 解包部分文件报错（unpacked 原生二进制缺失，不影响 JS 变换）');
}
const mainIdx = path.join(X, 'out', 'main', 'index.js');
if (!fs.existsSync(mainIdx)) {
  console.error('[!] asar 解包失败（out/main/index.js 不存在）');
  process.exit(3);
}

// 已打补丁 → 不允许直接重刷（重刷会在旧分支后叠加新分支），必须先卸载还原
if (fs.readFileSync(mainIdx, 'utf8').includes(SENTINELS.mainExecutor)) {
  console.error('[!] 目标 app.asar 已是补丁状态。请先执行卸载（Remove / 菜单[3]）还原原版，再重新安装。');
  process.exit(4);
}

console.log('[*] 遍历 out/**/*.js 应用规则 ...');
let filesChanged = 0;
let sawMainExecutor = false;
const cdpSchemaFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.js')) continue;
    const before = fs.readFileSync(p, 'utf8');
    let after;
    try {
      after = transform(before, p);
    } catch (e) {
      console.error(`[!] 变换异常 ${p}: ${e.message}（按原文保留）`);
      continue;
    }
    if (after === before) continue;
    fs.writeFileSync(p, after);
    filesChanged++;
    if (after.includes(SENTINELS.mainExecutor)) sawMainExecutor = true;
    if (after.includes(SENTINELS.cdpSchema)) cdpSchemaFiles.push(path.relative(X, p));
  }
}
walk(path.join(X, 'out'));

console.log(`[*] 变更文件 ${filesChanged} 个`);
console.log(`[*] 含 cdp schema 的文件: ${cdpSchemaFiles.join(', ') || '(无)'}`);

// 关键命中校验：分发器必须注入；schema 至少 2 份（3.9.2 win 实测 3 份：main/host/scheduler）
let fatal = '';
if (!sawMainExecutor) fatal += 'main 执行器锚点未命中（构建差异？）；';
if (cdpSchemaFiles.length === 0) fatal += '未找到任何 cdp schema 注入点；';
else if (cdpSchemaFiles.length < 2) console.warn('[!] cdp schema 仅命中 1 份（预期 ≥2），继续但请留意');
if (fatal) {
  console.error('[!] ' + fatal + ' 已中止，未写入任何文件。请将本输出发给维护者。');
  process.exit(3);
}

PROGRESS('npm','准备打包依赖');
console.log('[*] 重新打包（原生模块保持 unpacked）...');
// unpack glob 必须含双星前缀目录项（cli/native/node_modules/resources）：
// 3.12.3+ 构建的 unpacked 文件分布在这些目录下，只按扩展名匹配会丢 unpacked 文件 → 启动崩溃
fs.writeFileSync(path.join(workDir, 'pack.cjs'), `
const { createPackageWithOptions } = require("@electron/asar");
createPackageWithOptions(process.argv[2], process.argv[3], {
  unpack: "{**/cli/**,**/native/**,**/node_modules/**,**/resources/**,**/*.node,**/*.dll,**/*.exe,**/*.dylib,**/ffi/**}"
}).then(() => console.log("pack ok"))
  .catch((e) => { console.error(e); process.exit(1); });
`);
try {
  installAsar(workDir);
} catch (e) {
  console.error('[!] npm 安装 @electron/asar 失败（需要 Node.js + npm）: ' + e.message);
  process.exit(3);
}
PROGRESS('pack','重新打包中');
// 打包走 CLI + 相对路径（cwd=workDir）：Windows 绝对路径下 asar API 的 glob 判定不可靠。
// unpack 只按二进制扩展名收窄：3.14.0 原版 unpacked 恰为 12 个二进制（node-pty/ssh2），
// 目录型宽 glob（如 **/node_modules/**）在 minimatch 10 下会把整个 node_modules 都 unpack 出去
execFileSync(process.execPath, [
  asarBin(workDir), 'pack',
  'extracted', 'app.asar.new',
  '--unpack', '{**/*.node,**/*.dll,**/*.exe,**/*.dylib,**/*.so,**/*.wasm,**/ffi/**}',
], { cwd: workDir, stdio: 'inherit' });
if (!fs.existsSync(PACKED) || fs.statSync(PACKED).size < 200 * 1024 * 1024) {
  console.error('[!] 打包产物异常（<200MB），中止替换');
  process.exit(3);
}

// unpacked 覆盖安全闸门：重打包后 unpacked 文件数不得低于原版的 98%（丢文件 → 启动崩溃）
const NEW_UNPACKED = PACKED + '.unpacked';
function countFiles(dir) {
  let n = 0;
  (function w(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) w(f); else n++;
    }
  })(dir);
  return n;
}
if (fs.existsSync(unpackedSibling)) {
  const before = countFiles(unpackedSibling);
  const after = fs.existsSync(NEW_UNPACKED) ? countFiles(NEW_UNPACKED) : 0;
  console.log(`[*] unpacked 文件数：原版 ${before} → 新包 ${after}`);
  if (after < Math.floor(before * 0.98)) {
    console.error('[!] 安全闸门：新包 unpacked 文件缺失（打包 glob 与构建不匹配？），中止替换，未写入任何文件');
    process.exit(3);
  }
}

PROGRESS('replace','替换目标文件');
fs.copyFileSync(PACKED, asarPath);
console.log(`[OK] 已替换 ${asarPath}（变更 ${filesChanged} 个 JS）`);

// 同步 unpacked 目录：与安装处现存内容一致则不动；有差异则整体替换
const instUnpacked = asarPath + '.unpacked';
if (fs.existsSync(NEW_UNPACKED) && fs.existsSync(instUnpacked)) {
  function listRel(base) {
    const m = new Map();
    (function w(p) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) w(f);
        else m.set(path.relative(base, f).split(path.sep).join('/'), fs.statSync(f).size);
      }
    })(base);
    return m;
  }
  const a = listRel(instUnpacked), b = listRel(NEW_UNPACKED);
  let same = a.size === b.size;
  if (same) for (const [k, v] of a) { if (b.get(k) !== v) { same = false; break; } }
  if (same) {
    console.log('[OK] unpacked 目录与安装处一致，无需变更');
  } else {
    console.log('[*] unpacked 目录有差异，同步到安装处 ...');
    fs.rmSync(instUnpacked, { recursive: true, force: true });
    fs.cpSync(NEW_UNPACKED, instUnpacked, { recursive: true });
    console.log('[OK] unpacked 目录已同步');
  }
}

}
main().catch(e=>{console.error(e);process.exit(1);});
