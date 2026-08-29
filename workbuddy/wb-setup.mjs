#!/usr/bin/env node
/*
 * WorkBuddy 深度集成：安装 / 卸载 / 状态
 * 用法：node wb-setup.mjs install|remove|status
 *
 * install（全部用户级，无需管理员）：
 *   1) setx WORKBUDDY_REMOTE_DEBUGGING_PORT=9222 —— WorkBuddy 官方 CDP 开关，每次启动自动生效
 *   2) 注册 MCP 服务器（~/.codebuddy.json 的 mcpServers.workbuddy-cdp → 本目录 wb-mcp.mjs）
 *      WorkBuddy 的 agent 工具列表将原生出现 wb_list/wb_eval/wb_nav/wb_net/wb_shot/wb_devtools
 *   3) 追加全局记忆 ~/.codebuddy/CODEBUDDY.md（告诉 agent 何时使用这些工具）
 *   4) 重启 WorkBuddy 立即生效
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

const action = process.argv[2] || 'status';
const HOME = process.env.USERPROFILE || process.env.HOME;
const CFG = path.join(HOME, '.codebuddy.json');
const MEM = path.join(HOME, '.codebuddy', 'CODEBUDDY.md');
const HERE_DIR = path.dirname(path.resolve(process.argv[1]));
const MCP_SERVER_ABS = path.join(HERE_DIR, 'wb-mcp.mjs');
const PORT = '9222';

const MEMORY_MARK = 'wb-cdp.mjs';
const MEMORY_BLOCK = `

# WorkBuddy 内置浏览器调试（wb-cdp.mjs 工具）
当需要操作或调试内置浏览器预览面板（打开网页、执行 JS、读取 DOM、抓网络请求、截图、DevTools）时，直接调用你的 wb_list / wb_eval / wb_nav / wb_net / wb_shot / wb_devtools 工具（workbuddy-cdp MCP 服务器提供）。
- wb_eval 的 url_kw 传页面关键字（如 baidu），expr 传 JS 表达式。
- 若工具调用报连接失败：WorkBuddy 未以 CDP 模式运行，提示用户双击 workbuddy/wb-setup.cmd 重新安装。
- 打开新网页预览后先 wb_list 确认目标，再 eval/nav。
`;

const log = (m) => console.log(m);

function findWorkBuddyExe() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path"`,
      { encoding: 'utf8' },
    ).trim();
    if (out) return out;
  } catch {}
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -imatch '^WorkBuddy' } | Select-Object -First 1).DisplayIcon"`,
      { encoding: 'utf8' },
    ).trim();
    if (out) return out.split(',')[0];
  } catch {}
  for (const c of [
    'E:\\WorkBuddy\\WorkBuddy.exe',
    'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function userEnvVar(name) {
  try {
    return execSync(
      `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}','User')"`,
      { encoding: 'utf8' },
    ).trim();
  } catch { return ''; }
}

/* ---------- install ---------- */
function install(noRestart) {
  log('[1/4] 持久化环境变量 ...');
  try {
    execSync(`setx WORKBUDDY_REMOTE_DEBUGGING_PORT ${PORT}`, { stdio: 'pipe' });
    process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT = PORT;
    log('    [OK]');
  } catch (e) {
    throw new Error('setx 失败: ' + e.message);
  }

  log('[2/4] 注册 MCP 服务器 → ' + CFG);
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  if (fs.existsSync(CFG)) fs.copyFileSync(CFG, CFG + '.bak-wb');
  const j = readJsonSafe(CFG) || {};
  j.mcpServers = j.mcpServers || {};
  j.mcpServers['workbuddy-cdp'] = { command: 'node', args: [MCP_SERVER_ABS] };
  fs.writeFileSync(CFG, JSON.stringify(j, null, 2));
  log('    [OK] workbuddy-cdp -> ' + MCP_SERVER_ABS);

  log('[3/4] 全局记忆 → ' + MEM);
  fs.mkdirSync(path.dirname(MEM), { recursive: true });
  let mem = '';
  try { mem = fs.readFileSync(MEM, 'utf8'); } catch {}
  if (!mem.includes(MEMORY_MARK)) {
    fs.writeFileSync(MEM, mem + MEMORY_BLOCK);
    log('    [OK] 已写入');
  } else {
    log('    已存在，跳过');
  }

  log('[4/4] 重启 WorkBuddy ...');
  const exe = findWorkBuddyExe();
  if (!exe) {
    log('    [跳过] 未找到 WorkBuddy.exe，请稍后手动启动');
  } else {
    try { execSync('taskkill /im WorkBuddy.exe /f', { stdio: 'pipe' }); } catch {}
    if (noRestart) { log('    [跳过] --no-restart：不重启 WorkBuddy（下次启动生效）'); return; }
    setTimeout(() => {
      spawn(exe, [], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: PORT },
      }).unref();
      log('    [OK] 已重启（CDP 模式）');
    }, 1500);
  }

  log('');
  log('✅ 安装完成。WorkBuddy 的 agent 每次对话都自带浏览器调试工具。');
  log('   验证：新开对话说"打开 baidu 预览，然后用 wb_eval 执行 document.title"');
}

/* ---------- remove ---------- */
function remove() {
  const exe = findWorkBuddyExe();
  if (exe) {
    try { execSync('taskkill /im WorkBuddy.exe /f', { stdio: 'pipe' }); } catch {}
  }
  const cfg = readJsonSafe(CFG);
  let changed = false;
  if (cfg?.mcpServers?.['workbuddy-cdp']) {
    delete cfg.mcpServers['workbuddy-cdp'];
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
    changed = true;
    log('[OK] MCP 注册已移除');
  }
  try {
    execSync('setx WORKBUDDY_REMOTE_DEBUGGING_PORT ""', { stdio: 'pipe' });
    log('[OK] 环境变量已清除');
  } catch {}
  let mem = '';
  try { mem = fs.readFileSync(MEM, 'utf8'); } catch {}
  if (mem.includes(MEMORY_MARK)) {
    const cleaned = mem.split(MEMORY_BLOCK).join('');
    fs.writeFileSync(MEM, cleaned);
    log('[OK] 全局记忆已清理');
  }
  log('✅ 卸载完成');
}

/* ---------- status ---------- */
function status() {
  const cfg = readJsonSafe(CFG);
  const mcpOn = !!cfg?.mcpServers?.['workbuddy-cdp'];
  let memOn = false;
  try { memOn = fs.readFileSync(MEM, 'utf8').includes(MEMORY_MARK); } catch {}
  const envOn = userEnvVar('WORKBUDDY_REMOTE_DEBUGGING_PORT') === PORT;
  const exe = findWorkBuddyExe();
  console.log('== WorkBuddy 深度集成状态 ==（锚点适配版本 5.4.4）');
  console.log('  WorkBuddy 路径 : ' + (exe || '未找到'));
  console.log('  CDP 环境变量   : ' + (envOn ? 'Patched(已启用)' : 'Clean'));
  console.log('  MCP 工具注册   : ' + (mcpOn ? 'Patched' : 'Clean'));
  console.log('  全局记忆       : ' + (memOn ? 'Patched' : 'Clean'));
  console.log('');
  console.log('结论：三项全为 Patched 即 WorkBuddy agent 原生具备浏览器调试能力');
}

const noRestart = process.argv.includes('--no-restart');
switch (action) {
  case 'install': install(noRestart); break;
  case 'remove': remove(); break;
  default: status(); break;
}
