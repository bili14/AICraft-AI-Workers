// saves.js — 存档管理页（只做两件事：存一份 / 删除世界；下面是已有存档，可挑一个用）
'use strict';
/* global window, document */

(function () {
  const APP = window.APP;
  const $ = APP.$;

  async function refresh() {
    let failed = false;
    const r = await APP.api('GET', '/api/world/snapshots').catch(() => { failed = true; return null; });
    render(r || { list: [], totalSizeMB: 0, capMB: 2048, current: {} }, failed);
  }

  function render(data, failed) {
    const cur = data.current || {};
    const capMB = data.capMB || 2048;
    const total = data.totalSizeMB || 0;
    const pct = Math.min(100, Math.round(total / capMB * 100));
    const capWarn = total >= capMB;
    const list = (data.list || []);
    const hasWorld = !!cur.exists;

    // 这一块全部是磁盘现读的真值，读不到就老实说"未知"，不编
    const lines = [];
    if (hasWorld) {
      const bits = [];
      if (cur.difficulty) bits.push('难度 ' + diffText(cur.difficulty));
      if (cur.gamemode) bits.push('模式 ' + modeText(cur.gamemode));
      if (bits.length) lines.push(bits.join(' · '));
      lines.push('世界 ' + APP.fmtMB(cur.sizeMB) + ' · 最后动过 ' + (cur.lastPlayed ? APP.relTime(cur.lastPlayed) : '未知'));
      lines.push('种子 ' + (cur.seedKnown ? APP.esc(cur.seed) : '随机（每开一次新世界都不一样）'));
    }

    $('saves-body').innerHTML = `
      <div class="panel-card">
        <h3>💾 存档管理</h3>
        <div class="desc">存档共占 <b>${APP.fmtMB(total)}</b> / 建议上限 ${APP.fmtMB(capMB)}。删存档不动世界本体。</div>
        <div class="cap-bar"><div class="cap-fill ${capWarn ? 'over' : ''}" style="width:${pct}%"></div></div>
        ${capWarn ? '<div class="warn-inline">⚠️ 快照到上限了，删掉不用的腾地方（世界本体不动）。</div>' : ''}

        <div class="saves-current">
          <h4>🏠 当前世界 ${cur.running ? '<span class="dim" style="font-weight:400;">（服务器运行中）</span>' : ''}</h4>
          ${hasWorld
            ? lines.map(t => `<div class="dim">${t}</div>`).join('')
            : (failed
              ? '<div class="dim">读不到世界信息（后台没响应）。稍等一下再刷新看看。</div>'
              : '<div class="dim">还没有世界。先去「指挥大厅」点「启动服务器」，让它生成一个。</div>')}
          <div class="row" style="margin-top:10px; gap:10px;">
            <button class="btn btn-primary" id="snap-now"${hasWorld ? '' : ' disabled'}>💾 存一份</button>
            <button class="btn btn-danger" id="world-reset-new"${hasWorld ? '' : ' disabled'}>🗑 删除这个世界（重新生成）</button>
          </div>
          <div class="dim" style="margin-top:6px;">删除会自动先给现在存一份，想反悔能从下面列表回到这一刻。</div>
        </div>
      </div>

      <div class="panel-card">
        <h3>📸 已有的存档</h3>
        ${list.length === 0 ? '<div class="dim">还没有存档。点上面「存一份」，给现在的世界拍一张。</div>' : ''}
        ${list.map(snapRow).join('')}
        <div class="dim" style="margin-top:10px;">自动快照留最近 5 份，手动存档一直留着；想腾地方就删，世界本体不受影响。</div>
      </div>
      <div class="saves-progress" id="saves-progress" hidden></div>
    `;

    if ($('snap-now')) $('snap-now').onclick = snapNow;
    if ($('world-reset-new')) $('world-reset-new').onclick = resetWorld;
    // 快照行操作（委托；不完整存档没有「用这个」按钮，逐行判空）
    document.querySelectorAll('[data-snap]').forEach(row => {
      const rs = row.querySelector('.snap-restore');
      const dl = row.querySelector('.snap-del');
      if (rs) rs.onclick = () => restore(row.dataset.snap);
      if (dl) dl.onclick = () => del(row.dataset.snap);
    });
  }

  function diffText(d) {
    return { peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' }[d] || '未知';
  }
  function modeText(g) {
    return { survival: '生存', creative: '创造', adventure: '冒险', spectator: '旁观' }[g] || '未知';
  }
  function kindTag(s) {
    if (s.kind === 'manual') return '<span class="tag manual">✋ 手动</span>';
    if (s.kind === 'preRestore') return '<span class="tag auto">↩ 回滚前自动留的</span>';
    return '<span class="tag auto">🤖 自动</span>';
  }
  function snapRow(s) {
    const invalid = s.valid === false;
    return `<div class="snap-row ${invalid ? 'invalid' : ''}" data-snap="${APP.esc(s.id)}">
      ${kindTag(s)}
      <span class="snap-time">${APP.relTime(s.createdAt)}</span>
      <span class="snap-label">${s.label ? '「' + APP.esc(s.label) + '」' : ''}</span>
      <span class="dim">${APP.fmtMB(s.sizeMB)}</span>
      ${invalid ? '<span class="dim">（这份存档不完整）</span>' : ''}
      <div class="spacer" style="flex:1"></div>
      ${invalid ? '' : '<button class="btn snap-restore">用这个</button>'}
      <button class="btn btn-danger snap-del">删除</button>
    </div>`;
  }

  // ---- 存一份（不弹命名框：Electron 不支持 window.prompt，之前就是它把按钮弄哑了） ----
  async function snapNow() {
    showProgress('正在给世界存档……');
    const r = await APP.api('POST', '/api/world/snapshot', { kind: 'manual', label: '' });
    hideProgress();
    if (r && r.ok !== false) APP.toast('✅ 存好了，下面列表里能看见。', 'success');
    else APP.toast(snapFailText(r), 'error', 'snap-fail');
    refresh();
  }

  function snapFailText(r) {
    const msg = (r && r.msg) || '';
    if (/还没有世界/.test(msg)) return '还没生成世界呢——先去「指挥大厅」启动一次服务器。';
    if (/磁盘|满|ENOSPC/i.test(msg)) return '这次没存上：磁盘快满了。删掉一些旧存档或腾点空间再试。';
    if (/占用|EBUSY|锁定/i.test(msg)) return '被杀毒软件挡住了：它正在扫这个文件夹，等一两分钟再点。';
    if (/正在整理|WORLD_BUSY/i.test(msg)) return '正在忙别的世界操作，等它跑完再点一次。';
    return '这次没存上：' + (msg || '未知原因');
  }

  // ---- 用这个（恢复） ----
  async function restore(id) {
    if (!confirm('回到这一刻？\n\n世界会倒回这张存档的样子，之后盖的东西会消失。\n恢复前会先自动给现在存一份，想反悔还能回来。')) return;
    showProgress('正在把世界倒回这一刻（约 10~30 秒）');
    const r = await APP.api('POST', '/api/world/snapshot/restore', { id });
    hideProgress();
    if (r && r.ok !== false) APP.toast('✅ 已回到那一刻。', 'success');
    else APP.toast('恢复失败：' + ((r && r.msg) || '未知错误'), 'error', 'restore-fail');
    refresh();
  }

  // ---- 删除存档 ----
  async function del(id) {
    if (!confirm('删掉这张存档？以后就回不到这一刻了。')) return;
    const r = await APP.api('DELETE', '/api/world/snapshot', { id });
    APP.toast((r && r.msg) || '已删除', r && r.ok === false ? 'error' : 'success');
    refresh();
  }

  // ---- 删除世界（重新生成；删前后端自动存一份，不再二选一） ----
  async function resetWorld() {
    if (!confirm('删除现在这个世界，按「设置」里的种子重新生成一个？\n\n删除前会自动给现在存一份，想反悔能从下面列表回来。')) return;
    showProgress('正在删除世界并重新生成（约 10~30 秒）');
    const r = await APP.api('POST', '/api/world/reset', {});
    hideProgress();
    if (r && r.ok === false) {
      APP.toast('没删成：' + ((r && r.msg) || '未知错误'), 'error', 'reset-fail');
    } else if (r && r.preSnapError) {
      APP.toast('新世界开好了，但删除前的自动备份没成功：' + r.preSnapError, 'error', 'presnap-fail');
    } else {
      APP.toast('✅ 新世界开好了。', 'success');
    }
    refresh();
  }

  function showProgress(title) {
    const box = $('saves-progress');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `⏳ ${title}<div class="dim" style="margin-top:4px;">别关窗口，等它跑完。</div>`;
  }
  function hideProgress() { const b = $('saves-progress'); if (b) b.hidden = true; }

  window.Saves = { refresh };
})();
