// bot-lite.js — 无限破坏工接入版（v8，2026-10-17）
// 角色：无限破坏工（bot-player-mind.json）。没有目标没有终点，遇树砍/遇土挖/遇矿挖/挡路全拆。
// 设计目标：视觉流畅（bot 大部分时间在动，决策空窗 2~3s），动作做完立即下一轮（无 sleep）。
// 系统保障：spawn 发石工具+铁剑+弓+箭+皮甲+牛排+dirt；采前自动换工具、见怪补战斗装、饿了先补货再吃。
// 脱困：60s 无位移 / 卡水 10s / 血<10 / 连续 3 次失败 → safeTp 到脱困点 (36,68,-26)。
// 服务器 difficulty=normal（真刷怪）；破坏工正常模式打怪，死亡自然重生（spawn 初始化重跑）。
// 保留 HUD(3001)+思考流(3002)+JSONL 流水。驱动模型默认 gemma-4-e4b-it（LM Studio 本地），--model 可切。
'use strict';
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const mineflayerViewer = require('prismarine-viewer').mineflayer;
const Vec3 = require('vec3').Vec3;
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
// 二期改造：provider 路由改为 env 注入（center 下发）→ argv → config.json 兜底；
// 不再按模型名前缀猜 cloud/qwen/ark/local。思考参数由 AICRAFT_THINKING_STYLE 枚举驱动。
const RUN = {
  providerId: 'local',
  thinkingStyle: 'none',
  name: 'AI-Bot-L1',
  viewerPort: 3001,
  streamPort: 3002,
  minutes: 30,
  llmUrl: '',
  model: 'gemma-4-e4b-it',
  apiKey: '',
  maxTokens: 12288,
  temperature: 0.3,
  rconPort: 25575,
  serverPort: 25565,
  memoryRounds: 5,
  noViewer: false,
  persona: '',
  spawnSlot: 0,
  decisionMs: 3000,
  staggerStartMs: 8000,
  color: '',
};
// 配置文件：优先读环境变量 CONFIG_PATH，兜底项目根 config.json（防御式读取，新旧 schema 都能活）
const CONFIG_FILE = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json');
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { console.log('[config] 读取配置失败：' + e.message); }
// providers 兼容两种 schema：新 schema 为数组 [{id,endpoint,key,defaultModel,thinkingStyle}]，旧 schema 为对象 {cloud:{endpoint,apiKey}}
function providersMap(cfg) {
  const out = {};
  if (Array.isArray(cfg.providers)) cfg.providers.forEach((p) => { out[p.id] = { endpoint: p.endpoint, apiKey: p.key, defaultModel: p.defaultModel, thinkingStyle: p.thinkingStyle }; });
  else if (cfg.providers && typeof cfg.providers === 'object') for (const [id, p] of Object.entries(cfg.providers)) out[id] = { endpoint: p.endpoint, apiKey: p.key || p.apiKey, defaultModel: p.defaultModel || p.model, thinkingStyle: p.thinkingStyle };
  if (!out.lmstudio && cfg.model && cfg.model.lmstudio) out.lmstudio = { endpoint: cfg.model.lmstudio.endpoint, apiKey: cfg.model.lmstudio.apiKey || '', defaultModel: cfg.model.lmstudio.model || '', thinkingStyle: 'local' };
  return out;
}
const PROV_MAP = providersMap(CFG);
// 找到自己的 bot 配置条目：argv --name 精确匹配优先，否则按本脚本文件名匹配 config.bots[].script
const SELF_SCRIPT = path.basename(__filename);
const OWN_ENTRY = (CFG.bots || []).find((b) => b.name === process.argv[process.argv.indexOf('--name') + 1] && process.argv.includes('--name'))
  || (CFG.bots || []).find((b) => b.script === SELF_SCRIPT) || null;
const TARGET = { log: 24, stone: 40 };
// 动态出生点（二期改造，替代固定 RESCUE_POINT=(36,68,-26)）：
// spawn 后以世界出生点为中心铺 7×6 安全平台，本站按 spawnSlot 落 2×3 方阵一格；下方 spawn 事件里测定
const SLOT_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]]; // spawnSlot 0..5 → (dx,dz)
const PLATFORM = { cx: 0, cy: 64, cz: 0, sx: 0, sy: 65, sz: 0 }; // 中心(cx,cy,cz) + 本站落点(sx,sy,sz)，spawn 时测定
// 统一柔和色板（两脚本同一份；流页面/聊天/大厅共用，为 bot3+ 预留）
const BOT_COLOR_PALETTE = ['#60a5fa', '#c084fc', '#fb923c', '#f87171', '#22d3ee', '#a3e635', '#fbbf24', '#34d399'];
function colorForName(who) {
  if (RUN.color && String(who) === RUN.name) return RUN.color; // 自己：env AICRAFT_COLOR 优先
  const m = String(who || '').match(/L(\d*)$/); // AI-Bot-L(=L1) / AI-Bot-L2..L6 → 槽位色
  if (m) return BOT_COLOR_PALETTE[((m[1] ? Number(m[1]) : 1) - 1) % BOT_COLOR_PALETTE.length];
  let h = 0; for (let i = 0; i < String(who || '').length; i++) h = (h * 31 + String(who || '').charCodeAt(i)) >>> 0;
  return BOT_COLOR_PALETTE[h % BOT_COLOR_PALETTE.length];
}
let argvModel = '';
process.argv.forEach((a, i) => {
  if (a === '--name') RUN.name = process.argv[i + 1];
  if (a === '--viewer-port') RUN.viewerPort = Number(process.argv[i + 1]);
  if (a === '--stream-port') RUN.streamPort = Number(process.argv[i + 1]);
  if (a === '--minutes') RUN.minutes = Number(process.argv[i + 1]);
  if (a === '--no-viewer') RUN.noViewer = true;
  if (a === '--server-port') RUN.serverPort = Number(process.argv[i + 1]);
  if (a === '--rcon-port') RUN.rconPort = Number(process.argv[i + 1]);
  if (a === '--memory-rounds') RUN.memoryRounds = Number(process.argv[i + 1]) || 5;
  if (a === '--persona') RUN.persona = process.argv[i + 1];
  if (a === '--model') argvModel = process.argv[i + 1]; // env 优先，argv 兜底（不再按模型名前缀猜 provider）
});
// env 优先 → argv → config 条目 → 默认值
RUN.name = (process.argv.includes('--name') && process.argv[process.argv.indexOf('--name') + 1]) || (OWN_ENTRY && OWN_ENTRY.name) || RUN.name;
RUN.providerId = process.env.AICRAFT_PROVIDER_ID || (OWN_ENTRY && OWN_ENTRY.providerId) || 'local';
const PROV = PROV_MAP[RUN.providerId] || PROV_MAP.local || {};
RUN.llmUrl = process.env.AICRAFT_LLM_URL || PROV.endpoint || (RUN.providerId === 'local' ? 'http://127.0.0.1:1234/v1/chat/completions' : '');
RUN.apiKey = process.env.AICRAFT_LLM_KEY || PROV.apiKey || '';
RUN.model = process.env.AICRAFT_MODEL || argvModel || (OWN_ENTRY && OWN_ENTRY.model) || PROV.defaultModel || RUN.model;
RUN.thinkingStyle = process.env.AICRAFT_THINKING_STYLE || PROV.thinkingStyle || 'all';
RUN.spawnSlot = Math.max(0, Math.min(5, Number(process.env.AICRAFT_SPAWN_SLOT != null ? process.env.AICRAFT_SPAWN_SLOT : (OWN_ENTRY && OWN_ENTRY.spawnSlot != null ? OWN_ENTRY.spawnSlot : 0)) || 0));
RUN.decisionMs = Number(process.env.AICRAFT_DECISION_MS || (CFG.llm && CFG.llm.decisionIntervalMs) || (CFG.model && CFG.model.decisionIntervalMs) || 3000);
RUN.staggerStartMs = Number((CFG.llm && CFG.llm.staggerStartMs) || 8000);
RUN.color = process.env.AICRAFT_COLOR || (OWN_ENTRY && OWN_ENTRY.color) || '';
RUN.memoryRounds = Number(process.env.AICRAFT_MEMORY_ROUNDS || RUN.memoryRounds);
RUN.persona = RUN.persona || (OWN_ENTRY && OWN_ENTRY.persona) || ('personas/' + RUN.name + '.json');
RUN.viewerOn = !RUN.noViewer && (!OWN_ENTRY || OWN_ENTRY.viewer !== false);
console.log('[配置] name=' + RUN.name + ' provider=' + RUN.providerId + ' model=' + RUN.model + ' thinking=' + RUN.thinkingStyle + ' slot=' + RUN.spawnSlot + ' decisionMs=' + RUN.decisionMs + ' viewer=' + (RUN.viewerOn ? RUN.viewerPort : 'off'));

const LOG_FAMILY = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'dark_oak_log', 'acacia_log', 'mangrove_log', 'cherry_log'];
const LEAF_FAMILY = ['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'dark_oak_leaves', 'acacia_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves'];
const STONE_FAMILY = ['stone', 'andesite', 'diorite', 'granite'];
const CRAFTABLE = ['planks', 'sticks', 'crafting_table', 'wooden_axe', 'wooden_pickaxe'];
const PLANK_FAMILY = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'dark_oak_planks', 'acacia_planks', 'mangrove_planks', 'cherry_planks'];
const HOSTILE_SET = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'husk', 'drowned', 'pillager', 'witch', 'slime']);

// ---------- RCON 内嵌（仅 tp 脱困用） ----------
async function rconExec(cmd, _tries = 3) {
  // 2 个 bot 共用 RCON 25575，加失败重试防竞争超时（之前单 bot 时独立脚本连不稳）
  for (let _t = 0; _t < _tries; _t++) {
    const r = await rconExecOnce(cmd);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}
function rconExecOnce(cmd) {
  return new Promise((resolve) => {
    let s = null;
    const timer = setTimeout(() => { try { if (s) s.end(); } catch (e) {} resolve(false); }, 5000); // RCON 无响应 5s 兜底，防 await 永久挂起（破坏工动作 60s 超时根因）
    s = net.connect(RUN.rconPort, '127.0.0.1');
    const buf = [];
    let authed = false;
    const finish = (v) => { clearTimeout(timer); try { s.end(); } catch (e) {} resolve(v); };
    s.on('data', (d) => {
      buf.push(d);
      const all = Buffer.concat(buf);
      if (all.length < 12) return;
      const len = all.readInt32LE(0);
      if (all.length < len + 4) return;
      const id = all.readInt32LE(4), type = all.readInt32LE(8);
      buf.length = 0;
      if (!authed && type === 2) { authed = id !== -1; if (!authed) return finish(false); s.write(authPkt(100, 2, cmd)); return; } // 命令包 type=2（曾误用登录 type=3 → give/tp 全不执行）
      if (authed && type === 0) return finish(true);
    });
    s.on('error', () => finish(false));
    s.on('close', () => finish(false));
    s.on('connect', () => {
      // 登录口令优先 env AICRAFT_RCON_PWD（center 下发），兜底 server.properties
      const envPwd = process.env.AICRAFT_RCON_PWD;
      if (envPwd) { s.write(authPkt(100, 3, envPwd)); return; }
      fs.readFile(path.join(__dirname, '..', 'server', 'server.properties'), 'utf8', (e, txt) => {
        const pwd = (!e && (txt.match(/rcon\.password=(.*)/) || [])[1] || '').trim();
        s.write(authPkt(100, 3, pwd)); // 登录包 type=3
      });
    });
    function authPkt(reqId, type, payload) {
      const p = Buffer.from(payload, 'utf8');
      const b = Buffer.alloc(14 + p.length);
      b.writeInt32LE(10 + p.length, 0); b.writeInt32LE(reqId, 4); b.writeInt32LE(type, 8); p.copy(b, 12); b.writeInt16LE(0, 12 + p.length);
      return b;
    }
  });
}

// ---------- bot ----------
const bot = mineflayer.createBot({ host: '127.0.0.1', port: RUN.serverPort || 25565, username: RUN.name, auth: 'offline', version: '1.21.4' });
bot.loadPlugin(pathfinder);
bot.on('kicked', (r) => console.log('[kick]', r));
bot.on('error', (e) => console.log('[err]', e.message));

let viewerHandle = null;
const decisions = [];        // 思考流历史
let DEC_SEQ = 0, CHAT_SEQ = 0;   // 决策/对话自增 id（供决策流页增量追加去重）
const BOOT_TAG = Date.now().toString(36);   // 启动时间戳前缀：bot 重启后 id 全局唯一，旧页面 seenChat 不会误判新消息为已读
const LOG_FILE = path.join(__dirname, 'logs', `decisions-lite-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8)}-${RUN.name}-${Date.now() % 100000}.jsonl`);
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function appendLog(o) { try { fs.appendFileSync(LOG_FILE, JSON.stringify(o) + '\n'); } catch (e) {} }

const RUNTIME = { homePos: null, startedAt: Date.now(), lastPos: null, lastMoveAt: Date.now(), lastHpRetreat: 0, lastResult: '开局', waterSince: null, waterBrokenAt: null, lastReply: '', lastReasoning: '', failStreak: 0, obsNoted: false, lastAutoPillar: 0, autoPillarStreak: 0, brokenCount: 0, manualBroken: 0, tntBroken: 0, rockBroken: 0, toolStage: 0, manualRewardNext: 32, manualRewardStep: 32, manualChop: 0, woodPoint: 0, stoneExchange: 0, builtCount: 0, lastBuild: '', teammateChats: [], selfChats: [], roundHistory: [], injectedMsg: '', llmBusy: false, busySince: null,
  // 二期改造：/state meta 契约（前端对话页通过 center 代理消费）
  meta: { spawned: false, spawnedAt: 0, spawnTimeout: false, viewerDown: false, viewerDownReason: '', errorCode: '', lastErr: '', cooling: false, personaMissing: '' },
  llmErr: { code: '', msg: '', ts: 0, streak: 0, circuitUntil: 0, nextAuthProbeAt: 0 } };
// 60s 未进厂 → meta.spawnTimeout=true（不自杀，转黄给前端）
setTimeout(() => { if (!RUNTIME.meta.spawned) RUNTIME.meta.spawnTimeout = true; }, 60000);
// 无 LLM 地址 = 还没有大脑：不创建 bot 进程崩溃，/state 明确报 E_NO_PROVIDER
if (!RUN.llmUrl) { RUNTIME.meta.errorCode = 'E_NO_PROVIDER'; RUNTIME.meta.lastErr = '这个工人还没有大脑：去「API 服务商」配一把钥匙后再启动'; console.log('[启动] ' + RUNTIME.meta.lastErr); }
const PICKAXE_FAMILY = ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'iron_ore', 'coal_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore', 'netherrack', 'sandstone', 'red_sandstone', 'bricks', 'mossy_cobblestone'];
const TOOL_NAMES = ['石', '铁', '铁·效率I', '钻石·效率I', '钻石·效率II', '钻石·效率III', '合金·效率III', '合金·效率IV', '合金·效率V+耐久III'];
// 各档镐物品串（含附魔；索引 0=开局石镐，1-8=升级档）。升级发放与 ensureToolForBlock 补发统一查此表，保证附魔一致。
// 1.21.4 data-component 格式（旧式 {Enchantments:[...lvl:Ns]} 已废弃、RCON 报 trailing data）：
// [minecraft:enchantments={levels:{"minecraft:efficiency":N}}]，多附魔用逗号并列。
const PICKAXE_SPEC_BY_STAGE = [
  'stone_pickaxe',
  'iron_pickaxe',
  'minecraft:iron_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":1}}]',
  'minecraft:diamond_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":1}}]',
  'minecraft:diamond_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":2}}]',
  'minecraft:diamond_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":3}}]',
  'minecraft:netherite_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":3}}]',
  'minecraft:netherite_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":4}}]',
  'minecraft:netherite_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":5,"minecraft:unbreaking":3}}]',
];
// 手动拆除计数 + 奖励投放 + 工具升级阶梯（主人需求）：只算手动拆（bot.dig 挖/砍），TNT 炸的不算；
// ① 手动拆满 manualRewardNext 补投 1 颗 TNT；② 镐挖的石头/矿累计 rockBroken 升级镐（9档：71→191→369→613→960→1520→2196→3236，满级4792）
function manualBreak(block) {
  RUNTIME.brokenCount++; RUNTIME.manualBroken++;
  // 工具升级：镐挖的石头/矿累积 → 镐升级（石→铁→效率I~V+耐久III，九档）
  if (block && PICKAXE_FAMILY.includes(block)) {
    RUNTIME.rockBroken++;
    // 石头/矿石 128:1 兑换点（v3 兜底渠道，10-20 新增）：只算自己手挖的（TNT炸/捡不算），满 128 换 1 兑换点，
    // 同时从背包 clear 对应方块（有多少扣多少，不足清到没有为止、不回退攒点——与原木实扣同规则）
    RUNTIME.stoneExchange++;
    if (RUNTIME.stoneExchange >= 128) {
      RUNTIME.stoneExchange -= 128;
      RUNTIME.woodPoint = Math.min(99, RUNTIME.woodPoint + 1);
      let remainRock = 128;
      for (const rk of PICKAXE_FAMILY) {
        if (remainRock <= 0) break;
        const have = invCount(rk);
        if (have > 0) {
          const n = Math.min(have, remainRock);
          rconExec(`clear ${RUN.name} minecraft:${rk} ${n}`);
          remainRock -= n;
        }
      }
      RUNTIME.lastResult = `石头兑换：手挖满 ${RUNTIME.stoneExchange + 128} 块石头/矿，+1 兑换点（当前 ${RUNTIME.woodPoint}）`;
      console.log(`[stone-point] 手挖满128石头 → +1兑换点 → woodPoint=${RUNTIME.woodPoint}（背包已实扣128）`);
      try { appendLog({ ts: new Date().toISOString(), event: 'stone-point', stoneExchange: RUNTIME.stoneExchange, woodPoint: RUNTIME.woodPoint }); } catch (e) {}
    }
    const STAGES = [71, 191, 369, 613, 960, 1520, 2196, 3236];
    while (RUNTIME.toolStage < 8 && RUNTIME.rockBroken >= STAGES[RUNTIME.toolStage]) {
      RUNTIME.toolStage++;
      rconExec(`give ${RUN.name} ${PICKAXE_SPEC_BY_STAGE[RUNTIME.toolStage]} 1`);
      RUNTIME.lastResult = `镐升级！挖满 ${RUNTIME.rockBroken} 块石头，镐升到${TOOL_NAMES[RUNTIME.toolStage]}镐`;
      console.log(`[工具升级] rockBroken=${RUNTIME.rockBroken} → ${TOOL_NAMES[RUNTIME.toolStage]}镐`);
      try { appendLog({ ts: new Date().toISOString(), event: 'tool-upgrade', stage: RUNTIME.toolStage, rockBroken: RUNTIME.rockBroken }); } catch (e) {}
    }
  }
  if (RUNTIME.manualBroken >= RUNTIME.manualRewardNext) {
    RUNTIME.manualRewardNext += RUNTIME.manualRewardStep;
    if (invCount('tnt') < 60) {
      rconExec(`give ${RUN.name} tnt 1`);
      RUNTIME.lastResult = `奖励：手动拆满 ${RUNTIME.manualBroken} 块，补投 TNT ×1（背包 TNT=${invCount('tnt')}/60，用掉才能继续赚）`;
      console.log(`[TNT奖励] 手动拆满 ${RUNTIME.manualBroken}，补投 TNT ×1（当前 ${invCount('tnt')}/60）`);
      try { appendLog({ ts: new Date().toISOString(), event: 'tnt-reward', manualBroken: RUNTIME.manualBroken, tnt: invCount('tnt') }); } catch (e) {}
    } else {
      RUNTIME.lastResult = 'TNT 已达上限 60/60，用掉一些才能继续赚 TNT（手动拆仍在累计）';
      console.log(`[TNT奖励] 背包 TNT 已满 60，暂停奖励（用完再赚）`);
    }
  }
}

