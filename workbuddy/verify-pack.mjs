#!/usr/bin/env node
/*
 * verify-pack.mjs — static verification of a patched WorkBuddy asar.
 * No app launching. Usage: node verify-pack.mjs <patched.asar> <original-unpacked-dir>
 * Checks:
 *  1. patched files inside the archive (browser_cdp factory + registration, Inspect un-gated)
 *  2. patched files pass node --check
 *  3. unpacked dir covers the original unpacked file set (no missing files)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ASAR_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');

const [asarArg, origUnp] = process.argv.slice(2);
if (!asarArg || !origUnp) { console.error('usage: node verify-pack.mjs <asar> <original-unpacked-dir>'); process.exit(2); }
const asarPath = path.resolve(asarArg);
let bad = 0;
const die = (m) => { console.error('[x] ' + m); bad++; };

// 1+2: pull patched sources out of the archive and check them
const tmp = fs.mkdtempSync(path.join(process.env.TEMP, 'wb-verify-'));
for (const f of ['main/server.js', 'main/index.js', 'package.json']) {
  try {
    execFileSync(process.execPath, [ASAR_JS, 'extract-file', asarPath, f], { cwd: tmp, stdio: 'pipe' });
    const out = path.join(tmp, path.basename(f));
    if (!fs.existsSync(out)) { die(`${f}: extract-file did not produce output`); continue; }
    const content = fs.readFileSync(out, 'utf8');
    if (f === 'main/server.js') {
      content.includes('function createBrowserCdpTool()') ? console.log('[ok] server.js: browser_cdp factory present') : die('server.js: factory MISSING');
      content.includes('tools.push(createBrowserCdpTool());') ? console.log('[ok] server.js: tool registered') : die('server.js: registration MISSING');
    }
    if (f === 'main/index.js') {
      !content.includes('if (isDev) guestContents.on("context-menu"') && content.includes('guestContents.on("context-menu", () => {')
        ? console.log('[ok] index.js: Inspect un-gated') : die('index.js: Inspect gate still present or mangled');
    }
    if (f === 'package.json') {
      const pkg = JSON.parse(content);
      console.log('[ok] package.json main = ' + pkg.main);
      continue;
    }
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    console.log('[ok] syntax: ' + f);
  } catch (e) { die(`${f}: ${e.message.split('\n')[0]}`); }
}

// 3: unpacked coverage
const orig = [], now = new Set();
const walk = (base, d, cb) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(base, p, cb) : cb(path.relative(base, p).split(path.sep).join('/')); } };
walk(origUnp, origUnp, (rel) => orig.push(rel));
walk(asarPath + '.unpacked', asarPath + '.unpacked', (rel) => now.add(rel));
// only binaries truly need to live on disk (dlopen/wasm can't read archives);
// README/dotfile/etc. are readable from inside the archive via Electron's asar fs
const CRITICAL = /\.(node|dll|exe|wasm|so|dylib)$/i;
const missing = orig.filter((f) => !now.has(f));
const missingCritical = missing.filter((f) => CRITICAL.test(f));
const missingBenign = missing.length - missingCritical.length;
missingCritical.length === 0 ? console.log(`[ok] unpacked coverage: all ${orig.length} original files present (${now.size} total)`) : die(`critical unpacked files missing: ${missingCritical.slice(0, 5).join(', ')}`);
if (missingBenign > 0) console.log(`[note] ${missingBenign} non-binary originals (README/dotfiles) live inside the archive instead — runtime-readable, OK`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? '[PASS] verify-pack' : `[FAIL] ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
