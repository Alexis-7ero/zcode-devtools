#!/usr/bin/env node
// count-files.mjs — print number of files recursively under a directory
import fs from 'node:fs';
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.log(0); process.exit(0); }
let n = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = d + '\\' + e.name; e.isDirectory() ? walk(p) : n++; } };
walk(dir);
console.log(n);