// 原木自动兑换（v3，10-20）：不再要求手砍——只要背包有原木就自动扣，8 个原木 = 1 兑换点（捡到/手砍都算）。
// 每轮决策前调用：查背包原木总数，每满 8 扣 8 换 1 点；不足 8 不扣继续攒。扣减逐种 clear（/clear 服务器侧直接移除、不掉落物）。
async function autoWoodExchange() {
  if (!bot.entity) return;
  const logs = invAny(LOG_FAMILY);
  const gained = Math.floor(logs / 8);
  if (gained < 1) return;
  let remainLog = gained * 8;
  for (const lg of LOG_FAMILY) {
    if (remainLog <= 0) break;
    const have = invCount(lg);
    if (have > 0) {
      const n = Math.min(have, remainLog);
      await rconExec(`clear ${RUN.name} minecraft:${lg} ${n}`);
      remainLog -= n;
    }
  }
  RUNTIME.woodPoint = Math.min(99, RUNTIME.woodPoint + gained);
  console.log(`[wood-point] 背包原木${logs} → 自动兑换 +${gained}点 → woodPoint=${RUNTIME.woodPoint}（已实扣${gained * 8}原木）`);
  try { appendLog({ ts: new Date().toISOString(), event: 'wood-point', logs, gained, woodPoint: RUNTIME.woodPoint }); } catch (e) {}
}

// 公屏聊天接收：chat 事件作冗余，统一以 message 组件解析为准；同一条 1.5s 内去重
function chatPlainText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (x.name) return String(x.name);
  if (x.text) return String(x.text);
  if (Array.isArray(x.extra)) return x.extra.map(chatPlainText).join('');
  if (Array.isArray(x)) return x.map(chatPlainText).join('');
  return String(x);
}
let lastChatKey = '', lastChatTs = 0;
function chatNameOf(comp) {
  try { if (comp && comp.json && comp.json.hoverEvent && comp.json.hoverEvent.contents && comp.json.hoverEvent.contents.name) return String(comp.json.hoverEvent.contents.name); } catch (e) {}
  return chatPlainText(comp);
}
function recordTeammateChat(who, msg) {
  who = String(who || '').trim(); msg = String(msg || '').trim();
  if (!who || who === bot.username || !msg) return; // 忽略自己与系统空消息
  const key = who + '|' + msg;
  const now = Date.now();
  if (key === lastChatKey && now - lastChatTs < 1500) return; // chat+message 双通道同发去重
  lastChatKey = key; lastChatTs = now;
  RUNTIME.teammateChats.push({ id: BOOT_TAG + '-' + (++CHAT_SEQ), who, msg, ts: now });
  if (RUNTIME.teammateChats.length > RUN.memoryRounds) RUNTIME.teammateChats.shift();
  try { appendLog({ ts: new Date().toISOString(), event: 'teammate-chat', who, msg }); } catch (e) {}
}
bot.on('chat', (username, message) => { try { recordTeammateChat(username, message); } catch (e) {} });
bot.on('message', (json) => {
  try {
    const tr = json && json.translate;
    // 本服务器聊天格式 translate="<%s> %s"（with[0]=玩家组件, with[1]=内容）；兼容原版 chat.type.text
    if (tr === '<%s> %s' || tr === 'chat.type.text' || tr === 'chat.type.whisper') {
      const who = chatNameOf(json.with[0]);
      const msg = chatPlainText(json.with[1]);
      recordTeammateChat(who, msg);
    }
  } catch (e) {}
});

bot.once('spawn', async () => {
  console.log(`[spawn] ${RUN.name} 落地 ${bot.entity.position.toString()}`);
  // 二期改造：彻底删除固定 RESCUE_POINT=(36,68,-26)。以自己的首次 spawn（世界出生点）为基准：
  // ① RCON 本地探测落点 3×3（熔岩/水/深崖/卡头 → 就近安全偏移）② 7×6 石平台（主体 y-2..y-1、顶面 y、清空 y+1..y+2）
  // ③ 按 spawnSlot 落 2×3 方阵一格，safeTp 校验落位（失败重试并报 tp-failed，不假成功）
  await sleep(1000); // 等首块区块加载，blockAt 才能读到真实方块
  function spawnUnsafe(x, y, z) {
    try {
      const feet = bot.blockAt(new Vec3(x, y, z));
      const below = bot.blockAt(new Vec3(x, y - 1, z));
      const head = bot.blockAt(new Vec3(x, y + 1, z));
      if (feet && (feet.name === 'lava' || feet.name === 'water')) return true;
      if (below && below.name === 'lava') return true;
      if (!below || below.boundingBox === 'empty') return true; // 深崖/悬空
      if (head && head.boundingBox !== 'empty' && head.name !== 'water' && head.name !== 'lava') return true; // 卡头
      return false;
    } catch (e) { return false; } // 区块没加载到就当安全，交给平台 fill 兜底
  }
  const p0 = bot.entity.position.floored();
  let cx = p0.x, cy = p0.y, cz = p0.z;
  if (spawnUnsafe(cx, cy, cz)) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (!spawnUnsafe(cx + dx, cy, cz + dz)) { cx += dx; cz += dz; break; }
    }
  }
  const slot = SLOT_OFFSETS[RUN.spawnSlot] || SLOT_OFFSETS[0];
  PLATFORM.cx = cx; PLATFORM.cy = cy; PLATFORM.cz = cz;
  PLATFORM.sx = cx + slot[0]; PLATFORM.sy = cy + 1; PLATFORM.sz = cz + slot[1];
  console.log(`[spawn] ${RUN.name} 出生点中心 (${cx},${cy},${cz})，slot=${RUN.spawnSlot} → 本站落点 (${PLATFORM.sx},${PLATFORM.sy},${PLATFORM.sz})`);
  try {
    await rconExec(`fill ${cx - 3} ${cy - 2} ${cz - 3} ${cx + 3} ${cy - 1} ${cz + 2} stone`); // 平台主体 y-2..y-1 垫实
    await rconExec(`fill ${cx - 3} ${cy} ${cz - 3} ${cx + 3} ${cy} ${cz + 2} stone`); // 顶面 y
    await rconExec(`fill ${cx - 3} ${cy + 1} ${cz - 3} ${cx + 3} ${cy + 2} ${cz + 2} air`); // 站层+上层清空（防树/叶卡头）
  } catch (e) { console.log('[spawn] 铺平台失败：' + e.message); }
  await sleep(1500); // 等世界区块加载，平台已就位直接 tp
  await safeTp(PLATFORM.sx, PLATFORM.sy, PLATFORM.sz); // 本站槽位落点（脚站平台顶面上方一格）
  await sleep(600);
  RUNTIME.meta.spawned = true; RUNTIME.meta.spawnedAt = Date.now();
  RUNTIME.homePos = bot.entity.position.clone();
  bot.chat('/gamemode survival');
  setMovements();
  // TNT 对账修复（2026-10-20）：MC 服务器端背包不随 bot 进程重启清空，而 manualBroken 是内存变量重启清零。
  // 每次 spawn 先 clear 掉服务器端残留 TNT，让背包 TNT 与内存 manualBroken 重新对齐到 0，避免历史存量叠加导致 TNT 偏多。
  await rconExec(`clear ${RUN.name} minecraft:tnt`);
  await sleep(300);
  // 破坏工 spawn 套装：无食物开局（食物唯一来源=砍树兑换）+ 石镐（工具升级起点）+ 合金斧/铲 + 合金剑 + 下界合金全套保护IV + 盾 + dirt 32 垫脚料兜底（无弓无箭：脚本贴身剑打，弓用不到）
  rconExec(`give ${RUN.name} netherite_axe 1`);
  rconExec(`give ${RUN.name} stone_pickaxe 1`); // 石镐起步，挖石头升级（9档阶梯）
  rconExec(`give ${RUN.name} netherite_shovel 1`);
  rconExec(`give ${RUN.name} netherite_sword 1`);
  // 10-19 战斗系统升级：皮甲 → 下界合金全套 + 保护IV + 盾（1.21.4 data-component 附魔格式）
  rconExec(`give ${RUN.name} minecraft:netherite_helmet[minecraft:enchantments={levels:{"minecraft:protection":4}}] 1`);
  rconExec(`give ${RUN.name} minecraft:netherite_chestplate[minecraft:enchantments={levels:{"minecraft:protection":4}}] 1`);
  rconExec(`give ${RUN.name} minecraft:netherite_leggings[minecraft:enchantments={levels:{"minecraft:protection":4}}] 1`);
  rconExec(`give ${RUN.name} minecraft:netherite_boots[minecraft:enchantments={levels:{"minecraft:protection":4}}] 1`);
  rconExec(`give ${RUN.name} shield 1`);
  rconExec(`give ${RUN.name} dirt 32`);
  // rconExec(`give ${RUN.name} tnt 8`); // 2026-10-20 TNT 对账修复：主人明确去掉开局送 TNT；TNT 唯一来源=手动拆满 32 块奖 1 颗（上限 60）
  rconExec(`give ${RUN.name} flint_and_steel 1`);
  await sleep(800); // 等背包刷新，再把合金套四件穿到对应槽位、盾挂副手
  const armorSlot = { netherite_helmet: 'head', netherite_chestplate: 'torso', netherite_leggings: 'legs', netherite_boots: 'feet' };
  for (const [item, slot] of Object.entries(armorSlot)) {
    const it = bot.inventory.items().find((i) => i.name === item);
    if (it) { try { await bot.equip(it, slot); } catch (e) {} }
  }
  const shield0 = bot.inventory.items().find((i) => i.name === 'shield');
  if (shield0) { try { await bot.equip(shield0, 'off-hand'); } catch (e) {} }
  // viewer 启动（二期改造）：按参数/配置决定是否启动；起不来（端口被占/崩溃）→ meta.viewerDown=true 并写原因，bot 照常跑
  if (RUN.viewerOn) {
    try {
      viewerHandle = mineflayerViewer(bot, { port: RUN.viewerPort });
      // 2.5s 后探测 viewer 端口是否真在听（旧 viewer 无 return 值、EADDRINUSE 不抛错，只能探活）
      setTimeout(() => {
        const probe = http.get({ host: '127.0.0.1', port: RUN.viewerPort, path: '/', timeout: 1500 }, () => { try { probe.destroy(); } catch (e) {} });
        probe.on('error', () => { RUNTIME.meta.viewerDown = true; RUNTIME.meta.viewerDownReason = 'viewer 端口 ' + RUN.viewerPort + ' 未响应（被占用或启动失败）'; console.log('[viewer] ' + RUNTIME.meta.viewerDownReason); });
        probe.on('timeout', () => { try { probe.destroy(); } catch (e) {} });
      }, 2500);
    } catch (e) {
      RUNTIME.meta.viewerDown = true; RUNTIME.meta.viewerDownReason = 'viewer 启动异常: ' + e.message;
      console.log('[viewer] ' + RUNTIME.meta.viewerDownReason);
    }
    // HUD 推送（500ms）
    setInterval(() => {
      if (!bot.viewer || !bot.viewer.io || !bot.entity) return;
      bot.viewer.io.emit('botStatus', {
        health: bot.health, food: bot.food, pos: bot.entity.position.floored().toArray(),
        task: { name: '无限破坏工·自主选拆', progress: RUNTIME.brokenCount },
        lastAction: RUNTIME.lastResult, inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
      });
    }, 500);
  }
  // 卡住检测（60s 无位移 → tp 出生点脱困）+ 卡水（10s 没拆动 → tp 出生点）
  setInterval(async () => {
    if (!bot.entity) return;
    // busy 锁看门狗（主人 10-17 拍板）：busy 锁独立硬上限 200s，到点强制解锁并 tp 脱困重试，防"锁住但没走超时分支、呆住不判"；必须在下面 busy 早退之前执行
    if (RUNTIME.busySince && Date.now() - RUNTIME.busySince > 200000) {
      RUNTIME.llmBusy = false; RUNTIME.actionBusy = false; RUNTIME.busySince = null;
      await safeTp(PLATFORM.sx, PLATFORM.sy, PLATFORM.sz);
      appendLog({ ts: new Date().toISOString(), event: 'busy-timeout-rescue' });
      RUNTIME.lastResult = 'busy 锁超时 200s，强制解除并 tp 脱困重试';
      console.log('[脱困] busy 锁超时 200s，强制解除并 tp 脱困重试');
    }
    if (RUNTIME.llmBusy || RUNTIME.actionBusy) return; // LLM 决策中/动作执行中不判脱困（避免长动作被误判"卡住"反复 tp 打断）
    const p = bot.entity.position;
    if (RUNTIME.lastPos && p.distanceTo(RUNTIME.lastPos) < 0.5 && Date.now() - RUNTIME.lastMoveAt > 60000) {
      console.log('[脱困] 60s 无位移，tp 回出生点');
      await safeTp(PLATFORM.sx, PLATFORM.sy, PLATFORM.sz);
      RUNTIME.lastMoveAt = Date.now(); RUNTIME.lastResult = '脚本脱困：卡住传送回出生点会合平台（已自动清障）';
      appendLog({ ts: new Date().toISOString(), event: 'stuck-rescue' });
    } else if (RUNTIME.lastPos && p.distanceTo(RUNTIME.lastPos) >= 0.5) { RUNTIME.lastMoveAt = Date.now(); }
    RUNTIME.lastPos = p.clone();
    const feet = bot.blockAt(bot.entity.position), head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    // 卡水规则（10-19 对齐清单二-4）：只有"10 秒没正常拆(brokenCount 不涨) + 脚下/头在水里"才判真困才 tp；
    // 进水时记 brokenCount 快照，期间还在正常拆就重置计时，不再一进水就 10s/15s 计时打断，也不再用 nearWater 浅水被困触发
    const inWaterNow = (feet && feet.name === 'water') || (head && head.name === 'water');
    if (inWaterNow) {
      if (RUNTIME.waterSince === null) { RUNTIME.waterSince = Date.now(); RUNTIME.waterBrokenAt = RUNTIME.brokenCount; }
      else if (RUNTIME.brokenCount > RUNTIME.waterBrokenAt) { RUNTIME.waterSince = Date.now(); RUNTIME.waterBrokenAt = RUNTIME.brokenCount; }
      else if (Date.now() - RUNTIME.waterSince > 10000) {
        await safeTp(PLATFORM.sx, PLATFORM.sy, PLATFORM.sz);
        appendLog({ ts: new Date().toISOString(), event: 'water-rescue', mode: 'stuck-still' });
        RUNTIME.waterSince = null; RUNTIME.waterBrokenAt = null; RUNTIME.lastMoveAt = Date.now();
        RUNTIME.lastResult = '脚本检测到脚下有水且 10s 没拆动，tp 回脱困点';
        console.log('[脱困] 脚下有水且 10s 没拆动，tp 回脱困点');
      }
    } else { RUNTIME.waterSince = null; RUNTIME.waterBrokenAt = null; }
    // 空息保险丝缩版：头被实心方块埋住（非树叶，树叶已在清障里处理）→ 直接挖掉窒息源（玩家行为：闷了就挖，不用闪现）
    if (head && head.boundingBox !== 'empty' && head.name !== 'water' && head.name !== 'lava' && !LEAF_FAMILY.includes(head.name)) {
      try { await bot.dig(head); manualBreak(head.name); appendLog({ ts: new Date().toISOString(), event: 'suffocate-dig', block: head.name }); } catch (e) {}
    }
    // 自动吃（饿到 16 以下主动吃；背包有食物就自动吃，食物只靠砍树兑换、系统不再补货）
    if (bot.food < 16) {
      const food = bot.inventory.items().find((i) => i.name === 'cooked_beef' || i.name === 'cooked_porkchop' || i.name === 'bread' || i.name === 'apple' || i.name === 'carrot' || i.name === 'cookie');
      if (food) { bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {}); }
    }
    // 低血撤离（摔落/意外保底，不再掉血观感）
    if (bot.health < 10 && bot.health > 0 && Date.now() - RUNTIME.lastHpRetreat > 45000) {
      RUNTIME.lastHpRetreat = Date.now();
      await safeTp(PLATFORM.sx, PLATFORM.sy, PLATFORM.sz);
      appendLog({ ts: new Date().toISOString(), event: 'low-hp-retreat', hp: bot.health });
      console.log(`[保命] 血量 ${bot.health}/20，撤离回出生点`);
    }
  }, 2000);
  streamServer();
  setTimeout(() => digOutLeaves(), 3000); // 出生点若在树叶丛中，自动挖开（主人 10-17 观察实证：刷新点本身就是卡点）
  mainLoop();
});

// 重生保护（10-19 新增）：死亡重生后短暂自动远离最近怪——
// 配合世界出生点=会合点（server 侧三-3），防"重生落地被围→又死→再被围"死循环。
bot.on('respawn', async () => {
  console.log('[重生保护] bot 重生落地，扫视附近怪');
  try { appendLog({ ts: new Date().toISOString(), event: 'respawn' }); } catch (e) {}
  await sleep(1500); // 等区块加载
  if (!bot.entity) return;
  const mob = bot.nearestEntity((e) => e && e.position && HOSTILE_SET.has(e.name) && bot.entity.position.distanceTo(e.position) < 16);
  if (mob) {
    const d0 = Math.round(bot.entity.position.distanceTo(mob.position));
    const dx = bot.entity.position.x - mob.position.x, dz = bot.entity.position.z - mob.position.z;
    console.log(`[重生保护] 落地 ${d0}格有 ${mob.name}，朝反方向自动跑 10 格远离`);
    try { await gotoNear(bot.entity.position.x + dx, bot.entity.position.y, bot.entity.position.z + dz, 2, 10000); } catch (e) {}
    RUNTIME.lastResult = `重生保护：落地附近${d0}格有${mob.name}，已自动拉开距离`;
    try { appendLog({ ts: new Date().toISOString(), event: 'respawn-protect', mob: mob.name, dist: d0 }); } catch (e) {}
  } else {
    RUNTIME.lastResult = '重生落地安全（附近无怪）';
  }
});

// 自动挖穿身边树叶：头部/身体/四邻的树叶优先，再开头顶空间——不依赖模型决策（主人：完全可以挖几下就打开路）
async function digOutLeaves() {
  if (!bot.entity) return;
  const base = bot.entity.position.floored();
  const spots = [
    base.offset(0, 1, 0), base.offset(0, 2, 0),            // 头上两层
    base.offset(1, 1, 0), base.offset(-1, 1, 0), base.offset(0, 1, 1), base.offset(0, 1, -1), // 四邻头位
    base.offset(1, 0, 0), base.offset(-1, 0, 0), base.offset(0, 0, 1), base.offset(0, 0, -1), // 四邻脚位
  ];
  let dug = 0;
  for (const p of spots) {
    const b = bot.blockAt(p);
    if (b && (LEAF_FAMILY.includes(b.name) || b.name === 'oak_log' || b.name === 'birch_log' || b.name === 'spruce_log')) {
      try { await bot.dig(b); manualBreak(b.name); dug++; await sleep(120); } catch (e) {}
    }
  }
  if (dug > 0) { console.log(`[脱困] 🍃 自动挖穿身边树叶/木头 ${dug} 格，路已打开`); appendLog({ ts: new Date().toISOString(), event: 'dig-out', dug }); }
}

