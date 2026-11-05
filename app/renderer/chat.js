// chat.js — 大厅对话区：公屏式聊天，所有 bot 消息合并成一个时间流，按发送者名字着色
'use strict';
/* global window, setInterval, clearInterval */

(function () {
  const APP = window.APP;
  const $ = APP.$;
  let timer = null;
  const allRows = [];   // 所有消息，按时间倒序
  const seen = new Set(); // 去重：key = 发送者名:内容:时间戳（id 是各 bot 本地的，不能用）

  async function poll() {
    const bots = (APP.state.hall && APP.state.hall.bots) || [];
    for (const b of bots) {
      const online = b.runStatus === 'running';
      if (!online) continue;
      const st = await APP.api('GET', '/api/bot/' + encodeURIComponent(b.name) + '/state').catch(() => null);
      const cr = (st && st.chatRows) || [];
      for (const r of cr) {
        const sender = r.name || b.name;
        const text = r.text || r.msg || '';
        const ts = r.ts || 0;
        // 按秒级去重：同一条消息从不同 bot 拿，ts 可能差几十毫秒
        const key = sender + ':' + text + ':' + Math.floor(ts / 1000);
        if (seen.has(key)) continue;
        seen.add(key);
        allRows.push({
          name: sender,
          text: text,
          ts: ts,
        });
      }
    }
    // 按时间倒序，最多保留 100 条
    allRows.sort((a, b2) => b2.ts - a.ts);
    if (allRows.length > 100) allRows.length = 100;
    render();
  }

  // 按名字取颜色（和 bot 卡片颜色对应）
  function colorForName(name) {
    const bots = (APP.state.hall && APP.state.hall.bots) || [];
    const b = bots.find(x => x.name === name || x.nick === name);
    return b ? APP.colorFor(b) : '#9ca3af'; // 找不到就用灰色
  }

  function render() {
    const bots = (APP.state.hall && APP.state.hall.bots) || [];
    if (!bots.length) {
      $('chat-body').innerHTML = '<div class="dim">还没有工人。去「Bot 管理」添加，或点「新手一键配好两个工人」。</div>';
      return;
    }
    if (allRows.length === 0) {
      const anyOnline = bots.some(b => b.runStatus === 'running');
      $('chat-body').innerHTML = `<div class="chat-empty">${anyOnline ? '工人们刚进厂，还没说话…' : '还没有工人进厂'}</div>`;
      return;
    }
    const html = allRows.slice(0, 50).map(r => {
      const color = colorForName(r.name);
      const time = r.ts ? new Date(r.ts).toTimeString().slice(0, 8) : '';
      return `
        <div class="chat-row" style="border-left-color:${color}">
          <span class="chat-who" style="color:${color}">${APP.esc(r.name)}</span>
          <span class="chat-text">${APP.esc(r.text)}</span>
          <span class="chat-time dim">${time}</span>
        </div>`;
    }).join('');
    $('chat-body').innerHTML = html;
  }

  function start() { if (!timer) timer = setInterval(poll, 2000); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  window.Chat = { start, stop, poll };
})();
