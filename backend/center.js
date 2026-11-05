// center.js — AICraft 指挥中心后端（第二阶段改造版）
// 职责：进程管理（服务器+bot 优雅启停）、config v2 原子读写、6 bot 动态、快照系统、LLM 共享冷却、回环绑定
// 端口：center 3100 起（EADDRINUSE 顺延 +10）；MC 25565；RCON 25575；bot viewer/stream 3001~3012
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync, spawnSync } = require('child_process');

const cfgStore = require('./lib/config-store');
const { rconExec } = require('./lib/rcon');
const portsLib = require('./lib/ports');
const { SnapshotManager } = require('./lib/snapshots');
const { CooldownBuckets } = require('./lib/llm-cooldown');

// ---------- 路径 ----------
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const BOTS_DIR = path.join(ROOT, 'bots');
const PERSONAS_DIR = path.join(BOTS_DIR, 'personas');
const SERVER_DIR = path.join(ROOT, 'server');
const LOGS_DIR = path.join(ROOT, 'logs');
const NODE_BIN = path.join(ROOT, 'runtime', 'node', 'node.exe');
const JDK_BIN = path.join(ROOT, 'runtime', 'jdk25', 'bin', 'java.exe');
const CENTER_PORT_FILE = path.join(LOGS_DIR, 'center.port.json');

fs.mkdirSync(LOGS_DIR, { recursive: true });

// ---------- 配置加载（损坏回滚） ----------
const loaded = cfgStore.loadConfig(CONFIG_PATH);
let CFG = loaded.cfg;
const CONFIG_BROKEN = loaded.broken; // null 或 {restoredFrom, reason}
// 启动后若做过升级，立即落盘一次（把 v2 结构写回，避免下次再跑升级）
cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG));

// RCON 口令：首次生成 32hex 落盘固定
if (!CFG.server.rconPassword) {
  CFG.server.rconPassword = cfgStore.randomRconPassword();
  cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG));
}

// ---------- 全局运行时状态 ----------
const bootTime = Date.now();
const STATE = {
  server: {
    running: false, pid: null, status: 'stopped', // stopped|starting|saving|stopping|waiting-exit|running|start_failed|stopped-force
    phase: 'boot', // boot|alloc-port|write-props|spawn-java|world-loading|port-ready|running
    spawnPct: null, waitMs: 0, logFile: null, logLines: [],
    startedAt: null, actualPort: null, actualRcon: null, ready: null,
  },
  bots: {}, // name -> {pid, runStatus, logFile, actualViewer, actualStream, startedAt, consecFails, lastErr}
  cooldown: new CooldownBuckets(),
  warnRuntime: false,
};

// ---------- 工具 ----------
function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function killTree(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch (e) { try { process.kill(pid); } catch (e2) {} }
}
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(v); } };
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
    setTimeout(() => fin(false), 1000);
  });
}
async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    STATE.server.waitMs = Date.now() - start;
    if (await portOpen(port)) return true;
    await new Promise(r => setTimeout(r, 800));
  }
  return false;
}
function tailServerLogLines(n) {
  const f = STATE.server.logFile;
  if (!f || !fs.existsSync(f)) return [];
  try {
    const txt = fs.readFileSync(f, 'utf8');
    return txt.split(/\r?\n/).slice(-n);
  } catch (e) { return []; }
}
function refreshSpawnPct() {
  const lines = tailServerLogLines(50);
  let pct = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/Preparing spawn area:\s*(\d+)%/);
    if (m) { pct = Number(m[1]); break; }
  }
  STATE.server.spawnPct = pct;
  STATE.server.logLines = lines.slice(-30);
}