function setMovements() {
  const m = new Movements(bot);
  m.allow1by1towers = true;  // pathfinder 自带垫脚搭塔（玩家行为：到不了的地方垫脚上）
  m.canDig = true; m.allowSprinting = true;
  bot.pathfinder.setMovements(m);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invCount = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
const invAny = (names) => bot.inventory.items().filter((i) => names.includes(i.name)).reduce((s, i) => s + i.count, 0);

function taskProgress() {
  const logs = invAny(LOG_FAMILY);
  const stones = invCount('cobblestone');
  const axe = invCount('wooden_axe'), pick = invCount('wooden_pickaxe');
  const done = [logs >= TARGET.log, axe >= 1, pick >= 1, stones >= TARGET.stone].filter(Boolean).length;
  return { logs, stones, axe, pick, pct: Math.round((done / 4) * 100) };
}

// ---------- LLM ----------
// 二期改造：错误分类 9 类 errorCode + 退避熔断 + center 共享冷却 lease/report（防 6 bot 惊群）
const RETRIABLE_CODES = new Set(['E_429_RATE_LIMIT', 'E_5XX_UPSTREAM', 'E_NETWORK', 'E_TIMEOUT', 'E_BAD_RESPONSE']);
const BACKOFF_STEPS = [2000, 5000, 15000]; // 可退避类：2s→5s→15s
const CIRCUIT_MS = 30000;                  // 熔断 30s
const AUTH_PROBE_MS = 60000;               // 401/403 每 60s 探一次
const CENTER_HTTP = 'http://127.0.0.1:3100';
// 错误 → 前端/模型可见的中文短句
function friendlyLlmErr(code, httpStatus) {
  switch (code) {
    case 'E_401_AUTH': return '🔑 大脑钥匙不对：服务商不认 Key（HTTP 401），去「API 服务商」检查 Key 后重新启动工人';
    case 'E_403_FORBIDDEN': return '💰 大脑余额用完或没开通该模型（HTTP 403）：去服务商官网充值/开通，或换一把 Key';
    case 'E_429_RATE_LIMIT': return '🐢 抢脑子抢太凶了：调用太频繁（HTTP 429），已自动放慢，过一分钟自己好';
    case 'E_5XX_UPSTREAM': return '🤒 AI 服务商今天不舒服（HTTP ' + (httpStatus || 500) + '）：会自动重试';
    case 'E_NETWORK': return '📡 工人和大脑断网了：检查网络/代理；如果是自己电脑上跑的模型，先确认那个服务开着';
    case 'E_TIMEOUT': return '⏳ 大脑走神了：等了很久没回，会自动重试';
    case 'E_BAD_RESPONSE': return '🗣 大脑说胡话了：返回格式看不懂，通常是模型名填错';
    case 'E_NO_PROVIDER': return '这个工人还没有大脑：去「API 服务商」配一把钥匙';
    default: return 'LLM 错误：' + code;
  }
}
// best-effort 向 center 申请共享冷却：有 delayMs 就睡，有 cooldownUntilMs 就标 cooling；center 不可达失败放行
async function leaseWait() {
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.get(CENTER_HTTP + '/api/llm/lease?providerId=' + encodeURIComponent(RUN.providerId), (res) => {
        let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('error', () => reject(new Error('center unreachable')));
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('lease timeout')); });
    });
    if (r && r.delayMs > 0) { console.log('[冷却] center 通知本 provider 错峰 ' + r.delayMs + 'ms'); await sleep(r.delayMs); }
    RUNTIME.meta.cooling = !!(r && r.cooldownUntilMs && r.cooldownUntilMs > Date.now());
  } catch (e) { RUNTIME.meta.cooling = false; } // center 挂了失败放行，退回自己的退避
}
// best-effort 上报本轮 LLM 错误（center 侧 provider 计数/熔断）
function reportLlmErr(code) {
  try {
    const body = JSON.stringify({ providerId: RUN.providerId, code });
    const req = http.request(CENTER_HTTP + '/api/llm/report', { method: 'POST', timeout: 2000, headers: { 'Content-Type': 'application/json' } }, () => { try { req.destroy(); } catch (e) {} });
    req.on('error', () => {});
    req.write(body); req.end();
  } catch (e) {}
}
// 错误落盘 /state.meta.errorCode+lastErr（含 HTTP 状态码与上游返回片段，禁止吞错空转）
function handleLlmError(code, msg) {
  RUNTIME.meta.errorCode = code; RUNTIME.meta.lastErr = msg;
  RUNTIME.llmErr.code = code; RUNTIME.llmErr.msg = msg; RUNTIME.llmErr.ts = Date.now();
  reportLlmErr(code);
}
function clearLlmError() {
  RUNTIME.llmErr.streak = 0; RUNTIME.llmErr.circuitUntil = 0; RUNTIME.llmErr.nextAuthProbeAt = 0;
  RUNTIME.meta.errorCode = ''; RUNTIME.meta.lastErr = '';
}
// 退避熔断：可退避类 2s→5s→15s 后熔断 30s；401/403 每 60s 探一次
async function applyBackoff(code) {
  const L = RUNTIME.llmErr;
  if (code === 'E_401_AUTH' || code === 'E_403_FORBIDDEN') {
    const now = Date.now();
    const wait = L.nextAuthProbeAt ? Math.max(0, L.nextAuthProbeAt - now) : 0;
    L.nextAuthProbeAt = now + wait + AUTH_PROBE_MS;
    if (wait > 0) await sleep(wait);
    return;
  }
  if (!RETRIABLE_CODES.has(code)) return;
  if (Date.now() < L.circuitUntil) { await sleep(Math.max(0, L.circuitUntil - Date.now())); return; }
  const step = BACKOFF_STEPS[Math.min(L.streak, BACKOFF_STEPS.length - 1)];
  L.streak++;
  if (L.streak >= 3) { L.circuitUntil = Date.now() + CIRCUIT_MS; console.log('[退避] 连续 ' + L.streak + ' 次可退避类错误（' + code + '），半熔断 ' + CIRCUIT_MS / 1000 + 's'); }
  await sleep(step);
}

async function askLLM(userText) {
  // 硬超时 45s：LM Studio 挂起连接时保证主循环永不卡死（v6.5 教训的 lite 版）
  return Promise.race([askLLMInner(userText), new Promise((r) => setTimeout(() => r({ text: '', ms: 60000, errCode: 'E_TIMEOUT', errMsg: 'hard-timeout-60s（LLM 超过 60s 没回）' }), 60000))]);
}
async function askLLMInner(userText) {
  // 最近 5 轮精简历史插在 system 与当前 user 之间（[system, 历史, 当前user]）
  const histText = RUNTIME.roundHistory.length
    ? '【最近 ' + RUNTIME.roundHistory.length + ' 轮历史（更早的事你已忘记，别假装记得）】\n' +
      RUNTIME.roundHistory.map((h, i) => `${i + 1}. 动作:${h.act} | 结果:${h.result} | 我说:${h.iSaid || '(没说话)'} | 队友说:${h.teammateSaid || '(没说话)'}`).join('\n')
    : '';
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT_ACTIVE }];
  if (histText) msgs.push({ role: 'user', content: histText });
  msgs.push({ role: 'user', content: userText });
  const bodyObj = {
    model: RUN.model, messages: msgs, max_tokens: RUN.maxTokens, temperature: RUN.temperature, stream: false,
  };
  // ===== 思考参数：默认全开，不管接哪家 OpenAI 兼容服务 =====
  // 各家字段名不同：Agnes=chat_template_kwargs.enable_thinking；通义千问=enable_thinking；
  // 火山方舟=thinking.type；其余/本地=reasoning_effort。
  // 2026-11-06 实测：Agnes(agnes-2.5-flash) 与通义千问(qwen-plus) 同时收到全部字段均正常返回、思考正常生效，
  //   多余字段被忽略 → 一次全发最省心，新增任何供应商默认就是开思考的。
  // 只有 thinkingStyle==='none' 才关思考（保留这个逃生口）。
  const thinkOn = RUN.thinkingStyle !== 'none';
  if (thinkOn) {
    bodyObj.chat_template_kwargs = { enable_thinking: true };
    bodyObj.enable_thinking = true;
    bodyObj.thinking = { type: 'enabled', budget_tokens: 2048 };
    bodyObj.reasoning_effort = 'medium';
  }
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90000); // LLM 请求超时 90s（原 180s 太长，API 挂起会让 bot 干等 3 分钟不动）
  const post = (obj) => fetch(RUN.llmUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(RUN.apiKey ? { 'Authorization': 'Bearer ' + RUN.apiKey } : {}) },
    body: JSON.stringify(obj),
    signal: ac.signal,
  });
  const fail = (code, errMsg, httpStatus) => ({ text: '', ms: Date.now() - t0, errCode: code, errMsg, httpStatus });
  try {
    let res = await post(bodyObj);
    let raw = await res.text().catch(() => '');
    // 兜底：万一某家服务端对不认识的思考字段直接吐 400 → 去掉思考参数重试一次，保证不漏单
    if (thinkOn && res.status === 400 && /unknown|unsupported|unrecognized|unexpected|invalid.{0,20}(param|field)|param.{0,20}invalid|不支持|参数|字段/i.test(raw)) {
      const plain = JSON.parse(JSON.stringify(bodyObj));
      delete plain.chat_template_kwargs; delete plain.enable_thinking; delete plain.thinking; delete plain.reasoning_effort;
      console.log('[思考] 服务端拒绝思考参数（HTTP 400），已降级为不带思考重试一次');
      res = await post(plain);
      raw = await res.text().catch(() => '');
    }
    clearTimeout(timer);
    if (!res.ok) {
      const low = raw.toLowerCase();
      let code;
      if (res.status === 401) code = 'E_401_AUTH';
      else if (res.status === 403 || res.status === 402) code = 'E_403_FORBIDDEN';
      else if (res.status === 429) code = 'E_429_RATE_LIMIT';
      else if (res.status >= 500) code = 'E_5XX_UPSTREAM';
      else code = 'E_BAD_RESPONSE';
      // 欠费 body 嗅探（HTTP 403 但 body 提示余额不足 → 归 E_403，黄卡）
      if (/insufficient_quota|欠费|余额|exceeded your current quota|insufficient_user_quota/i.test(low)) code = 'E_403_FORBIDDEN';
      return fail(code, 'HTTP ' + res.status + ' ' + raw.slice(0, 120), res.status);
    }
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { return fail('E_BAD_RESPONSE', 'HTTP 200 但返回不是合法 JSON：' + raw.slice(0, 120), 200); }
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!m) return fail('E_BAD_RESPONSE', 'HTTP 200 但没有 choices 字段（模型名可能填错）' + (raw ? '：' + raw.slice(0, 100) : ''), 200);
    const c = (m.content || '').trim();
    if (!c) return fail('E_EMPTY_REPLY', 'HTTP 200 但 content 为空（模型拒答/空回复）', 200);
    // 思考内容字段名各家不一：多数 reasoning_content，个别 reasoning
    return { text: c, reasoning: m.reasoning_content || m.reasoning || '', ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(timer);
    let code = 'E_NETWORK';
    if (e && e.name === 'AbortError') code = 'E_TIMEOUT';
    else if (e && e.cause && /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/.test(e.cause.code || '')) code = 'E_NETWORK';
    return fail(code, String((e && e.message) || e));
  }
}
function parseAction(text) {
  if (!text) return null;
  // 思考自由，只取含 "action" 键的 JSON 块（思考文本里的其它花括号不干扰）
  const m = text.match(/\{[^{}]*"action"[^{}]*\}/s);
  if (!m) return null;
  try {
    const a = JSON.parse(m[0]);
    if (typeof a.action !== 'string') return null;
    const actStr = a.action.trim();
    const known = ['chop_tree', 'dig_blocks', 'place_block', 'build', 'look', 'fight', 'flee', 'escape', 'exchange', 'go_to', 'give'];
    // 容错：部分模型（火山方舟 Doubao-Seed-lite）偶发把参数并进 action 值，
    // 如 "dig_blocks block=stone count=16" → 拆出 action + 独立参数
    const head = actStr.split(/\s+/)[0];
    if (!known.includes(actStr) && known.includes(head)) {
      const out = { action: head };
      for (const part of actStr.split(/\s+/).slice(1)) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
      }
      return out;
    }
    return a;
  } catch (e) { return null; }
}

const SYSTEM_PROMPT = ''; // 人设卡：center 下发的专属副本 bots/personas/<自己名字>.json（env/--persona/config 可覆盖路径）
let SYSTEM_PROMPT_ACTIVE = '';

// 拼接 system prompt：人设（persona）+ 功能说明书（spec）
function buildSystemPrompt(persona, spec) {
  const c = persona.character || {};
  const pk = spec.player_knowledge || {};
  const acts = spec.actions || {};
  const ss = spec.system_supply || {};
  const df = spec.decision_format || {};

  let parts = [];

  // 1. 身份与人设
  parts.push('你是' + (c.identity || '一名工人') + '。');
  if (c.personality) parts.push(c.personality);
  if (persona.sibling) parts.push(persona.sibling);
  if (c.language_style) parts.push(c.language_style);

  // 2. 操作常识（player_knowledge 按类别展开）
  const knowledgeSections = [];
  for (const [k, lines] of Object.entries(pk)) {
    if (Array.isArray(lines) && lines.length > 0) {
      knowledgeSections.push('【' + k + '】\n' + lines.join('\n'));
    }
  }
  if (knowledgeSections.length > 0) {
    parts.push('操作常识：\n' + knowledgeSections.join('\n\n'));
  }

  // 3. 可用动作列表
  const actLines = [];
  for (const [name, def] of Object.entries(acts)) {
    let line = name;
    if (def.params && typeof def.params === 'object' && Object.keys(def.params).length > 0) {
      const paramStr = Object.entries(def.params).map(([k, v]) => k + '=' + (typeof v === 'string' ? v.split('，')[0] : v)).join(' ');
      line += ' ' + paramStr;
    }
    if (def.trigger) line += '（' + def.trigger + '）';
    actLines.push(line);
  }
  if (actLines.length > 0) {
    parts.push('可用动作：\n' + actLines.join('\n'));
  }

  // 4. 供给规则
  if (ss.note) {
    parts.push('系统供给：' + ss.note);
  }

  // 5. JSON 格式铁律
  if (df.hard_rule) {
    parts.push('JSON 格式铁律：' + df.hard_rule);
    if (df.good_examples && df.good_examples.length > 0) {
      parts.push('正确示例：' + df.good_examples.join('；'));
    }
    if (df.bad_examples && df.bad_examples.length > 0) {
      parts.push('错误示例：' + df.bad_examples.join('；'));
    }
  }

  // 6. chat 字段说明
  parts.push('另外决策 JSON 可以附带一个 chat 字段写你要说的话（例如 {"action":"look","chat":"大家好，我来了"}），脚本会边说边干、不占干活轮，想跟队友们商量分工、喊帮忙或报进度都用它说；说话内容别以 / 开头。');

  return parts.join('\n\n');
}

try {
  let card;
  if (RUN.persona) {
    card = path.isAbsolute(RUN.persona) ? RUN.persona : path.join(__dirname, RUN.persona);
  } else {
    card = path.join(__dirname, 'personas', RUN.name + '.json');
  }
  console.log('[人设] 读取人设卡：' + card);
  const persona = JSON.parse(fs.readFileSync(card, 'utf8'));

  // 读功能 spec：根据 persona.meta.preset 找对应 spec 文件
  const preset = persona.meta && persona.meta.preset;
  if (!preset) throw new Error('人设卡缺少 meta.preset 字段，无法找到功能说明书');
  const specFile = path.join(__dirname, 'specs', preset + '.json');
  console.log('[功能] 读取功能说明书：' + specFile);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));

  SYSTEM_PROMPT_ACTIVE = buildSystemPrompt(persona, spec);
  console.log('[人设] 系统提示词拼接完成，长度 ' + SYSTEM_PROMPT_ACTIVE.length + ' 字');
} catch (e) {
  // 缺文件不静默用兜底人设：/state 明确报 persona-missing 中文错误
  RUNTIME.meta.personaMissing = 'persona-missing：人设卡或功能说明书不存在/损坏（' + e.message + '），系统提示词为空';
  console.log('[人设] ' + RUNTIME.meta.personaMissing);
}

// 罗盘方向（MC 坐标：x+东，z+南）
function toCompass(dx, dz) {
  const deg = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360; // 0=南，90=西？—— MC 中 atan2(dx,dz)：0=+z 南，90=+x 东
  const names = ['南', '东南', '东', '东北', '北', '西北', '西', '西南'];
  return names[Math.round(deg / 45) % 8];
}
// 视野描述（10-19 双子作战增强）：怪物(类型+数量+方向+距离) / 队友(方向+距离+血量+是否被围) /
// 地形(附近水/沙/悬崖) / 资源密度(石头/树/矿大致方向) / 危险提示(脚下水/面前悬崖)
function describeNearby() {
  try {
    const pos = bot.entity.position;
    const rd = (v) => Math.round(v);
    // ① 怪物：24 格内全部敌对，按类型计数 + 最近 3 个的方向距离
    // 10-19 修复：旧过滤 e.type==='mob' 恒 false——minecraft-data 1.21.4 敌对怪 type='hostile' 非 'mob'，
    // 导致被围攻时视野仍报"无敌对"。改为只按 HOSTILE_SET 名字白名单判定（不依赖易出错的 type 字段）
    const hostiles = Object.values(bot.entities).filter((e) => e && e.position && HOSTILE_SET.has(e.name) && pos.distanceTo(e.position) < 24);
    let mobLine;
    if (!hostiles.length) mobLine = '怪物[无敌对]';
    else {
      const byType = {};
      hostiles.forEach((e) => { byType[e.name] = (byType[e.name] || 0) + 1; });
      const countDesc = Object.entries(byType).map(([n, c]) => `${n}×${c}`).join('、');
      const near3 = hostiles.slice().sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position)).slice(0, 3)
        .map((e) => `${e.name}${toCompass(e.position.x - pos.x, e.position.z - pos.z)}${rd(pos.distanceTo(e.position))}格`).join('、');
      mobLine = `怪物[共${hostiles.length}只 ${countDesc}｜最近: ${near3}]`;
    }
    // ② 队友：方向+距离+血量+是否被围（16 格内敌对≥2 判被围）。二期改造：从在线玩家动态枚举（排除自己），不再写死 AI-Bot-L/L2
    const mate = bot.nearestEntity((e) => e.type === 'player' && e.username !== bot.username && pos.distanceTo(e.position) < 64);
    let mateLine;
    if (!mate) mateLine = '队友[不在附近]';
    else {
      const md = rd(pos.distanceTo(mate.position));
      // 队友血量：MC 协议 update_health 只发给自己，bot 读不到其他玩家实体血量（恒 undefined→?）；
      // 改读队友自报的 bot-state-<真实名字>.json（主循环每轮写入），读不到才回退实体血量
      let mateHp = null;
      try {
        const mf = path.join(__dirname, 'logs', `bot-state-${mate.username}.json`);
        const ms = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (ms.hp != null) mateHp = Math.round(ms.hp);
      } catch (e) {}
      const mhp = mateHp != null ? mateHp : (mate.health == null ? '?' : Math.round(mate.health));
      const besieged = hostiles.filter((e) => mate.position.distanceTo(e.position) < 16).length >= 2;
      mateLine = `队友[${toCompass(mate.position.x - pos.x, mate.position.z - pos.z)}${md}格 血量${mhp}/20${besieged ? ' ⚠️被围' : ''}]`;
    }
    // ③ 地形 + ⑤ 危险提示：脚下水 / 面前悬崖骤降 / 附近水域 / 附近沙
    const feetB = bot.blockAt(pos), headB = bot.blockAt(pos.offset(0, 1, 0));
    const waterHere = (feetB && feetB.name === 'water') || (headB && headB.name === 'water');
    const yaw = bot.entity.yaw;
    const fx = Math.round(-Math.sin(yaw)), fz = Math.round(Math.cos(yaw));
    let cliffAhead = false;
    if (fx || fz) {
      const frontFeet = pos.floored().offset(fx, 0, fz);
      const fb = bot.blockAt(frontFeet);
      if (!fb || fb.boundingBox === 'empty') {
        const below3 = bot.blockAt(frontFeet.offset(0, -3, 0));
        if (!below3 || below3.boundingBox === 'empty') cliffAhead = true;
      }
    }
    const nearWater = bot.findBlocks({ matching: (b) => b.name === 'water', maxDistance: 8, count: 4 });
    const nearSand = bot.findBlocks({ matching: (b) => b.name === 'sand', maxDistance: 12, count: 4 });
    const terrains = [];
    if (waterHere) terrains.push('脚下是水⚠️');
    if (cliffAhead) terrains.push('面前悬崖/骤降⚠️');
    if (nearWater.length) terrains.push(`附近水域${nearWater.length}处`);
    if (nearSand.length) terrains.push('附近有沙');
    const terraLine = `地形[${terrains.join('、') || '平地'}]`;
    // ④ 资源密度：树/石/矿的大致方向 + 数量
    const trees = bot.findBlocks({ matching: (b) => LOG_FAMILY.includes(b.name), maxDistance: 48, count: 30 });
    const stones = bot.findBlocks({ matching: (b) => STONE_FAMILY.includes(b.name), maxDistance: 48, count: 30 });
    const ores = bot.findBlocks({ matching: (b) => ['iron_ore', 'coal_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore'].includes(b.name), maxDistance: 48, count: 10 });
    const densityOf = (blocks) => {
      if (!blocks.length) return '无';
      const cx = blocks.reduce((s, b) => s + b.x, 0) / blocks.length, cz = blocks.reduce((s, b) => s + b.z, 0) / blocks.length;
      return toCompass(cx - pos.x, cz - pos.z) + '向×' + blocks.length;
    };
    const resLine = `资源[树${densityOf(trees)}｜石${densityOf(stones)}｜矿${ores.length ? densityOf(ores) : '无'}]`;
    const facing = toCompass(-Math.sin(yaw), Math.cos(yaw));
    return `视野: 面朝${facing} | ${mobLine} | ${mateLine} | ${terraLine} | ${resLine}`;
  } catch (e) { return '视野: （环境感知暂不可用）'; }
}

