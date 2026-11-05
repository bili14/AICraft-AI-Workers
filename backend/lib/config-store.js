// config-store.js — AICraft 配置存储（v2）
// 职责：config.json 原子读写、损坏自动回滚 .bak（留 10 份）、旧 schema 一次性升级 v2、key 打码/占位合并
// 红线：禁止静默 normalize({})；损坏必须回滚最近 .bak；所有写盘走 同目录.tmp → fsync → rename
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BAK_KEEP = 10;

// 6 槽位配色表（与 bot-lite/bot.js 现有配色兜底对齐）
const SLOT_COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171'];

// ---------- 全新默认 v2（发行模板同源） ----------
function buildDefault() {
  return {
    setupWizardDone: false,
    server: {
      host: '127.0.0.1',
      portPref: 25565,
      rconPortPref: 25575,
      xmx: '2G',
      rconPassword: '',
      world: { seed: null, difficulty: 'peaceful', gamemode: 'survival', keepInventory: true, levelType: 'minecraft:normal' },
      snapshots: { autoEveryMin: 10, autoKeep: 5, manualKeep: 20, totalCapMB: 2048, autoThrottleAtMB: 500, throttleEveryMin: 20 },
    },
    memory: { rounds: 5 },
    llm: { decisionIntervalMs: 3000, staggerStartMs: 8000 },
    providers: [
      { id: 'cloud', name: 'Agnes AI', endpoint: 'https://api.agnes-ai.cn/v1/chat/completions', key: '', models: [], defaultModel: '', thinkingStyle: 'budget512', rpmBudget: 60 },
      { id: 'qwen', name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', key: '', models: ['qwen-plus', 'qwen-max', 'qwen-flash'], defaultModel: 'qwen-plus', thinkingStyle: 'qwen', rpmBudget: null },
      { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', key: '', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-v4-flash', thinkingStyle: 'all', rpmBudget: null },
      { id: 'ark', name: '火山方舟', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', key: '', models: [], defaultModel: '', thinkingStyle: 'ark', rpmBudget: null },
    ],
    presets: [
      { id: 'worker', name: '拆建全能工', desc: '会拆会建：TNT爆破 + 蓝图秒建 + 兑换机制', script: 'bot-lite.js', persona: 'persona-worker.json' },
      { id: 'builder', name: '纯建造工', desc: '自由搭建：一格格亲手盖房，不靠脚本', script: 'bot.js', persona: 'persona-builder.json' },
    ],
    bots: [],
  };
}

// ---------- 旧 → v2 一次性升级（真实 key 一字不动） ----------
function upgradeCfg(old) {
  old = old || {};
  const cfg = buildDefault();

  // server 段
  if (old.server && typeof old.server === 'object') {
    const s = old.server;
    cfg.server.host = s.host || '127.0.0.1';
    cfg.server.portPref = s.portPref || s.port || 25565;
    cfg.server.rconPortPref = s.rconPortPref || 25575;
    cfg.server.xmx = s.xmx || '2G';
    cfg.server.rconPassword = s.rconPassword || '';
    if (s.world && typeof s.world === 'object') {
      cfg.server.world = {
        seed: s.world.seed != null ? s.world.seed : null,
        difficulty: s.world.difficulty || 'peaceful',
        gamemode: s.world.gamemode || 'survival',
        keepInventory: s.world.keepInventory !== false,
        levelType: 'minecraft:normal',
      };
    }
    if (s.snapshots && typeof s.snapshots === 'object') {
      cfg.server.snapshots = Object.assign({}, cfg.server.snapshots, s.snapshots);
    }
  }

  // memory 段
  if (old.memory && typeof old.memory === 'object') cfg.memory.rounds = old.memory.rounds || 5;

  // llm 段（旧 model.decisionIntervalMs 迁入）
  const oldModel = old.model && typeof old.model === 'object' ? old.model : {};
  cfg.llm.decisionIntervalMs = Number(oldModel.decisionIntervalMs) || 3000;
  cfg.llm.staggerStartMs = 8000;

  // providers 段：保留已有（含真实 key 不动），补缺失 provider 与新字段
  const provList = Array.isArray(old.providers) ? old.providers.filter(p => p && typeof p === 'object' && p.id) : [];
  const THINK_DEFAULT = { cloud: 'budget512', qwen: 'qwen', ark: 'ark', deepseek: 'all' };
  const byId = {};
  for (const p of provList) byId[p.id] = p;
  for (const def of cfg.providers) {
    const ex = byId[def.id];
    if (ex) {
      def.name = ex.name || def.name;
      def.endpoint = ex.endpoint || def.endpoint;
      def.key = ex.key || ''; // 真实 key 原样保留
      def.models = Array.isArray(ex.models) ? ex.models.filter(m => typeof m === 'string' && m) : (ex.model ? [ex.model] : []);
      def.defaultModel = ex.defaultModel || (def.models[0] || '');
      def.thinkingStyle = ex.thinkingStyle || THINK_DEFAULT[def.id] || 'all';
      def.rpmBudget = ex.rpmBudget != null ? ex.rpmBudget : (def.id === 'cloud' ? 60 : null);
    }
  }
  // 旧配置里有、但已下线的内置条目 → 升级时清掉（本地 LM Studio 已下架，改用「添加供应商」自行接入）
  const RETIRED_IDS = new Set(['lmstudio']);
  // 旧配置里有、新默认列表里没有的 provider（用户手动加的）→ 原样保留，别升级一次就吃掉了
  const defaultIds = new Set(cfg.providers.map(p => p.id));
  const EXTRA = provList.filter(p => !defaultIds.has(p.id) && !RETIRED_IDS.has(p.id));
  cfg.providers = cfg.providers.concat(EXTRA.map(p => ({
    id: p.id, name: p.name || p.id, endpoint: p.endpoint || '', key: p.key || '',
    models: Array.isArray(p.models) ? p.models.filter(m => typeof m === 'string' && m) : [],
    defaultModel: p.defaultModel || '', thinkingStyle: p.thinkingStyle || 'all', rpmBudget: p.rpmBudget != null ? p.rpmBudget : null,
  })));

  // presets 段：对齐新模板名
  cfg.presets = Array.isArray(old.presets) && old.presets.length ? old.presets.map(p => {
    const o = Object.assign({}, p);
    if (o.id === 'worker') o.persona = 'persona-worker.json';
    if (o.id === 'builder') o.persona = 'persona-builder.json';
    return o;
  }) : cfg.presets;

  // bots 段：AI-Bot-L→L1；provider→providerId；补新字段
  const provById = (id) => cfg.providers.find(p => p.id === id);
  const oldBots = Array.isArray(old.bots) ? old.bots.filter(b => b && typeof b === 'object' && b.name) : [];
  // 一次性改名：AI-Bot-L → AI-Bot-L1（AI-Bot-L2 等已合规）
  const renamed = oldBots.map(b => {
    if (b.name === 'AI-Bot-L') return Object.assign({}, b, { name: 'AI-Bot-L1' });
    return b;
  });
  cfg.bots = renamed.map((b, i) => {
    const providerId = b.providerId || b.provider || (oldModel.provider || 'cloud');
    const prov = provById(providerId);
    const model = b.model || (prov && prov.defaultModel) || '';
    return {
      name: b.name,
      nick: b.nick || b.name,
      script: b.script || 'bot-lite.js',
      persona: b.persona || (i === 0 ? 'personas/persona-1.json' : 'personas/persona-2.json'),
      providerId,
      model,
      keyMode: b.keyMode === 'own' ? 'own' : 'shared',
      ownKey: b.ownKey || '',
      color: b.color || SLOT_COLORS[i % 6],
      viewer: b.viewer !== false, // 老 bot 保留 viewer:true
      viewerPortPref: b.viewerPortPref || (3000 + 2 * i + 1),
      streamPortPref: b.streamPortPref || (3000 + 2 * i + 2),
      spawnSlot: Number.isInteger(b.spawnSlot) ? b.spawnSlot : i,
      memoryRounds: b.memoryRounds || cfg.memory.rounds,
    };
  });

  // model 块过渡镜像（bot 脚本过渡期仍 require .model.cloud）——见 migrateModelBlock
  cfg.model = oldModel && Object.keys(oldModel).length ? oldModel : undefined;
  // 已下线的内置条目不再带进 model 镜像（本地模型改用「添加供应商」自行接入）
  if (cfg.model && cfg.model.lmstudio) delete cfg.model.lmstudio;

  // 首启向导标记：老配置已在开发，标 true 避免升级后弹向导；全新默认 false
  cfg.setupWizardDone = old.setupWizardDone === true || old.setupWizardDone === false ? old.setupWizardDone : (oldBots.length ? true : false);
  return cfg;
}

// ---------- 原子写 ----------
function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const body = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch (e) {}
  }
  // Windows 同卷覆盖 rename 原子；先删目标再 rename 防 Windows rename 覆盖失败
  try { fs.renameSync(tmp, file); }
  catch (e) {
    if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') {
      try { fs.unlinkSync(file); } catch (e2) {}
      fs.renameSync(tmp, file);
    } else {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
  }
}