// ---------- server.properties ----------
function ensureServerProps(srvPort, rconPort) {
  const f = path.join(SERVER_DIR, 'server.properties');
  let content = '';
  try { content = fs.readFileSync(f, 'utf8'); } catch (e) { content = ''; }
  const w = CFG.server.world || {};
  const lines = content.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  const map = {};
  lines.forEach(l => { const i = l.indexOf('='); if (i > 0) map[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  map['server-ip'] = '127.0.0.1';
  map['server-port'] = String(srvPort);
  map['query.port'] = String(srvPort);
  map['rcon.port'] = String(rconPort);
  map['enable-rcon'] = 'true';
  map['rcon.password'] = CFG.server.rconPassword;
  map['online-mode'] = 'false';
  map['level-name'] = 'world';
  map['level-seed'] = String(w.seed != null ? w.seed : '');
  map['difficulty'] = w.difficulty || 'peaceful';
  map['gamemode'] = w.gamemode || 'survival';
  map['level-type'] = 'minecraft:normal'; // 固定普通世界：其他类型（flat/large_biomes）会解析失败导致世界生成异常
  map['keepInventory'] = w.keepInventory !== false ? 'true' : 'false';
  // 清空 management-server-secret（发行安全）
  map['management-server-secret'] = '';
  map['management-server-enabled'] = 'false';
  const out = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
  fs.writeFileSync(f, out, 'utf8');
}

// ---------- 服务器启停 ----------
async function startServer() {
  if (STATE.server.running) return { ok: true, msg: '服务器已在运行' };
  if (STATE.server.status === 'starting' || STATE.server.phase === 'spawn-java') return { ok: false, msg: '服务器正在启动，请稍候', code: 'STARTING' };
  const cfg = CFG;
  const javaBin = fs.existsSync(JDK_BIN) ? JDK_BIN : 'java';

  STATE.server.phase = 'alloc-port';
  const used = [];
  const srvPort = await portsLib.resolveOne(cfg.server.portPref || 25565, used);
  const rconPort = await portsLib.resolveOne(cfg.server.rconPortPref || 25575, used);
  STATE.server.actualPort = srvPort;
  STATE.server.actualRcon = rconPort;
  STATE.server.status = 'starting';

  STATE.server.phase = 'write-props';
  ensureServerProps(srvPort, rconPort);

  STATE.server.phase = 'spawn-java';
  const args = ['-Xmx' + (cfg.server.xmx || '2G'), '-jar', 'minecraft_server_1.21.4.jar', 'nogui'];
  const log = path.join(LOGS_DIR, new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-server-run.log');
  const child = spawn(javaBin, args, { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  STATE.server.pid = child.pid;
  STATE.server.logFile = log;
  STATE.server.logLines = [];
  const out = fs.createWriteStream(log, { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);

  child.on('exit', (code) => {
    if (STATE.server.pid === child.pid) {
      STATE.server.running = false;
      STATE.server.status = STATE.server.status === 'stopping' ? 'stopped' : 'crashed';
      STATE.server.pid = null;
    }
  });

  // 首生世界 180s，复用 90s
  const worldDir = path.join(SERVER_DIR, 'world');
  const firstBoot = !fs.existsSync(path.join(worldDir, 'level.dat'));
  const timeout = firstBoot ? 180000 : 90000;
  STATE.server.phase = 'world-loading';
  STATE.server.waitMs = 0;
  STATE.server.ready = waitForPort(srvPort, timeout).then(async (ok) => {
    if (STATE.server.pid !== child.pid) return false;
    refreshSpawnPct();
    if (ok) {
      STATE.server.running = true;
      STATE.server.status = 'running';
      STATE.server.phase = 'running';
      STATE.server.startedAt = Date.now();
      return true;
    }
    STATE.server.status = 'start_failed';
    return false;
  });
  return { ok: true, msg: `服务器启动中（端口 ${srvPort}）`, pid: child.pid, actualPort: srvPort, actualRcon: rconPort };
}

// 统一优雅停服状态机：先停 bot（调用方负责），再 save-all→stop→poll 退出
async function gracefulStopServer() {
  if (!STATE.server.pid && !STATE.server.running) return { ok: true, already: true };
  const pid = STATE.server.pid;
  const rconPort = STATE.server.actualRcon;
  const pwd = CFG.server.rconPassword;

  STATE.server.status = 'saving';
  STATE.server.phase = 'stopping';

  // 1. save-all（RCON 可用时）
  let rconUp = false;
  if (rconPort && pwd) {
    const r = await rconExec({ host: '127.0.0.1', port: rconPort, password: pwd, cmd: 'save-all', timeoutMs: 5000, tries: 1 });
    rconUp = r.ok;
    if (r.ok) await new Promise(r => setTimeout(r, 1500)); // 等 flush
  }
  // 2. stop
  if (rconUp) {
    await rconExec({ host: '127.0.0.1', port: rconPort, password: pwd, cmd: 'stop', timeoutMs: 5000, tries: 1 });
  }
  // 3. poll 退出 ≤15s
  STATE.server.status = 'waiting-exit';
  const deadline = Date.now() + 15000;
  let exited = false;
  while (Date.now() < deadline) {
    if (!pid || !isRunning(pid)) { exited = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (exited) {
    STATE.server.running = false;
    STATE.server.status = 'stopped';
    STATE.server.pid = null;
    STATE.server.phase = 'boot';
    return { ok: true, force: false };
  }
  // 4. killTree 兜底
  try { killTree(pid); } catch (e) {}
  STATE.server.running = false;
  STATE.server.status = 'stopped-force';
  STATE.server.pid = null;
  STATE.server.phase = 'boot';
  console.error('[center] 服务器 15s 未退出，已强制结束（存档可能只到几分钟前）');
  return { ok: true, force: true };
}

async function stopAllBots() {
  const names = Object.keys(STATE.bots);
  for (const n of names) { try { stopBot(n); } catch (e) {} }
  await new Promise(r => setTimeout(r, 500));
}

// ---------- bot 启停 ----------
function stopBot(name) {
  const b = STATE.bots[name];
  if (b && b.pid) { killTree(b.pid); }
  if (b) { b.runStatus = 'stopped'; b.pid = null; }
  return { ok: true, msg: `${name} 已停止` };
}

async function startBot(botCfg) {
  if (!STATE.server.running) {
    return { ok: false, msg: STATE.server.status === 'starting' ? '服务器正在启动，请稍候' : '请先启动服务器', code: 'SERVER_NOT_READY' };
  }
  const live = STATE.bots[botCfg.name];
  if (live && (live.runStatus === 'starting' || live.runStatus === 'running') && live.pid && isRunning(live.pid)) {
    return { ok: false, msg: `${botCfg.name} 已在运行`, code: 'ALREADY_RUNNING' };
  }

  const prov = CFG.providers.find(p => p.id === botCfg.providerId);
  if (!prov) return { ok: false, msg: '所选服务商不存在', code: 'E_NO_PROVIDER' };
  const key = botCfg.keyMode === 'own' ? (botCfg.ownKey || '') : (prov.key || '');
  if (!key && !isLocalEndpoint(prov.endpoint)) {
    return { ok: false, msg: '这个工人还没有大脑，请先在「API 服务商」配一把钥匙', code: 'E_NO_PROVIDER' };
  }

  // 端口：以配置的 viewerPortPref/streamPortPref 为准，被占则顺延写回
  const used = [];
  for (const b of CFG.bots) {
    if (b.name === botCfg.name) continue;
    if (b.viewerPortPref) used.push(b.viewerPortPref);
    if (b.streamPortPref) used.push(b.streamPortPref);
  }
  let viewer = botCfg.viewerPortPref || 3001;
  let stream = botCfg.streamPortPref || 3002;
  if (botCfg.viewer !== false) {
    viewer = await portsLib.resolveOne(viewer, used); used.push(viewer);
    stream = await portsLib.resolveOne(stream, used); used.push(stream);
  } else {
    stream = await portsLib.resolveOne(stream, used); used.push(stream);
  }
  // 顺延结果写回 config
  botCfg.viewerPortPref = viewer; botCfg.streamPortPref = stream;
  const cfgIdx = CFG.bots.findIndex(b => b.name === botCfg.name);
  if (cfgIdx >= 0) { CFG.bots[cfgIdx].viewerPortPref = viewer; CFG.bots[cfgIdx].streamPortPref = stream; cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG)); }

  const script = path.join(BOTS_DIR, botCfg.script);
  const nodeBin = fs.existsSync(NODE_BIN) ? NODE_BIN : 'node';
  const args = [script, '--name', botCfg.name,
    '--viewer-port', String(viewer), '--stream-port', String(stream), '--minutes', '0'];
  if (botCfg.viewer === false) args.push('--no-viewer');
  args.push('--server-port', String(STATE.server.actualPort || 25565),
    '--rcon-port', String(STATE.server.actualRcon || 25575),
    '--memory-rounds', String(botCfg.memoryRounds || CFG.memory.rounds || 5));
  if (botCfg.persona) args.push('--persona', String(botCfg.persona));

  const log = path.join(LOGS_DIR, new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-bot-' + botCfg.name.replace(/[^\w\-]/g, '_') + '.log');
  const env = {
    ...process.env,
    CONFIG_PATH,
    AICRAFT_PROVIDER_ID: prov.id,
    AICRAFT_LLM_URL: chatUrl(prov.endpoint || ''),
    AICRAFT_LLM_KEY: key,
    AICRAFT_MODEL: botCfg.model || '',
    AICRAFT_THINKING_STYLE: prov.thinkingStyle || 'all',
    AICRAFT_RCON_PWD: CFG.server.rconPassword || '',
    AICRAFT_SPAWN_SLOT: String(botCfg.spawnSlot != null ? botCfg.spawnSlot : 0),
    AICRAFT_DECISION_MS: String((CFG.llm && CFG.llm.decisionIntervalMs) || 3000),
    AICRAFT_COLOR: botCfg.color || '',
    AICRAFT_MEMORY_ROUNDS: String(botCfg.memoryRounds || CFG.memory.rounds || 5),
  };
  const child = spawn(nodeBin, args, { cwd: BOTS_DIR, stdio: ['ignore', 'pipe', 'pipe'], env });
  STATE.bots[botCfg.name] = {
    pid: child.pid, runStatus: 'starting', logFile: log,
    actualViewer: viewer, actualStream: stream, startedAt: Date.now(), consecFails: 0,
  };
  const out = fs.createWriteStream(log, { flags: 'a' });
  child.stdout.pipe(out); child.stderr.pipe(out);
  child.on('exit', (code) => {
    const b = STATE.bots[botCfg.name];
    if (b) {
      b.pid = null;
      b.runStatus = (b.runStatus === 'running') ? 'crashed' : 'stopped';
      b.lastErr = '进程退出 code=' + code;
    }
  });
  // spawn 后轮询 /state 验证 stream 活着（最多 15s）
  pollBotAlive(botCfg.name, stream);
  return { ok: true, msg: `${botCfg.name} 启动中（stream ${stream}）`, pid: child.pid, actualViewer: viewer, actualStream: stream };
}

async function pollBotAlive(name, streamPort) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const b = STATE.bots[name];
    if (!b || !b.pid) return;
    try {
      const r = await fetch(`http://127.0.0.1:${streamPort}/state`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        b.runStatus = 'running';
        b.consecFails = 0;
        return;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  // 15s 未应答仍保留 starting（看门狗后续观察）
}

// ---------- bot 状态聚合 ----------
async function fetchBotState(bot) {
  const live = STATE.bots[bot.name] || {};
  const base = {
    name: bot.name, nick: bot.nick || bot.name, color: bot.color || '',
    script: bot.script, persona: bot.persona || null,
    online: false, state: null,
    viewer: bot.viewer !== false,
    viewerPort: live.actualViewer || bot.viewerPortPref || null,
    streamPort: live.actualStream || bot.streamPortPref || null,
    runStatus: live.runStatus || 'stopped',
    pid: live.pid || null,
    spawnSlot: bot.spawnSlot || 0,
    keyMode: bot.keyMode || 'shared',
    providerId: bot.providerId || '',
    model: bot.model || '',
  };
  const streamPort = live.actualStream || bot.streamPortPref;
  if (!streamPort || !live.pid) return base;
  try {
    const r = await fetch(`http://127.0.0.1:${streamPort}/state`, { signal: AbortSignal.timeout(3500) });
    if (!r.ok) throw new Error('http ' + r.status);
    const st = await r.json();
    base.online = true;
    base.state = st;
    if (live.runStatus === 'starting') { live.runStatus = 'running'; live.consecFails = 0; }
    if (live.runStatus === 'running') live.consecFails = 0;
    return base;
  } catch (e) {
    if (live.runStatus === 'running') {
      live.consecFails = (live.consecFails || 0) + 1;
      if (live.consecFails >= 3) { live.runStatus = 'crashed'; live.lastErr = '状态连续 ' + live.consecFails + ' 次无响应'; }
    }
    return base;
  }
}

// ---------- 运行环境真实探测（spawnSync 跑 --version/-version，启动一次缓存 60s） ----------
function extractVersion(raw, kind) {
  if (!raw) return '';
  const s = String(raw);
  if (kind === 'node') {
    const m = s.match(/v\d+\.\d+\.\d+[-\w.]*/);
    return m ? m[0] : '';
  }
  // Java：openjdk version "25.0.4.1" … 或 1.8.0_402
  const q = s.match(/"([^"]+)"/);
  if (q) return q[1];
  const m = s.match(/\d+\.\d+\.\d+(?:\.\d+)?(?:[_\-\w]*)/);
  return m ? m[0] : '';
}
function probeTool(bin, args, label, kind) {
  try {
    const r = spawnSync(bin, args, { timeout: 8000, windowsHide: true, encoding: 'utf8' });
    if (r.error) return { ok: false, version: '', reason: label + '启动失败：' + (r.error.code || r.error.message) };
    if (r.status !== 0) return { ok: false, version: '', reason: label + '退出码 ' + r.status };
    const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
    return { ok: true, version: extractVersion(out, kind), source: fs.existsSync(bin) ? 'portable' : 'system' };
  } catch (e) {
    return { ok: false, version: '', reason: label + '异常：' + e.message };
  }
}
function detectTool(label, portableBin, systemCmd, versionArgs, kind) {
  // 便携存在→先跑便携；便携失败或不存在→回退系统命令
  if (fs.existsSync(portableBin)) {
    const r = probeTool(portableBin, versionArgs, label, kind);
    if (r.ok) return r;
    const sys = probeTool(systemCmd, versionArgs, label, kind);
    if (sys.ok) { sys.source = 'system'; sys.reason = '便携 ' + r.reason + '；已回退系统版本'; return sys; }
    return { ok: false, version: '', reason: '便携 ' + r.reason + '；系统 ' + sys.reason };
  }
  const sys = probeTool(systemCmd, versionArgs, label, kind);
  if (sys.ok) { sys.source = 'system'; return sys; }
  return { ok: false, version: '', reason: '系统 ' + sys.reason };
}
let runtimeCache = null;
let runtimeCacheAt = 0;
function getRuntime() {
  const now = Date.now();
  if (!runtimeCache || now - runtimeCacheAt > 60000) {
    try {
      runtimeCache = { node: detectTool('Node', NODE_BIN, 'node', ['--version'], 'node'),
                       java: detectTool('Java', JDK_BIN, 'java', ['-version'], 'java') };
    } catch (e) {
      runtimeCache = { node: { ok: false, reason: '探测异常：' + e.message }, java: { ok: false, reason: '探测异常：' + e.message } };
    }
    runtimeCacheAt = now;
  }
  return runtimeCache;
}

// ---------- hall 聚合 ----------
async function hallJson() {
  const bots = await Promise.all(CFG.bots.map(fetchBotState));

  // needsKey：没有任何「有钥匙的供应商」或「本机端点」时，才算还没配大脑
  const needsKey = !CFG.providers.some(p => p.key || isLocalEndpoint(p.endpoint));
  const noWorld = !fs.existsSync(path.join(SERVER_DIR, 'world', 'level.dat'));

  // 内存预估
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const coef = {
    javaRSS: { '1.5G': 2050, '2G': 2550, '3G': 3550 },
    perBotMB: 250, centerMB: 80, electronMB: 300, perViewerMB: 400, systemReserveMB: 2048,
  };
  const runningBots = bots.filter(b => b.runStatus === 'running').length;
  const viewersOpen = bots.filter(b => b.runStatus === 'running' && b.viewer && !(b.state && b.state.meta && b.state.meta.viewerDown)).length;
  const xmx = CFG.server.xmx || '2G';
  const estMB = (coef.javaRSS[xmx] || 2550) + 250 * runningBots + 80 + 300 + 400 * viewersOpen;
  const ratio = (estMB + coef.systemReserveMB) / Math.max(1, totalMB);
  const level = ratio < 0.6 ? 'green' : ratio < 0.8 ? 'yellow' : 'red';

  return {
    bootTime,
    runtime: getRuntime(),
    needsKey, noWorld,
    setupWizardDone: CFG.setupWizardDone === true,
    configBroken: CONFIG_BROKEN ? { restoredFrom: CONFIG_BROKEN.restoredFrom, reason: CONFIG_BROKEN.reason } : false,
    llmCooldown: STATE.cooldown.list(),
    mem: {
      totalMB, freeMB, coef,
      current: { botsRunning: runningBots, viewersOpen, xmx },
      ratio: Math.round(ratio * 1000) / 1000,
      level,
      manualAllowed: true,
      warnRuntime: STATE.warnRuntime,
    },
    server: {
      running: STATE.server.running,
      status: STATE.server.status,
      phase: STATE.server.phase,
      spawnPct: STATE.server.spawnPct,
      waitMs: STATE.server.waitMs,
      logTail: STATE.server.logLines,
      startedAt: STATE.server.startedAt,
      actualPort: STATE.server.actualPort || CFG.server.portPref,
      actualRcon: STATE.server.actualRcon || CFG.server.rconPortPref,
    },
    providers: CFG.providers.map(p => ({
      id: p.id, name: p.name, endpoint: p.endpoint,
      models: p.models || [], defaultModel: p.defaultModel,
      thinkingStyle: p.thinkingStyle, rpmBudget: p.rpmBudget,
      key: p.key ? '****' : '',
      coolUntil: (STATE.cooldown.lease(p.id).cooldownUntilMs) || 0,
    })),
    presets: CFG.presets,
    memory: CFG.memory,
    llm: CFG.llm,
    bots,
    updatedAt: new Date().toISOString(),
  };
}

// ---------- API 工具 ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

// ---------- 快照管理器（在路由前构造，回调引用心智） ----------
const snap = new SnapshotManager({
  serverDir: SERVER_DIR,
  logsDir: LOGS_DIR,
  botLogsDir: path.join(BOTS_DIR, 'logs'),
  snapshotsCfg: CFG.server.snapshots || {},
  rconExec: async (cmd) => rconExec({ host: '127.0.0.1', port: STATE.server.actualRcon, password: CFG.server.rconPassword, cmd, timeoutMs: 5000, tries: 2 }),
  tailServerLog: tailServerLogLines,
  isServerUp: () => STATE.server.running,
  stopAllBots,
  gracefulStopServer,
  startServer,
});

// ---------- provider/test 结构化错误识别 ----------
// ---------- OpenAI 兼容地址归一化 ----------
// 本机 / 内网端点：自己跑的服务（vLLM、llama.cpp、Ollama、LM Studio 等）通常不要 Key
function isLocalEndpoint(endpoint) {
  let host = '';
  try { host = new URL(chatUrl(endpoint)).hostname; } catch (e) { return false; }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

// 用户可能填 base（https://x.com 或带 /v1），也可能直接粘贴完整 /chat/completions；统一剥成 base
function normalizeBase(endpoint) {
  let s = String(endpoint || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/i, '');
  return s;
}
function chatUrl(endpoint) { return normalizeBase(endpoint) + '/chat/completions'; }
function modelsUrl(endpoint) { return normalizeBase(endpoint) + '/models'; }

// 拉取供应商真实可用模型（OpenAI 兼容 GET /models），返回去重后的 id 列表
async function fetchProviderModels(prov) {
  let r;
  try {
    r = await fetch(modelsUrl(prov.endpoint), {
      headers: prov.key ? { Authorization: 'Bearer ' + prov.key } : {},
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, code: 'E_NETWORK', message: '连不上：' + (e.message || '断网/网址错/本地模型未启动') };
  }
  const txt = await r.text().catch(() => '');
  if (!r.ok) return { ok: false, code: 'E_BAD_RESPONSE', message: 'HTTP ' + r.status + '（这家可能不支持自动获取，请手动添加）' };
  let j;
  try { j = JSON.parse(txt); } catch (e) { return { ok: false, code: 'E_BAD_RESPONSE', message: '返回不是有效 JSON，无法自动获取，请手动添加' }; }
  let ids = [];
  if (Array.isArray(j.data)) ids = j.data.map(x => x && x.id).filter(Boolean);
  else if (Array.isArray(j.models)) ids = j.models.map(x => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
  ids = Array.from(new Set(ids.map(String)));
  if (!ids.length) return { ok: false, code: 'E_BAD_RESPONSE', message: '没解析到模型，请手动添加' };
  return { ok: true, models: ids };
}

async function testProvider(endpoint, key, model) {
  const t0 = Date.now();
  try {
    const r = await fetch(chatUrl(endpoint), {
      method: 'POST',
      headers: key ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key } : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '说OK' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(60000),
    });
    const ms = Date.now() - t0;
    const txt = await r.text().catch(() => '');
    if (r.ok) {
      let reply = '';
      try { const j = JSON.parse(txt); reply = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || ''; } catch (e) {}
      return { ok: true, errorCode: 'OK', httpStatus: r.status, ms, replyPreview: String(reply).slice(0, 40) };
    }
    // 错误分类
    const lower = txt.toLowerCase();
    if (r.status === 401) return { ok: false, errorCode: 'E_401_AUTH', message: '钥匙不对（401）：Key 没填、多空格或已被服务商删除', httpStatus: r.status, ms };
    if (r.status === 403 || /insufficient_quota|欠费|balance|余额/.test(lower)) return { ok: false, errorCode: 'E_403_FORBIDDEN', message: '钥匙能进门但账户没钱/没开通该模型（403）', httpStatus: r.status, ms };
    if (r.status === 429) return { ok: false, errorCode: 'E_429_RATE_LIMIT', message: '调用太频繁被限流（429）', httpStatus: r.status, ms };
    if (r.status >= 500) return { ok: false, errorCode: 'E_5XX_UPSTREAM', message: '服务商服务器开小差（' + r.status + '）', httpStatus: r.status, ms };
    // 其他 4xx：透传服务商返回的具体错误（如"未指定模型名称"），不笼统显示 HTTP 码
    let upstreamMsg = '';
    try { const j = JSON.parse(txt); upstreamMsg = (j.error && (j.error.message || j.error.code)) || j.message || ''; } catch (e) {}
    return { ok: false, errorCode: 'E_BAD_RESPONSE', message: 'HTTP ' + r.status + (upstreamMsg ? '：' + upstreamMsg : ''), httpStatus: r.status, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const causeName = e.cause && e.cause.name;
    const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError' ||
      causeName === 'AbortError' || causeName === 'TimeoutError';
    if (isTimeout) return { ok: false, errorCode: 'E_TIMEOUT', message: '等了 60 秒没回话（超时）', ms };
    return { ok: false, errorCode: 'E_NETWORK', message: '连不上：' + (e.message || '断网/网址错/填的地址上没有服务在跑'), ms };
  }
}

// ---------- 路由 ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const m = req.method;
  try {
    // ===== 只读聚合 =====
    if (m === 'GET' && p === '/api/hall') return send(res, 200, await hallJson());
    if (m === 'GET' && p === '/api/state') return send(res, 200, await hallJson());
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, bootTime, pid: process.pid });

    // ===== 服务器启停（统一走优雅停服） =====
    if (m === 'POST' && p === '/api/server/start') return send(res, 200, await startServer());
    if (m === 'POST' && p === '/api/server/stop') {
      await stopAllBots();
      return send(res, 200, await gracefulStopServer());
    }
    if (m === 'POST' && p === '/api/all/stop') {
      await stopAllBots();
      return send(res, 200, await gracefulStopServer());
    }
    if (m === 'POST' && p === '/api/shutdown') {
      send(res, 200, { ok: true, msg: '正在优雅关闭…' });
      setTimeout(async () => {
        try { await stopAllBots(); await gracefulStopServer(); } catch (e) {}
        process.exit(0);
      }, 300);
      return;
    }

    // ===== bot 启停 =====
    if (m === 'POST' && p === '/api/bot/start') {
      const body = await readBody(req);
      const bot = CFG.bots.find(b => b.name === body.name);
      if (!bot) return send(res, 404, { ok: false, msg: 'bot 不存在' });
      return send(res, 200, await startBot(bot));
    }
    if (m === 'POST' && p === '/api/bot/stop') {
      const body = await readBody(req); return send(res, 200, stopBot(body.name));
    }
    if (m === 'POST' && p === '/api/bot/restart') {
      const body = await readBody(req);
      const bot = CFG.bots.find(b => b.name === body.name);
      if (!bot) return send(res, 404, { ok: false, msg: 'bot 不存在' });
      stopBot(bot.name);
      await new Promise(r => setTimeout(r, 600));
      return send(res, 200, await startBot(bot));
    }
    if (m === 'POST' && p === '/api/all/start') {
      if (!STATE.server.running) {
        await startServer();
        if (STATE.server.ready) await STATE.server.ready;
      }
      if (!STATE.server.running) return send(res, 200, { ok: false, msg: '服务器尚未就绪，工人未启动' });
      const out = [];
      for (const b of CFG.bots) out.push(await startBot(b));
      return send(res, 200, { ok: out.some(r => r.ok), results: out });
    }

    // ===== bot 状态代理 / 人设 =====
    let m2 = p.match(/^\/api\/bot\/([^/]+)\/state$/);
    if (m2 && m === 'GET') {
      const bot = CFG.bots.find(b => b.name === m2[1]);
      if (!bot) return send(res, 404, { ok: false, msg: 'bot 不存在' });
      const live = STATE.bots[bot.name];
      const port = (live && live.actualStream) || bot.streamPortPref;
      if (!live || !live.pid || !isRunning(live.pid)) return send(res, 200, { offline: true });
      try {
        const r = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(3500) });
        const j = await r.json();
        return send(res, 200, j);
      } catch (e) { return send(res, 200, { offline: true, reason: e.message }); }
    }
    m2 = p.match(/^\/api\/bot\/([^/]+)\/persona$/);
    if (m2 && (m === 'GET' || m === 'PUT')) {
      const bot = CFG.bots.find(b => b.name === m2[1]);
      if (!bot) return send(res, 404, { ok: false, msg: 'bot 不存在' });
      const personaFile = path.join(BOTS_DIR, bot.persona || ('personas/' + bot.name + '.json'));
      if (m === 'GET') {
        try { return send(res, 200, { ok: true, persona: fs.readFileSync(personaFile, 'utf8') }); }
        catch (e) { return send(res, 404, { ok: false, msg: '人设文件不存在' }); }
      }
      const body = await readBody(req);
      // 整个 JSON 原样写回、保留结构：字符串先 JSON.parse 校验，对象直接落盘；不合法一律不写盘
      // （人设文件现在是纯人设：角色名/性格/口吻/队友关系，功能由 specs/ 目录的 spec 文件提供）
      let parsed;
      if (typeof body.persona === 'object' && body.persona !== null) {
        parsed = body.persona;
      } else if (typeof body.persona === 'string') {
        try { parsed = JSON.parse(body.persona); }
        catch (e) { return send(res, 200, { ok: false, msg: '人设不是合法 JSON：' + e.message }); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return send(res, 200, { ok: false, msg: '人设必须是一个 JSON 对象（含 character/meta 字段），不能是数组/数字/纯字符串' });
        }
      } else {
        return send(res, 200, { ok: false, msg: '人设内容为空，请在弹窗里粘贴完整 JSON 后再保存' });
      }
      cfgStore.atomicWriteJson(personaFile, parsed);
      return send(res, 200, { ok: true, msg: '人设已保存' });
    }

    // ===== 打开功能说明书（弹资源管理器定位文件） =====
    const mOpenSpec = p.match(/^\/api\/bot\/([^/]+)\/open-spec$/);
    if (m === 'POST' && mOpenSpec) {
      const bot = CFG.bots.find(b => b.name === mOpenSpec[1]);
      if (!bot) return send(res, 404, { ok: false, msg: 'bot 不存在' });
      const personaFile = path.join(BOTS_DIR, bot.persona || ('personas/' + bot.name + '.json'));
      let preset = 'worker';
      try {
        const persona = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
        preset = (persona.meta && persona.meta.preset) || 'worker';
      } catch (e) { /* 用默认 worker */ }
      const specFile = path.join(BOTS_DIR, 'specs', preset + '.json');
      if (!fs.existsSync(specFile)) return send(res, 404, { ok: false, msg: '功能说明书不存在：' + specFile });
      try {
        require('child_process').exec('explorer.exe /select,"' + specFile + '"');
        return send(res, 200, { ok: true, path: specFile });
      } catch (e) {
        return send(res, 500, { ok: false, msg: '打开资源管理器失败：' + e.message });
      }
    }

    // ===== 配置读写 =====
    if (m === 'GET' && p === '/api/config') return send(res, 200, cfgStore.maskConfig(CFG));
    if (m === 'PUT' && p === '/api/config') {
      const body = await readBody(req);
      const oldBots = JSON.stringify(CFG.bots);
      const oldProv = JSON.stringify(CFG.providers.map(p => ({ id: p.id, key: p.key, endpoint: p.endpoint })));
      CFG = cfgStore.mergeSavedInto(CFG, body);
      cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG));
      // 自动重启受影响 bot
      const newBots = JSON.stringify(CFG.bots);
      const newProv = JSON.stringify(CFG.providers.map(p => ({ id: p.id, key: p.key, endpoint: p.endpoint })));
      if (oldBots !== newBots || oldProv !== newProv) {
        for (const b of CFG.bots) {
          const live = STATE.bots[b.name];
          if (live && live.pid && isRunning(live.pid)) { stopBot(b.name); }
        }
        await new Promise(r => setTimeout(r, 600));
        for (const b of CFG.bots) {
          if (STATE.server.running) { try { await startBot(b); } catch (e) {} }
        }
      }
      return send(res, 200, { ok: true, msg: '配置已保存，相关工人已自动重启' });
    }

    // ===== bot add / update / remove =====
    if (m === 'POST' && p === '/api/bot/add') {
      const body = await readBody(req);
      // 取空洞槽位 1..6
      const usedSlots = CFG.bots.map(b => b.spawnSlot != null ? b.spawnSlot + 1 : 0);
      let slot;
      try { slot = portsLib.nextHoleSlot(usedSlots); }
      catch (e) { return send(res, 200, { ok: false, msg: e.message, code: 'SLOT_FULL' }); }
      const name = 'AI-Bot-L' + slot;
      if (CFG.bots.some(b => b.name === name)) return send(res, 200, { ok: false, msg: '重名冲突，请重试', code: 'DUP_NAME' });

      const preset = CFG.presets.find(x => x.id === body.presetId) || CFG.presets[0];
      const providerId = body.providerId || (CFG.providers[0] && CFG.providers[0].id);
      const prov = CFG.providers.find(x => x.id === providerId);
      if (!prov) return send(res, 200, { ok: false, msg: '服务商不存在', code: 'NO_PROVIDER' });
      // EMPTY_MODELS 白名单
      const models = (prov.models || []).filter(x => x);
      if (!models.length) return send(res, 200, { ok: false, msg: '该服务商还没填可用模型，先到「服务商」页添加模型名', code: 'EMPTY_MODELS' });
      const model = body.model || prov.defaultModel || models[0];
      if (!models.includes(model)) return send(res, 200, { ok: false, msg: '模型「' + model + '」不在该服务商模型列表里', code: 'BAD_MODEL' });

      // persona 副本：从模板复制
      const templateFile = path.join(PERSONAS_DIR, preset.persona || 'persona-worker.json');
      const ownFile = path.join(PERSONAS_DIR, name + '.json');
      try {
        if (!fs.existsSync(templateFile)) throw new Error('模板缺失: ' + preset.persona);
        fs.copyFileSync(templateFile, ownFile);
      } catch (e) {
        return send(res, 200, { ok: false, msg: '人设模板复制失败：' + e.message, code: 'PERSONA_COPY_FAIL' });
      }

      const pair = portsLib.pairForSlot(slot);
      const bot = {
        name, nick: (body.nick || name).trim(), script: preset.script || 'bot-lite.js',
        persona: 'personas/' + name + '.json',
        providerId, model,
        keyMode: body.keyMode === 'own' ? 'own' : 'shared',
        ownKey: body.keyMode === 'own' ? (body.ownKey || '') : '',
        color: cfgStore.SLOT_COLORS[(slot - 1) % 6],
        viewer: body.viewer === true,
        viewerPortPref: pair.viewer, streamPortPref: pair.stream,
        spawnSlot: slot - 1,
        memoryRounds: Number(body.memoryRounds) || CFG.memory.rounds || 5,
      };
      CFG.bots.push(bot);
      cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG));
      return send(res, 200, { ok: true, msg: `已添加 ${name}（${preset.name}）`, bot });
    }
    if (m === 'POST' && p === '/api/bot/update') {
      const body = await readBody(req);
      const bot = CFG.bots.find(b => b.name === body.name);
      if (!bot) return send(res, 404, { ok: false, msg: 'bot 不存在' });
      if (body.nick != null) bot.nick = String(body.nick).trim();
      if (body.color) bot.color = String(body.color);
      if (body.viewer != null) bot.viewer = !!body.viewer;
      if (body.providerId) bot.providerId = body.providerId;
      if (body.model) bot.model = body.model;
      if (body.keyMode) bot.keyMode = body.keyMode === 'own' ? 'own' : 'shared';
      if (body.ownKey && body.ownKey !== '****') bot.ownKey = body.ownKey;
      if (body.memoryRounds) bot.memoryRounds = Number(body.memoryRounds);
      cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG));
      // 自动重启该 bot
      const live = STATE.bots[bot.name];
      if (live && live.pid && isRunning(live.pid)) { stopBot(bot.name); await new Promise(r => setTimeout(r, 600)); if (STATE.server.running) await startBot(bot); }
      return send(res, 200, { ok: true, msg: '已更新并按需重启', bot });
    }
    if (m === 'POST' && p === '/api/bot/remove') {
      const body = await readBody(req);
      const bot = CFG.bots.find(b => b.name === body.name);
      if (!bot) return send(res, 404, { ok: false, msg: 'bot 不存在' });
      stopBot(bot.name);
      // 清 persona 副本 / bot-state / decisions jsonl（不动 world）
      try { fs.rmSync(path.join(BOTS_DIR, bot.persona || ''), { force: true }); } catch (e) {}
      try {
        for (const f of fs.readdirSync(LOGS_DIR)) {
          if (f.startsWith('bot-state-' + bot.name) || f.includes(bot.name + '-') && f.endsWith('.jsonl')) {
            try { fs.rmSync(path.join(LOGS_DIR, f), { force: true }); } catch (e) {}
          }
        }
      } catch (e) {}
      CFG.bots = CFG.bots.filter(b => b.name !== bot.name);
      cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG));
      return send(res, 200, { ok: true, msg: `已移除 ${body.name}` });
    }

    // ===== 一键预设 two（worker + builder 幂等） =====
    if (m === 'POST' && p === '/api/bot/preset/two') {
      const results = [];
      for (const presetId of ['worker', 'builder']) {
        const preset = CFG.presets.find(x => x.id === presetId);
        if (!preset) continue;
        // 已有同脚本+同模板的 bot 则跳过
        const exists = CFG.bots.some(b => b.script === preset.script);
        if (exists) { results.push({ preset: presetId, skipped: true }); continue; }
        const usedSlots = CFG.bots.map(b => b.spawnSlot != null ? b.spawnSlot + 1 : 0);
        let slot;
        try { slot = portsLib.nextHoleSlot(usedSlots); } catch (e) { results.push({ preset: presetId, skipped: true, reason: e.message }); continue; }
        const name = 'AI-Bot-L' + slot;
        const prov = CFG.providers.find(p => p.id === 'cloud') || CFG.providers[0];
        const models = (prov && prov.models || []).filter(x => x);
        const model = prov && (prov.defaultModel || models[0]) || '';
        const ownFile = path.join(PERSONAS_DIR, name + '.json');
        try { fs.copyFileSync(path.join(PERSONAS_DIR, preset.persona), ownFile); }
        catch (e) { results.push({ preset: presetId, skipped: true, reason: '人设模板缺失' }); continue; }
        const pair = portsLib.pairForSlot(slot);
        CFG.bots.push({
          name, nick: name, script: preset.script, persona: 'personas/' + name + '.json',
          providerId: prov ? prov.id : 'cloud', model, keyMode: 'shared', ownKey: '',
          color: cfgStore.SLOT_COLORS[(slot - 1) % 6], viewer: false,
          viewerPortPref: pair.viewer, streamPortPref: pair.stream, spawnSlot: slot - 1,
          memoryRounds: CFG.memory.rounds || 5,
        });
        results.push({ preset: presetId, added: name });
      }
      cfgStore.saveConfig(CONFIG_PATH, cfgStore.migrateModelBlock(CFG));
      return send(res, 200, { ok: true, results });
    }

    // ===== provider test =====
    if (m === 'POST' && p === '/api/provider/test') {
      const body = await readBody(req);
      const endpoint = body.endpoint;
      const key = body.key && body.key !== '****' ? body.key : (CFG.providers.find(p => p.id === body.providerId) || {}).key || '';
      const model = body.model || (CFG.providers.find(p => p.id === body.providerId) || {}).defaultModel || '';
      if (!endpoint) return send(res, 200, { ok: false, errorCode: 'E_NETWORK', message: '缺少接口地址' });
      if (!model) return send(res, 200, { ok: false, errorCode: 'E_NO_MODEL', message: '没填模型名：请在「大脑型号列表」填一个模型名（如 agnes-2.5-flash），可在服务商控制台/文档查询' });
      const r = await testProvider(endpoint, key, model);
      return send(res, 200, r);
    }
    if (m === 'POST' && p === '/api/provider/fetch-models') {
      const body = await readBody(req);
      let prov = null;
      if (body.providerId) prov = CFG.providers.find(x => x.id === body.providerId);
      else if (body.endpoint) prov = { endpoint: body.endpoint, key: body.key || '' };
      if (!prov) return send(res, 200, { ok: false, message: '供应商不存在，请先保存' });
      if (!prov.endpoint) return send(res, 200, { ok: false, message: '缺少接口地址' });
      const r = await fetchProviderModels(prov);
      return send(res, 200, r);
    }

    // ===== LLM 共享冷却 =====
    if (m === 'GET' && p === '/api/llm/lease') {
      const providerId = url.searchParams.get('providerId');
      const r = STATE.cooldown.lease(providerId || 'unknown');
      return send(res, 200, r);
    }
    if (m === 'POST' && p === '/api/llm/report') {
      const body = await readBody(req);
      const bk = STATE.cooldown.constructor.bucketKey({ providerId: body.providerId, keyMode: body.keyMode, ownKey: body.ownKey });
      if (body.code === 'OK') STATE.cooldown.noteSuccess(bk);
      else STATE.cooldown.report(bk, body.code);
      return send(res, 200, { ok: true });
    }

    // ===== 快照族 =====
    if (m === 'POST' && p === '/api/world/snapshot') {
      const body = await readBody(req);
      try { return send(res, 200, await snap.withLock(() => snap.createSnapshot(body.kind || 'manual', body.label))); }
      catch (e) { return send(res, 200, { ok: false, code: e.code || 'SNAP_FAIL', msg: e.message }); }
    }
    if (m === 'GET' && p === '/api/world/snapshots') return send(res, 200, snap.list());
    if (m === 'POST' && p === '/api/world/snapshot/restore') {
      const body = await readBody(req);
      try { return send(res, 200, await snap.withLock(() => snap.restore(body.id))); }
      catch (e) { return send(res, 200, { ok: false, code: e.code || 'RESTORE_FAIL', msg: e.message }); }
    }
    if (m === 'DELETE' && p === '/api/world/snapshot') {
      const body = await readBody(req);
      try { return send(res, 200, await snap.withLock(() => snap.remove(body.id))); }
      catch (e) { return send(res, 200, { ok: false, code: e.code || 'DEL_FAIL', msg: e.message }); }
    }
    if (m === 'POST' && p === '/api/world/reset') {
      // 不再接受"要不要先存快照"的选项：一律先自动存一份（失败会回报在 preSnapError）
      await readBody(req);
      try { return send(res, 200, await snap.withLock(() => snap.resetWorld())); }
      catch (e) { return send(res, 200, { ok: false, code: e.code || 'RESET_FAIL', msg: e.message }); }
    }

    // ===== 日志 =====
    if (m === 'GET' && p === '/api/logs') {
      const name = url.searchParams.get('name') || '';
      let f = '';
      if (name === 'server') f = STATE.server.logFile;
      else if (name && STATE.bots[name]) f = STATE.bots[name].logFile;
      const lines = Number(url.searchParams.get('lines') || 200);
      if (!f || !fs.existsSync(f)) return send(res, 200, { content: '' });
      const txt = fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(-lines);
      return send(res, 200, { content: txt.join('\n') });
    }

    send(res, 404, { ok: false, msg: '未知接口 ' + m + ' ' + p });
  } catch (e) {
    send(res, 500, { ok: false, msg: '内部错误：' + e.message });
  }
}