// 成绩对比：读对方状态文件，拼成提示行
function getScoreCompare() {
  const mine = RUNTIME.brokenCount;
  // 二期改造：动态枚举——扫 logs/bot-state-*.json，排除自己，取最新写入的那个当队友战绩
  let mate = null;
  try {
    for (const f of fs.readdirSync(path.join(__dirname, 'logs'))) {
      if (!f.startsWith('bot-state-') || !f.endsWith('.json')) continue;
      const who = f.slice('bot-state-'.length, -'.json'.length);
      if (who === RUN.name) continue;
      const ms = JSON.parse(fs.readFileSync(path.join(__dirname, 'logs', f), 'utf8'));
      if (!mate || (ms.ts || '') > (mate.ts || '')) mate = ms;
    }
  } catch (e) {}
  const mateTotal = mate ? (mate.total != null ? mate.total : mate.built) : null;
  const delta = mateTotal == null ? null : mine - mateTotal;
  const text = mateTotal == null
    ? `战绩对比：我 ${mine} 块（手挖${RUNTIME.manualBroken}/TNT${RUNTIME.tntBroken}） vs 队友战绩未知`
    : `战绩对比：我 ${mine} 块（手挖${RUNTIME.manualBroken}/TNT${RUNTIME.tntBroken}） vs 队友 ${mateTotal} 块（手挖${mate.manual}/TNT${mate.tnt}），${delta >= 0 ? '领先' + delta + '块' : '落后' + (-delta) + '块'}`;
  return { text, mine, teammate: mateTotal, delta };
}
// 本轮自己说的话（在决策循环里赋值）
let roundISaid = '';

function buildUserPrompt() {
  // 实时指令注入（主人实时指令箱）：bot\指令箱.txt 有内容则读入本轮 prompt 并清空，实现不重启给模型发消息
  try {
    const f = path.join(__dirname, '指令箱.txt');
    if (fs.existsSync(f)) {
      const hint = fs.readFileSync(f, 'utf8').trim();
      if (hint) { RUNTIME.injectedMsg = hint; try { fs.unlinkSync(f); } catch (e) {} }
    }
  } catch (e) {}
  const pos = bot.entity.position.floored();
  // 天色感知：normal 真刷怪，日落夜间警惕
  const t = (bot.time && bot.time.timeOfDay) || 0;
  const sky = t >= 23000 || t < 12000 ? `白天（游戏内 ${Math.floor(t / 1000)} 点）` : t < 13000 ? `日落临近（游戏内 ${Math.floor(t / 1000)} 点）` : `夜间（游戏内 ${Math.floor(t / 1000)} 点，正常模式有怪，日落警惕）`;
  const stuckWarn = (Date.now() - RUNTIME.lastMoveAt > 45000) ? '\n⚠️ 你已长时间未移动，脚本即将 tp 脱困，或请直接输出 {"action":"escape"}' : '';
  const inj = RUNTIME.injectedMsg ? `\n【来自主人的实时指令】${RUNTIME.injectedMsg}` : '';
  const nowMs = Date.now();
  const chatsBlock = RUNTIME.teammateChats.length
    ? '队友最近说的话：\n' + RUNTIME.teammateChats.map((c) => `  [${c.who} ${Math.max(0, Math.round((nowMs - c.ts) / 1000))}s前] ${c.msg}`).join('\n')
    : '队友最近说的话：（暂无）';
  const scoreLine = getScoreCompare().text;
  return `任务进度: 已拆 ${RUNTIME.brokenCount} 方块（手动 ${RUNTIME.manualBroken} / TNT炸 ${RUNTIME.tntBroken}）（无限破坏工·自主选拆，无固定终点）${inj}
血量: ${Math.round(bot.health)}/20 饥饿: ${Math.round(bot.food)}/20（低血先撤或兑换回血：金苹果/治疗药水见效快，吃食物也能缓慢回血——饥饿值满时再吃，多余饱食会转成生命恢复）
背包: 原木${invAny(LOG_FAMILY)} 圆石${invCount('cobblestone')} 土/沙垫脚料${invAny(['dirt', 'sand', 'cobblestone'])} tnt×${invCount('tnt')}/60 打火石×${invCount('flint_and_steel')} 空格${bot.inventory.emptySlotCount()}/36（工具/垫脚/脱困由系统保障，你只管选拆什么；但食物和回血要自己管——背包满不影响拆除、系统会自动消化垫脚料，别为背包纠结；TNT最多60个、手动拆满32块奖1颗，满了不增加、用掉才能继续赚）
兑换点: ${RUNTIME.woodPoint}（背包原木${invAny(LOG_FAMILY)}；原木自动兑换：背包每有8个原木自动扣掉换1兑换点——砍树、捡到都算，不用特意手砍；想换食物/回血就输出 exchange 去花点；吃的：beef牛排×1 / bread面包×2 / carrot胡萝卜×3 / cookie曲奇×8；回血：golden_apple金苹果×1 / potion治疗药水×1——低血自己 exchange 换，脚本会自动喝下；加速：speed速度药水×1——想跑得快/拆得快就换，脚本自动喝下；吃食物也能缓慢回血）
${scoreLine}
${chatsBlock}
天色: ${sky}
位置: x=${pos.x}, y=${pos.y}, z=${pos.z}
${describeNearby()}
上一步结果: ${RUNTIME.lastResult}${stuckWarn}
建造能力（你既能拆也能建，像玩家一样）: 发 build <蓝图> 就能瞬间用脚本造好一栋（不用搬材料）——可用蓝图：build cabin 小木屋(可住人) / build tower 瞭望塔(登高观察) / build farm 农田(种小麦) / build bridge 木桥(跨河/坑) / build wall 石围墙(围地界)；可选加 x=<数> z=<数> 指定位置，不写就建在脚下；建议先 look 看地形再挑平地建，别建进水里/山坡；建好发 chat 邀请队友来看。你既承担拆除生产（赚兑换点），也可在安身/防御/邀请队友时建造，自主权衡。
下一步做什么？输出你的决策 JSON。`;
}

// ---------- 动作 ----------
function stopPathfinder() { try { bot.pathfinder.setGoal(null); } catch (e) {} }
// 背包保底清理：材料（非工具/装备/食物/垫脚）格数 >28 扔一批腾空位，保证 give 新工具/食物不落地（MC 满包不拾取掉落，掉落留地上即可，不专门做"拆了扔"）
function clearSurplusInv() {
  // 绝对保留：工具/盔甲/盾/食物/回血药/TNT/打火石/垫脚/原木（兑换用）——弓和箭已弃用（脚本贴身剑打）
  const KEEP = new Set(['netherite_axe', 'netherite_pickaxe', 'netherite_shovel', 'netherite_sword', 'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots', 'shield', 'cooked_beef', 'bread', 'carrot', 'cookie', 'golden_apple', 'potion', 'dirt', 'cobblestone', 'tnt', 'flint_and_steel']);
  const isKeep = (name) => KEEP.has(name) || LOG_FAMILY.includes(name) || /_(axe|pickaxe|shovel|sword)$/.test(name);
  // 怪物掉落物：bot 不合成，直接丢（腐肉/骨头/火药/线/蜘蛛眼/史莱姆球/箭等占格无用）
  const MOB_DROPS = new Set(['rotten_flesh', 'bone', 'gunpowder', 'string', 'spider_eye', 'slime_ball', 'arrow', 'experience_bottle', 'ender_pearl', 'blaze_rod', 'ghast_tear', 'magma_cream', 'glass_bottle']);
  let mobDropped = 0;
  for (const it of bot.inventory.items()) {
    if (MOB_DROPS.has(it.name)) { bot.tossStack(it).catch(() => {}); mobDropped++; }
  }
  if (mobDropped > 0) console.log(`[背包] 丢弃怪物掉落物 ${mobDropped} 组`);
  // 垫脚料设上限：土/圆石/沙每种保留 1 组(64)，够垫脚就行，多的扔（防占满格子 → give 工具/TNT 落地、挖的捡不起）
  const STEP_CAP = { dirt: 64, cobblestone: 64, sand: 64 };
  for (const name of Object.keys(STEP_CAP)) {
    const stacks = bot.inventory.items().filter((i) => i.name === name);
    const total = stacks.reduce((s, i) => s + i.count, 0);
    if (total > STEP_CAP[name]) {
      let need = total - STEP_CAP[name];
      for (const st of stacks) { if (need <= 0) break; bot.tossStack(st).catch(() => {}); need -= st.count; }
      console.log(`[背包] 垫脚料 ${name} 共 ${total}，超上限清到保留 64`);
    }
  }
  const mats = bot.inventory.items().filter((i) => !isKeep(i.name) && !MOB_DROPS.has(i.name));
  if (mats.length <= 28) return;
  const dropCount = mats.length - 24;
  let dropped = 0;
  for (const it of mats.slice(0, dropCount)) { bot.tossStack(it).catch(() => {}); dropped++; }
  if (dropped > 0) console.log(`[背包] 材料 ${mats.length} 格，扔 ${dropped} 组腾空位`);
}
// 挖穿面前的阻挡方块（玩家行为：挡住就挖开，不用绕）——返回是否挖到了东西；本轮累计 >8 次止损（挖挡路是通行不是目标，无限挖会把 120s 耗光导致目标挖不到）
async function digThroughForward() {
  if ((RUNTIME.digThroughCount || 0) >= 8) return false;
  const eye = bot.entity.position.offset(0, 1.5, 0);
  const yaw = bot.entity.yaw;
  const face = eye.offset(-Math.sin(yaw), -0.5, -Math.cos(yaw)).floored();
  let dug = 0;
  for (const p of [face, face.offset(0, 1, 0), face.offset(0, -1, 0)]) {
    const b = bot.blockAt(p);
    if (b && b.boundingBox !== 'empty' && b.name !== 'bedrock' && !b.name.includes('water')) {
      try { await bot.dig(b); manualBreak(b.name); dug++; await sleep(100); } catch (e) {}
    }
  }
  if (dug > 0) { RUNTIME.digThroughCount = (RUNTIME.digThroughCount || 0) + 1; console.log(`[行为] ⛏️ 挖开挡路方块 ${dug} 格，重试寻路（${RUNTIME.digThroughCount}/8）`); }
  return dug > 0;
}
// tp 到目标并挖目标（寻路彻底失败的最后手段）：优先直接 tp 到目标正上方（落点两格空防窒息），落点危险才走安全偏移；tp 后挖脚下，脚下不是目标扫 4 格内同名方块挖
async function safeTpDig(p, blockName) {
  try {
    const feet = bot.blockAt(new Vec3(p.x, p.y + 1, p.z)), head = bot.blockAt(new Vec3(p.x, p.y + 2, p.z));
    const landSafe = (!feet || (feet.boundingBox === 'empty' && feet.name !== 'water' && feet.name !== 'lava')) && (!head || (head.boundingBox === 'empty' && head.name !== 'water'));
    if (landSafe) { stopPathfinder(); await rconExec(`tp ${RUN.name} ${p.x + 0.5} ${p.y + 1} ${p.z + 0.5}`); }
    else await safeTp(p.x, p.y + 1, p.z);
    const under = bot.blockAt(bot.entity.position.offset(0, -0.1, 0));
    let tgt = null;
    if (under && under.boundingBox !== 'empty' && under.name !== 'bedrock' && (!blockName || under.name === blockName)) tgt = under;
    if (!tgt && blockName) {
      const near = bot.findBlocks({ matching: (x) => x.name === blockName, maxDistance: 4, count: 6 }).map((q) => bot.blockAt(q)).find((q) => q && q.boundingBox !== 'empty');
      if (near) tgt = near;
    }
    if (tgt) { await bot.dig(tgt); manualBreak(tgt.name); return true; }
  } catch (e) {}
  return false;
}
async function gotoNear(x, y, z, range, timeoutMs = 20000) {
  setMovements();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { stopPathfinder(); reject(new Error('goto 超时')); }, timeoutMs);
    bot.pathfinder.goto(new goals.GoalNear(x, y, z, range)).then(() => { clearTimeout(t); resolve(); }).catch((e) => { clearTimeout(t); stopPathfinder(); reject(e); });
  });
}
async function digBlockAt(p) {
  const b = bot.blockAt(p);
  if (!b || b.boundingBox === 'empty') return false;
  try { await bot.dig(b); manualBreak(b.name); return true; } catch (e) { return false; }
}
async function walkInto(p) { try { await gotoNear(p.x, p.y, p.z, 0, 5000); } catch (e) {} }

// 掉落物捡漏（分身建议 #11）：弹开 1~2 格的掉落物不捡，gemma 对不上账会反复补撸——收尾扫 4 格内 item 实体挨个贴近吸取
async function collectDrops() {
  for (let i = 0; i < 5; i++) {
    const it = bot.nearestEntity((e) => e.name === 'item' && bot.entity.position.distanceTo(e.position) < 4);
    if (!it) break;
    try { await gotoNear(it.position.x, it.position.y, it.position.z, 0, 4000); } catch (e) { break; }
    await sleep(150);
  }
}

// 工具上手套（玩家肌肉记忆：干活前换工具）——mineflayer 的 dig 只认手持，不自动换手（分身实锤：无 equip 则空手挖石 0 掉落）
async function ensureTool(names) {
  const held = bot.heldItem;
  if (held && names.includes(held.name)) return true;
  const tool = bot.inventory.items().find((i) => names.includes(i.name));
  if (!tool) return false;
  try { await bot.equip(tool, 'hand'); return true; } catch (e) { return false; }
}

// 最近敌对生物（< maxDist 格）——10-19 修复：去掉 e.type==='mob'（1.21.4 敌对怪 type='hostile'），按名字白名单判定
async function nearestHostile(maxDist = 24) {
  return bot.nearestEntity((e) => e && e.position && HOSTILE_SET.has(e.name) && bot.entity.position.distanceTo(e.position) < maxDist);
}

// 工具族映射 + 耐久余量判定（>10 才算可用）+ 缺则 RCON 发下界合金工具，将坏同等级补发（材质上限 netherite——最高级，9x 速度 2031 耐久，无限拆产能最优；金 12x 但耐久 33 次弃用）
async function ensureToolForBlock(block) {
  const b = String(block || '').toLowerCase();
  const SHOVEL = ['dirt', 'grass_block', 'sand', 'gravel', 'clay', 'snow', 'snow_block', 'dirt_path', 'farmland', 'rooted_dirt', 'mud'];
  const PICKAXE = ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'iron_ore', 'coal_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore', 'netherrack', 'sandstone', 'red_sandstone', 'bricks', 'mossy_cobblestone'];
  // 补发镐：按当前工具档查 PICKAXE_SPEC_BY_STAGE（含附魔 NBT，与升级发放一致）；斧/铲等非镐原样返回
  const giveItem = (name) => (name.endsWith('_pickaxe') ? PICKAXE_SPEC_BY_STAGE[RUNTIME.toolStage] : name);
  let family = null, bestTool = null;
  if (LOG_FAMILY.includes(b) || b === 'log') { family = 'axe'; bestTool = 'netherite_axe'; }
  else if (PICKAXE.includes(b)) { family = 'pickaxe'; bestTool = ['stone_pickaxe', 'iron_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'diamond_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'netherite_pickaxe', 'netherite_pickaxe'][RUNTIME.toolStage]; }
  else if (SHOVEL.includes(b)) { family = 'shovel'; bestTool = 'netherite_shovel'; }
  if (!family) return false; // 其它方块（树叶等）→ 空手
  const famNames = [bestTool];
  const usable = (i) => famNames.includes(i.name) && (i.durabilityUsed === undefined || i.maxDurability === undefined || (i.maxDurability - i.durabilityUsed) > 10);
  let tool = bot.inventory.items().find(usable);
  if (!tool) {
    await rconExec(`give ${RUN.name} ${giveItem(bestTool)} 1`);
    await sleep(500);
    tool = bot.inventory.items().find(usable) || bot.inventory.items().find((i) => i.name === bestTool);
    if (tool) RUNTIME.lastResult = `已自动下发并装备 ${bestTool}`;
  } else if (tool.durabilityUsed !== undefined && tool.maxDurability !== undefined && (tool.maxDurability - tool.durabilityUsed) <= 20) {
    await rconExec(`give ${RUN.name} ${giveItem(bestTool)} 1`);
    await sleep(500);
    tool = bot.inventory.items().find((i) => i.name === bestTool) || tool;
    RUNTIME.lastResult = `${family}将坏，已补 ${bestTool}`;
  }
  if (tool) { try { await bot.equip(tool, 'hand'); return true; } catch (e) { return false; } }
  return false;
}

// 战斗装备保障（10-19 升级）：下界合金全套 + 保护IV + 盾；缺件或盔甲低耐久(余量≤20)自动补发并穿戴
const ARMOR_SPEC = {
  netherite_helmet: 'minecraft:netherite_helmet[minecraft:enchantments={levels:{"minecraft:protection":4}}]',
  netherite_chestplate: 'minecraft:netherite_chestplate[minecraft:enchantments={levels:{"minecraft:protection":4}}]',
  netherite_leggings: 'minecraft:netherite_leggings[minecraft:enchantments={levels:{"minecraft:protection":4}}]',
  netherite_boots: 'minecraft:netherite_boots[minecraft:enchantments={levels:{"minecraft:protection":4}}]',
};
async function ensureCombatGear() {
  const gives = [];
  // 剑：缺了发；耐久≤20 补发（先扔旧的防占格，同类只留1件）
  const swords = bot.inventory.items().filter((i) => i.name === 'netherite_sword');
  if (swords.length === 0) gives.push('netherite_sword 1');
  else {
    const worn = swords.find((i) => i.durabilityUsed !== undefined && i.maxDurability !== undefined && (i.maxDurability - i.durabilityUsed) <= 20);
    if (worn) { bot.tossStack(worn).catch(() => {}); gives.push('netherite_sword 1'); console.log('[装备] 合金剑耐久≤20，扔旧补新'); }
  }
  if (invCount('shield') < 1) gives.push('shield 1');
  for (const [item, spec] of Object.entries(ARMOR_SPEC)) {
    const owned = bot.inventory.items().find((i) => i.name === item);
    if (!owned) { gives.push(`${spec} 1`); continue; }
    // 低耐久补发扩展到盔甲：余量≤20 就补一件新的（先扔旧的防占格）
    if (owned.durabilityUsed !== undefined && owned.maxDurability !== undefined && (owned.maxDurability - owned.durabilityUsed) <= 20) {
      bot.tossStack(owned).catch(() => {});
      gives.push(`${spec} 1`);
      console.log(`[装备] ${item} 耐久≤20，扔旧补新`);
    }
  }
  for (const g of gives) await rconExec(`give ${RUN.name} ${g}`);
  if (gives.length) await sleep(500);
  const armorSlot = { netherite_helmet: 'head', netherite_chestplate: 'torso', netherite_leggings: 'legs', netherite_boots: 'feet' };
  for (const [item, slot] of Object.entries(armorSlot)) {
    const cands = bot.inventory.items().filter((i) => i.name === item)
      .sort((a, b) => ((b.maxDurability || 0) - (b.durabilityUsed || 0)) - ((a.maxDurability || 0) - (a.durabilityUsed || 0)));
    if (cands[0]) { try { await bot.equip(cands[0], slot); } catch (e) {} }
  }
  const shield = bot.inventory.items().find((i) => i.name === 'shield');
  if (shield) { try { await bot.equip(shield, 'off-hand'); } catch (e) {} }
  if (gives.length) RUNTIME.lastResult = `已补发战斗装备：${gives.join('、')}`;
}

