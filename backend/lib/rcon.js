// rcon.js — center 侧 RCON 客户端（移植自 bot-lite.js 内嵌实现）
// 用法：rconExec({host,port,password,cmd,timeoutMs=5000,tries=3}) → Promise<{ok, body}>
// 协议：type=3 登录包、type=2 命令包；连接短命、每命令新建。
'use strict';
const net = require('net');

function authPkt(reqId, type, payload) {
  const p = Buffer.from(String(payload == null ? '' : payload), 'utf8');
  const b = Buffer.alloc(14 + p.length);
  b.writeInt32LE(10 + p.length, 0);
  b.writeInt32LE(reqId, 4);
  b.writeInt32LE(type, 8);
  p.copy(b, 12);
  b.writeInt16LE(0, 12 + p.length);
  return b;
}

function rconExecOnce({ host, port, password, cmd, timeoutMs }) {
  return new Promise((resolve) => {
    let s = null;
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { s && s.end(); } catch (e) {}
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, body: 'rcon-timeout' }), timeoutMs || 5000);
    s = net.connect({ host: host || '127.0.0.1', port });
    const buf = [];
    let authed = false;
    s.on('data', (d) => {
      buf.push(d);
      const all = Buffer.concat(buf);
      if (all.length < 12) return;
      const len = all.readInt32LE(0);
      if (all.length < len + 4) return;
      const id = all.readInt32LE(4), type = all.readInt32LE(8);
      buf.length = 0;
      if (!authed && type === 2) {
        authed = id !== -1;
        if (!authed) return finish({ ok: false, body: 'rcon-auth-failed' });
        s.write(authPkt(100, 2, cmd));
        return;
      }
      if (authed && type === 0) {
        // 命令回包：payload 在 offset 12
        const body = all.slice(12, 12 + len - 10).toString('utf8');
        return finish({ ok: true, body });
      }
    });
    s.on('error', () => finish({ ok: false, body: 'rcon-conn-error' }));
    s.on('close', () => finish({ ok: false, body: 'rcon-conn-closed' }));
    s.on('connect', () => { s.write(authPkt(100, 3, password || '')); });
  });
}

async function rconExec(opts) {
  const tries = Math.max(1, Number(opts.tries) || 3);
  let last = { ok: false, body: 'rcon-unknown' };
  for (let i = 0; i < tries; i++) {
    last = await rconExecOnce(opts);
    if (last.ok) return last;
    await new Promise(r => setTimeout(r, 300));
  }
  return last;
}

module.exports = { rconExec };
