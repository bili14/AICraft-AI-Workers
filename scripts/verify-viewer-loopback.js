#!/usr/bin/env node
// verify-viewer-loopback.js — 出包校验：prismarine-viewer 的 listen 必须绑 127.0.0.1
// 防 npm 重装覆盖 patch；打包前跑一次，退出码 0=通过，1=未 patch
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const target = path.join(ROOT, 'bots', 'node_modules', 'prismarine-viewer', 'lib', 'mineflayer.js');

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  OK  ' + msg);
  else { failed++; console.error('  FAIL ' + msg); }
}

if (!fs.existsSync(target)) {
  console.error('FAIL 找不到文件: ' + target);
  process.exit(1);
}
const src = fs.readFileSync(target, 'utf8');

// 1. http.listen 必须带第二参 '127.0.0.1'
check(/http\.listen\s*\(\s*port\s*,\s*['"]127\.0\.0\.1['"]/.test(src), 'http.listen(port, "127.0.0.1", ...) 绑回环');

// 2. 必须有 error 监听
check(/http\.on\(\s*['"]error['"]/.test(src), 'http.on("error", ...) 错误处理在位');

// 3. 不能再出现裸 listen(port, () => 这种全网卡监听
check(!/http\.listen\s*\(\s*port\s*,\s*\(\s*\)\s*=>/.test(src.replace(/http\.listen\s*\(\s*port\s*,\s*['"]127\.0\.0\.1['"]/, '')), '无残留全网卡 listen');

if (failed) {
  console.error('\nviewer 回环 patch 未就位！请重新 patch ' + target);
  process.exit(1);
}
console.log('\nviewer 回环 patch 校验通过。');