// 安全落点缩版（v6.5 safeTpFloor 的 10 行版）：实心地面+头两格空，防盲传嵌方块窒息
function safeTpFloorLite(x, z, hintY) {
  const pass = (b) => !b || (b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava');
  for (const dy of [0, 1, 2, 3, -1, -2, 4, 5, 6, 7, 8]) {
    const y = Math.floor(hintY || 64) + dy;
    const ground = bot.blockAt(new Vec3(x, y - 1, z));
    const feet = bot.blockAt(new Vec3(x, y, z)), head = bot.blockAt(new Vec3(x, y + 1, z));
    if (ground && ground.boundingBox !== 'empty' && ground.name !== 'water' && pass(feet) && pass(head)) return y;
  }
  return null;
}
// 动态安全落点（防固定传送点被挖空 → 传送深渊摔死 → 死循环）：hint 点无安全地面时，
// 从 hint 中心向外环形扫描，找"脚下实心 + 脚下下方有支撑(非浮空薄层) + 头两格空 + 非水/岩浆"的真实地表，返回站姿坐标或 null
function findSafeLanding(cx, cz, hintY, radius = 14) {
  const pass = (b) => !b || (b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava');
  const baseY = Math.floor(hintY || 64);
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // 只扫当前环
        const x = cx + dx, z = cz + dz;
        for (let sy = baseY + 6; sy >= baseY - 18; sy--) {
          const ground = bot.blockAt(new Vec3(x, sy - 1, z));
          const feet = bot.blockAt(new Vec3(x, sy, z));
          const head = bot.blockAt(new Vec3(x, sy + 1, z));
          if (ground && ground.boundingBox !== 'empty' && ground.name !== 'water' && ground.name !== 'lava'
            && pass(feet) && pass(head)) {
            const below = bot.blockAt(new Vec3(x, sy - 2, z)); // ground 下一格：有实心=真实地表(非悬空薄层)，站上不会摔落
            if (below && below.boundingBox !== 'empty') return { x, y: sy, z };
          }
        }
      }
    }
  }
  return null;
}
// tp 落点统一走安全检查：优先 hint 点安全落点；hint 点被挖空/无安全地面时动态找附近真实地表（防传送深渊摔死死循环），极端才硬传
async function safeTp(x, y, z) {
  stopPathfinder(); // 瞬移前清残留 goal，防旧 pathfinder 目标继续控制移动
  let tx = x, tz = z, sy = safeTpFloorLite(x, z, y);
  if (sy == null) {
    const land = findSafeLanding(x, z, y, 14);
    if (land) { tx = land.x; tz = land.z; sy = land.y; }
    else sy = Math.floor(y) + 1; // 最终兜底（罕见）：仍原高度+1
  }
  const tpos = new Vec3(tx + 0.5, sy, tz + 0.5);
  const before = bot.entity.position.clone();
  await rconExec(`tp ${RUN.name} ${tx + 0.5} ${sy} ${tz + 0.5}`);
  await sleep(900);
  // tp 后验证：实体位置是否到了目标；没到且原地未动 → 重试一次，仍失败明说"没传走"（防"显示成功实际没动"）
  const after = bot.entity.position;
  if (after.distanceTo(tpos) > 2 && before.distanceTo(after) < 0.5) {
    console.log(`[脱困] tp 疑似未生效（${before.x.toFixed(1)},${before.y.toFixed(1)},${before.z.toFixed(1)} → ${after.x.toFixed(1)},${after.y.toFixed(1)},${after.z.toFixed(1)}），重试一次`);
    await rconExec(`tp ${RUN.name} ${tx + 0.5} ${sy} ${tz + 0.5}`);
    await sleep(900);
    const after2 = bot.entity.position;
    if (after2.distanceTo(tpos) > 2 && before.distanceTo(after2) < 0.5) {
      RUNTIME.lastResult = '脱困失败：tp 未生效，位置没变（脚本会再判脱困重试）';
      console.log('[脱困] tp 两次未生效，位置未变');
      try { appendLog({ ts: new Date().toISOString(), event: 'tp-failed', from: before.toString(), to: tpos.toString() }); } catch (e) {}
      return false;
    }
  }
  setTimeout(() => digOutLeaves(), 1200); // 落地顺手清障（分身建议 #10）
  await sleep(800);
  return true;
}

// ========== 方案B（2026-10-20 合并）：建造能力并入拆工 ==========
// 蓝图库 + 建造动作（与 bot.js 同源）。模型发 build <蓝图名>，脚本 RCON setblock 秒建，不需要材料。
const BLUEPRINTS = {
  cabin: {
    name: '小木屋', size: [7, 4, 6],
    desc: '6×5 木屋：木板墙+原木柱+玻璃窗+木门+木楼梯屋顶，适合住人',
    build: async (ox, oy, oz) => {
      const W = 7, D = 6, H = 4;
      await rconExec(`fill ${ox} ${oy - 1} ${oz} ${ox + W - 1} ${oy + H - 1} ${oz + D - 1} air`);
      await rconExec(`fill ${ox} ${oy - 2} ${oz} ${ox + W - 1} ${oy - 1} ${oz + D - 1} stone`);
      await rconExec(`fill ${ox} ${oy - 1} ${oz} ${ox + W - 1} ${oy - 1} ${oz + D - 1} oak_planks`);
      for (let x = 0; x < W; x++) for (let y = 0; y < H - 1; y++) for (let z = 0; z < D; z++) {
        const bx = ox + x, by = oy + y, bz = oz + z;
        const isCorner = (x === 0 || x === W - 1) && (z === 0 || z === D - 1);
        const isEdge = (x === 0 || x === W - 1 || z === 0 || z === D - 1);
        if (!isEdge) continue;
        if (isCorner) await rconExec(`setblock ${bx} ${by} ${bz} oak_log`);
        else await rconExec(`setblock ${bx} ${by} ${bz} oak_planks`);
      }
      const doorX = ox + 3, doorZ = oz;
      await rconExec(`setblock ${doorX} ${oy} ${doorZ} oak_door[facing=south,half=lower]`);
      await rconExec(`setblock ${doorX} ${oy + 1} ${doorZ} oak_door[facing=south,half=upper]`);
      await rconExec(`setblock ${ox} ${oy + 1} ${oz + 2} glass_pane`);
      await rconExec(`setblock ${ox + W - 1} ${oy + 1} ${oz + 2} glass_pane`);
      for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) await rconExec(`setblock ${ox + x} ${oy + H - 1} ${oz + z} oak_stairs[facing=south]`);
      await rconExec(`setblock ${doorX} ${oy - 1} ${oz - 1} stone`);
      await rconExec(`setblock ${doorX} ${oy} ${oz - 1} air`);
      await rconExec(`setblock ${ox + 1} ${oy} ${oz + 1} torch`);
      await rconExec(`setblock ${ox + W - 2} ${oy} ${oz + D - 2} torch`);
      return { blocks: W * D * (H + 1) };
    }
  },
  tower: {
    name: '瞭望塔', size: [3, 8, 3],
    desc: '3×3 木塔 8 格高：内部梯子登顶 + 顶部平台 + 围栏，可俯瞰四周',
    build: async (ox, oy, oz) => {
      const W = 3, D = 3, H = 8;
      await rconExec(`fill ${ox} ${oy} ${oz} ${ox + W - 1} ${oy + H - 1} ${oz + D - 1} air`);
      await rconExec(`fill ${ox} ${oy - 2} ${oz} ${ox + W - 1} ${oy - 1} ${oz + D - 1} stone`);
      await rconExec(`fill ${ox} ${oy - 1} ${oz} ${ox + W - 1} ${oy - 1} ${oz + D - 1} oak_planks`);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
          const isEdge = (x === 0 || x === W - 1 || z === 0 || z === D - 1);
          if (!isEdge) continue;
          await rconExec(`setblock ${ox + x} ${oy + y} ${oz + z} ${(x === 0 || x === W - 1) && (z === 0 || z === D - 1) ? 'oak_log' : 'oak_planks'}`);
        }
        await rconExec(`setblock ${ox + 1} ${oy + y} ${oz} ladder[facing=north]`);
      }
      await rconExec(`fill ${ox} ${oy + H} ${oz} ${ox + W - 1} ${oy + H} ${oz + D - 1} oak_planks`);
      await rconExec(`fill ${ox} ${oy + H + 1} ${oz} ${ox + W - 1} ${oy + H + 1} ${oz + D - 1} oak_fence`);
      return { blocks: W * D * (H + 2) };
    }
  },
  farm: {
    name: '农田', size: [9, 1, 9],
    desc: '9×9 农田：锄地成垄 + 十字水渠 + 种小麦，等生长后可收',
    build: async (ox, oy, oz) => {
      const W = 9, D = 9;
      await rconExec(`fill ${ox} ${oy} ${oz} ${ox + W - 1} ${oy} ${oz + D - 1} air`);
      await rconExec(`fill ${ox} ${oy - 2} ${oz} ${ox + W - 1} ${oy - 1} ${oz + D - 1} stone`);
      await rconExec(`fill ${ox} ${oy - 1} ${oz} ${ox + W - 1} ${oy - 1} ${oz + D - 1} dirt`);
      for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
        const isChannel = (x === 4 || z === 4);
        if (isChannel) await rconExec(`setblock ${ox + x} ${oy} ${oz + z} water`);
        else await rconExec(`setblock ${ox + x} ${oy} ${oz + z} farmland`);
      }
      for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
        if (x === 4 || z === 4) continue;
        await rconExec(`setblock ${ox + x} ${oy + 1} ${oz + z} wheat`);
      }
      return { blocks: W * D * 2 };
    }
  },
  bridge: {
    name: '木桥', size: [5, 1, 7],
    desc: '5 宽 7 长的木板桥 + 两侧围栏扶手，可跨河/跨坑',
    build: async (ox, oy, oz) => {
      const W = 5, L = 7;
      await rconExec(`fill ${ox} ${oy - 1} ${oz} ${ox + W - 1} ${oy} ${oz + L - 1} oak_planks`);
      await rconExec(`fill ${ox} ${oy + 1} ${oz} ${ox} ${oy + 1} ${oz + L - 1} oak_fence`);
      await rconExec(`fill ${ox + W - 1} ${oy + 1} ${oz} ${ox + W - 1} ${oy + 1} ${oz + L - 1} oak_fence`);
      return { blocks: W * L * 2 };
    }
  },
  wall: {
    name: '石围墙', size: [10, 2, 1],
    desc: '10×2 石头围墙 + 原木柱，围出一块地界',
    build: async (ox, oy, oz) => {
      const L = 10;
      await rconExec(`fill ${ox} ${oy} ${oz} ${ox + L - 1} ${oy + 1} ${oz} stone_bricks`);
      await rconExec(`setblock ${ox} ${oy} ${oz} oak_log`);
      await rconExec(`setblock ${ox + L - 1} ${oy} ${oz} oak_log`);
      return { blocks: L * 2 };
    }
  },
};

async function actBuild(name, x, z) {
  const key = String(name || '').toLowerCase().trim();
  const bp = BLUEPRINTS[key];
  if (!bp) return { ok: false, detail: `未知蓝图 '${key}'——可用：${Object.keys(BLUEPRINTS).join('/')}（如 build cabin）` };
  let ox = Math.floor(bot.entity.position.x), oy = Math.floor(bot.entity.position.y), oz = Math.floor(bot.entity.position.z);
  if (x != null && !isNaN(Number(x))) ox = Math.floor(Number(x));
  if (z != null && !isNaN(Number(z))) oz = Math.floor(Number(z));
  const t0 = Date.now();
  try {
    const info = await bp.build(ox, oy, oz);
    await safeTp(ox + 4, oy + 1, oz); // 建完站旁边空地，不叠高
    RUNTIME.builtCount++; RUNTIME.lastBuild = key;
    const detail = `已建成【${bp.name}】于 (${ox},${oy},${oz})：${bp.desc}（${info.blocks || ''}块 / ${Date.now() - t0}ms）`;
    console.log(`[build] ${RUN.name} ${detail}`);
    try { appendLog({ ts: new Date().toISOString(), event: 'build', blueprint: key, pos: [ox, oy, oz], ms: Date.now() - t0 }); } catch (e) {}
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: `建造失败: ${e.message}` };
  }
}

async function actLook() {
  return { ok: true, detail: describeNearby() };
}

async function actCollectWood(n) {
  console.log(`[chop] 开始 count=${n} 位置=${bot.entity.position.toString().slice(0, 24)}`);
  await ensureToolForBlock('log'); // 有斧用斧（石斧也行），没斧空手也不报错
  let got = 0, attempts = 0;
  while (got < n && attempts < 5) {
    attempts++;
    const pos = bot.findBlocks({ matching: (b) => LOG_FAMILY.includes(b.name), maxDistance: 48, count: n * 3 + 6 });
    console.log(`[chop] 第${attempts}轮 findBlocks=${pos.length}棵`);
    if (!pos.length) return { ok: got > 0, got, detail: `附近 48 格没有树，撸到 ${got}/${n}——用 go_to 换方向找森林` };
    let minedAny = false;
    for (const p of pos) {
      if (got >= n) break;
      const b = bot.blockAt(p);
      if (!b || !LOG_FAMILY.includes(b.name)) continue;
      // 找该 x,z 列最低 log（树根），目标是树根——走地面到树根再整棵向上撸（修复：目标若在树冠/空中，pathfinder 走不到会 15s 卡死叠加成 60s 超时）
      let baseY = p.y;
      while (baseY > bot.entity.position.y - 10) { const below = bot.blockAt(new Vec3(p.x, baseY - 1, p.z)); if (below && LOG_FAMILY.includes(below.name)) baseY--; else break; }
      const targetY = Math.min(baseY, bot.entity.position.y); // 树根不高于 bot 脚面，确保地面可达
      const tGoto = Date.now();
      console.log(`[chop] goto 树根(${p.x},${baseY},${p.z}) 距=${bot.entity.position.distanceTo(new Vec3(p.x, targetY, p.z)).toFixed(1)}`);
      try { await gotoNear(p.x, targetY, p.z, Math.max(2, bot.entity.position.distanceTo(new Vec3(p.x, targetY, p.z)) > 6 ? 2 : 1), 15000); console.log(`[chop] goto 成功 ${Date.now() - tGoto}ms`); } catch (e) {
        console.log(`[chop] goto 失败 ${Date.now() - tGoto}ms: ${e.message}`);
        // 寻路失败：先挖面前挡路方块重试一次（玩家行为），仍不行才安全传送
        if (await digThroughForward()) { try { await gotoNear(p.x, targetY, p.z, 2, 15000); } catch (e2) { await safeTp(p.x, targetY + 1, p.z); } }
        else { await safeTp(p.x, targetY + 1, p.z); }
      }
      // 整棵撸：从树根(baseY)向上连续挖树干（够不着先站进树桩垫高，不留半截树）
      let cur = bot.blockAt(new Vec3(p.x, baseY, p.z));
      let up = 0;
      while (cur && LOG_FAMILY.includes(cur.name) && up < 12) {
        if (bot.entity.position.distanceTo(cur.position) > 4.5) {
          await walkInto(cur.position.offset(0, -1, 0)); // 站进已挖空的树干格垫高
          if (bot.entity.position.distanceTo(cur.position) > 4.5) break;
        }
        const okd = await digBlockAt(cur.position);
        if (!okd) break;
        got++; minedAny = true;
        await sleep(150);
        cur = bot.blockAt(cur.position.offset(0, 1, 0));
        up++;
      }
      await walkInto(p);
    }
    console.log(`[chop] 第${attempts}轮撸到 ${got}/${n} minedAny=${minedAny}`);
    if (!minedAny) { await sleep(500); }
  }
  await collectDrops();
  return { ok: got >= n, got, detail: `撸到 ${got}/${n} 原木（背包 ${invAny(LOG_FAMILY)}）` };
}

async function actCollectStone(n) {
  if (invCount('wooden_pickaxe') < 1) return { ok: false, detail: '没有木镐挖不了石头——先 craft wooden_pickaxe' };
  await ensureTool(['wooden_pickaxe']); // 分身实锤：不 equip 则空手挖石 0 掉落（考卷成败级）
  // 镐快坏了提前补（玩家直觉：木镐 59 耐久心里有数）
  const pick = bot.inventory.items().find((i) => i.name === 'wooden_pickaxe');
  if (pick && pick.durabilityUsed !== undefined && (pick.durabilityUsed > 44)) RUNTIME.lastResult = '镐快坏了（耐久余量<15），挖完这批记得 craft wooden_pickaxe';
  let got = 0, attempts = 0;
  while (got < n && attempts < 5) {
    attempts++;
    const pos = bot.findBlocks({ matching: (b) => STONE_FAMILY.includes(b.name), maxDistance: 48, count: n * 2 + 4 });
    if (!pos.length) return { ok: got > 0, detail: `附近 48 格没有裸露石头，挖到 ${got}/${n}——用 go_to 换方向找山崖/石壁` };
    let minedAny = false;
    for (const p of pos) {
      if (got >= n) break;
      const b = bot.blockAt(p);
      if (!b || !STONE_FAMILY.includes(b.name)) continue;
      try { await gotoNear(p.x, p.y, p.z, Math.max(1, bot.entity.position.distanceTo(p) > 6 ? 2 : 1), 8000); } catch (e) {
        // 寻路失败：先挖面前挡路方块重试一次（玩家行为），仍不行才 tp 到目标上方挖脚下目标
        if (await digThroughForward()) { try { await gotoNear(p.x, p.y, p.z, 1, 8000); } catch (e2) { if (await safeTpDig(p)) { got++; minedAny = true; } } }
        else { if (await safeTpDig(p)) { got++; minedAny = true; } }
      }
      // 贴身扫面：只挖同高度±1 的横向面，不挖自己脚下（玩家不把自己挖进坑里）
      let cur = bot.blockAt(p);
      let swings = 0;
      while (cur && STONE_FAMILY.includes(cur.name) && swings < n - got + 2) {
        if (bot.entity.position.distanceTo(cur.position) > 4.5) break;
        if (cur.position.x === Math.floor(bot.entity.position.x) && cur.position.z === Math.floor(bot.entity.position.z) && cur.position.y <= Math.floor(bot.entity.position.y)) break; // 脚下正方不挖
        const okd = await digBlockAt(cur.position);
        if (!okd) break;
        got++; minedAny = true; swings++;
        await sleep(120);
        // 找相邻下一块：剔除脚下正方/脚下一格，优先同高度横向面
        const near = bot.findBlocks({ matching: (x) => STONE_FAMILY.includes(x.name), maxDistance: 4, count: 8 })
          .map((q) => bot.blockAt(q)).filter((q) => q && STONE_FAMILY.includes(q.name))
          .filter((q) => !(q.position.x === Math.floor(bot.entity.position.x) && q.position.z === Math.floor(bot.entity.position.z) && q.position.y <= Math.floor(bot.entity.position.y)))
          .sort((a, c) => a.position.distanceTo(bot.entity.position) - c.position.distanceTo(bot.entity.position))[0];
        cur = near || null;
      }
      // 分身建议 #5：挖完不走进挖空格（那是坑），站原位继续扫相邻面
    }
    if (!minedAny) { await sleep(500); }
  }
  await collectDrops();
  return { ok: got >= n, detail: `挖到 ${got}/${n} 圆石（背包 ${invCount('cobblestone')}）` };
}

// chop_tree：撸树逻辑复用 actCollectWood（工具保障已改为 ensureToolForBlock('log')）
async function actChopTree(n) {
  return await actCollectWood(n);
}

