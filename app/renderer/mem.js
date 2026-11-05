// mem.js — 内存预估（绿/黄/红，软提示不硬拦）
// 公式（§3.2.7）：estMB = javaRSS(xmx) + perBotMB*N + centerMB + electronMB + perViewerMB*M
// ratio = (estMB + systemReserveMB) / totalMB
'use strict';
/* global window, document */

(function () {
  const $ = window.APP.$;
  function compute(hall, opts) {
    const mem = (hall && hall.mem) || {};
    const coef = mem.coef || {};
    // 兜底系数（与设计稿默认值一致），后端未下发时也能算
    const javaRSS = coef.javaRSS || { '1.5G': 2050, '2G': 2550, '3G': 3550 };
    const perBot = coef.perBotMB || 250;
    const center = coef.centerMB || 80;
    const electron = coef.electronMB || 300;
    const perViewer = coef.perViewerMB || 400;
    const reserve = coef.systemReserveMB || 2048;
    const totalMB = mem.totalMB || 8192;

    const xmx = opts.xmx || (hall && hall.server && hall.server.xmx) || '2G';
    const bots = opts.botsRunning;
    const viewers = opts.viewersOpen;
    const estMB = (javaRSS[xmx] || 2550) + perBot * bots + center + electron + perViewer * viewers;
    const ratio = (estMB + reserve) / totalMB;
    let level = 'green';
    if (ratio >= 0.8) level = 'red';
    else if (ratio >= 0.6) level = 'yellow';
    return { estMB, ratio, level, totalMB, reserveMB: reserve };
  }

  function lineHtml(r) {
    const estGB = (r.estMB / 1024).toFixed(1);
    const totalGB = (r.totalMB / 1024).toFixed(0);
    if (r.level === 'green') {
      return `<span class="mem-dot green"></span>🟢 放心开：预计总共用运行内存 ${estGB} GB，你电脑 ${totalGB} GB，很宽裕。`;
    }
    if (r.level === 'yellow') {
      return `<span class="mem-dot yellow"></span>🟡 刚好：预计总共用运行内存 ${estGB} GB，你电脑 ${totalGB} GB，能跑。建议少开几个 3D 画面（每个约 0.3GB），看完随手关。`;
    }
    return `<span class="mem-dot red"></span>🔴 这样开可能会卡：预计用运行内存 ${estGB} GB，你电脑只有 ${totalGB} GB，系统自己还要留 ${(r.reserveMB / 1024).toFixed(0)} GB——再开下去会开始用硬盘当虚拟内存，工人动作会变慢。`;
  }

  // 红档弹窗（不阻断，点一次“照常开”确认）
  function confirmRed(r, onProceed) {
    const estGB = (r.estMB / 1024).toFixed(1);
    const totalGB = (r.totalMB / 1024).toFixed(0);
    const box = document.createElement('div');
    box.className = 'modal-mask';
    box.innerHTML = `
      <div class="modal">
        <h3>🔴 这样开可能会卡哦</h3>
        <p>预计总共要用 <b>${estGB} GB</b>，你电脑只有 <b>${totalGB} GB</b>。系统自己还要留约 3 GB，剩下的会开始用硬盘当内存——工人动作会变慢，电脑也可能卡。</p>
        <p class="dim">建议：· 少开 1~2 个工人 · 关掉几个 3D 画面 · 服务器内存从 2G 降到 1.5G</p>
        <div class="row" style="justify-content:flex-end; gap:10px; margin-top:14px;">
          <button class="btn" id="mem-close">我去关几个 3D 画面</button>
          <button class="btn btn-danger" id="mem-proceed">我知道了，照常开</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    $('mem-close').onclick = () => box.remove();
    $('mem-proceed').onclick = () => { box.remove(); onProceed(); };
  }

  window.Mem = { compute, lineHtml, confirmRed };
})();