// .bak 滚动：留最近 BAK_KEEP 份
function rotateBaks(configPath) {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let baks = [];
  try {
    baks = fs.readdirSync(dir).filter(n => n.indexOf(base + '.bak-') === 0)
      .map(n => ({ name: n, mtime: (fs.statSync(path.join(dir, n)).mtimeMs) }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return; }
  for (const old of baks.slice(BAK_KEEP)) {
    try { fs.unlinkSync(path.join(dir, old.name)); } catch (e) {}
  }
}

// 读盘上现有 config.json；损坏则回滚最新 .bak；再坏返回 null
function readRaw(configPath) {
  const readOne = (f) => {
    const raw = fs.readFileSync(f, 'utf8');
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    return JSON.parse(clean);
  };
  try {
    return { cfg: readOne(configPath), source: configPath, restoredFrom: null };
  } catch (e) {
    // 找最新 .bak
    const dir = path.dirname(configPath);
    const base = path.basename(configPath);
    let baks = [];
    try {
      baks = fs.readdirSync(dir).filter(n => n.indexOf(base + '.bak-') === 0)
        .map(n => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e2) {}
    for (const b of baks) {
      try {
        const bakPath = path.join(dir, b.name);
        return { cfg: readOne(bakPath), source: bakPath, restoredFrom: b.name };
      } catch (e3) { /* 下一个 */ }
    }
    return null;
  }
}

// 加载入口：返回 {cfg, broken}；broken=null 表示配置健康
function loadConfig(configPath) {
  const r = readRaw(configPath);
  if (!r) {
    // 盘上无任何可读配置 → 默认配置启动，但标记损坏（引导用户）
    return { cfg: buildDefault(), broken: { restoredFrom: null, reason: 'config.json 不存在或全部备份损坏，已用默认配置启动' } };
  }
  const cfg = upgradeCfg(r.cfg);
  if (r.restoredFrom) {
    return { cfg, broken: { restoredFrom: r.restoredFrom, reason: 'config.json 损坏，已从最近备份恢复' } };
  }
  return { cfg, broken: null };
}

// 保存：先 copy 现盘文件到 .bak（滚动），再原子写新内容
function saveConfig(configPath, cfg) {
  // 保存前备份当前盘上文件
  try {
    if (fs.existsSync(configPath)) {
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const bak = configPath + '.bak-' + ts;
      fs.copyFileSync(configPath, bak);
    }
  } catch (e) {}
  rotateBaks(configPath);
  atomicWriteJson(configPath, cfg);
  // 写后自检
  const back = fs.readFileSync(configPath, 'utf8');
  if (back.charCodeAt(0) === 0xFEFF) throw new Error('config 写入产生 BOM，已拒绝');
  JSON.parse(back);
}

// ---------- key 打码 / 占位合并 ----------
// GET /api/config 返回前调用：所有 key/ownKey/apiKey 打码
function maskConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (Array.isArray(out.providers)) {
    for (const p of out.providers) {
      if (p && p.key) { p.keyLen = String(p.key).length; p.key = '****'; }
      else if (p) { p.keyLen = 0; }
    }
  }
  if (Array.isArray(out.bots)) {
    for (const b of out.bots) { if (b && b.ownKey) b.ownKey = '****'; }
  }
  // 过渡 model 块里的 apiKey 也必须打码（bot 脚本过渡期仍读 model.cloud.apiKey）
  if (out.model && typeof out.model === 'object') {
    for (const k of Object.keys(out.model)) {
      if (out.model[k] && typeof out.model[k] === 'object' && out.model[k].apiKey) out.model[k].apiKey = '****';
    }
  }
  return out;
}

// PUT /api/config 合并：body 里 key/ownKey 为空串或 '****' 时保持原 key 不改写
function mergeSavedInto(current, saved) {
  const cfg = JSON.parse(JSON.stringify(current));
  if (saved.server && typeof saved.server === 'object') cfg.server = Object.assign({}, cfg.server, saved.server);
  if (saved.memory && typeof saved.memory === 'object') cfg.memory = Object.assign({}, cfg.memory, saved.memory);
  if (saved.llm && typeof saved.llm === 'object') cfg.llm = Object.assign({}, cfg.llm, saved.llm);
  if (Array.isArray(saved.providers)) {
    cfg.providers = saved.providers.map(p => {
      const old = cfg.providers.find(x => x.id === p.id) || {};
      const key = (!p.key || p.key === '****') ? (old.key || '') : p.key;
      return Object.assign({}, p, { key });
    });
  }
  if (Array.isArray(saved.presets)) cfg.presets = saved.presets;
  if (Array.isArray(saved.bots)) {
    cfg.bots = saved.bots.map(b => {
      const old = cfg.bots.find(x => x.name === b.name) || {};
      const ownKey = (!b.ownKey || b.ownKey === '****') ? (old.ownKey || '') : b.ownKey;
      return Object.assign({}, b, { ownKey });
    });
  }
  if (saved.setupWizardDone != null) cfg.setupWizardDone = !!saved.setupWizardDone;
  return cfg;
}

// 过渡：把 providers 镜像回旧 model 块（bot 脚本 require .model.cloud 期间兼容）
function migrateModelBlock(cfg) {
  const find = (id) => cfg.providers.find(p => p.id === id);
  cfg.model = cfg.model || {};
  const set = (slot, p) => {
    if (p) cfg.model[slot] = { endpoint: p.endpoint || '', apiKey: p.key || '', model: p.defaultModel || (p.models && p.models[0]) || '' };
  };
  set('cloud', find('cloud') || find('agnes'));
  set('qwen', find('qwen'));
  set('ark', find('ark'));
  cfg.model.provider = (find('cloud') || {}).id || 'cloud';
  cfg.model.decisionIntervalMs = (cfg.llm && cfg.llm.decisionIntervalMs) || 3000;
  return cfg;
}

function randomRconPassword() {
  return crypto.randomBytes(16).toString('hex'); // 32 位 hex
}

module.exports = {
  SLOT_COLORS,
  buildDefault,
  upgradeCfg,
  loadConfig,
  saveConfig,
  maskConfig,
  mergeSavedInto,
  migrateModelBlock,
  randomRconPassword,
  atomicWriteJson,
};