// exchange：用攒的兑换点（woodPoint：背包每8原木自动换1点，v3 起原木只看背包、不要求手砍；手挖石头/矿满128也自动换1点）换食物（beef/bread/carrot/cookie）+ 回血项（golden_apple/potion）+ 速度药水（speed）
// 10-19 新增回血项：模型低血自己换 golden_apple/potion，脚本兑换后立即自动装备喝下（不占模型操作）
async function actExchange(item) {
  const it = String(item || '').toLowerCase();
  if (RUNTIME.woodPoint < 1) return { ok: false, detail: '兑换点不够：还没攒出兑换点（背包原木每8个自动换1点，砍树/捡原木最快；手挖石头/矿也能自动换点）' };
  // 食物 4 种数量定死 1/2/3/8；回血 2 种（金苹果/治疗药水，1.21.4 potion_contents data-component 格式）；速度药水 1 种（v3 恢复，10-20）
  const EXCHANGE = {
    beef:   { give: `give ${RUN.name} cooked_beef 1`, label: '牛排×1' },
    bread:  { give: `give ${RUN.name} bread 2`,         label: '面包×2' },
    carrot: { give: `give ${RUN.name} carrot 3`,        label: '胡萝卜×3' },
    cookie: { give: `give ${RUN.name} cookie 8`,        label: '曲奇×8' },
    golden_apple: { give: `give ${RUN.name} golden_apple 1`, label: '金苹果×1', drink: 'golden_apple' },
    potion: { give: `give ${RUN.name} minecraft:potion[minecraft:potion_contents={potion:"minecraft:healing"}] 1`, label: '治疗药水×1', drink: 'potion' },
    speed:  { give: `give ${RUN.name} minecraft:potion[minecraft:potion_contents={potion:"minecraft:swiftness"}] 1`, label: '速度药水×1', drink: 'potion' },
  };
  const opt = EXCHANGE[it];
  if (!opt) return { ok: false, detail: '没有这个兑换项（beef/bread/carrot/cookie/golden_apple/potion/speed）' };
  await rconExec(opt.give);
  RUNTIME.woodPoint--;
  console.log(`[exchange] ${RUN.name} 兑换 ${opt.label}，剩余兑换点=${RUNTIME.woodPoint}`);
  try { appendLog({ ts: new Date().toISOString(), event: 'exchange', item: it, woodPoint: RUNTIME.woodPoint }); } catch (e) {}
  // 回血项：兑换后脚本自动装备喝下
  if (opt.drink) {
    await sleep(400);
    const potionItem = bot.inventory.items().find((i) => i.name === (opt.drink === 'potion' ? 'potion' : 'golden_apple'));
    if (potionItem) {
      try { await bot.equip(potionItem, 'hand'); await bot.consume(); } catch (e) {}
      console.log(`[回血] ${RUN.name} 已自动喝下 ${opt.label}`);
      try { appendLog({ ts: new Date().toISOString(), event: 'heal-drink', item: opt.drink, hp: bot.health }); } catch (e) {}
    }
    return { ok: true, detail: `兑换并喝下 ${opt.label}（花 1 点，剩余兑换点 ${RUNTIME.woodPoint}，血量 ${Math.round(bot.health)}/20）` };
  }
  return { ok: true, detail: `兑换成功：花 1 点换了 ${opt.label}（剩余兑换点 ${RUNTIME.woodPoint}）` };
}

// dig_blocks：以 actCollectStone 为骨架泛化——挖任意 block，按方块自动换工具，不挖脚下，附近无目标返回待脚本代走
async function actDigBlocks(block, n) {
  const b = String(block || 'dirt').toLowerCase();
  await ensureToolForBlock(b); // 缺/将尽自动补发石镐/铲，不再"无工具直接拒"
  let got = 0, attempts = 0;
  const isTarget = (x) => x && x.name === b;
  while (got < n && attempts < 5) {
    attempts++;
    const pos = bot.findBlocks({ matching: (x) => x.name === b, maxDistance: 48, count: n * 2 + 4 });
    if (!pos.length) return { ok: false, detail: `附近无 ${b}——脚本不再自动挪位置，自己 go_to 换方向找` };
    let minedAny = false;
    for (const p of pos) {
      if (got >= n) break;
      const blk = bot.blockAt(p);
      if (!isTarget(blk)) continue;
      try { await gotoNear(p.x, p.y, p.z, Math.max(1, bot.entity.position.distanceTo(p) > 6 ? 2 : 1), 8000); } catch (e) {
        if (await digThroughForward()) { try { await gotoNear(p.x, p.y, p.z, 1, 8000); } catch (e2) { if (await safeTpDig(p, b)) { got++; minedAny = true; } } }
        else { if (await safeTpDig(p, b)) { got++; minedAny = true; } }
      }
      // 贴身扫面：只挖同高度横向面，脚下正方不挖（沿用 actCollectStone 两处 filter）
      let cur = bot.blockAt(p);
      let swings = 0;
      while (cur && isTarget(cur) && swings < n - got + 2) {
        if (bot.entity.position.distanceTo(cur.position) > 4.5) break;
        if (cur.position.x === Math.floor(bot.entity.position.x) && cur.position.z === Math.floor(bot.entity.position.z) && cur.position.y <= Math.floor(bot.entity.position.y)) break;
        const okd = await digBlockAt(cur.position);
        if (!okd) break;
        got++; minedAny = true; swings++;
        await sleep(120);
        const near = bot.findBlocks({ matching: (x) => x.name === b, maxDistance: 4, count: 8 })
          .map((q) => bot.blockAt(q)).filter(isTarget)
          .filter((q) => !(q.position.x === Math.floor(bot.entity.position.x) && q.position.z === Math.floor(bot.entity.position.z) && q.position.y <= Math.floor(bot.entity.position.y)))
          .sort((a, c) => a.position.distanceTo(bot.entity.position) - c.position.distanceTo(bot.entity.position))[0];
        cur = near || null;
      }
    }
    if (!minedAny) { await sleep(500); }
  }
  await collectDrops();
  return { ok: got >= n, detail: `挖到 ${got}/${n} 个 ${b}` };
}

async function ensureTable() {
  // 复用已有台子（用户洞察：bot 挖木/挖石走远后别每次重放新台子——先找 32 格内已有台子，找到就直接用，打断"放台→走远→重放"死循环）
  try {
    const tb = bot.findBlocks({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 32, count: 1 })[0];
    if (tb) { const blk = bot.blockAt(tb); if (blk && blk.name === 'crafting_table') return blk; }
  } catch (e) {}
  // 脚下 3 格内有台子？
  for (const d of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 0, 1], [-1, 0, -1]]) {
    const b = bot.blockAt(bot.entity.position.offset(d[0], d[1], d[2]));
    if (b && b.name === 'crafting_table') return b;
  }
  // 背包没台子：有 4 块木板就先自己合成一个（prompt 承诺“脚本自动处理台子”，必须兑底到底——gemma 信了承诺直接合斧，脚本不能掉链子）
  if (invCount('crafting_table') < 1) {
    const planksHeld = invCount('oak_planks') + invCount('spruce_planks') + invCount('birch_planks') + invCount('dark_oak_planks') + invCount('birch_planks');
    if (planksHeld < 4) return null; // 材料不够，由 actCraft 上游提示 craft planks
    try {
      const mcData = require('minecraft-data')(bot.version);
      const ct = mcData.itemsByName['crafting_table'];
      const recipes = bot.recipesFor(ct.id, null, 1, null);
      if (recipes.length) { await bot.craft(recipes[0], 1, null); console.log('[合成] 🛠️ 台子没带就自己合一个（玩家本能）'); }
    } catch (e) { console.log('[合成] 台子合成失败:', e.message); return null; }
  }
  // 背包有台子 → 找地方放
  if (invCount('crafting_table') > 0) {
    // 真根因（探针四组对照实证）：findBlocks 的 matching 回调里，传入的 b 是 Block 但 .position 为 null！
    // 访问 b.position.x 必崩 null.x（run3 实锤）；加 b && b.position 保护则把所有候选都短路拒掉 → 空数组找不到落点。
    // 正确做法：matching 里只判断方块类型（不碰 position），返回数组是 Vec3（血泪坑④：findBlocks 返回 Vec3 无 .position），
    // 在结果层用 v.x/v.z 剔除 bot 脚下列（往自己站格顶面放会被服务端拒 the block is still air 实锤）。
    let ref = null;
    try {
      const cands = bot.findBlocks({ matching: (b) => b && b.name !== 'air' && b.boundingBox !== 'empty', maxDistance: 3, count: 12 });
      // 结果层筛选：①剔除脚下列（往自己站格顶面放会被服务端拒 the block is still air）
      // ②顶面必须是空气（run10 实证：bot 在树冠里反复放台子失败 "Server refused to place crafting_table ... the block is still oak_leaves"，候选顶面被树叶占）
      ref = cands.find((v) => {
        if (v.x === Math.floor(bot.entity.position.x) && v.z === Math.floor(bot.entity.position.z)) return false;
        const above = bot.blockAt(v.offset(0, 1, 0));
        return above && above.name === 'air';
      });
    } catch (e) { console.log('[合成] 找落点异常:', e.message); }
    if (ref) {
      try {
        await gotoNear(ref.x, ref.y, ref.z, 2, 8000);
        const item = bot.inventory.items().find((i) => i.name === 'crafting_table');
        await bot.equip(item, 'hand');
        await bot.lookAt(ref.offset(0.5, 1.2, 0.5));
        // 顶面放置：faceVector 必须是单位轴向量；ref 本身就是 Vec3 坐标（原 ref.position 是不存在的属性，每次必崩——分身报告另注的暗雷之一）
        await bot.placeBlock(bot.blockAt(ref), new Vec3(0, 1, 0));
        await sleep(400);
        const placed = bot.findBlocks({ matching: (b) => b.name === 'crafting_table', maxDistance: 4, count: 1 })[0];
        if (placed) { console.log('[合成] 工作台已放置'); return bot.blockAt(placed); }
      } catch (e) { console.log('[合成] 放台子失败:', e.message); }
    }
  }
  return null;
}

async function actCraft(item) {
  if (!CRAFTABLE.includes(item)) return { ok: false, detail: `白名单外物品: ${item}（只能 planks/sticks/wooden_axe/wooden_pickaxe）` };
  const mcData = require('minecraft-data')(bot.version);
  const full = item === 'planks' ? 'oak_planks' : item === 'sticks' ? 'stick' : item;
  const it = mcData.itemsByName[full];
  if (!it) return { ok: false, detail: `未知物品 ${full}` };
  // 斧镐需要台子 → 自动保障
  let table = null;
  if (item === 'wooden_axe' || item === 'wooden_pickaxe') {
    if (invCount('crafting_table') < 1 && invAny(['oak_planks', 'spruce_planks', 'birch_planks']) < 4) {
      return { ok: false, detail: '合成斧/镐需要工作台（4 木板），先 craft planks 攒够木板' };
    }
    table = await ensureTable();
    if (!table) return { ok: false, detail: '工作台自动放置失败，稍后再试或换位置' };
  }
  const count = item === 'planks' ? 8 : item === 'sticks' ? 8 : 1;
  // planks 树种适配：背包里什么原木就合什么板（云杉局 missing ingredient 实锤）
  const plankTargets = item === 'planks' ? ['oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks', 'jungle_planks', 'acacia_planks', 'cherry_planks', 'mangrove_planks'] : [full];
  let recipes = [];
  for (const target of plankTargets) {
    const it2 = mcData.itemsByName[target];
    if (!it2) continue;
    recipes = bot.recipesFor(it2.id, null, 1, table);
    if (recipes.length) break;
  }
  try {
    if (!recipes.length) {
      const tips = { planks: '需要先撸原木', sticks: '需要木板（craft planks）', wooden_axe: '需要木板×3+木棍×2', wooden_pickaxe: '需要木板×3+木棍×2' };
      return { ok: false, detail: `材料不足: ${tips[item] || '配方不可用'}` };
    }
    if (table) {
      setMovements();
      // 血泪坑7：bot.craft 必须站台子 1 格内，否则 updateSlot 20s 超时。
      // 不能对台子本身用 GoalNear(range=1)（树冠/地形下常站不进、被树叶堵）；改找台子水平相邻的"可站格"（地面+空气）再 goto。
      let stand = null;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const p = table.position.offset(dx, 0, dz);
        const g = bot.blockAt(p), below = bot.blockAt(p.offset(0, -1, 0));
        if (g && g.name === 'air' && below && below.boundingBox !== 'empty') { stand = p; break; }
      }
      if (stand) { try { await gotoNear(stand.x, stand.y, stand.z, 0.5, 8000); } catch (e) {} }
      console.log(`[craft-站位] 目标=${item} bot@${bot.entity.position.floored().toString()} 台子@${table.position.toString()} 距离=${bot.entity.position.distanceTo(table.position).toFixed(1)} 站立点=${stand ? stand.toString() : '无'}`);
    } // 站进台子 1 格内（updateSlot 超时实锤：距离不够服务端不响应窗口）
    await bot.craft(recipes[0], count, table);
    console.log(`[合成] ✅ ${full} x${count}`);
    return { ok: true, detail: `合成 ${full} x${count} 成功` };
  } catch (e) { return { ok: false, detail: `合成失败: ${e.message}` }; }
}

// go_to：模型自主移动——四方向 north/south/east/west，或 rally/home(回会合点)，或 mate/teammate(靠近队友)
// 寻路超时兜底：走不过去就如实反馈"换个目标"，不干等（10-19 双子自主作战改造）
async function actGoTo(direction, distance) {
  const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
  const dir = String(direction || '').toLowerCase();
  let gx, gz, grange = 3, targetDesc;
  if (dirs[dir]) {
    const dist = Math.min(64, Math.max(8, Number(distance) || 24));
    gx = bot.entity.position.x + dirs[dir][0] * dist; gz = bot.entity.position.z + dirs[dir][1] * dist;
    targetDesc = `向 ${dir} 走约 ${dist} 格`;
  } else if (dir === 'rally' || dir === 'home' || dir === 'rescue' || dir === 'spawn') {
    gx = PLATFORM.sx; gz = PLATFORM.sz; targetDesc = '回会合点'; grange = 2;
  } else if (dir === 'mate' || dir === 'teammate' || dir === 'follow') {
    // 动态枚举：最近的在线玩家（排除自己），不再写死队友名
    const mate = bot.nearestEntity((e) => e.type === 'player' && e.username !== bot.username);
    if (!mate) return { ok: false, detail: '附近找不到队友——换个方向 go_to 再找，别原地干等' };
    gx = mate.position.x; gz = mate.position.z; targetDesc = `靠近队友(${mate.username})`; grange = 3;
  } else {
    return { ok: false, detail: 'direction 要给 north/south/east/west，或 rally(回会合点)、mate(靠近队友)——走不过去就换个目标 go_to，别干等' };
  }
  try {
    await gotoNear(gx, bot.entity.position.y, gz, grange, 25000);
    return { ok: true, detail: `[go_to] 已${targetDesc}（落点 ${Math.round(bot.entity.position.distanceTo(new Vec3(gx, bot.entity.position.y, gz)))}格内）` };
  } catch (e) {
    return { ok: false, detail: `[go_to] 去${targetDesc}途中走不过去（寻路超时/受阻，已尽力走一段）——换个方向或目标 go_to，别原地干等` };
  }
}

// give：把背包里的物品走到队友身边丢地上让她捡（饿了/缺东西/血低时主动给）
async function actGive(item, count) {
  const itemName = String(item || '').toLowerCase().trim();
  const n = Math.max(1, Math.min(64, Number(count) || 1));
  if (!itemName) return { ok: false, detail: 'give 要带 item=物品id（如 cooked_beef/bread/tnt）' };
  // 1. 检查背包有没有
  const have = bot.inventory.items().filter((i) => i.name === itemName);
  const totalHave = have.reduce((s, i) => s + i.count, 0);
  if (totalHave < 1) return { ok: false, detail: `背包里没有 ${itemName}——没法给，先去赚/换这个物品再说` };
  const giveN = Math.min(n, totalHave);
  // 2. 找队友（动态枚举：最近在线玩家，排除自己）
  const mate = bot.nearestEntity((e) => e.type === 'player' && e.username !== bot.username);
  if (!mate) return { ok: false, detail: '附近找不到队友——先 go_to direction=mate 靠近她，再 give' };
  // 3. 走到队友身边（2 格内）
  try { await gotoNear(mate.position.x, bot.entity.position.y, mate.position.z, 2, 25000); }
  catch (e) { return { ok: false, detail: `走到队友身边失败：${e.message}（已尽力走一段）` }; }
  // 4. 重新定位队友（走到附近后队友可能动了）
  const mateNow = bot.nearestEntity((e) => e.type === 'player' && e.username !== bot.username);
  if (mateNow) { try { await bot.lookAt(mateNow.position.offset(0, 1, 0)); } catch (e) {} }
  await sleep(300);
  // 5. 从背包再拿一次（防走到队友途中背包被别的动作动过）
  const it = bot.inventory.items().find((i) => i.name === itemName && i.count > 0);
  if (!it) return { ok: false, detail: `走到队友身边后背包里 ${itemName} 没了？` };
  const tossN = Math.min(giveN, it.count);
  try { await bot.toss(it.type, it.metadata, tossN); }
  catch (e) { return { ok: false, detail: `丢物品失败：${e.message}` }; }
  // 6. bot 自己在公屏说一句
  try { bot.chat(`给你扔了 ${tossN} 个 ${itemName}，捡一下！`); } catch (e) {}
  console.log(`[give] ${RUN.name} → ${mate.username} 扔了 ${tossN} 个 ${itemName}`);
  try { appendLog({ ts: new Date().toISOString(), event: 'give', item: itemName, count: tossN, to: mate.username }); } catch (e) {}
  return { ok: true, detail: `已走到队友身边，扔了 ${tossN} 个 ${itemName} 给她捡` };
}

// 垫脚料取用链：指定 block → dirt → cobblestone → 原木族 → 木板族；全空返回 null
function pickPillarBlock(preferredBlock) {
  const chain = [preferredBlock, 'dirt', 'cobblestone', ...LOG_FAMILY, ...PLANK_FAMILY];
  for (const name of chain) { if (name && invCount(name) > 0) return name; }
  return null;
}

// 共享放置 helper（placeBlock 血泪实证：equip 手持 → lookAt(ref.offset(0.5,1.2,0.5)) → placeBlock(refBlock, 单位轴 face)）
async function pillarPlace(placePos, standPos, ref, face, preferredBlock) {
  if (!ref) return false;
  const refBlock = bot.blockAt(ref);
  if (!refBlock || refBlock.boundingBox === 'empty' || refBlock.name === 'water' || refBlock.name === 'lava') return false; // ref 非实心放弃
  let mat = pickPillarBlock(preferredBlock);
  if (!mat) { await rconExec(`give ${RUN.name} dirt 32`); await sleep(500); mat = 'dirt'; }
  const item = bot.inventory.items().find((i) => i.name === mat);
  if (!item) return false;
  try {
    await bot.equip(item, 'hand');
    await bot.lookAt(ref.offset(0.5, 1.2, 0.5));
    await bot.placeBlock(refBlock, face);
    await sleep(400);
    if (standPos) await walkInto(standPos);
    return true;
  } catch (e) { return false; }
}