// ---------- 定时器 ----------
// 5 分钟周期 save-all（只落盘不产副本）
setInterval(async () => {
  if (!STATE.server.running) return;
  try { await rconExec({ host: '127.0.0.1', port: STATE.server.actualRcon, password: CFG.server.rconPassword, cmd: 'save-all', timeoutMs: 5000, tries: 1 }); } catch (e) {}
}, 5 * 60 * 1000);

// 自动快照调度：世界>500MB 降 20min，否则 10min
// 初始化为启动时刻（首个 tick 不得立即触发；若已有自动快照，以其时间为准）
let lastAutoSnap = Date.now();
try {
  const _idx = snap.readIndex();
  const _lastAuto = _idx.list.filter(x => x.kind === 'auto').map(x => new Date(x.createdAt).getTime()).filter(x => x > 0).sort((a, b) => b - a)[0];
  if (_lastAuto) lastAutoSnap = _lastAuto;
} catch (e) {}
setInterval(async () => {
  if (!STATE.server.running || snap.busy) return;
  const cfg = CFG.server.snapshots || {};
  const worldMB = Math.round(require('./lib/snapshots').dirSize(path.join(SERVER_DIR, 'world')) / 1048576);
  const throttle = worldMB > (cfg.autoThrottleAtMB || 500);
  const intervalMin = throttle ? (cfg.throttleEveryMin || 20) : (cfg.autoEveryMin || 10);
  if (Date.now() - lastAutoSnap < intervalMin * 60 * 1000) return;
  lastAutoSnap = Date.now();
  try { await snap.createSnapshot('auto'); } catch (e) { console.error('[center] 自动快照失败:', e.message); }
}, 60 * 1000);

