// boot.js — 冷启动加载屏：MC 挖掘动画 + 9 格真实信号 + 双文案池 + 失败面板
'use strict';
/* global window, setInterval, clearTimeout, setTimeout, document */

(function () {
  const APP = window.APP;
  const $ = APP.$;

  // 9 格成品（B 草案 C.3.1）
  const GRIDS = [
    { icon: '🚪', label: '打开大门' },
    { icon: '🧠', label: '指挥中心开张' },
    { icon: '🛠', label: '自带工具就位' },
    { icon: '📮', label: '申请端口' },
    { icon: '📝', label: '写下世界配置' },
    { icon: '☕', label: '服务器开机' },
    { icon: '🌍', label: '画工地地图', pct: true },
    { icon: '✅', label: '服务器就绪' },
    { icon: '👷', label: '工人进厂', count: true },
  ];

  // phase → 已完成到第几格（0基索引：0大门 1指挥中心 2工具就位 3申请端口 4写配置 5开机 6画地图 7就绪 8工人进厂）
  const PHASE_TO_GRID = {
    boot: 1,
    runtime: 2,
    'alloc-port': 3,
    'write-props': 4,
    'spawn-java': 5,
    'world-loading': 6,
    'waiting-port': 6,
    'port-ready': 6,
    running: 7,
  };

  // 趣味文案 15 条（定稿）
  const FUN = [
    '工人已经打卡上班，正在磨斧头。',
    '正在给世界发身份证号……',
    '第一棵树正在被瞄准。',
    '服务器在热身，像早上的发动机。',
    '工人的大脑正在联网（别让它摸鱼太久）。',
    '方块在排队出生。',
    '正在把太阳挂上去。',
    '今天也要搬砖呢。',
    '怪物们还在被窝里，趁现在赶紧盖房子。',
    '背包正在清空准备装货。',
    '工人互相使了个眼色：开工。',
    '地皮刚批下来，正在打地基。',
    '树木们已经收到了拆迁通知。',
    '世界加载中，工人已经迫不及待了。',
    '正在把 TNT 搬到安全距离。',
  ];
  // 新手小贴士 13 条（定稿）
  const TIPS = [
    '💡 工人的“大脑”要联网调用大模型，得先在「AI 大脑供应商」填一把 Key——没 Key 工人会睡觉。',
    '💡 3D 画面只是看热闹，不想看随时可以关，工人在地下照常干活。',
    '💡 世界会自动保存（每 10 分钟一次），不用怕关窗口前忘存。',
    '💡 第一次生成世界最慢，要等 1~2 分钟；以后再开就几秒钟。',
    '💡 如果弹出蓝色“Windows 已保护你的电脑”窗口，点左边小字「更多信息」→「仍要运行」就行。',
    '💡 如果杀毒软件拦了 Java/Node，把整个 AICraft 文件夹加入信任列表就好。',
    '💡 工人偶尔会停在原地不动——那是 AI 服务商限流了，它会自己放慢，过一分钟就好。',
    '💡 建议把 AICraft 文件夹放在 D:\\Games\\AICraft 这种短路径下。',
    '💡 每个 3D 窗口约吃 0.3GB 内存，8GB 电脑一次开 1~2 个就够，看完随手关。',
    '💡 想回到以前的世界？去「💾 存档管理」点那份存档的「用这个」就行。',
    '💡 工人的背包、盖的房子都存在世界里；换 key、换模型都不影响它们。',
    '💡 关窗口时如果看到“正在存盘”，等它自己关完，别直接拔电源。',
    '💡 工人动作变慢、风扇狂响？多半是 3D 开太多了，关几个画面试试。',
  ];
  const SLOW_QUOTES = [
    '这步比平时慢——可能是杀毒软件第一次在扫这个文件夹，以后会快。',
    '慢一点也没关系，安全第一，存档不丢。',
  ];

  let quoteTimer = null;
  let quoteIdx = 0;
  let useTips = false;
  let failExtra = 0;       // [再等60秒] 累加的延时 ms
  const gridEnterAt = {};   // 每格进入时刻（判 30s 慢机）

  function renderGrid() {
    $('boot-grid').innerHTML = GRIDS.map((g, i) =>
      `<div class="bcell" id="bcell-${i}"><span class="bcell-icon">${g.icon}</span><span class="bcell-label">${g.label}</span>${g.pct ? '<span class="bcell-pct" id="bcell-pct"></span>' : ''}${g.count ? '<span class="bcell-count" id="bcell-count"></span>' : ''}</div>`
    ).join('');
  }

  function setCell(i, state, extra) {
    const el = $('bcell-' + i);
    if (!el) return;
    el.classList.remove('done', 'now', 'slow', 'fail');
    if (state) el.classList.add(state); // 空字符串不能 add（DOMTokenList 会抛错），pending 格不加类
    if (extra != null) {
      if (i === 6 && $('bcell-pct')) $('bcell-pct').textContent = extra;
      if (i === 8 && $('bcell-count')) $('bcell-count').textContent = extra;
    }
  }

  function rotateQuote() {
    const q = useTips ? TIPS[quoteIdx % TIPS.length] : FUN[quoteIdx % FUN.length];
    useTips = !useTips; quoteIdx++;
    $('boot-quote').textContent = '💬 ' + q;
  }

  // 主更新：返回 {done, wizardNeeded, hallErr}
  function update(hall) {
    const srv = (hall && hall.server) || {};
    const bots = (hall && hall.bots) || [];

    // ---- 格 1~8 由 phase 单调推进 ----
    let doneUpTo = 0; // 已完成格数（0基最后完成的索引）
    if (hall && hall.bootTime) doneUpTo = Math.max(doneUpTo, 1);
    const rt = (hall && hall.runtime) || {};
    if (hall && hall.bootTime) {
      // 工具就位：新后端 runtime.node/java 是 {ok,version,source,reason} 对象 → 看 .ok；
      // 老后端是 'portable'/'system' 字符串 → 按原存在性逻辑；无 runtime 字段则放行
      const toolsOk = !rt.node ? true
        : (typeof rt.node === 'object') ? !!(rt.node.ok && rt.java && rt.java.ok)
        : !!(rt.node && rt.java);
      if (toolsOk) doneUpTo = Math.max(doneUpTo, 2);
    }
    const phase = srv.phase || (srv.status === 'running' ? 'running' : (srv.status === 'starting' ? 'spawn-java' : 'boot'));
    if (PHASE_TO_GRID[phase] != null) doneUpTo = Math.max(doneUpTo, PHASE_TO_GRID[phase]);
    if (srv.running || srv.status === 'running') doneUpTo = Math.max(doneUpTo, 7);

    // ---- 格 9 工人进厂 ----
    const spawned = bots.filter(b => b && b.runStatus === 'running' && b.state && b.state.meta && b.state.meta.spawned).length;
    const total = bots.length;
    if (srv.running || srv.status === 'running') {
      if (total === 0 || spawned >= total) doneUpTo = Math.max(doneUpTo, 8);
    }

    // ---- 渲染格状态 ----
    const now = Date.now();
    let currentGrid = Math.min(doneUpTo + 1, 8);
    if (doneUpTo >= 8) currentGrid = -1;
    for (let i = 0; i < 9; i++) {
      if (i <= doneUpTo) { setCell(i, 'done'); if (!gridEnterAt[i]) gridEnterAt[i] = now; }
      else if (i === currentGrid) {
        setCell(i, 'now');
        if (!gridEnterAt[i]) gridEnterAt[i] = now;
        // 单格 >30s 切慢机文案
        if (now - gridEnterAt[i] > 30000 && !$('boot-fail').offsetParent) {
          $('boot-quote').textContent = '🐢 ' + SLOW_QUOTES[(i + Math.floor(now / 30000)) % SLOW_QUOTES.length];
          $('bcell-' + i).classList.add('slow');
        }
      } else setCell(i, '');
    }
    if (srv.spawnPct != null) setCell(6, srv.running || srv.status === 'running' ? 'done' : 'now', srv.spawnPct + '%');
    setCell(8, doneUpTo >= 8 ? 'done' : (currentGrid === 8 ? 'now' : ''), spawned + '/' + total);

    // ---- 当前阶段一句人话 ----
    const phaseText = {
      'alloc-port': '📮 正在申请端口…',
      'write-props': '📝 正在写下世界配置…',
      'spawn-java': '☕ 服务器开机中…',
      'world-loading': '🌍 正在开荒…',
      'waiting-port': '🌍 正在画工地地图…' + (srv.spawnPct != null ? ' ' + srv.spawnPct + '%' : ''),
      'port-ready': '✅ 服务器马上就绪…',
      'running': '✅ 服务器就绪',
    };
    $('boot-phase').textContent = phaseText[phase] || (doneUpTo < 1 ? '🚪 正在打开大门…' : '🧠 正在等指挥中心回应…');

    // ---- 日志尾 ----
    const tail = srv.logTail;
    let logTxt = '';
    if (Array.isArray(tail)) logTxt = tail.slice(-40).join('\n');
    else if (typeof tail === 'string') logTxt = tail.split(/\r?\n/).slice(-40).join('\n');
    if (logTxt) $('boot-log').textContent = logTxt;

    // ---- 失败判定 ----
    // 只有用户主动启动过（starting 卡住 / start_failed）才判失败；
    // status=stopped（用户还没点启动、准备先逛大厅）不算失败，避免误报
    const elapsed = now - APP.state.bootStart;
    const thresholdSec = (hall && hall.noWorld) ? 180 : 90;
    const started = srv.running || srv.status === 'running';
    const everStarted = srv.status === 'starting' || srv.status === 'start_failed';
    if (srv.status === 'start_failed' || (everStarted && !started && hall && hall.bootTime && elapsed > thresholdSec * 1000 + failExtra)) {
      showFail(srv.status === 'start_failed');
    }

    // ---- 是否完成 ----
    // center 就绪（hall.bootTime 存在）且不需要向导即可进入大厅；
    // 服务器启动是用户进入大厅后主动点的，不作为加载屏完成前提
    const wizardNeeded = !!(hall && (hall.needsKey || hall.noWorld || !hall.setupWizardDone));
    return { done: !!(hall && hall.bootTime) && !wizardNeeded, wizardNeeded };
  }

  function showFail(javaCrashed) {
    const f = $('boot-fail');
    f.hidden = false;
    $('boot-fail-title').textContent = javaCrashed ? '服务器开机就摔了一跤' : '服务器今天有点懒';
    $('boot-fail-desc').textContent = javaCrashed
      ? 'Java 进程刚启动就退出了，细节在下面日志里——把最后十几行截图发给帮你的人。常见原因：杀毒软件第一次扫描这个文件夹。'
      : '等了 ' + ((Date.now() - APP.state.bootStart) / 1000 | 0) + ' 秒还没完全醒。常见原因：① 杀毒软件第一次扫描文件夹（以后会快）；② 上一次没关干净；③ 这个世界第一次生成特别大。';
    $('boot-log-wrap').open = true;
  }
  async function forceRetry() {
    await APP.api('POST', '/api/server/stop').catch(() => {});
    await APP.api('POST', '/api/server/start').catch(() => {});
    failExtra = 0;
    APP.state.bootStart = Date.now();
    $('boot-fail').hidden = true;
  }

  function init() {
    renderGrid();
    rotateQuote();
    quoteTimer = setInterval(rotateQuote, 6000);
    $('boot-wait').onclick = () => { failExtra += 60000; $('boot-fail').hidden = true; };
    $('boot-showlog').onclick = () => { $('boot-log-wrap').open = true; };
    $('boot-retry').onclick = () => { forceRetry(); };
  }

  function show() { const o = $('boot-overlay'); if (o) o.style.display = 'flex'; }
  function hide() { const o = $('boot-overlay'); if (o) o.style.display = 'none'; }

  window.Boot = { init, update, show, hide };
})();
