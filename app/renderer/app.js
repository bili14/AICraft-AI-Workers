// app.js — 渲染层主编排：轮询 hall、渲染大厅/服务商/设置/工人、3D 窗口管理、错误飘红
'use strict';
/* global window, document, setTimeout, setInterval, clearInterval */

(function () {
  const APP = window.APP;
  const { $, esc, toast, ERROR_CODES, colorFor, scriptLabel, serverStatusText, fmtMB, relTime, api } = APP;

  let pollTimer = null;
  let bootVisible = true;
  let wizardShownThisRun = false;
  let theme = 'dark';

  // ================= 主题 / 面板 =================
  function setTheme(t) {
    theme = t;
    document.documentElement.dataset.theme = t;
    $('theme-dark').classList.toggle('active', t === 'dark');
    $('theme-light').classList.toggle('active', t === 'light');
    try { localStorage.setItem('aicraft-theme', t); } catch (e) {}
  }
  function showPanel(name) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $('panel-' + name).classList.add('active');
    document.querySelectorAll('.side-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    if (name === 'saves' && window.Saves) Saves.refresh();
  }

  // ================= 警告条 =================
  function renderWarnBars() {
    const hall = APP.state.hall || {};
    const bars = [];
    if (hall.configBroken) {
      bars.push('<div class="warn-bar">⚠️ 配置小本本坏了，已从最近一次自动备份恢复（' + esc(hall.configBroken.restoredFrom || '') + '），你的设置应该都在。<button class="btn" onclick="this.parentElement.remove()">知道了</button></div>');
    }
    if (hall.mem && hall.mem.warnRuntime) {
      bars.push('<div class="warn-bar">🧠 内存快不够了，建议先关几个 3D 画面（每个约 0.3GB）。<button class="btn" onclick="this.parentElement.remove()">知道了</button></div>');
    }
    if (!hall.setupWizardDone && !window.Wizard.isOpen()) {
      bars.push('<div class="warn-bar">👷 新手设置还没走完，工人还没大脑。<button class="btn" id="bar-continue-wizard">继续设置</button></div>');
    }
    $('warn-bars').innerHTML = bars.join('');
    const cw = $('bar-continue-wizard');
    if (cw) cw.onclick = () => Wizard.start();
  }

  // ================= 服务器卡 =================
  function renderServer() {
    const srv = (APP.state.hall && APP.state.hall.server) || {};
    const badge = $('srv-status-badge');
    badge.textContent = serverStatusText(srv);
    badge.style.color = srv.running ? 'var(--green)' : 'var(--text2)';
    const w = srv.world || {};
    $('srv-info').textContent = `游戏端口 ${srv.actualPort || '—'} · 种子 ${w.seed != null ? w.seed : '随机'} · ${w.difficulty === 'peaceful' ? '和平难度' : w.difficulty || ''}`;
  }

  // ================= 帮助页：亲自进服地址 =================
  function fillJoinAddr() {
    const span = $('help-join-addr');
    if (!span || !APP.state.config) return;
    const port = ((APP.state.config.server || {}).portPref) || 25565;
    span.textContent = '127.0.0.1:' + port;
  }

  // ================= Bot 卡片 =================
  function closeBotWin(name, kind) {
    const wins = APP.state.botWins[name];
    if (!wins) return;
    if (kind) { try { if (wins[kind] && !wins[kind].closed) wins[kind].close(); } catch (e) {} wins[kind] = null; }
    else { Object.keys(wins).forEach(k => { try { if (wins[k] && !wins[k].closed) wins[k].close(); } catch (e) {} wins[k] = null; }); }
  }

  function openBotWin(b, kind) {
    const port = kind === 'viewer' ? b.viewerPort : b.streamPort;
    if (!port) { toast('这个工人还没开摄像头——先在工人管理里打开 3D 开关并重启它。', '', 'noviewer'); return; }
    // 重开先关旧窗（防 200~400MB/窗泄漏）
    closeBotWin(b.name, kind);
    const win = window.open('http://127.0.0.1:' + port, '_blank');
    APP.state.botWins[b.name] = APP.state.botWins[b.name] || {};
    APP.state.botWins[b.name][kind] = win;
  }

  function renderBots() {
    const hall = APP.state.hall || {};
    const bots = hall.bots || [];
    const grid = $('bot-grid');
    if (!bots.length) {
      grid.innerHTML = '<div class="card"><h3>还没有工人</h3><p class="dim">点左侧「工人管理」里的 ✨ 一键配好两个工人，或手动添加。</p></div>';
      return;
    }
    // provider 冷却表
    const coolMap = {};
    (hall.providers || []).forEach(p => { if (p.coolUntil && p.coolUntil > Date.now()) coolMap[p.id] = p.coolUntil; });

    grid.innerHTML = bots.map(b => {
      const st = b.state || {};
      const hud = st.hud || {};
      const color = colorFor(b);
      const online = b.runStatus === 'running' && b.online;
      const crashed = b.runStatus === 'crashed' || st.meta && st.meta.crashed;
      const starting = b.runStatus === 'starting';
      const dotCls = crashed ? 'crashed' : (online ? 'on' : (starting ? 'starting' : 'off'));
      const cardCls = crashed ? 'crashed' : (online ? 'online' : '');
      const err = st.meta && st.meta.error;
      const ec = err && ERROR_CODES[err.code];
      const cooling = b.providerId && coolMap[b.providerId];
      const viewerOn = b.viewer === true || b.viewer === undefined; // viewer 开关
      const viewerPort = b.viewerPort || b.actualViewer;
      const streamPort = b.streamPort || b.actualStream;
      const canOpen = online;

      let errHtml = '';
      if (crashed && !ec) errHtml = `<div class="bot-err"><span class="t">💥 工人摔了一跤</span><div>进程退出了。点「重启」试试；一直这样就看它的日志。</div></div>`;
      else if (ec) errHtml = `<div class="bot-err"><span class="t">${ec.title}</span><div>${esc(ec.desc)}</div><div class="dim">👉 ${esc(ec.action)}</div></div>`;
      else if (cooling) errHtml = `<div class="bot-err" style="border-color:var(--yellow); background:#3a3510;"><span class="t" style="color:var(--yellow);">🐢 在外面等一等</span><div class="dim">同一家供应商的工人都在放慢，过一分钟自动好。</div></div>`;

      const stats = ['❤ 血量', '🍗 饱食', '🎟 兑换点', '💣 TNT', '⛏ 工具', '📊 总计'].map((label, i) => {
        const keys = ['hp', 'food', 'woodPoint', 'tnt', 'tool', 'total'];
        const v = hud[keys[i]];
        return `<div class="stat"><div class="label">${label}</div><div class="value">${v != null && v !== '' ? esc(v) : '—'}</div></div>`;
      }).join('');

      const ld = st.lastDecision || {};
      const lastText = ld.act ? `[${esc(ld.act)}] ${esc(ld.detail || '')}` : '';

      return `<div class="bot-card ${cardCls}" style="border-left-color:${color}">
        <div class="bot-head">
          <span class="bot-dot ${dotCls}"></span>
          <span class="bot-name">${esc(b.nick || b.name)}</span>
          <span class="bot-sub">${scriptLabel(b.script)} · ${esc(b.model || '—')}</span>
          <div style="flex:1"></div>
          <div class="bot-actions">
            <button class="btn btn-green bot-start" data-name="${esc(b.name)}" ${online || starting ? 'disabled' : ''} data-tip="启动这个工人">启动</button>
            <button class="btn bot-restart" data-name="${esc(b.name)}" ${online ? '' : 'disabled'} data-tip="按新配置重启这个工人">重启</button>
            <button class="btn btn-danger bot-stop" data-name="${esc(b.name)}" ${online ? '' : 'disabled'} data-tip="让这个工人下班">停止</button>
            <button class="btn bot-viewer" data-name="${esc(b.name)}" ${canOpen && viewerOn && viewerPort ? '' : 'disabled'} data-tip="${viewerOn ? '从第三人称看它干活' : '先在「工人管理」里打开 3D 开关并重启'}">👁 3D</button>
            <button class="btn bot-stream" data-name="${esc(b.name)}" ${canOpen && streamPort ? '' : 'disabled'} data-tip="打开它的内心戏（思考过程）">💭 思考</button>
            <button class="btn bot-persona" data-name="${esc(b.name)}" data-tip="编辑这个工人的人设卡">📝 人设</button>
            <button class="btn bot-open-spec" data-name="${esc(b.name)}" data-tip="打开这个工人的功能说明书（高级用户直接改文件）">🔧 功能文件</button>
            <button class="btn btn-danger bot-del" data-name="${esc(b.name)}" data-tip="删掉这个工人（停止它并删配置）">删人</button>
          </div>
        </div>
        <div class="bot-body">
          <div class="bot-stats">${stats}</div>
          <div class="recent"><b>最近决策：</b>${lastText || '（暂无）'}</div>
          ${errHtml}
        </div>
      </div>`;
    }).join('');
  }

  // ================= 服务商面板 =================
  function renderProviders() {
    const cfg = APP.state.config;
    if (!cfg) return;
    $('provider-list').innerHTML = (cfg.providers || []).map((p, i) => `
      <div class="card" data-pi="${i}">
        <div class="row" style="gap:10px;align-items:flex-end;">
          <div class="field" style="flex:2;"><label>供应商名称</label><input data-k="name" value="${esc(p.name)}"></div>
          <div class="field" style="flex:1;"><label>系统标识（ID，自动）</label><input data-k="id" value="${esc(p.id)}" readonly></div>
        </div>
        <div class="dim" style="margin:-4px 0 8px;">OpenAI 兼容 · Chat Completions（固定，无需选择协议）</div>
        <div class="field"><label>API 地址 ${p.endpoint ? '<span style="color:var(--green);font-weight:400;">✓ 已填</span>' : '<span style="color:var(--red);font-weight:400;">✗ 还没填</span>'}</label><input data-k="endpoint" value="${esc(p.endpoint || '')}" placeholder="填 base 级即可，如 https://api.deepseek.com （粘贴完整地址会自动补全）"></div>
        <div class="field"><label>接口密钥 ${p.key === '****' ? '<span style="color:var(--green);font-weight:400;">✓ 已保存 ' + (p.keyLen || 0) + ' 位（框里留空=不改动）</span>' : '<span style="color:var(--red);font-weight:400;">✗ 还没填</span>'}</label>
          <div class="row">
            <input type="password" data-k="key" value="${esc(p.key === '****' ? '' : (p.key || ''))}" placeholder="${p.key === '****' ? '已打码保存，留空保存时不会改动它' : '粘贴 Key'}">
            <button class="btn pw-toggle" data-pi="${i}" type="button">显示</button>
          </div>
        </div>
        <div class="field">
          <label>已启用模型目录</label>
          <div class="model-tags">
            ${(p.models || []).map(m => `<span class="model-tag" data-model="${esc(m)}">${esc(m)}<button class="model-del" data-model="${esc(m)}" type="button" title="移除">×</button></span>`).join('')}
            ${(p.models || []).length ? '' : '<span class="dim">还没有模型，点下方「获取可用模型」，或手动添加。</span>'}
          </div>
          <div class="row" style="margin-top:6px;">
            <input class="model-add-input" placeholder="手动添加模型名（自动获取拿不到时）">
            <button class="btn model-add-btn" type="button">添加</button>
          </div>
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap;">
          <button class="btn provider-fetch" data-pi="${i}">获取可用模型</button>
          <button class="btn provider-test" data-pi="${i}">测试连接</button>
          <div class="dim" data-test-result="${i}"></div>
          <div style="flex:1"></div>
          <button class="btn btn-danger provider-remove" data-pi="${i}">移除这个供应商</button>
        </div>
      </div>`).join('');
  }

  function readProvidersFromDom() {
    const out = [];
    document.querySelectorAll('#provider-list .card').forEach(card => {
      const p = {};
      card.querySelectorAll('[data-k]').forEach(inp => { p[inp.dataset.k] = inp.value; });
      p.models = Array.from(card.querySelectorAll('.model-tag')).map(t => t.dataset.model);
      out.push(p);
    });
    return out;
  }

  // 自动拉取后的复选框弹窗：返回勾选数组；取消返回 null
  function openModelPicker(allModels, currentModels) {
    return new Promise(resolve => {
      const cur = new Set(currentModels || []);
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal-box">' +
          '<h3>选择要添加的模型</h3>' +
          '<div class="dim">以下是该供应商的可用模型，勾选要启用的；工人只能选这里勾选的模型。</div>' +
          '<div class="row" style="margin-top:10px;">' +
            '<input class="picker-search" placeholder="搜索模型" style="flex:1;">' +
            '<button class="btn picker-all" type="button">全选</button>' +
          '</div>' +
          '<div class="modal-list">' +
            allModels.map(m =>
              `<label data-row="${esc(m)}"><input type="checkbox" value="${esc(m)}" ${cur.has(m) ? 'checked' : ''}> ${esc(m)}</label>`
            ).join('') +
          '</div>' +
          '<div class="row" style="justify-content:flex-end;gap:10px;">' +
            '<button class="btn picker-cancel" type="button">取消</button>' +
            '<button class="btn btn-primary picker-ok" type="button">添加所选</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);
      const close = v => { mask.remove(); resolve(v); };
      mask.querySelector('.picker-search').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        mask.querySelectorAll('[data-row]').forEach(l => {
          l.style.display = l.dataset.row.toLowerCase().includes(q) ? '' : 'none';
        });
      };
      mask.querySelector('.picker-all').onclick = () => {
        const visible = Array.from(mask.querySelectorAll('[data-row]')).filter(l => l.style.display !== 'none');
        const anyUnchecked = visible.some(l => !l.querySelector('input').checked);
        visible.forEach(l => { l.querySelector('input').checked = anyUnchecked; });
      };
      mask.querySelector('.picker-cancel').onclick = () => close(null);
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
      const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(null); } };
      document.addEventListener('keydown', onKey);
      mask.querySelector('.picker-ok').onclick = () => {
        const sel = Array.from(mask.querySelectorAll('.modal-list input:checked')).map(b => b.value);
        close(sel);
      };
    });
  }

  // ================= 设置面板 =================
  function loadSettings() {
    const cfg = APP.state.config;
    if (!cfg) return;
    const s = cfg.server || {}, w = s.world || {};
    $('set-seed').value = w.seed != null ? w.seed : '';
    $('set-difficulty').value = w.difficulty || 'peaceful';
    $('set-gamemode').value = w.gamemode || 'survival';
    $('set-xmx').value = s.xmx || '2G';
    $('set-keepinventory').checked = w.keepInventory !== false;
    $('set-memory').value = (cfg.memory && cfg.memory.rounds) || 5;
    $('set-srvport').value = s.portPref || 25565;
    $('set-rconport').value = s.rconPortPref || 25575;
  }

  // ================= 工人管理：添加表单联动 + 现有列表 =================
  function refreshProviderSelect() {
    const cfg = APP.state.config;
    if (!cfg) return;
    $('add-provider').innerHTML = (cfg.providers || []).map(p =>
      `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    syncModelSelect();
  }
  function syncModelSelect() {
    const cfg = APP.state.config;
    const pid = $('add-provider').value;
    const p = (cfg.providers || []).find(x => x.id === pid);
    const models = (p && p.models) || [];
    $('add-model').innerHTML = models.length
      ? models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      : '<option value="">（这家还没启用模型，先去供应商页获取或添加）</option>';
  }

  function renderBotManage() {
    const cfg = APP.state.config;
    if (!cfg) return;
    $('bot-manage-list').innerHTML = (cfg.bots || []).map(b => `
      <div class="card" style="margin-bottom:10px;">
        <div class="row">
          <b>${esc(b.nick || b.name)}</b>
          <span class="dim">${scriptLabel(b.script)} · ${esc(b.model || '—')} · ${b.keyMode === 'own' ? '独立钥匙' : '共用钥匙'}</span>
        </div>
        <div class="row" style="gap:10px; margin-top:8px;">
          <label class="dim">记忆条数 <input type="number" min="1" max="50" value="${b.memoryRounds || 5}" data-mem="${esc(b.name)}" style="width:70px;"></label>
          <label class="dim">3D 开关 <input type="checkbox" data-viewer="${esc(b.name)}" ${b.viewer ? 'checked' : ''}></label>
          <div style="flex:1"></div>
          <button class="btn bot-edit-model" data-name="${esc(b.name)}" data-tip="改这个工人的供应商/型号，保存后自动让它按新设置上班">改配置</button>
        </div>
      </div>`).join('');
  }

  // ================= 内存预估行 =================
  function renderMemLines() {
    const hall = APP.state.hall;
    if (!hall) return;
    const runningCount = (hall.bots || []).filter(b => b.runStatus === 'running').length;
    const viewersOpen = (Object.keys(APP.state.botWins) || []).reduce((n, k) => n + (APP.state.botWins[k].viewer ? 1 : 0), 0);
    const addViewer = $('add-viewer').checked ? 1 : 0;
    const addBot = $('add-name').value.trim() ? 1 : 0;
    const r = Mem.compute(hall, { botsRunning: runningCount, viewersOpen: viewersOpen, xmx: (hall.server || {}).xmx });
    $('mem-line-side').innerHTML = Mem.lineHtml(r);
    const r2 = Mem.compute(hall, { botsRunning: runningCount + addBot, viewersOpen: viewersOpen + addViewer, xmx: (hall.server || {}).xmx });
    $('mem-line-add').innerHTML = '添加后：' + Mem.lineHtml(r2);
    return { r, r2 };
  }

  // ================= 事件绑定 =================
  function btnBusy(el) { el.classList.add('busy'); }
  function bindEvents() {
    $('theme-dark').onclick = () => setTheme('dark');
    $('theme-light').onclick = () => setTheme('light');
    document.querySelectorAll('.side-btn').forEach(b => b.onclick = () => showPanel(b.dataset.panel));
    $('btn-replay-wizard').onclick = () => Wizard.start();

    // 服务器
    $('btn-srv-start').onclick = async (e) => {
      btnBusy(e.target);
      const r = await api('POST', '/api/server/start');
      toast((r && r.msg) || '已下发启动', r && r.ok === false ? 'error' : 'success');
      refresh();
    };
    $('btn-srv-stop').onclick = async () => {
      const r = await api('POST', '/api/server/stop');
      toast((r && r.msg) || '已停止', r && r.ok === false ? 'error' : 'success');
      refresh();
    };
    $('btn-log-toggle').onclick = async () => {
      const pre = $('srv-log');
      if (!pre.hidden) { pre.hidden = true; return; }
      const r = await api('GET', '/api/logs?name=server&lines=120');
      pre.textContent = (r && r.content) || '（暂无日志）';
      pre.hidden = false;
    };

    // 一键上班/集体下班
    $('btn-all-start').onclick = async (e) => {
      const hall = APP.state.hall || {};
      const plannedBots = (hall.bots || []).length;
      const viewersOpen = Object.keys(APP.state.botWins).filter(k => APP.state.botWins[k].viewer).length;
      const rAll = Mem.compute(hall, { botsRunning: plannedBots, viewersOpen, xmx: (hall.server || {}).xmx });
      const gate = () => doAllStart(e.target);
      if (rAll.level === 'red') Mem.confirmRed(rAll, gate);
      else gate();
    };
    async function doAllStart(btn) {
      btnBusy(btn);
      const r = await api('POST', '/api/all/start');
      toast((r && r.msg) || '一键上班中…', r && r.ok === false ? 'error' : 'success');
      btn.classList.remove('busy');
      refresh();
    }
    $('btn-all-stop').onclick = async () => {
      if (!confirm('工人集体下班？\n\n会先让每个工人把手头的活存好，再让服务器打烊（约 5~15 秒）。刚盖好的房子会留在世界里，之前打开的 3D 小窗户也会一起关掉。')) return;
      const r = await api('POST', '/api/all/stop');
      toast((r && r.msg) || '已下班', 'success');
      // 批量关所有 3D/思考窗
      Object.keys(APP.state.botWins).forEach(n => closeBotWin(n));
      refresh();
    };

    // bot 卡片操作（委托）
    $('bot-grid').onclick = async (e) => {
      const el = e.target.closest('button');
      if (!el || el.disabled) return;
      const name = el.dataset.name;
      if (el.classList.contains('bot-start')) { const r = await api('POST', '/api/bot/start', { name }); toast(r.msg, r.ok === false ? 'error' : 'success'); refresh(); }
      else if (el.classList.contains('bot-stop')) { await api('POST', '/api/bot/stop', { name }); closeBotWin(name); toast('已让 ' + name + ' 下班', 'success'); refresh(); }
      else if (el.classList.contains('bot-restart')) { const r = await api('POST', '/api/bot/restart', { name }); toast((r && r.msg) || '正在按新设置重启', 'success'); refresh(); }
      else if (el.classList.contains('bot-viewer')) { const b = (APP.state.hall.bots || []).find(x => x.name === name); if (b) openBotWin(b, 'viewer'); }
      else if (el.classList.contains('bot-stream')) { const b = (APP.state.hall.bots || []).find(x => x.name === name); if (b) openBotWin(b, 'stream'); }
      else if (el.classList.contains('bot-del')) {
        if (!confirm('删掉这个工人？会停止它并删除配置（它的日志/记忆会一起清理）。')) return;
        const r = await api('POST', '/api/bot/remove', { name });
        closeBotWin(name);
        toast((r && r.msg) || '已删除', 'success');
        APP.state.config = await api('GET', '/api/config');
        renderBotManage();
        refresh();
      }
      else if (el.classList.contains('bot-persona')) { openPersonaEditor(name); }
      else if (el.classList.contains('bot-open-spec')) {
        const r = await api('POST', '/api/bot/' + encodeURIComponent(name) + '/open-spec');
        if (!r || !r.ok) alert('打开功能文件失败：' + (r && r.msg || '未知错误'));
      }
    };

    // 设置保存
    $('btn-save-settings').onclick = async (e) => {
      btnBusy(e.target);
      const xmx = $('set-xmx').value;
      const body = {
        server: {
          portPref: Number($('set-srvport').value) || 25565,
          rconPort: Number($('set-rconport').value) || 25575,
          xmx,
          world: {
            seed: $('set-seed').value === '' ? null : Number($('set-seed').value),
            difficulty: $('set-difficulty').value,
            gamemode: $('set-gamemode').value,
            keepInventory: $('set-keepinventory').checked,
          },
        },
        memory: { rounds: Number($('set-memory').value) || 5 },
      };
      const r = await api('PUT', '/api/config', body);
      APP.state.config = await api('GET', '/api/config');
      e.target.classList.remove('busy');
      if (r && r.ok === false) toast(r.msg, 'error');
      else {
        toast('✅ 世界设置已保存。种子/难度下次开新世界生效；' + (xmx !== (APP.state.hall.server || {}).xmx ? '运行内存（RAM）变了，需重启 AICraft 生效。' : ''), 'success');
      }
      renderMemLines();
    };

    // 服务商：密码框切换 / 测试 / 删除校验 / 添加
    const persistProviders = async () => {
      const providers = readProvidersFromDom();
      await api('PUT', '/api/config', { providers });
      APP.state.config = await api('GET', '/api/config');
    };
    $('provider-list').onclick = async (e) => {
      const tg = e.target.closest('.pw-toggle');
      if (tg) {
        const inp = tg.parentElement.querySelector('input[data-k="key"]');
        inp.type = inp.type === 'password' ? 'text' : 'password';
        tg.textContent = inp.type === 'password' ? '显示' : '隐藏';
        return;
      }
      // 删除单个已启用模型
      const mdel = e.target.closest('.model-del');
      if (mdel) {
        const card = mdel.closest('.card');
        const want = mdel.dataset.model;
        card.querySelectorAll('.model-tag').forEach(t => { if (t.dataset.model === want) t.remove(); });
        await persistProviders();
        renderProviders();
        return;
      }
      // 手动添加模型
      const madd = e.target.closest('.model-add-btn');
      if (madd) {
        const card = madd.closest('.card');
        const inp = card.querySelector('.model-add-input');
        const val = (inp.value || '').trim();
        if (!val) return;
        const exist = Array.from(card.querySelectorAll('.model-tag')).map(t => t.dataset.model);
        if (exist.includes(val)) { toast('这个模型已经在目录里了', 'error'); return; }
        await persistProviders();
        const providers = readProvidersFromDom();
        const idx = Number(card.dataset.pi);
        providers[idx].models = providers[idx].models.concat([val]);
        await api('PUT', '/api/config', { providers });
        APP.state.config = await api('GET', '/api/config');
        renderProviders();
        return;
      }
      // 获取可用模型：先保存，再调后端拉取，弹复选框
      const fetchBtn = e.target.closest('.provider-fetch');
      if (fetchBtn) {
        const card = fetchBtn.closest('.card');
        const idx = Number(card.dataset.pi);
        let r;
        try {
          await persistProviders();
          const providerId = (APP.state.config.providers[idx] || {}).id || '';
          fetchBtn.classList.add('busy');
          r = await api('POST', '/api/provider/fetch-models', { providerId });
        } catch (err) {
          toast('自动获取出错：' + (err.message || err) + '，可手动添加', 'error');
          return;
        } finally {
          fetchBtn.classList.remove('busy');
        }
        if (!r || r.ok === false) { toast('自动获取失败：' + ((r && r.message) || '后端无响应') + '，可手动添加', 'error'); return; }
        const current = (APP.state.config.providers[idx] || {}).models || [];
        const picked = await openModelPicker(r.models, current);
        if (picked === null) return;
        const providers = readProvidersFromDom();
        providers[idx].models = picked;
        await api('PUT', '/api/config', { providers });
        APP.state.config = await api('GET', '/api/config');
        renderProviders();
        toast('已启用 ' + picked.length + ' 个模型', 'success');
        return;
      }
      const test = e.target.closest('.provider-test');
      if (test) {
        const card = test.closest('.card');
        const ep = card.querySelector('[data-k="endpoint"]').value;
        const key = card.querySelector('[data-k="key"]').value;
        const model = (card.querySelector('.model-tag') || {}).dataset ? card.querySelector('.model-tag').dataset.model : '';
        const providerId = (APP.state.config.providers[Number(card.dataset.pi)] || {}).id || '';
        if (!model) { toast('这个供应商还没有模型名：「获取可用模型」勾一个，或在下方手动输入模型名，再来测试', 'error'); return; }
        test.classList.add('busy');
        // 带 providerId：key 输入框留空（打码态）时，后端才能回退到已保存的真实 key
        const r = await api('POST', '/api/provider/test', { endpoint: ep, key, model, providerId });
        test.classList.remove('busy');
        const res = card.querySelector('[data-test-result]');
        res.textContent = r.ok
          ? '✅ 通了！模型 ' + model + ' 有回应（' + (r.ms || 0) + 'ms）'
          : '❌ ' + (r.message || r.msg || '测试失败');
        res.style.color = r.ok ? 'var(--green)' : 'var(--red)';
        return;
      }
      const rm = e.target.closest('.provider-remove');
      if (rm) {
        const cfg = APP.state.config;
        const idx = Number(rm.dataset.pi);
        const p = cfg.providers[idx];
        const usedBy = (cfg.bots || []).filter(b => (b.providerId || b.provider) === p.id);
        if (usedBy.length) {
          if (!confirm(`「${p.name}」还有 ${usedBy.length} 个工人在用：${usedBy.map(b => b.nick || b.name).join('、')}。\n删了它们会变成没大脑。确定硬删吗？`)) return;
        } else if (!confirm(`删掉供应商「${p.name}」？它的钥匙也会一起删。`)) return;
        cfg.providers.splice(idx, 1);
        await api('PUT', '/api/config', { providers: cfg.providers });
        APP.state.config = await api('GET', '/api/config');
        renderProviders(); refreshProviderSelect();
        toast('已删除，记得把用到它的工人换到别的供应商。', 'success');
      }
    };
    $('btn-add-provider').onclick = () => {
      APP.state.config.providers.push({ id: 'p' + Date.now().toString(36), name: '新供应商', endpoint: '', key: '', models: [], defaultModel: '' });
      renderProviders();
    };
    // 服务商编辑后统一保存（失焦即写，生效范围提示）
    $('provider-list').addEventListener('change', async () => {
      const providers = readProvidersFromDom();
      await api('PUT', '/api/config', { providers });
      APP.state.config = await api('GET', '/api/config');
      toast('✅ 供应商已保存，正在让相关工人按新钥匙上班。', 'success');
    });

    // 添加 bot 表单
    $('add-provider').onchange = syncModelSelect;
    $('add-viewer').onchange = renderMemLines;
    $('add-name').oninput = renderMemLines;
    $('btn-preset-two').onclick = async (e) => {
      btnBusy(e.target);
      const r = await api('POST', '/api/bot/preset/two');
      e.target.classList.remove('busy');
      toast((r && r.msg) || '已配好两个工人', r && r.ok === false ? 'error' : 'success');
      APP.state.config = await api('GET', '/api/config');
      renderBotManage(); refresh();
    };
    $('btn-add-bot').onclick = async (e) => {
      const pid = $('add-provider').value;
      const cfg = APP.state.config;
      const p = (cfg.providers || []).find(x => x.id === pid);
      const model = $('add-model').value;
      if (!p || !(p.models || []).length) { toast('这个供应商还没有填大脑型号，先去「AI 大脑供应商」填型号。', 'error', 'nomodel'); return; }
      if (!model) { toast('大脑型号为空，选一个型号再加。', 'error', 'nomodel2'); return; }
      btnBusy(e.target);
      const r = await api('POST', '/api/bot/add', {
        name: $('add-name').value.trim() || undefined,
        nick: $('add-nick').value.trim() || undefined,
        script: $('add-script').value,
        providerId: pid,
        model,
        keyMode: document.querySelector('input[name="add-keymode"]:checked').value,
        ownKey: $('add-ownkey').value,
        memoryRounds: Number($('add-memrounds').value) || 5,
        color: $('add-color').value,
        viewer: $('add-viewer').checked,
      });
      e.target.classList.remove('busy');
      toast((r && r.msg) || '已添加', r && r.ok === false ? 'error' : 'success');
      APP.state.config = await api('GET', '/api/config');
      renderBotManage(); refresh();
    };

    // 现有工人：记忆条数 / 3D 开关 / 改配置
    $('bot-manage-list').onchange = async (e) => {
      const memInp = e.target.dataset && e.target.dataset.mem;
      if (memInp) {
        const r = await api('POST', '/api/bot/update', { name: memInp, memoryRounds: Number(e.target.value) || 5 });
        toast((r && r.msg) || '✅ 已保存，正在让这个工人按新记性上班。', r && r.ok === false ? 'error' : 'success');
        refresh();
      }
      const viewerTarget = e.target.dataset && e.target.dataset.viewer;
      if (viewerTarget) {
        const r = await api('POST', '/api/bot/update', { name: viewerTarget, viewer: e.target.checked });
        toast((r && r.msg) || (e.target.checked ? '已打开摄像头开关，需重启这个工人才有 3D 画面。' : '已关摄像头开关。'), r && r.ok === false ? 'error' : 'success');
        refresh();
      }
    };

    // 工人管理页「改配置」点击（事件委托）
    $('bot-manage-list').onclick = (e) => {
      const btn = e.target.closest('button.bot-edit-model');
      if (!btn) return;
      openBotEditor(btn.dataset.name);
    };

    // 关窗存盘小条：强制退出二次点
    let forceArmed = false;
    window.aicraft.on('aicraft-shutdown-starting', () => { $('shutdown-bar').style.display = 'block'; });
    $('btn-force-quit').onclick = () => {
      if (!forceArmed) { forceArmed = true; $('btn-force-quit').classList.add('arm'); $('btn-force-quit').textContent = '⚠️ 再点一次确认强退（这次存档可能少几分钟）'; return; }
      window.aicraft.forceQuit();
    };
  }

  // 工人配置编辑弹窗：改供应商/模型/钥匙/昵称/记忆/3D/颜色，保存后自动重启
  function openBotEditor(name) {
    const cfg = APP.state.config;
    if (!cfg) return;
    const bot = (cfg.bots || []).find(b => b.name === name);
    if (!bot) return;
    const providers = cfg.providers || [];
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="width:min(640px,94vw);">
      <h3>⚙️ 改配置 — ${esc(bot.nick || bot.name)}</h3>
      <p class="dim">改完保存，会自动让这个工人按新设置上班。</p>
      <div class="field"><label>昵称</label><input id="be-nick" value="${esc(bot.nick || '')}"></div>
      <div class="row" style="gap:10px;">
        <div class="field" style="flex:1;"><label>供应商（Provider）</label>
          <select id="be-provider">${providers.map(p => `<option value="${esc(p.id)}" ${p.id === bot.providerId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        </div>
        <div class="field" style="flex:1;"><label>模型型号（Model）</label>
          <select id="be-model"></select>
        </div>
      </div>
      <div class="dim" style="margin:-4px 0 8px;">只能选该供应商已启用的模型；想加更多，去「AI 大脑供应商」页获取或手动添加。</div>
      <div class="check"><input type="radio" name="be-keymode" id="be-key-shared" value="shared" ${bot.keyMode !== 'own' ? 'checked' : ''}><label for="be-key-shared">共用供应商的钥匙</label></div>
      <div class="check"><input type="radio" name="be-keymode" id="be-key-own" value="own" ${bot.keyMode === 'own' ? 'checked' : ''}><label for="be-key-own">这个工人用独立钥匙</label></div>
      <input id="be-ownkey" type="password" placeholder="${bot.ownKey ? '已打码保存（留空=不改）' : '独立钥匙（password 框）'}" value="" style="margin-top:4px;">
      <div class="row" style="gap:10px;margin-top:10px;">
        <div class="field" style="flex:1;"><label>记忆条数（默认 5）</label><input id="be-mem" type="number" min="1" max="50" value="${bot.memoryRounds || 5}"></div>
        <div class="field" style="flex:1;"><label>颜色（卡片/对话配色）</label>
          <div class="row" style="gap:8px;align-items:center;">
            <input id="be-color" type="color" value="${esc(bot.color || '#60a5fa')}" style="flex:1;">
            <span id="be-color-dot" style="width:22px;height:22px;border-radius:50%;background:${esc(bot.color || '#60a5fa')};border:2px solid #fff;display:inline-block;flex:none;"></span>
          </div>
        </div>
      </div>
      <div class="check" style="margin-top:8px;"><input type="checkbox" id="be-viewer" ${bot.viewer ? 'checked' : ''}><label for="be-viewer">给他开个摄像头（3D 画面）</label></div>
      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:14px;">
        <button class="btn" id="be-cancel">取消</button>
        <button class="btn btn-primary" id="be-save">保存并让它按新设置上班</button>
      </div></div>`;
    document.body.appendChild(mask);

    const fillModelList = () => {
      const pid = $('be-provider').value;
      const prov = APP.state.config.providers.find(x => x.id === pid);
      let models = (prov && prov.models) ? prov.models.slice() : [];
      if (bot.model && !models.includes(bot.model)) models = [bot.model].concat(models);
      $('be-model').innerHTML = models.length
        ? models.map(m => `<option value="${esc(m)}" ${m === bot.model ? 'selected' : ''}>${esc(m)}</option>`).join('')
        : '<option value="">（该供应商还没启用模型）</option>';
    };
    fillModelList();
    $('be-provider').onchange = fillModelList;
    $('be-color').oninput = () => { $('be-color-dot').style.background = $('be-color').value; };
    $('be-cancel').onclick = () => mask.remove();
    $('be-save').onclick = async () => {
      const payload = {
        name,
        nick: $('be-nick').value.trim(),
        providerId: $('be-provider').value,
        model: $('be-model').value.trim(),
        keyMode: document.querySelector('input[name="be-keymode"]:checked').value,
        memoryRounds: Number($('be-mem').value) || 5,
        viewer: $('be-viewer').checked,
        color: $('be-color').value,
      };
      const own = $('be-ownkey').value;
      if (own && own !== '****') payload.ownKey = own;
      const rr = await api('POST', '/api/bot/update', payload);
      toast((rr && rr.msg) || '✅ 已保存，正在让这个工人按新设置上班。', rr && rr.ok === false ? 'error' : 'success');
      mask.remove();
      APP.state.config = await api('GET', '/api/config');
      renderBotManage(); refresh();
    };
  }

  // 人设编辑弹窗
  async function openPersonaEditor(name) {
    const r = await api('GET', '/api/bot/' + encodeURIComponent(name) + '/persona');
    const cur = (r && r.system_prompt_ready) || (r && r.persona) || '';
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="width:min(640px,94vw);">
      <h3>📝 编辑人设卡 — ${esc(name)}</h3>
      <p class="dim">改完保存会自动让这个工人按新人设上班。</p>
      <textarea id="persona-ta" style="width:100%;min-height:260px;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:inherit;font-size:13px;">${esc(cur)}</textarea>
      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:12px;">
        <button class="btn" id="persona-cancel">取消</button>
        <button class="btn btn-primary" id="persona-save">保存并让它按新人设上班</button>
      </div></div>`;
    document.body.appendChild(mask);
    $('persona-cancel').onclick = () => mask.remove();
    $('persona-save').onclick = async () => {
      const rr = await api('PUT', '/api/bot/' + encodeURIComponent(name) + '/persona', { persona: $('persona-ta').value });
      toast((rr && rr.msg) || '✅ 已保存，正在让这个工人按新设置上班。', rr && rr.ok === false ? 'error' : 'success');
      mask.remove(); refresh();
    };
  }

  // ================= 轮询 =================
  async function refresh() {
    try {
      APP.state.hall = await api('GET', '/api/hall');
    } catch (e) {
      if (!bootVisible) toast('后端未响应：' + e.message, 'error', 'hall-offline');
      return;
    }
    // IPC 层在后端未就绪时会返回 {ok:false} 而非抛错；识别为未就绪，等下一轮，避免假 hall 污染
    if (!APP.state.hall || APP.state.hall.ok === false || !APP.state.hall.bootTime) return;
    // 各渲染独立容错：单个渲染抛错不影响其余渲染、不阻断轮询与向导
    [['warn', renderWarnBars], ['server', renderServer], ['bots', renderBots], ['mem', renderMemLines]].forEach(pair => {
      try { pair[1](); } catch (e) { console.error('[render:' + pair[0] + ']', e); }
    });

    // 加载屏阶段判定
    if (bootVisible) {
      let res;
      try {
        res = Boot.update(APP.state.hall);
      } catch (e) {
        console.error('[boot.update]', e);
        // 兜底：即使 Boot 渲染异常，也直接按 hall 判定，保证首启向导必弹
        const h = APP.state.hall || {};
        res = { done: false, wizardNeeded: !!(h.needsKey || h.noWorld || !h.setupWizardDone) };
      }
      if (res.wizardNeeded && !wizardShownThisRun && !Wizard.isOpen()) {
        wizardShownThisRun = true;
        Boot.hide();
        try {
          if (!APP.state.config) APP.state.config = await api('GET', '/api/config');
          Wizard.start();
        } catch (e) { console.error('[wizard.start]', e); }
        return;
      }
      if (res.done) {
        bootVisible = false;
        Boot.hide();
        if (!APP.state.config) APP.state.config = await api('GET', '/api/config');
        try {
          loadSettings(); renderProviders(); refreshProviderSelect(); renderBotManage(); fillJoinAddr();
        } catch (e) { console.error('[post-boot render]', e); }
        Chat.start();
      }
    }
  }

  function pollLoop() {
    refresh();
    const wait = bootVisible ? 1000 : 3000;
    pollTimer = setTimeout(pollLoop, wait);
  }

  // Wizard 走完（finish）：要启动服务器，回加载屏跟踪真实启动进度
  APP.onWizardDone = () => { bootVisible = true; Boot.show(); };
  // Wizard 跳过（先逛逛大厅）：不启动，直接进大厅浏览，加载 config 并渲染各面板
  APP.onWizardSkip = async () => {
    bootVisible = false;
    Boot.hide();
    try {
      if (!APP.state.config) APP.state.config = await api('GET', '/api/config');
      loadSettings(); renderProviders(); refreshProviderSelect(); renderBotManage(); fillJoinAddr();
    } catch (e) { console.error('[wizard.skip render]', e); }
  };

  // ================= 启动 =================
  function init() {
    try { theme = localStorage.getItem('aicraft-theme') || 'dark'; } catch (e) {}
    setTheme(theme);
    bindEvents();
    Boot.init();
    Boot.show();
    APP.state.bootStart = Date.now();
    pollLoop();
  }
  init();
})();
