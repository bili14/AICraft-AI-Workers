// ports.js — 确定性端口分配（消除 6 bot 连开竞态）
// 规则：slot i（1..6）→ viewer=3000+2i-1、stream=3000+2i（即 3001~3012）
// 仅当目标端口被本机其他软件占用时顺延，顺延结果由调用方写回 config。
'use strict';
const net = require('net');

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    try { srv.listen(port, '127.0.0.1'); } catch (e) { resolve(false); }
  });
}

// slot 从 1 开始（第一个 bot=1）
function pairForSlot(slot) {
  const i = Math.max(1, Math.min(6, Number(slot) || 1));
  return { viewer: 3000 + 2 * i - 1, stream: 3000 + 2 * i };
}

// 顺延：从 pref 起找空闲端口，跳过 used；上限 +20
async function resolveOne(pref, used) {
  let p = pref;
  for (let i = 0; i <= 20; i++) {
    if (!used.includes(p) && await portFree(p)) return p;
    p++;
  }
  throw new Error('端口范围耗尽（偏好 ' + pref + '）');
}

// 给新 bot 分配一对端口：先按 slot 对号，被占则顺延
// used: 已被其他 bot 占用的端口数组
async function resolvePair(slot, used) {
  const want = pairForSlot(slot);
  const viewer = await resolveOne(want.viewer, used);
  used.push(viewer);
  const stream = await resolveOne(viewer + 1, used);
  used.push(stream);
  return { viewer, stream, viewerPref: want.viewer, streamPref: want.stream };
}

// 取最小空洞槽位 1..6
function nextHoleSlot(usedSlots) {
  const s = new Set(usedSlots.map(n => Number(n)));
  for (let i = 1; i <= 6; i++) if (!s.has(i)) return i;
  throw new Error('已达 6 个工人上限');
}

module.exports = { pairForSlot, resolvePair, resolveOne, nextHoleSlot, portFree };