// 前方水域/骤降探测（与 describeNearby 提示共用）：返回 {placePos,standPos,ref,face,type} 或 null
function frontHazardProbe() {
  const yaw = bot.entity.yaw;
  const fx = Math.round(-Math.sin(yaw)), fz = Math.round(Math.cos(yaw));
  if (fx === 0 && fz === 0) return null;
  const feet = bot.entity.position.floored();
  const frontFeet = feet.offset(fx, 0, fz);
  const fb = bot.blockAt(frontFeet);
  const fbBelow = bot.blockAt(frontFeet.offset(0, -1, 0));
  const isWater = (b) => b && b.name === 'water';
  const isSolid = (b) => b && b.boundingBox !== 'empty' && b.name !== 'water' && b.name !== 'lava';
  // A：面前脚格是水 → 向下扫首个实心块当 ref，face=(0,1,0) 填水过河
  if (isWater(fb)) {
    let ref = null;
    for (const dy of [-1, -2, -3]) { const c = bot.blockAt(frontFeet.offset(0, dy, 0)); if (isSolid(c)) { ref = frontFeet.offset(0, dy, 0); break; } }
    if (!ref) return null;
    return { type: 'water', placePos: frontFeet, standPos: frontFeet, ref, face: new Vec3(0, 1, 0) };
  }
  // B：面前脚格空、其下一格是水 → 填脚下水再迈过去
  if ((!fb || fb.boundingBox === 'empty') && isWater(fbBelow)) {
    const ref = frontFeet.offset(0, -2, 0);
    if (!isSolid(bot.blockAt(ref))) return null;
    return { type: 'water', placePos: frontFeet.offset(0, -1, 0), standPos: frontFeet, ref, face: new Vec3(0, 1, 0) };
  }
  // C：面前脚格空、其下一格也空（非水）→ 水平搭地沿防骤降
  if ((!fb || fb.boundingBox === 'empty') && (!fbBelow || fbBelow.boundingBox === 'empty') && !isWater(fbBelow)) {
    const ref = feet.offset(0, -1, 0);
    if (!isSolid(bot.blockAt(ref))) return null;
    return { type: 'drop', placePos: frontFeet.offset(0, -1, 0), standPos: frontFeet, ref, face: new Vec3(fx, 0, fz) };
  }
  return null;
}

// W4 脚本自动垫脚：探测到危险 且 距上次≥6s 且 连续<8 次 → 自动放一格垫脚料（兑现 JSON pillar_rule.auto_fallback）
async function autoPillarAhead() {
  const feetB = bot.blockAt(bot.entity.position);
  const headB = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  if ((feetB && (feetB.name === 'water' || feetB.name === 'lava')) || (headB && (headB.name === 'water' || headB.name === 'lava'))) return; // bot 自己在水里不垫
  // 水漏进坑/贴水时不再自动垫脚打断拆方块（主人 10-17：一进水就触发垫脚石打断，今天被打断 2 次）：五格邻位有水直接 return 不垫
  const nearPillarWater = [bot.blockAt(bot.entity.position.offset(0, -1, 0)), bot.blockAt(bot.entity.position.offset(1, 0, 0)), bot.blockAt(bot.entity.position.offset(-1, 0, 0)), bot.blockAt(bot.entity.position.offset(0, 0, 1)), bot.blockAt(bot.entity.position.offset(0, 0, -1))].some((b) => b && b.name === 'water');
  if (nearPillarWater) return;
  if (await nearestHostile(6)) return; // 附近 6 格有怪不垫
  if (RUNTIME.autoPillarStreak >= 8) return; // 连续垫 8 次停手交回提示
  const haz = frontHazardProbe();
  if (!haz) return;
  if (Date.now() - RUNTIME.lastAutoPillar < 6000) return;
  const ok = await pillarPlace(haz.placePos, haz.standPos, haz.ref, haz.face, 'dirt');
  if (ok) {
    RUNTIME.lastAutoPillar = Date.now();
    RUNTIME.autoPillarStreak++;
    RUNTIME.lastResult = `脚本已自动垫脚${haz.type === 'water' ? '过河' : '垫格'}（你继续拆）`;
    appendLog({ ts: new Date().toISOString(), event: 'auto-pillar', type: haz.type });
  }
}

