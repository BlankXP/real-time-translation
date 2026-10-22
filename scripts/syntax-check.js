/*
 * 零依赖语法自检：逐个 node --check 扩展脚本，并校验 manifest/JSON 可解析。
 * 用途：没有构建步骤，改完文件跑一次即可挡住低级语法错误。
 * 用法：node scripts/syntax-check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['background', 'content', 'options', 'popup', 'offscreen', 'shared', 'tests', 'scripts'];
const ROOT_JSON = ['manifest.json'];

const targets = [];
DIRS.forEach((dir) => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  fs.readdirSync(abs)
    .filter((f) => f.endsWith('.js'))
    .forEach((f) => targets.push(path.join(dir, f)));
});
ROOT_JSON.forEach((f) => targets.push(f));

let bad = 0;
targets.forEach((rel) => {
  const abs = path.join(ROOT, rel);
  if (rel.endsWith('.json')) {
    try {
      JSON.parse(fs.readFileSync(abs, 'utf8'));
      console.log('OK   ' + rel);
    } catch (e) {
      bad++;
      console.error('BAD  ' + rel + ' — ' + e.message);
    }
    return;
  }
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log('OK   ' + rel);
  } else {
    bad++;
    console.error('BAD  ' + rel + '\n' + (r.stderr || ''));
  }
});

console.log('\n' + (targets.length - bad) + ' / ' + targets.length + ' 通过');
process.exit(bad ? 1 : 0);