// 30s 内存采样：>90% 物理占用 → warnRuntime=true
setInterval(() => {
  const used = os.totalmem() - os.freemem();
  STATE.warnRuntime = (used / os.totalmem()) > 0.9;
  refreshSpawnPct();
}, 30 * 1000);

// ---------- center 端口监听（回环 + 顺延 + port.json） ----------
function writeCenterPortFile(port) {
  try {
    cfgStore.atomicWriteJson(CENTER_PORT_FILE, { port, bootTime, pid: process.pid, ts: Date.now() });
  } catch (e) {}
}
function listenWithFallback() {
  const startPort = Number(process.env.AICRAFT_CENTER_PORT) || 3100;
  let p = startPort;
  const tryListen = () => {
    const srv = http.createServer(handle);
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && p < startPort + 100) {
        p += 10;
        console.log(`[center] 端口 ${p - 10} 被占，顺延到 ${p}`);
        tryListen();
      } else {
        console.error('[center] 致命错误：' + e.message);
        process.exit(1);
      }
    });
    srv.listen(p, '127.0.0.1', () => {
      console.log(`[center] AICraft 指挥中心 http://127.0.0.1:${p}`);
      console.log(`[center] Node: ${fs.existsSync(NODE_BIN) ? '便携版' : '系统'} | Java: ${fs.existsSync(JDK_BIN) ? '便携版' : '系统'}`);
      writeCenterPortFile(p);
    });
  };
  tryListen();
}
listenWithFallback();

// 退出清理
process.on('exit', () => { for (const n of Object.keys(STATE.bots)) stopBot(n); try { killTree(STATE.server.pid); } catch (e) {} });
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log(`[center] 收到 ${sig}，清理子进程…`);
  for (const n of Object.keys(STATE.bots)) stopBot(n);
  try { killTree(STATE.server.pid); } catch (e) {}
  process.exit(0);
}));
