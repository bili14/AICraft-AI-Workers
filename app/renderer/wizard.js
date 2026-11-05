// wizard.js — 首启向导（5 步，可跳过/断点续作；半填内容实时 PUT /api/config 落盘）
'use strict';
/* global window, document */

(function () {
  const APP = window.APP;
  const $ = APP.$;
  let step = 0;
  // 向导编辑中的草稿（完成后一次性写回）
  let draft = null;

  const STEP_NAMES = ['欢迎', '环境', '大脑', '地图', '开工'];

  function el(body) {
    $('wiz-body').innerHTML = body;
    $('wiz-nav').style.display = 'flex';
    $('wiz-prev').style.visibility = step === 0 ? 'hidden' : 'visible';
    $('wiz-next').textContent = step === 4 ? '▶ 开始上班！' : '下一步';
  }

  function renderSteps() {
    $('wiz-steps').innerHTML = STEP_NAMES.map((n, i) =>
      `<span class="wiz-dot ${i === step ? 'cur' : (i < step ? 'done' : '')}">${i + 1}·${n}</span>`).join('');
  }

  // ---------- Step 0 欢迎 ----------
  function s0() {
    el(`
      <h2>👷 欢迎来到 AICraft</h2>
      <p class="wiz-p">这里是一个 AI 打工现场：你雇几个 AI 工人，让它们在我的世界里自己砍树、盖房、聊天。你当监工，不用自己动手。</p>
      <p class="wiz-p dim">花一分钟走个过场，配一把“大脑钥匙”、挑一张开工地图，就能开工。</p>
    `);
  }

  // ---------- Step 1 环境自检（自动） ----------
  function s1() {
    const rt = (APP.state.hall && APP.state.hall.runtime) || {};
    // 新后端：rt.node/java = {ok, version, source, reason} 真实探测；老后端：'portable'/'system' 字符串；缺失：检测中
    const fmtTool = (v, name) => {
      if (!v) return `<div class="wiz-check">⏳ ${name}：检测中…</div>`;
      if (typeof v === 'string') {
        return `<div class="wiz-check">✅ ${name}：自带运行环境齐全，不用你装任何东西。</div>`;
      }
      if (v.ok) {
        const where = v.source === 'portable' ? '（自带）' : '（系统）';
        return `<div class="wiz-check">✅ ${name}：${APP.esc(v.version || '已就绪')}${APP.esc(where)}</div>`;
      }
      return `<div class="wiz-check bad">❌ ${name}：${APP.esc(v.reason || '未就绪')}。可能是解压没解完整——请把整个文件夹一起解压，不要只把 exe 拖出来。</div>`;
    };
    el(`<h2>🔧 环境自检</h2>${fmtTool(rt.node, 'Node')}${fmtTool(rt.java, 'Java')}`);
  }

  // ---------- Step 2 配大脑（Key 密码框 + 测试） ----------
  function s2() {
    const providers = draft.providers;
    const cards = providers.map((p, i) => {
      const keyLabel = '大脑钥匙（API Key）';
      const keyHint = '怎么拿 Key？浏览器搜「' + APP.esc(p.name) + ' 官网 API 密钥」，注册后在控制台创建一个，复制粘贴到这里。';
      return `
      <div class="wiz-provider">
        <div class="wiz-provider-head">
          <b>${APP.esc(p.name)}</b>
          <span class="dim">（${APP.esc(p.id)}）</span>
        </div>
        <div class="field">
          <label>${keyLabel}</label>
          <div class="row">
            <input type="password" id="wiz-key-${i}" value="${APP.esc(p.key === '****' ? '' : p.key)}" placeholder="${p.key === '****' ? '已保存（留空不变）' : '粘贴 Key'}">
            <button class="btn" id="wiz-show-${i}" data-i="${i}">显示</button>
          </div>
          <div class="hint">${keyHint}</div>
          <div class="row" style="margin-top:6px;">
            <button class="btn" id="wiz-test-${i}" data-i="${i}">测试一下钥匙</button>
            <span class="wiz-test-result" id="wiz-test-result-${i}"></span>
          </div>
        </div>
      </div>`;
    }).join('');
    el(`<h2>🧠 给 AI 工人装个大脑</h2>
      <p class="wiz-p">工人的思考要调用云端大模型，需要一把钥匙。没有 Key 工人会睡觉，但界面可以先逛。不要求全填，填一个就能玩。</p>
      ${cards}
      <p class="wiz-p dim" style="margin-top:10px;">想接自己电脑上跑的模型？进「AI 大脑供应商」点「＋ 添加供应商」，填你自己的地址就行（只要兼容 OpenAI 接口）。</p>`);
    // 显示/隐藏切换
    providers.forEach((p, i) => {
      const showBtn = $('wiz-show-' + i);
      showBtn.onclick = () => {
        const inp = $('wiz-key-' + i);
        inp.type = inp.type === 'password' ? 'text' : 'password';
        showBtn.textContent = inp.type === 'password' ? '显示' : '隐藏';
      };
      const testBtn = $('wiz-test-' + i);
      testBtn.onclick = async () => {
        const res = $('wiz-test-result-' + i);
        res.textContent = '测试中…';
        const r = await APP.api('POST', '/api/provider/test', {
          endpoint: p.endpoint, key: $('wiz-key-' + i).value,
          model: (p.models && p.models[0]) || p.defaultModel || '',
          providerId: p.id,
        });
        res.textContent = r.ok ? '✅ 通了！' : '❌ ' + (r.message || r.msg || '测试失败');
        res.style.color = r.ok ? 'var(--green)' : 'var(--red)';
      };
    });
  }

  // ---------- Step 3 世界设置 ----------
  function s3() {
    const w = draft.world;
    const mem = APP.state.hall && APP.state.hall.mem;
    const memTotal = mem && mem.totalMB;
    const memFree = mem && mem.freeMB;
    const recommendXmx = (memTotal && memTotal <= 8192) ? '1.5G' : '2G';
    const gamemode = (w.gamemode === 'creative') ? 'creative' : 'survival';
    const gmDesc = {
      survival: '生存（默认）：工人要自己砍树挖矿、会饿会受伤，死了会掉东西（除非开了死亡不掉落）。这是最像真打工的现场。',
      creative: '创造：方块无限、能飞、不会受伤，专心盖楼适合观赏。工人不用操心吃饭和命，适合你只想看它盖房子。',
    };
    const memHint = memTotal
      ? '这台电脑共 ' + Math.round(memTotal / 1024) + ' GB 内存，当前可用 ' + Math.round(memFree / 1024) + ' GB，推荐 ' + recommendXmx + '。这是给游戏世界留的内存，不是工人 AI 大脑的内存。'
      : '这是给游戏世界留的内存，不是工人 AI 大脑的内存。';
    el(`<h2>🗺 挑一个开工地图</h2>
      <div class="field">
        <label>种子（数字，留空 = 随机新大陆）</label>
        <input id="wiz-seed" type="number" value="${w.seed != null ? APP.esc(w.seed) : ''}" placeholder="留空 = 随机">
        <div class="hint">相同种子 = 相同地形。想给朋友晒你的地形，把这串数字给他就行。</div>
      </div>
      <div class="field">
        <label>难度</label>
        <select id="wiz-difficulty">
          <option value="peaceful" ${w.difficulty === 'peaceful' ? 'selected' : ''}>和平（没怪物乱跑，第一次强烈推荐）</option>
          <option value="easy" ${w.difficulty === 'easy' ? 'selected' : ''}>简单</option>
          <option value="normal" ${w.difficulty === 'normal' ? 'selected' : ''}>普通</option>
          <option value="hard" ${w.difficulty === 'hard' ? 'selected' : ''}>困难</option>
        </select>
      </div>
      <div class="field">
        <label>游戏模式</label>
        <select id="wiz-gamemode">
          <option value="survival" ${gamemode === 'survival' ? 'selected' : ''}>生存（工人要自己砍树挖矿、会饿会受伤）</option>
          <option value="creative" ${gamemode === 'creative' ? 'selected' : ''}>创造（方块无限、能飞、不会受伤，专心盖楼适合观赏）</option>
        </select>
        <div class="dim" id="wiz-gamemode-desc" style="margin-top:6px;line-height:1.7;"></div>
      </div>
      <div class="check"><input type="checkbox" id="wiz-keepinv" ${w.keepInventory !== false ? 'checked' : ''}><label for="wiz-keepinv">死亡不掉落（工人死了不丢背包里的东西）</label></div>
      <div class="field">
        <label>给服务器留多少内存</label>
        <select id="wiz-xmx">
          <option value="1.5G" ${draft.xmx === '1.5G' ? 'selected' : ''}>1.5G（省内存：8GB 小电脑推荐，可能偶尔掉点远处的区块）</option>
          <option value="2G" ${draft.xmx === '2G' ? 'selected' : ''}>2G（默认，大多数电脑合适）</option>
          <option value="3G" ${draft.xmx === '3G' ? 'selected' : ''}>3G（大内存：16GB 以上、世界很大时再用）</option>
        </select>
        <div class="hint">${memHint}</div>
      </div>
      <div class="wiz-join-card">🎮 <b>想亲自进去玩？</b>电脑上装一个 Minecraft 1.21.4 客户端，多人游戏填地址 <b>127.0.0.1:${APP.esc(String(draft.serverPort || 25565))}</b> 就能连进来，和工人们同场。服务器开着就能进，纯本机联机，不联网、不花钱、不用正版账号。注意：先启动服务器才能进。</div>`);
    // 游戏模式白话说明随下拉动态切换
    const gmSel = $('wiz-gamemode');
    const gmBox = $('wiz-gamemode-desc');
    const showGmDesc = () => { gmBox.textContent = gmDesc[gmSel.value] || gmDesc.survival; };
    gmSel.onchange = showGmDesc;
    showGmDesc();
  }

  // ---------- Step 4 完成 ----------
  function s4() {
    el(`<h2>🎉 准备好了！</h2>
      <p class="wiz-p">点下面的按钮，工人就会进厂开工。第一次要生成世界，大约 1~2 分钟，会看到小人和清单在跑——那是正常的，不是卡死。</p>
      <div class="check"><input type="checkbox" id="wiz-done" checked><label for="wiz-done">以后不再显示这个向导</label></div>`);
  }

  const STEPS = [s0, s1, s2, s3, s4];

  async function collectStep() {
    // 离开某步时把该步草稿写回 draft 并 PUT 落盘（断点续作）
    if (step === 2) {
      draft.providers.forEach((p, i) => {
        const v = $('wiz-key-' + i).value;
        if (v) p.key = v; // 空 = 不修改原 key
      });
      await APP.api('PUT', '/api/config', { providers: draft.providers }).catch(() => {});
    }
    if (step === 3) {
      draft.world = {
        seed: $('wiz-seed').value === '' ? null : Number($('wiz-seed').value),
        difficulty: $('wiz-difficulty').value,
        gamemode: $('wiz-gamemode').value,
        keepInventory: $('wiz-keepinv').checked,
      };
      draft.xmx = $('wiz-xmx').value;
      await APP.api('PUT', '/api/config', { server: { world: draft.world, xmx: draft.xmx } }).catch(() => {});
    }
  }

  async function next() {
    if (step === 2) {
      await collectStep();
      // 至少一个 provider 有 key，或全空（用户硬要先玩）→ 放行，红字提示只警告
      const hasKey = draft.providers.some(p => p.key && p.key !== '****');
      if (!hasKey) {
        if (!confirm('一把钥匙都还没配，工人醒来会一直睡觉。确定先用本地大脑/稍后再配？')) return;
      }
    } else if (step === 3) {
      await collectStep();
    } else if (step === 4) {
      return finish();
    }
    if (step < 4) { step++; render(); }
  }
  function prev() { if (step > 0) { step--; render(); } }

  async function finish() {
    const remember = $('wiz-done') ? $('wiz-done').checked : true;
    await APP.api('PUT', '/api/config', remember ? { setupWizardDone: true } : {}).catch(() => {});
    // 立即启动：进加载屏
    $('wizard-overlay').style.display = 'none';
    APP.toast('正在让工人进厂，第一次生成世界约 1~2 分钟…', 'success');
    await APP.api('POST', '/api/all/start').catch(() => {});
    if (APP.onWizardDone) APP.onWizardDone();
  }

  function skip() {
    $('wizard-overlay').style.display = 'none';
    if (APP.onWizardSkip) APP.onWizardSkip();
  }

  function render() {
    renderSteps();
    STEPS[step]();
  }

  function start() {
    const cfg = APP.state.config || { providers: [], server: { world: {} } };
    draft = {
      providers: (cfg.providers || []).map(p => ({ ...p })),
      world: { ...((cfg.server || {}).world || {}) },
      xmx: (cfg.server || {}).xmx || '2G',
      serverPort: ((cfg.server || {}).portPref) || 25565,
    };
    step = 0;
    $('wizard-overlay').style.display = 'flex';
    render();
    $('wiz-next').onclick = next;
    $('wiz-prev').onclick = prev;
    $('wiz-skip').onclick = skip;
  }

  window.Wizard = { start, skip, isOpen: () => $('wizard-overlay').style.display === 'flex' };
})();
