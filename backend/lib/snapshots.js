// snapshots.js — AICraft 单世界快照系统（五步打快照 / 八步恢复 / 索引原子写 / 滚动清理）
// 红线：唯一活世界 server\world；快照目录 server\snapshots\<id>\；全局操作锁；任一步失败不留半残目录。
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./config-store');

const ROLLBACK_KEEP = 3; // world.pre-rollback / world.pre-reset 各留 3 份

function tsId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cleanLabel(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 40).trim();
}

// 递归算目录大小（字节）
function dirSize(p) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    const full = path.join(p, e.name);
    try {
      if (e.isDirectory()) total += dirSize(full);
      else if (e.isFile()) total += fs.statSync(full).size;
    } catch (e) {}
  }
  return total;
}

// 快照不需要、且 java 运行时会独占导致拷贝失败的文件
const SKIP_FILES = new Set(['session.lock']);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_FILES.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// 带 EBUSY 重试的拷贝（异步）
async function copyDirRetry(src, dst, tries = 3) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      copyDir(src, dst);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      await sleep(1000);
    }
  }
  throw lastErr || new Error('拷贝失败');
}

// 校验快照目录完整性：level.dat>0 且 region/*.mca 计数>0
function validateSnapshotDir(dir) {
  const levelDat = path.join(dir, 'level.dat');
  try {
    const st = fs.statSync(levelDat);
    if (!st.size || st.size <= 0) return { ok: false, reason: 'level.dat 缺失或为空' };
  } catch (e) { return { ok: false, reason: 'level.dat 缺失' }; }
  const regionDir = path.join(dir, 'region');
  let count = 0;
  try {
    count = fs.readdirSync(regionDir).filter(n => n.endsWith('.mca')).length;
  } catch (e) {}
  if (count <= 0) return { ok: false, reason: 'region 区块文件缺失' };
  return { ok: true };
}

class SnapshotManager {
  constructor(opts) {
    this.serverDir = opts.serverDir;
    this.logsDir = opts.logsDir;
    this.botLogsDir = opts.botLogsDir || null; // bot 实际写 bot-state 的目录（bots\logs）
    this.worldDir = path.join(this.serverDir, 'world');
    this.snapDir = path.join(this.serverDir, 'snapshots');
    this.indexFile = path.join(this.snapDir, 'snapshots.json');
    this.rconExec = opts.rconExec;           // async (cmd) => {ok, body}
    this.tailServerLog = opts.tailServerLog; // (n) => string[]
    this.isServerUp = opts.isServerUp;       // () => bool
    this.stopAllBots = opts.stopAllBots;     // async () => void
    this.gracefulStopServer = opts.gracefulStopServer; // async () => {ok, force}
    this.startServer = opts.startServer;     // async () => {ok,...}
    this.snapCfg = opts.snapshotsCfg || {};
    this.busy = false;
    this.queue = Promise.resolve();
    fs.mkdirSync(this.snapDir, { recursive: true });
  }

  // 全局互斥
  withLock(job) {
    const run = this.queue.then(() => {
      if (this.busy) return Promise.reject(Object.assign(new Error('正在整理世界，请稍候'), { code: 'WORLD_BUSY' }));
      this.busy = true;
      return Promise.resolve().then(job).finally(() => { this.busy = false; });
    });
    // 队列链：无论成败都继续
    this.queue = run.catch(() => {});
    return run;
  }

  // ---------- 索引 ----------
  readIndex() {
    try {
      const raw = fs.readFileSync(this.indexFile, 'utf8');
      const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      if (!Array.isArray(j.list)) j.list = [];
      return j;
    } catch (e) { return { version: 1, list: [] }; }
  }
  writeIndex(idx) { atomicWriteJson(this.indexFile, idx); }

