// common.js — 渲染层共享工具与全局状态（被 app.js / boot.js / wizard.js / saves.js / chat.js / mem.js 共用）
'use strict';
/* global window, document, setTimeout, setInterval, clearTimeout */

(function () {
  const api = window.aicraft.api;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // toast：错误按 dedupeKey 60s 去重（code+bot），常驻错误直到手动关
  const toastLast = {};
  function toast(msg, type, dedupeKey) {
    if (dedupeKey) {
      const now = Date.now();
      if (toastLast[dedupeKey] && now - toastLast[dedupeKey] < 60000) return;
      toastLast[dedupeKey] = now;
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    const close = document.createElement('span');
    close.textContent = ' ×';
    close.style.cssText = 'margin-left:10px;cursor:pointer;font-weight:700;';
    close.onclick = () => el.remove();
    el.appendChild(document.createTextNode(msg));
    el.appendChild(close);
    $('toast-wrap').appendChild(el);
    // 成功/信息类 4 秒自动消失；错误类常驻直到关闭
    if (type !== 'error') setTimeout(() => el.remove(), 4000);
  }

  // 全局悬浮提示：document 上 mouseover/mouseout 委托，命中 [data-tip] 就把文案放进 fixed 容器
  // （旧伪元素方案会被 .bot-card 的 overflow:hidden 裁掉；fixed 容器天然覆盖向导/存档/对话/大厅所有场景）
  (function initGlobalTooltip() {
    const box = () => document.getElementById('app-tooltip');
    document.addEventListener('mouseover', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      const b = box();
      if (!b) return;
      if (!el || !el.getAttribute('data-tip')) { b.style.display = 'none'; return; }
      b.textContent = el.getAttribute('data-tip');
      b.style.display = 'block';
      const r = el.getBoundingClientRect();
      let top = r.top - (b.offsetHeight || 0) - 6;
      if (top < 8) top = r.bottom + 6; // 贴近视口顶部放不下 → 改放元素下方
      let left = r.left + r.width / 2 - (b.offsetWidth || 0) / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - (b.offsetWidth || 0) - 8));
      b.style.top = top + 'px';
      b.style.left = left + 'px';
    });
    document.addEventListener('mouseout', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      const b = box();
      if (!el || !b) return;
      if (e.relatedTarget && el.contains(e.relatedTarget)) return; // 还在元素内部，不隐藏
      b.style.display = 'none';
    });
  })();

  // 中文错误码成品文案表（§3.4.2 / B 草案 Q5）
  const ERROR_CODES = {
    E_401_AUTH: { title: '🔑 大脑钥匙不对', desc: '服务商不认这把钥匙：Key 没填、多了空格，或者已被删掉。', action: '去「AI 大脑供应商」重新粘贴 Key，点「测试连接」，通了再启动工人。' },
    E_403_FORBIDDEN: { title: '💰 大脑余额用完了', desc: '钥匙能进门，但账户没钱了（或这个模型没开通）。', action: '去服务商官网充值；或把这个工人临时换到另一个还有额度的 Key。' },
    E_429_RATE_LIMIT: { title: '🐢 抢脑子抢太凶了', desc: '用的人太多，服务商让大家慢一点。工人已自动放慢在等。', action: '不用管，过一分钟自己好；一直这样就少开几个工人，或换个 Key。' },
    E_5XX_UPSTREAM: { title: '🤒 AI 服务商今天不舒服', desc: '服务商自己的服务器开小差了，不是你的问题。工人会自动重试。', action: '等一两分钟；一直不好就去「AI 大脑供应商」点「测试连接」。' },
    E_NETWORK: { title: '📡 工人和大脑断网了', desc: '连不上 AI 服务商：可能断网、网址填错；如果是自己电脑上跑的模型，可能那个服务还没启动。', action: '① 检查 Wi-Fi/网线 ② 关掉 VPN/代理试试 ③ 自己电脑上跑的模型服务要先启动，再回来点「测试连接」。' },
    E_TIMEOUT: { title: '⏳ 大脑走神了', desc: '这次思考等了快一分钟还没回，可能服务商太忙或网太慢。', action: '工人会自己重试；每个工人都这样就去「AI 大脑供应商」测测哪家慢。' },
    E_BAD_RESPONSE: { title: '🗣 大脑说胡话了', desc: '回是回了，但格式看不懂——通常是模型名填错了。', action: '去「AI 大脑供应商」检查这个工人选的模型名是不是拼对了。' },
    E_NO_PROVIDER: { title: '🚪 这个工人还没有大脑', desc: '还没给它配服务商和 Key，工人醒来是睡的。', action: '去「AI 大脑供应商」配一把钥匙，再启动这个工人。' },
  };

  // 每 bot 柔和配色板（颜色字段缺失时按名字 hash 取色，与决策流页一致）
  const PALETTE = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171'];
  function colorFor(bot) {
    if (bot && bot.color) return bot.color;
    const name = (bot && bot.name) || 'x';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // 工种中文名
  function scriptLabel(script) {
    if (!script) return '工人';
    if (/bot-lite/i.test(script)) return '拆建全能工';
    if (/bot\.js/i.test(script)) return '纯建造工';
    return script.replace(/\.js$/i, '');
  }

  // 服务器状态中文化
  function serverStatusText(srv) {
    if (!srv) return '未运行';
    if (srv.running || srv.status === 'running') return '运行中';
    if (srv.status === 'starting') return '启动中…';
    if (srv.status === 'start_failed') return '启动失败';
    if (srv.status === 'saving') return '存盘中…';
    if (srv.status === 'stopping') return '正在打烊…';
    return '未运行';
  }

  function fmtMB(mb) {
    mb = Number(mb) || 0;
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return Math.round(mb) + ' MB';
  }
  function relTime(iso) {
    if (!iso) return '—';
    const t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (isNaN(t)) return '—';
    const diff = Date.now() - t;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d === 1) return '昨天';
    if (d < 30) return d + ' 天前';
    return new Date(t).toLocaleDateString('zh-CN');
  }

  window.APP = {
    api, $, esc, toast, ERROR_CODES, colorFor, scriptLabel, serverStatusText, fmtMB, relTime,
    state: {
      hall: null,           // 最新 /api/hall
      config: null,         // 最新 /api/config
      botWins: {},          // botName → {viewer: win, stream: win} 窗口引用（防泄漏）
      bootStart: Date.now(),
      started: false,       // 加载屏是否已完成过一次
    },
  };
})();