// 统计某位置附近实心方块数（TNT 爆炸前后差值估算炸掉数）
function countSolidAround(cx, cy, cz, r) {
  let n = 0;
  for (let dx = -r; dx <= r; dx++) for (let dy = -3; dy <= 5; dy++) for (let dz = -r; dz <= r; dz++) {
    const b = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
    if (b && b.boundingBox !== 'empty' && !['bedrock', 'water', 'lava'].includes(b.name)) n++;
  }
  return n;
}
// TNT 实验动作（主人）：place_block block=tnt 时触发。模型未被告知 TNT 是"高效拆除工具"——
// 若它主动尝试 tnt 即可放置并点燃爆炸，观察其是否自主探索发现 TNT 拆除效率并持续使用。
// 流程：确保 TNT+打火石 → 面前 3 格找安全放置位 → 走近放置 → 打火石点燃 → 撤 14 格 → 等爆炸 → 差值估算炸掉数入 broken。
async function actTNTBlow(n) {
  const cnt = Math.min(8, Math.max(1, Number(n) || 1));
  const pos = bot.entity.position;
  const yaw = bot.entity.yaw;
  const fx = Math.round(-Math.sin(yaw)), fz = Math.round(Math.cos(yaw));
  const dirs = (fx !== 0 || fz !== 0) ? [[fx, fz], [-fz, fx], [fz, -fx], [-fx, -fz]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // 放宽选位：地下/密闭空间也能放（主人：算好距离拉开别把自己搭进去；TNT 是 32 拆换 1 颗的消耗品，找到位置就放）
  // 只要求"脚下实心（非水/熔岩）"就能放 TNT（setblock 直接放方块上也能炸），尽量挑方块密度大的位置炸得多，找不到也不强求
  let base = null, bestScore = -1;
  for (const [dx, dz] of dirs) {
    for (let d = 2; d <= 6; d++) {
      const bx = pos.floored().x + dx * d, bz = pos.floored().z + dz * d;
      for (let dy = 1; dy >= -3; dy--) {
        const sy = pos.floored().y + dy;
        const g = bot.blockAt(new Vec3(bx, sy - 1, bz));
        if (g && g.boundingBox !== 'empty' && g.name !== 'water' && g.name !== 'lava') {
          const score = countSolidAround(bx, sy, bz, 6);
          if (score > bestScore) { bestScore = score; base = { x: bx, y: sy, z: bz }; }
        }
      }
    }
  }
  if (!base) return { ok: false, detail: '附近没有适合放 TNT 的位置（找个开阔点再试）' };
  // 放雷数量受背包 TNT 约束：雷是攒的、放一颗少一颗，用完得手动拆赚（让模型心疼雷、数量真实对得上）
  const have = invCount('tnt');
  const want = Math.min(cnt, 8, have);
  if (want < 1) return { ok: false, detail: `背包没有 TNT（tnt×0），先手动拆满 32 赚一颗再来` };
  // ★ 修复（主人 10-18 实测 8 颗只记 1 块）：before 统计必须放在放置前——TNT fuse 4s，
  // 放置 8 颗需 3.2s + 撤离 14 格，第一颗在撤离期间就炸了，原"撤离后才统计 before"导致差值≈0
  const before = countSolidAround(base.x, base.y, base.z, 10);
  let placed = 0;
  for (let i = 0; i < want; i++) { // 单次最多 8 颗（主人限定），防一次全放光把服务器炸崩
    const tx = base.x + i * 2, tz = base.z; // 间隔 2 格：多颗爆炸范围叠加更猛
    await rconExec(`setblock ${tx} ${base.y} ${tz} minecraft:tnt`); // 脚本直接生成 TNT 方块
    await rconExec(`setblock ${tx} ${base.y + 1} ${tz} minecraft:redstone_block`); // 上方放红石块激活点燃
    placed++;
    await sleep(400);
  }
  try { await gotoNear(pos.x - dirs[0][0] * 14, pos.y, pos.z - dirs[0][1] * 14, 3, 10000); } catch (e) {} // 撤出爆炸范围
  await sleep(5500); // 等爆炸充分结算
  const after = countSolidAround(base.x, base.y, base.z, 10);
  const blasted = Math.max(0, before - after);
  await rconExec(`clear ${RUN.name} minecraft:tnt ${placed}`); // 引爆后扣背包 TNT（放 N 颗扣 N 颗，数量真实、让模型心疼）
  RUNTIME.tntBroken += (blasted || placed * 6); RUNTIME.brokenCount += (blasted || placed * 6); // TNT炸的单独记账（不算手动、不触发奖励）
  return { ok: true, detail: `脚本放置 ${placed} 颗 TNT 并引爆，炸掉约 ${blasted || placed * 6} 块（爆炸拆除效率极高，背包 TNT 扣了 ${placed}）` };
}
// place_block：位置脚本判断（面前水域/坑 → 垫脚；脚下方空气 → 向上搭塔），模型不输出坐标
async function actPlaceBlock(block, n) {
  const cnt = Math.min(8, Math.max(1, Number(n) || 1));
  const b = String(block || 'dirt').toLowerCase();
  if (b === 'tnt') return await actTNTBlow(n); // 实验分支（主人）：模型主动尝试 tnt → 放置并引爆
  let placed = 0;
  for (let i = 0; i < cnt; i++) {
    const haz = frontHazardProbe();
    if (haz && await pillarPlace(haz.placePos, haz.standPos, haz.ref, haz.face, b)) { placed++; continue; }
    // 脚下方空气 → 向上搭塔（ref=脚下第二格须实心，face=(0,1,0)）
    const feet = bot.entity.position.floored();
    const below = bot.blockAt(feet.offset(0, -1, 0));
    if (!below || below.boundingBox === 'empty') {
      const ref = feet.offset(0, -2, 0);
      if (!bot.blockAt(ref) || bot.blockAt(ref).boundingBox === 'empty') break;
      if (await pillarPlace(feet.offset(0, -1, 0), feet, ref, new Vec3(0, 1, 0), b)) { placed++; continue; }
    }
    break;
  }
  return { ok: placed > 0, detail: placed > 0 ? `已垫脚 ${placed} 格` : '面前没有可垫脚的位置（无水域/坑，脚下是实的）' };
}

// fight：模型下令才执行（脚本不自动还击）。方案A：不禁怪种，下界合金剑贴身近战打所有怪——
// 远程怪(骷髅/女巫/掠夺者)也主动贴身近战（不远程对射风筝）；苦力怕贴砍一下就后撤防爆。
// 盾：远程怪和苦力怕战斗中自动举盾格挡（箭/爆炸减伤），攻击瞬间收盾、攻击后再举。
async function actFight(mode) {
  const target = await nearestHostile(24);
  if (!target) return { ok: false, detail: '附近无敌对生物' };
  await ensureCombatGear();
  const isCreeper = target.name === 'creeper';
  const isRanged = ['skeleton', 'witch', 'pillager'].includes(target.name);
  const needShield = isCreeper || isRanged;
  const t0 = Date.now();
  while (target.isValid && bot.health > 0) {
    const d = bot.entity.position.distanceTo(target.position);
    if (isCreeper && d < 3.5) {
      // 苦力怕贴脸→朝反方向后撤拉开（防爆）
      const dx = bot.entity.position.x - target.position.x, dz = bot.entity.position.z - target.position.z;
      try { await gotoNear(bot.entity.position.x + dx, bot.entity.position.y, bot.entity.position.z + dz, 2, 4000); } catch (e) {}
    } else if (d > 2.5) {
      try { await gotoNear(target.position.x, target.position.y, target.position.z, 2, 8000); } catch (e) {}
    }
    await ensureTool(['netherite_sword']);
    await bot.lookAt(target.position.offset(0, 1, 0));
    if (needShield) { try { await bot.activateItem(); } catch (e) {} } // 举盾格挡
    bot.attack(target);
    await sleep(600);
    if (needShield) { try { bot.deactivateItem(); } catch (e) {} } // 收盾备下轮
    if (Date.now() - t0 > 30000 || bot.health < 10) break; // 30s 或血<10 交回模型/保命兜底
  }
  if (needShield) { try { bot.deactivateItem(); } catch (e) {} }
  await collectDrops();
  return { ok: true, detail: isCreeper ? `[fight] 苦力怕处理完毕（贴砍+后撤防爆+举盾，${target.isValid ? '还活着' : '已打倒'}）` : `[fight] 近战贴脸攻击完毕（${needShield ? '举盾格挡' : '纯近战'}，${target.isValid ? '目标还活着，可再下令 fight 补刀' : '目标已打倒'}）` };
}

// flee：指定四向跑 16 格；缺省/away 取反最近怪方向；跑完仍贴脸且血<10 → 转 escape
async function actFlee(direction) {
  const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
  let dir = String(direction || '').toLowerCase();
  if (!dirs[dir]) {
    const mob = await nearestHostile(24);
    if (mob) {
      const dx = bot.entity.position.x - mob.position.x, dz = bot.entity.position.z - mob.position.z;
      dir = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
    } else dir = 'north';
  }
  const g = await actGoTo(dir, 16);
  const mob = await nearestHostile(3);
  if (mob && bot.health < 10) return await actEscape();
  return g;
}

// escape：安全 tp 回自己的出生点平台（safeTp 内部已含落点修正 + 落地清障）
async function actEscape() {
  await safeTp(PLATFORM.sx, PLATFORM.sy, PLATFORM.sz);
  return { ok: true, detail: '已脱困传送回出生点会合平台' };
}

// ---------- 主循环（动作完立即决策，无 sleep） ----------
let running = true;
async function mainLoop() {
  appendLog({ ts: new Date().toISOString(), event: 'run-start', name: RUN.name, role: '无限破坏工（自主选拆）' });
  // 启动错峰：按 spawnSlot × staggerStartMs 错峰开工，避免 6 bot 同一瞬间打 API 触发 429 雪崩
  if (RUN.spawnSlot > 0) { const waitMs = RUN.spawnSlot * RUN.staggerStartMs; console.log('[错峰] slot=' + RUN.spawnSlot + ' 延迟 ' + waitMs + 'ms 开工'); await sleep(waitMs); }
  while (running) {
    // 无限破坏工无固定终点：不设收工逻辑，一直自主选拆（由主人手动停，或 --minutes 观测上限仅记录不退出）
    clearSurplusInv(); // 背包材料多时扔一批腾空位，保证工具/食物 give 不落地
    await autoWoodExchange(); // 原木自动兑换（v3）：背包每满 8 原木扣 8 换 1 兑换点（不要求手砍，捡的也算）
    // 实验观测上限（--minutes）：只记一次日志，不 break 不 exit——无限破坏工无终点，到点只是记录
    if (RUN.minutes > 0 && Date.now() - RUNTIME.startedAt > RUN.minutes * 60000 && !RUNTIME.obsNoted) {
      RUNTIME.obsNoted = true;
      console.log('[观测上限] 已达 --minutes 实验时长；这是实验局时长，不是角色停，破坏工继续拆');
      appendLog({ ts: new Date().toISOString(), event: 'obs-ceiling', minutes: RUN.minutes });
    }
    await Promise.race([autoPillarAhead(), new Promise((r) => setTimeout(() => r(), 15000))]); // W4 垫脚带 15s 护栏，防 placeBlock 卡死主循环
    // 无大脑（E_NO_PROVIDER）：不发请求，空转等下轮（/state 已报黄卡）
    if (RUNTIME.meta.errorCode === 'E_NO_PROVIDER') { await sleep(RUN.decisionMs); continue; }
    // 决策间隔真接线（二期改造）：写死的 1.5s 改读 AICRAFT_DECISION_MS（默认 3000）
    await sleep(RUN.decisionMs);
    await leaseWait(); // best-effort 共享冷却（center 不可达失败放行）
    const user = buildUserPrompt();
    RUNTIME.llmBusy = true;
    if (RUNTIME.busySince === null) RUNTIME.busySince = Date.now(); // busy 锁看门狗：LLM 忙起始计时（与 actionBusy 共享一个时间戳）
    const r = await askLLM(user);
    RUNTIME.llmBusy = false;
    if (!RUNTIME.actionBusy) RUNTIME.busySince = null; // LLM 忙结束且动作也不忙 → 清除看门狗计时
    // 错误分类落盘 + 退避熔断（二期改造：禁止吞错空转，r.err 必须进 /state.meta.errorCode/lastErr）
    // E_EMPTY_REPLY = 这一轮没想出来（灰，不红卡、不熔断）
    if (r.errCode && r.errCode !== 'E_EMPTY_REPLY') { handleLlmError(r.errCode, r.errMsg || ''); await applyBackoff(r.errCode); }
    else clearLlmError();
    const act = parseAction(r.text);
    // chat 附带字段：不是独立动作、不占干活轮；异步发到公屏（不 await），随后照常执行主动作
    let iSaid = '';
    if (act && typeof act.chat === 'string' && act.chat.trim()) {
      iSaid = act.chat.trim();
      let c = iSaid;
      if (c.startsWith('/')) c = c.slice(1); // 安全：以 / 开头去掉首字符，绝不当命令执行
      try { bot.chat(c); } catch (e) {}
      RUNTIME.selfChats.push({ id: BOOT_TAG + '-' + (++CHAT_SEQ), msg: iSaid, ts: Date.now() }); // 自己发出的话存档（决策页气泡，上限5条）
      if (RUNTIME.selfChats.length > RUN.memoryRounds) RUNTIME.selfChats.shift();
    }
    let result;
    if (!act) {
      if (r.errCode === 'E_EMPTY_REPLY') result = { ok: false, detail: '这一轮没想出动作（大脑回了空白，下一轮继续）' };
      else if (r.errCode) result = { ok: false, detail: friendlyLlmErr(r.errCode, r.httpStatus) };
      else result = { ok: false, detail: '输出不是合法 JSON——记住只输出一行 JSON' };
    } else {
      const t0 = Date.now();
      RUNTIME.actionBusy = true;
      if (RUNTIME.busySince === null) RUNTIME.busySince = Date.now(); // busy 锁看门狗：动作忙起始计时
      RUNTIME.digThroughCount = 0; // 本轮挖挡路计数清零
      try {
        result = await Promise.race([
          (async () => {
            let cnt = Math.min(16, Number(act.count) || 4);
            if (cnt < 1) cnt = 1; // 物理保底：count 非法（0/负/非数字）至少挖 1 个；不设下限，模型自由选 1~32，也可走 go_to 等非挖掘动作
            if (act.action === 'chop_tree' || act.action === 'collect_wood') {
              const r = await actChopTree(cnt);
              // 兑换改为背包自动扣（v3）：原木只看背包有无，每 8 个自动换 1 兑换点（捡到/手砍都算），由 autoWoodExchange 统一处理
              await autoWoodExchange();
              return r;
            }
            else if (act.action === 'dig_blocks' || act.action === 'collect_stone') return await actDigBlocks(String(act.block || (act.action === 'collect_stone' ? 'stone' : 'dirt')), cnt);
            else if (act.action === 'place_block') return await actPlaceBlock(String(act.block || 'dirt'), cnt);
            else if (act.action === 'build') return await actBuild(String(act.name || ''), Number(act.x), Number(act.z)); // 方案B：拆工也能建（蓝图秒建）
            else if (act.action === 'look') return await actLook();
            else if (act.action === 'fight') return await actFight(String(act.mode || 'auto'));
            else if (act.action === 'flee') return await actFlee(String(act.direction || ''));
            else if (act.action === 'escape') return await actEscape();
            else if (act.action === 'exchange') return await actExchange(String(act.item || ''));
            else if (act.action === 'go_to') return await actGoTo(String(act.direction || ''), act.distance);
            else if (act.action === 'give') return await actGive(String(act.item || ''), Number(act.count) || 1);
            else return { ok: false, detail: `未知动作 ${act.action}` };
          })(),
          new Promise((r) => setTimeout(() => r({ ok: false, detail: '动作执行超时 180s', ms: 0 }), 180000)),
        ]);
      } catch (e) { result = { ok: false, detail: `执行异常: ${e.message}` }; }
      RUNTIME.actionBusy = false;
      if (!RUNTIME.llmBusy) RUNTIME.busySince = null; // 动作忙结束且 LLM 也不忙 → 清除看门狗计时
      result.ms = Date.now() - t0;
      appendLog({ ts: new Date().toISOString(), action: act.action, params: act, result: { ok: result.ok, detail: result.detail }, broken: RUNTIME.brokenCount, reply: r.text });
    }
    // 10-19 双子作战改造：移除"脚本自动代走"——附近没东西拆时脚本不再自动随机挪位置；
    // 挪不挪、往哪挪全交模型 go_to 决策（结果进 lastResult，下一轮模型自己看见并决定移动）。
    // 连续失败 ≥3 → 安全 tp 脱困，failStreak 归零
    if (result.ok) RUNTIME.failStreak = 0;
    else {
      RUNTIME.failStreak++;
      if (RUNTIME.failStreak >= 3) {
        await safeTp(PLATFORM.sx, PLATFORM.sy, PLATFORM.sz);
        RUNTIME.failStreak = 0;
        RUNTIME.lastResult = '连续 3 次失败，脚本已 tp 脱困到出生点';
        appendLog({ ts: new Date().toISOString(), event: 'fail-streak-rescue' });
      }
    }
    RUNTIME.lastResult = (result.ok ? '✓ ' : '✗ ') + result.detail;
    RUNTIME.lastReply = r.text || ''; // 决策 JSON 全文
    RUNTIME.lastReasoning = r.reasoning || ''; // 模型思考过程
    decisions.push({ id: BOOT_TAG + '-' + (++DEC_SEQ), t: new Date().toISOString().slice(11, 19), act: act ? act.action : '(解析失败)', ok: result.ok, detail: result.detail, llmMs: r.ms, reasoning: r.reasoning || '' });
    if (decisions.length > 40) decisions.shift();
    console.log(`[决策 ${decisions[decisions.length - 1].t}] ${act ? act.action : '(失败)'} → ${result.detail}（LLM ${r.ms}ms / 动作 ${result.ms || 0}ms）`);
    // 本轮精简历史入 FIFO 窗口（最近 5 轮，更早挤掉）
    const actBrief = act ? `${act.action}${act.block ? ' ' + act.block : ''}${act.item ? ' ' + act.item : ''}${act.count ? ' ' + act.count : ''}` : '(解析失败)';
    const teammateSaid = RUNTIME.teammateChats.length ? RUNTIME.teammateChats[RUNTIME.teammateChats.length - 1].msg : '';
    RUNTIME.roundHistory.push({ act: actBrief, result: result.detail || '', iSaid, teammateSaid });
    if (RUNTIME.roundHistory.length > RUN.memoryRounds) RUNTIME.roundHistory.shift();
    try { appendLog({ ts: new Date().toISOString(), event: 'history-update', len: RUNTIME.roundHistory.length }); } catch (e) {}
    // 写自己的成绩状态文件（各写各的，无并发冲突），并读对方状态对比
    try {
      fs.writeFileSync(path.join(__dirname, 'logs', `bot-state-${RUN.name}.json`), JSON.stringify({ name: RUN.name, manual: RUNTIME.manualBroken, tnt: RUNTIME.tntBroken, total: RUNTIME.brokenCount, hp: Math.round(bot.health), ts: new Date().toISOString() }));
    } catch (e) {}
    try {
      const sc = getScoreCompare();
      appendLog({ ts: new Date().toISOString(), event: 'score-compare', mine: sc.mine, teammate: sc.teammate, delta: sc.delta });
    } catch (e) {}
    // 动作完立即下一轮——流畅的关键：这里没有 sleep
  }
  appendLog({ ts: new Date().toISOString(), event: 'run-end' });
  console.log('[收工] bot-lite 结束');
  setTimeout(() => process.exit(0), 3000);
}

// ---------- 3002 思考流（极简） ----------
function streamServer() {
  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/cmd') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let ok = false;
        try { const msg = String((JSON.parse(body).msg || '')).trim(); if (msg) { fs.writeFileSync(path.join(__dirname, '指令箱.txt'), msg, 'utf8'); ok = true; } } catch (e) {}
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(ok ? '{"ok":true,"msg":"指令已投递，bot 下一轮执行"}' : '{"ok":false,"msg":"指令为空或非法"}');
      });
      return;
    }
    // ---- 公共数据构建（HTML 与 /state JSON 共用）----
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmtMs = (ms) => (ms == null ? '-' : (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms'));
    const actColor = (act) => {
      const a = String(act || '');
      if (a.includes('wood')) return 'act-wood';
      if (a.includes('stone')) return 'act-stone';
      if (a.includes('craft')) return 'act-craft';
      if (a.includes('go')) return 'act-go';
      if (a.includes('done')) return 'act-done';
      return 'act-other';
    };
    const decHtmlArr = decisions.slice().reverse().map((d) => `
<details class="card ${d.ok ? 'ok-card' : 'fail-card'}" data-id="${d.id}">
<summary>
  <span class="row">
    <span class="tm">${esc(d.t)}</span>
    <span class="badge ${actColor(d.act)}">${esc(d.act)}</span>
    <span class="${d.ok ? 'st-ok' : 'st-no'}">${d.ok ? '✓ 成功' : '✗ 失败'}</span>
    <span class="detail">${esc(d.detail)}</span>
    <span class="ms">${fmtMs(d.llmMs)}</span>
  </span>
</summary>
<div class="body"><div class="lab">🧠 思考过程</div><pre>${esc(d.reasoning || '（本模型未返回思考）')}</pre></div>
</details>`);
    // 顶部信息区实时取值（每次渲染取最新）
    const hpNow = bot.entity ? Math.round(bot.health) : 0;
    const foodNow = Math.round(bot.food || 0);
    const woodRemain = 8 - (invAny(LOG_FAMILY) % 8); // v3：背包原木余数，还差几个再换 1 点（%8==0 时显示 8=又满一轮）
    const toolNameNow = (TOOL_NAMES[RUNTIME.toolStage] || '铁') + '镐';
    const invListNow = bot.inventory.items().map((i) => `${i.count} ${i.name}`).join('、') || '（空）';
    const renderTime = new Date().toLocaleTimeString();
    // 对话区：统一时间线（最新在上，ts 降序）、全左对齐，按"说话 bot"固定配色（统一色板函数 colorForName，两脚本同一份，同 bot 永远同色）
    const colorForWho = colorForName;
    const fmtTs = (ts) => { const d = new Date(ts); return isNaN(d) ? '-' : d.toTimeString().slice(0, 8); };
    // chatRows 统一来源：队友消息 + 自己消息，每条带 {id,name,text,ts,tsText,self,color}（/state 契约 + 页面 HTML 共用）
    const chatRows = [
      ...RUNTIME.teammateChats.map((c) => ({ id: c.id, who: c.who, msg: c.msg, ts: c.ts, self: false })),
      ...RUNTIME.selfChats.map((c) => ({ id: c.id, who: RUN.name, msg: c.msg, ts: c.ts, self: true })),
    ].sort((a, b) => b.ts - a.ts); // v4：最新在上（ts 降序）
    const chatHtmlArr = chatRows.map((c) => { const col = colorForWho(c.who); return `<div class="chat-row" data-id="${c.id}"><div class="bubble" style="background:${col}1f;border-left:3px solid ${col}"><div class="chat-meta" style="color:${col}"><b>${esc(String(c.who))}</b> · ${fmtTs(c.ts)}</div><div class="chat-msg">${esc(c.msg)}</div></div></div>`; });
    // ---- /state JSON 接口（前端对话页经 center 代理消费，必须稳定；二期改造补全契约）----
    if (req.url === '/state') {
      const now = Date.now();
      const posArr = bot.entity ? bot.entity.position.floored() : null;
      const hud = { hp: hpNow, food: foodNow, woodPoint: RUNTIME.woodPoint, manualChop: RUNTIME.manualChop, woodRemain: woodRemain, logs: invAny(LOG_FAMILY), tnt: invCount('tnt'), tool: toolNameNow, slots: bot.inventory.emptySlotCount(), manualBroken: RUNTIME.manualBroken, tntBroken: RUNTIME.tntBroken, total: RUNTIME.brokenCount, pos: (posArr ? posArr.toArray().join(',') : '-'), renderTime };
      const meta = { name: RUN.name, bot: RUN.name, model: RUN.model, providerId: RUN.providerId, online: true, viewerPort: RUN.viewerOn ? RUN.viewerPort : 0, streamPort: RUN.streamPort,
        spawned: RUNTIME.meta.spawned, spawnedAt: RUNTIME.meta.spawnedAt, spawnTimeout: RUNTIME.meta.spawnTimeout,
        viewerDown: RUNTIME.meta.viewerDown, viewerDownReason: RUNTIME.meta.viewerDownReason,
        errorCode: RUNTIME.meta.errorCode, lastErr: RUNTIME.meta.lastErr, cooling: RUNTIME.meta.cooling, uptime: now - RUNTIME.startedAt,
        personaMissing: RUNTIME.meta.personaMissing, color: colorForWho(RUN.name) };
      const info = `${esc(RUNTIME.lastResult)}<br>🎒 ${esc(invListNow)}<br>👁 ${bot.entity ? esc(describeNearby()) : '-'}`;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      const lastDecision = decisions.length ? { id: decisions[decisions.length - 1].id, t: decisions[decisions.length - 1].t, act: decisions[decisions.length - 1].act, ok: decisions[decisions.length - 1].ok, detail: decisions[decisions.length - 1].detail } : null;
      const lastChat = chatRows.length ? { who: chatRows[chatRows.length - 1].who, msg: chatRows[chatRows.length - 1].msg, ts: chatRows[chatRows.length - 1].ts } : null;
      const out = {
        bot: RUN.name, name: RUN.name, model: RUN.model, providerId: RUN.providerId,
        health: hpNow, food: foodNow, location: (posArr ? posArr.toArray().join(',') : '-'),
        score: { broken: RUNTIME.brokenCount, manual: RUNTIME.manualBroken, tnt: RUNTIME.tntBroken, woodPoint: RUNTIME.woodPoint, built: RUNTIME.builtCount },
        meta,
        chatRows: chatRows.map((c) => ({ id: c.id, name: c.who, text: c.msg, ts: c.ts, tsText: fmtTs(c.ts), self: c.self, color: colorForWho(c.who) })),
        events: decisions.slice().reverse().slice(0, 20).map((d) => ({ id: d.id, t: d.t, act: d.act, ok: d.ok, detail: d.detail })),
        // 向后兼容（本脚本流页面仍消费）
        hud, decisions: decisions.slice().reverse().map((d, i) => ({ id: d.id, html: decHtmlArr[i] })), chats: chatRows.map((c, i) => ({ id: c.id, html: chatHtmlArr[i] })), lastDecision, lastChat, inv: invListNow, info,
      };
      res.end(JSON.stringify(out));
      return;
    }
    // ---- HTML 页面 ----
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>bot-lite 思考流 · ${esc(RUN.name)}</title><style>
*{box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:22px 18px;max-width:1180px;margin:0 auto}
.head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.head h1{font-size:20px;margin:0;font-weight:700}
.live{width:9px;height:9px;border-radius:50%;background:#22c55e;flex:none;animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 9px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.wrap{display:flex;gap:16px;align-items:flex-start}
.main{flex:1;min-width:0}
.side{width:300px;flex:none}
.side-title{font-size:13px;font-weight:700;color:#94a3b8;margin:0 0 8px;letter-spacing:.5px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.chip{background:#111827;border:1px solid #334155;border-radius:9px;padding:6px 13px;font-size:13px;color:#94a3b8;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.chip b{color:#4ade80;font-weight:700;margin-left:2px}
.info{background:#111827;border:1px solid #334155;border-radius:11px;padding:11px 15px;font-size:13px;color:#cbd5e1;margin-bottom:16px;line-height:1.7}
.card{background:#111827;border:1px solid #334155;border-left:4px solid #475569;border-radius:12px;margin:11px 0;box-shadow:0 1px 3px rgba(0,0,0,.35)}
.card.ok-card{border-left-color:#22c55e}
.card.fail-card{border-left-color:#ef4444}
.card[open]{box-shadow:0 5px 18px rgba(0,0,0,.5)}
summary{cursor:pointer;list-style:none;padding:12px 16px}
summary::-webkit-details-marker{display:none}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tm{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#94a3b8;font-weight:600}
.badge{font-size:12px;font-weight:600;padding:3px 11px;border-radius:999px;white-space:nowrap}
.act-wood{background:#052e16;color:#4ade80}
.act-stone{background:#1e293b;color:#cbd5e1}
.act-craft{background:#172554;color:#60a5fa}
.act-go{background:#2e1065;color:#c084fc}
.act-done{background:#451a03;color:#fbbf24}
.act-other{background:#1f2937;color:#94a3b8}
.st-ok{font-size:12px;font-weight:700;color:#4ade80;white-space:nowrap}
.st-no{font-size:12px;font-weight:700;color:#f87171;white-space:nowrap}
.detail{font-size:13px;color:#cbd5e1;flex:1;min-width:120px}
.ms{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#a5b4fc;background:#1e1b4b;padding:3px 9px;border-radius:6px;white-space:nowrap;font-weight:600}
.body{padding:2px 16px 14px;border-top:1px dashed #334155}
.lab{font-size:12px;color:#818cf8;font-weight:700;margin:10px 0 6px}
pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;color:#e2e8f0;margin:0;max-height:360px;overflow-y:auto;background:#0b1220;padding:12px;border-radius:8px;border:1px solid #1f2937}
.empty{background:#111827;border:1px dashed #334155;border-radius:12px;padding:30px;text-align:center;color:#64748b;font-size:14px}
.cmdbar{display:flex;gap:8px;margin-bottom:14px}
.cmdbar input{flex:1;padding:9px 12px;border:1px solid #334155;border-radius:9px;font-size:14px;background:#111827;color:#e2e8f0}
.cmdbar button{padding:9px 20px;background:#6366f1;color:#fff;border:0;border-radius:9px;font-weight:600;cursor:pointer}
.cmdbar button:hover{background:#4f46e5}
.cmdmsg{font-size:12px;color:#4ade80;align-self:center;white-space:nowrap}
.side .chatbox{max-height:calc(100vh - 110px);overflow-y:auto;position:sticky;top:16px}
.chatbox{background:#0f172a;border:1px solid #334155;border-radius:11px;padding:11px 14px}
.chatbox.chat-empty{text-align:center;color:#64748b;padding:18px;font-size:13px}
.chatbox .chat-empty{text-align:center;color:#64748b;padding:14px;font-size:13px}
.chat-row{display:flex;justify-content:flex-start;margin:7px 0}
.bubble{max-width:92%;padding:7px 12px;border-radius:9px;font-size:13px;line-height:1.55;background:#1e293b}
.chat-meta{font-size:11px;color:#64748b;margin-bottom:2px}
.chat-msg{color:#e2e8f0;word-break:break-word}
</style></head><body>
<div class="head"><span class="live"></span><h1>${esc(RUN.name)} · 决策思考流</h1></div>
<div id="spawnbanner" style="display:none;background:#1e293b;border:1px solid #fbbf24;color:#fbbf24;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:14px"></div>
<div class="wrap">
<div class="main">
<div class="cmdbar"><input id="cmd" placeholder="给 bot 发指令，如：试试 place_block block=tnt（Enter 发送）" onkeydown="if(event.key==='Enter')send()"><button onclick="send()">发送</button><span class="cmdmsg" id="cmdmsg"></span></div>
<div class="stats">
  <span class="chip">❤ 血量<b id="h-hp">${hpNow}/20</b></span>
  <span class="chip">🍗 饥饿<b id="h-food">${foodNow}/20</b></span>
  <span class="chip">兑换点<b id="h-woodpoint">${RUNTIME.woodPoint}</b></span>
  <span class="chip">背包原木<b id="h-wood">${invAny(LOG_FAMILY)}个（还差${woodRemain}换1点）</b></span>
  <span class="chip">TNT<b id="h-tnt">${invCount('tnt')}/60</b></span>
  <span class="chip">工具<b id="h-tool">${toolNameNow}</b></span>
  <span class="chip">空格<b id="h-slots">${bot.inventory.emptySlotCount()}/36</b></span>
  <span class="chip">手挖<b id="h-manual">${RUNTIME.manualBroken}</b></span>
  <span class="chip">TNT炸<b id="h-tntbrk">${RUNTIME.tntBroken}</b></span>
  <span class="chip">总计<b id="h-total">${RUNTIME.brokenCount}</b></span>
  <span class="chip">位置<b id="h-pos">${bot.entity ? esc(bot.entity.position.floored().toArray().join(',')) : '-'}</b></span>
  <span class="chip">渲染<b id="h-render">${renderTime}</b></span>
</div>
<div class="info" id="info">📋 最近动作：${esc(RUNTIME.lastResult)}<br>🎒 背包：${esc(invListNow)}<br>👁 ${bot.entity ? esc(describeNearby()) : '-'}</div>
<div id="decisions">${decHtmlArr.join('') || '<div class="empty">（等待第一条决策…）</div>'}</div>
</div>
<div class="side">
<div class="side-title">💬 队伍对话</div>
<div id="chats" class="chatbox">${chatHtmlArr.length ? chatHtmlArr.join('') : '<div class="chat-empty">（暂无对话）</div>'}</div>
</div>
</div>
<script>
function send(){var i=document.getElementById('cmd');var m=document.getElementById('cmdmsg');var v=(i.value||'').trim();if(!v){m.textContent='指令为空';return;}fetch('/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({msg:v})}).then(function(r){return r.json();}).then(function(d){m.textContent=d.ok?d.msg:('失败:'+d.msg);if(d.ok){i.value='';}}).catch(function(){m.textContent='发送失败';});}
// 三流分离：HUD 原地更新 + 决策/对话按 id 去重增量追加（不再整页刷新）
var seenDec = new Set(), seenChat = new Set();
document.querySelectorAll('#decisions [data-id]').forEach(function(e){ seenDec.add(e.getAttribute('data-id')); });
document.querySelectorAll('#chats [data-id]').forEach(function(e){ seenChat.add(e.getAttribute('data-id')); });
function tick(){
  fetch('/state').then(function(r){return r.json();}).then(function(s){
    var el=function(id){return document.getElementById(id);};
    // 进厂状态横幅：未进厂显示"工人还没进厂"；超 60s 转黄提示；报错时显示错误
    var bn=el('spawnbanner');
    if(bn){
      var m=s.meta||{};
      if(m.errorCode){ bn.style.display='block'; bn.style.borderColor='#ef4444'; bn.style.color='#f87171'; bn.textContent='⚠ '+(m.errorCode==='E_NO_PROVIDER'?'工人还没有大脑：':'大脑报错：')+(m.lastErr||m.errorCode); }
      else if(m.spawnTimeout){ bn.style.display='block'; bn.textContent='🟡 工人还没进厂（超过 60s），检查大脑钥匙/服务器；不影响后续自动重试'; }
      else if(!m.spawned){ bn.style.display='block'; bn.textContent='⏳ 工人还没进厂……正在铺设出生点平台'; }
      else { bn.style.display='none'; }
    }
    if(el('h-hp'))el('h-hp').textContent=s.hud.hp+'/20';
    if(el('h-food'))el('h-food').textContent=s.hud.food+'/20';
    if(el('h-woodpoint'))el('h-woodpoint').textContent=s.hud.woodPoint;
    if(el('h-wood'))el('h-wood').textContent='原木'+s.hud.logs+'个（还差'+s.hud.woodRemain+'换1点）';
    if(el('h-tnt'))el('h-tnt').textContent=s.hud.tnt+'/60';
    if(el('h-tool'))el('h-tool').textContent=s.hud.tool;
    if(el('h-slots'))el('h-slots').textContent=s.hud.slots+'/36';
    if(el('h-manual'))el('h-manual').textContent=s.hud.manualBroken;
    if(el('h-tntbrk'))el('h-tntbrk').textContent=s.hud.tntBroken;
    if(el('h-total'))el('h-total').textContent=s.hud.total;
    if(el('h-pos'))el('h-pos').textContent=s.hud.pos;
    if(el('h-render'))el('h-render').textContent=s.hud.renderTime;
    if(el('info'))el('info').innerHTML=s.info;
    var dc=el('decisions'), cc=el('chats');
    if(dc && s.decisions && s.decisions.length){
      var frag=s.decisions.filter(function(d){return !seenDec.has(String(d.id));});
      if(frag.length){ dc.insertAdjacentHTML('afterbegin', frag.map(function(d){seenDec.add(String(d.id));return d.html;}).join('')); }
    }
    if(cc && s.chats && s.chats.length){
      var cf=s.chats.filter(function(c){return !seenChat.has(String(c.id));});
      if(cf.length){ var empty=cc.querySelector('.chat-empty'); if(empty) empty.remove(); cc.insertAdjacentHTML('afterbegin', cf.map(function(c){seenChat.add(String(c.id));return c.html;}).join('')); }
    }
  }).catch(function(){});
}
setInterval(tick, 1500);
tick();
</script>
</body></html>`);
  }).listen(RUN.streamPort, '127.0.0.1', () => console.log(`[思考流] http://127.0.0.1:${RUN.streamPort}`));
}