  // ---------- 五步打快照 ----------
  async createSnapshot(kind, label) {
    kind = (kind === 'auto' || kind === 'preRestore') ? kind : 'manual';
    label = cleanLabel(label || '');
    const id = tsId() + (label ? '-' + label : '') + (kind === 'preRestore' ? '-preRestore' : '');
    const tmpDir = path.join(this.snapDir, id + '.tmp');
    const finalDir = path.join(this.snapDir, id);

    // 世界不存在就没得存（服务器从来没生成过世界）
    if (!fs.existsSync(path.join(this.worldDir, 'level.dat'))) {
      throw Object.assign(new Error('还没有世界：先启动一次服务器让它生成世界，再来存档'), { code: 'NO_WORLD' });
    }

    // 服务器在跑 → 走 save-all/save-off 保证一致；服务器没跑 → 文件本来就不被写，直接拷
    const needSaveToggle = !!this.isServerUp();

    // 磁盘满预检：剩余空间 < 世界体积×2 拒绝
    const worldBytes = dirSize(this.worldDir);
    try {
      const st = fs.statfsSync(this.serverDir);
      const freeBytes = st.bavail * st.bsize;
      if (freeBytes < worldBytes * 2) throw Object.assign(new Error('磁盘空间不足：剩余空间小于世界体积两倍，已拒绝本次快照'), { code: 'DISK_FULL' });
    } catch (e) {
      if (e.code === 'DISK_FULL') throw e;
    }

    let saveOnFailed = false;
    try {
      if (needSaveToggle) {
        // 1. save-all，等日志 "Saved the game" ≤8s
        await this.rconExec('save-all');
        await this.waitForLog('Saved the game', 8000);
        // 2. save-off，暂停写盘
        await this.rconExec('save-off');
      }
      // 3. 拷贝到 .tmp（必须 await，否则拷贝失败会变成未处理的 promise 拒绝）
      try {
        await copyDirRetry(this.worldDir, tmpDir);
      } catch (e) {
        throw Object.assign(new Error('拷贝世界失败：' + (e.message || e.code)), { code: 'SNAP_COPY_FAILED' });
      }
      // 拷贝后校验
      const v = validateSnapshotDir(tmpDir);
      if (!v.ok) throw Object.assign(new Error('快照内容校验失败：' + v.reason), { code: 'SNAP_INVALID' });

      // 拷 _botstate：bot-state-*.json（bot 实际写在 bots\logs）+ 指令箱.txt（logs 与 bots\logs 都找）
      const botstateDir = path.join(tmpDir, '_botstate');
      fs.mkdirSync(botstateDir, { recursive: true });
      const collectFrom = (dir) => {
        let files = [];
        try { files = fs.readdirSync(dir); } catch (e) { return; }
        for (const f of files) {
          if (/^bot-state-.*\.json$/.test(f) || f === '指令箱.txt') {
            try { fs.copyFileSync(path.join(dir, f), path.join(botstateDir, f)); } catch (e) {}
          }
        }
      };
      collectFrom(this.botLogsDir);
      collectFrom(this.logsDir);

      // 4. rename .tmp → 正式
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, finalDir);
    } finally {
      if (needSaveToggle) {
        // 5. save-on 必发（哪怕前面失败）
        try { await this.rconExec('save-on'); } catch (e) { saveOnFailed = true; }
        try { await this.rconExec('save-all'); } catch (e) {}
      }
    }

    // 清理半残 tmp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

    // 写索引
    const sizeMB = Math.round(dirSize(finalDir) / 1048576);
    const idx = this.readIndex();
    idx.list.push({
      id, dir: 'snapshots/' + id, kind, label,
      createdAt: new Date().toISOString(), sizeMB, valid: true,
    });
    this.writeIndex(idx);
    await this.prune();
    return { ok: true, id, sizeMB, saveOnFailed };
  }

  // 等日志出现某行（超时返回 false）
  async waitForLog(pattern, timeoutMs) {
    const start = Date.now();
    const re = new RegExp(pattern);
    while (Date.now() - start < timeoutMs) {
      const lines = this.tailServerLog(30);
      if (lines.some(l => re.test(l))) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  // 读世界现状（存档页「当前世界」纯展示用，全部从磁盘现算，不猜任何值）
  currentWorld() {
    const now = Date.now();
    if (this._curCache && now - this._curCache.at < 10000) return this._curCache.val;

    const cur = { exists: false, running: false, sizeMB: 0, lastPlayed: null, difficulty: '', gamemode: '', seed: '', seedKnown: false };
    try { cur.running = !!this.isServerUp(); } catch (e) {}

    try {
      const st = fs.statSync(path.join(this.worldDir, 'level.dat'));
      cur.exists = true;
      cur.lastPlayed = st.mtime.toISOString();
      cur.sizeMB = Math.round(dirSize(this.worldDir) / 1048576);
    } catch (e) { cur.exists = false; }

    // server.properties 是服务器真正在用的设定（文件为 Latin-1，用 latin1 读不会坏）
    try {
      const raw = fs.readFileSync(path.join(this.serverDir, 'server.properties'), 'latin1');
      const props = {};
      for (const line of raw.split(/\r?\n/)) {
        const m = /^([^#=]+)=(.*)$/.exec(line);
        if (m) props[m[1].trim()] = m[2].trim();
      }
      cur.difficulty = props.difficulty || '';
      cur.gamemode = props.gamemode || '';
      cur.seed = props['level-seed'] || '';
      cur.seedKnown = !!cur.seed;
    } catch (e) {}

    this._curCache = { at: now, val: cur };
    return cur;
  }

  // ---------- 列表 ----------
  list() {
    const idx = this.readIndex();
    let total = 0;
    const out = idx.list.map(item => {
      const dir = path.join(this.serverDir, item.dir);
      let valid = item.valid !== false;
      let sizeMB = item.sizeMB || 0;
      try {
        const v = validateSnapshotDir(dir);
        valid = v.ok;
        sizeMB = Math.round(dirSize(dir) / 1048576);
      } catch (e) { valid = false; }
      total += sizeMB;
      return Object.assign({}, item, { valid, sizeMB });
    });
    // 回写 valid/sizeMB
    idx.list.forEach((it, i) => { it.valid = out[i].valid; it.sizeMB = out[i].sizeMB; });
    this.writeIndex(idx);
    return { list: out, totalSizeMB: total, capMB: this.snapCfg.totalCapMB || 2048, current: this.currentWorld() };
  }

  // ---------- 删除 ----------
  remove(id) {
    const idx = this.readIndex();
    const it = idx.list.find(x => x.id === id);
    if (!it) throw Object.assign(new Error('快照不存在'), { code: 'NOT_FOUND' });
    const dir = path.join(this.serverDir, it.dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    idx.list = idx.list.filter(x => x.id !== id);
    this.writeIndex(idx);
    return { ok: true };
  }

  // ---------- 恢复八步 ----------
  async restore(id) {
    const idx = this.readIndex();
    const it = idx.list.find(x => x.id === id);
    if (!it) throw Object.assign(new Error('快照不存在'), { code: 'NOT_FOUND' });
    const srcDir = path.join(this.serverDir, it.dir);
    if (!fs.existsSync(srcDir)) throw Object.assign(new Error('快照目录已丢失'), { code: 'NOT_FOUND' });

    const rollbackDir = path.join(this.serverDir, 'world.pre-rollback-' + tsId());

    // 1. 停全部 bot
    await this.stopAllBots();
    // 2. 优雅停服
    await this.gracefulStopServer();
    // 3. preRestore 后悔药（此时服务器已停，直接拷 world）
    let preRestoreId = null;
    try {
      const preDir = path.join(this.snapDir, tsId() + '-preRestore');
      fs.rmSync(preDir, { recursive: true, force: true });
      await copyDirRetry(this.worldDir, preDir);
      const v = validateSnapshotDir(preDir);
      if (v.ok) {
        const preIdx = this.readIndex();
        preIdx.list.push({ id: path.basename(preDir), dir: 'snapshots/' + path.basename(preDir), kind: 'preRestore', label: '恢复前自动备份', createdAt: new Date().toISOString(), sizeMB: Math.round(dirSize(preDir) / 1048576), valid: true });
        this.writeIndex(preIdx);
        preRestoreId = path.basename(preDir);
      }
    } catch (e) { /* preRestore 失败不阻断恢复，但要提示 */ }

    // 4. 当前 world rename → world.pre-rollback-<ts>
    let renamed = false;
    try {
      await this.renameWithRetry(this.worldDir, rollbackDir);
      renamed = true;
    } catch (e) {
      throw Object.assign(new Error('世界目录被占用（杀软可能正在扫描），已取消恢复，未改动任何东西'), { code: 'WORLD_LOCKED' });
    }

    try {
      // 5. 快照拷到临时目录 → 校验 → rename 为 world
      const stageDir = path.join(this.snapDir, '_restore-stage-' + tsId());
      fs.rmSync(stageDir, { recursive: true, force: true });
      await copyDirRetry(srcDir, stageDir);
      const v = validateSnapshotDir(stageDir);
      if (!v.ok) throw Object.assign(new Error('快照校验不通过：' + v.reason), { code: 'SNAP_INVALID' });
      await this.renameWithRetry(stageDir, this.worldDir);

      // _botstate 回写：bot-state-*.json → bots\logs；指令箱.txt → logs\
      const bs = path.join(this.worldDir, '_botstate');
      if (fs.existsSync(bs)) {
        try {
          for (const f of fs.readdirSync(bs)) {
            const targetDir = /^bot-state-.*\.json$/.test(f) ? (this.botLogsDir || this.logsDir)
              : f === '指令箱.txt' ? this.logsDir : this.logsDir;
            try { fs.mkdirSync(targetDir, { recursive: true }); fs.copyFileSync(path.join(bs, f), path.join(targetDir, f)); } catch (e) {}
          }
        } catch (e) {}
      }

      // 6. 校验 level.dat
      const v2 = validateSnapshotDir(this.worldDir);
      if (!v2.ok) throw Object.assign(new Error('恢复后世界校验失败'), { code: 'WORLD_CORRUPT' });

      // 7. 起服
      await this.startServer();
      // 8. 滚动 pre-rollback（留 3 份）
      this.rollRollbacks();
      return { ok: true, restored: id, preRestore: preRestoreId };
    } catch (e) {
      // 失败：把 rollback 拷回
      try {
        if (renamed && fs.existsSync(rollbackDir)) {
          fs.rmSync(this.worldDir, { recursive: true, force: true });
          await copyDirRetry(rollbackDir, this.worldDir);
        }
      } catch (e2) {}
      throw Object.assign(new Error('恢复失败，已自动回到原世界：' + (e.message || '')), { code: e.code || 'RESTORE_FAILED' });
    }
  }

  async renameWithRetry(src, dst) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try { fs.renameSync(src, dst); return; }
      catch (e) {
        lastErr = e;
        if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
        await sleep(1000);
      }
    }
    throw lastErr;
  }

  // world.pre-rollback-* / world.pre-reset-* 滚动留 3 份
  rollRollbacks() {
    const pat = /^world\.pre-(rollback|reset)-/;
    let items = [];
    try {
      items = fs.readdirSync(this.serverDir).filter(n => pat.test(n))
        .map(n => ({ name: n, mtime: fs.statSync(path.join(this.serverDir, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) { return; }
    for (const old of items.slice(ROLLBACK_KEEP)) {
      try { fs.rmSync(path.join(this.serverDir, old.name), { recursive: true, force: true }); } catch (e) {}
    }
  }

  // ---------- 世界重置 ----------
  async resetWorld() {
    // 1. 停 bot
    await this.stopAllBots();
    // 2. 优雅停服（必须先停服：文件不锁了，快照才拷得动）
    await this.gracefulStopServer();
    // 3. 删之前固定存一份；失败要如实回报，不能静默吞掉
    let preSnapError = '';
    try {
      await this.createSnapshot('manual', '删除世界前自动备份');
    } catch (e) {
      preSnapError = (e && e.message) || String(e);
    }
    // 4. world rename → world.pre-reset-<ts>（MC 将按「设置」里的种子重新生成）
    const bakDir = path.join(this.serverDir, 'world.pre-reset-' + tsId());
    try {
      if (fs.existsSync(this.worldDir)) await this.renameWithRetry(this.worldDir, bakDir);
    } catch (e) {
      // 改名失败 → 把服务器拉回来，不留一个关着的半残状态
      try { await this.startServer(); } catch (e2) {}
      throw Object.assign(new Error('世界目录被占用（杀软可能正在扫描），已取消删除，没动任何东西'), { code: 'WORLD_LOCKED' });
    }
    this.rollRollbacks();
    // 5. 起服
    await this.startServer();
    return { ok: true, backupDir: path.basename(bakDir), preSnapError };
  }

  // ---------- 滚动清理 ----------
  async prune() {
    const cfg = this.snapCfg;
    const autoKeep = cfg.autoKeep || 5;
    const manualKeep = cfg.manualKeep || 20;
    const totalCapMB = cfg.totalCapMB || 2048;

    const idx = this.readIndex();
    const byKind = (k) => idx.list.filter(x => x.kind === k).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);

    // 先超份删：auto 留最近 autoKeep；manual 留最近 manualKeep
    const auto = byKind('auto');
    for (const old of auto.slice(0, Math.max(0, auto.length - autoKeep))) this._delIndex(idx, old);
    const manual = byKind('manual');
    for (const old of manual.slice(0, Math.max(0, manual.length - manualKeep))) this._delIndex(idx, old);

    // 总量上限
    let total = 0;
    for (const it of idx.list) total += it.sizeMB || 0;
    if (total > totalCapMB) {
      // 先删最老 auto
      const auto2 = byKind('auto');
      for (const old of auto2) {
        if (total <= totalCapMB) break;
        total -= old.sizeMB || 0;
        this._delIndex(idx, old);
      }
    }
    this.writeIndex(idx);
  }

  _delIndex(idx, item) {
    const dir = path.join(this.serverDir, item.dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    idx.list = idx.list.filter(x => x !== item);
  }
}

module.exports = { SnapshotManager, validateSnapshotDir, dirSize, cleanLabel };
