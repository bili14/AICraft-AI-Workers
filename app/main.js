// main.js — AICraft Electron 主进程
// 职责：单实例锁 → 拉起/复用 center.js 后端 → 打开主窗（渲染层加载屏接管冷启动）→ IPC 桥接 → 优雅退出
'use strict';
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ---------- 自适应找项目根：含 backend/center.js 且含 config.json 的目录 ----------
let ROOT = __dirname;
for (let i = 0; i < 7; i++) {
  if (fs.existsSync(path.join(ROOT, 'backend', 'center.js')) && fs.existsSync(path.join(ROOT, 'config.json'))) break;
  ROOT = path.join(ROOT, '..');
}
ROOT = path.resolve(ROOT);
const BACKEND = path.join(ROOT, 'backend', 'center.js');
const NODE_BIN = path.join(ROOT, 'runtime', 'node', 'node.exe');
const LOGS_DIR = path.join(ROOT, 'logs');
const PORT_FILE = path.join(LOGS_DIR, 'center.port.json');
const DEFAULT_PORT = 3100;

const isDev = process.env.AICRAFT_DEV === '1';

let centerPort = DEFAULT_PORT;   // 实际生效的 center 端口（可能被 center 顺延写回）
let centerProc = null;           // 本实例 spawn 的 center 子进程（复用别人的则为 null）
let ownCenter = false;           // 当前 center 是否由本实例拉起（决定退出时要不要替它收尾）
let mainWindow = null;
let shuttingDown = false;        // 已进入优雅退出流程（期间 center exit 不再弹终态屏）
let shutdownTimer = null;

// ---------- 工具 ----------
function readPortFile() {
  try {
    const j = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
    return Number(j.port) || null;
  } catch (e) { return null; }
}

// 探测某端口上是不是“我们自己的 center”：GET /api/hall 必须是合法 JSON 且含 bootTime
// （只判 TCP/HTTP 有响应会误判别的 dev server，§3.1.3）
function probeHall(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/hall', method: 'GET', timeout: 1500 },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { const j = JSON.parse(d); resolve(j && j.bootTime ? j : null); }
          catch (e) { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}

// ---------- 拉起 / 复用 center ----------
async function startCenter() {
  // 1) 先看是不是已有 AICraft 在跑（读上次端口文件，无则 3100 起）
  const known = readPortFile() || DEFAULT_PORT;
  const existing = await probeHall(known);
  if (existing) {
    centerPort = known;
    ownCenter = false;
    console.log('[main] 检测到已有 AICraft center（bootTime 校验通过），复用，端口', centerPort);
    return;
  }
  // 2) 自己拉起：把选定端口经环境变量传给 center（占用时 center 会自己顺延并写回 port 文件）
  const nodeBin = fs.existsSync(NODE_BIN) ? NODE_BIN : (process.env.NODE || 'node');
  centerProc = spawn(nodeBin, [BACKEND], {
    cwd: path.dirname(BACKEND),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, AICRAFT_CENTER_PORT: String(known) },
  });
  ownCenter = true;
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (e) {}
  const outStream = fs.createWriteStream(path.join(LOGS_DIR, 'center.out.log'), { flags: 'a' });
  const errStream = fs.createWriteStream(path.join(LOGS_DIR, 'center.err.log'), { flags: 'a' });
  centerProc.stdout.on('data', d => { const s = d.toString(); console.log('[center]', s.trim()); outStream.write(s); });
  centerProc.stderr.on('data', d => { const s = d.toString(); console.error('[center-err]', s.trim()); errStream.write(s); });
  centerProc.on('exit', (code) => {
    centerProc = null;
    console.log('[main] center 退出 code=', code);
    if (shuttingDown) return; // 优雅退出流程中，不弹终态屏
    showDeadScreen(code);
  });
  // 3) spawn 后确认实际端口：优先读 port 文件（center 可能顺延），8s 内轮询
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await new Promise(r => setTimeout(r, 200));
    if (!centerProc) break; // 秒崩了，等 exit 回调走终态屏
    const p = readPortFile();
    if (p) { centerPort = p; break; }
    if (await probeHall(known)) { centerPort = known; break; }
  }
  console.log('[main] center 已拉起，端口', centerPort, 'PID', centerProc && centerProc.pid);
}

// ---------- center 进程终态屏（红色“指挥中心摔了”） ----------
function showDeadScreen(code) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = {
    code,
    errLog: path.join(LOGS_DIR, 'center.err.log'),
    outLog: path.join(LOGS_DIR, 'center.out.log'),
    logsDir: LOGS_DIR,
  };
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'dead.html'))
    .then(() => mainWindow.webContents.send('aicraft-dead', payload))
    .catch((e) => console.error('[main] dead page load failed', e));
}

// ---------- 后端 HTTP 代理（渲染进程 → center API） ----------
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: centerPort, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('响应解析失败: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('后端超时')));
    if (data) req.write(data);
    req.end();
  });
}

function postShutdown() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: centerPort, path: '/api/shutdown', method: 'POST', timeout: 5000 },
      (res) => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(false); });
    req.end();
  });
}

// ---------- 优雅退出：关窗先存盘，30s 上限 ----------
async function beginGracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // 通知渲染层弹“正在保存世界”小条
  try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('aicraft-shutdown-starting'); } catch (e) {}
  // 只替本实例拉起的 center 收尾；复用别人实例的不替它关
  if (ownCenter && centerProc) {
    await postShutdown();                 // 通知 center：停 bot → save-all → stop → 清理
    const t0 = Date.now();                // 30s 上限等它自己退
    while (centerProc && Date.now() - t0 < 30000) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (centerProc) { try { centerProc.kill(); } catch (e) {} centerProc = null; }
  // 收尾完成，真的关窗退出
  try { mainWindow && !mainWindow.isDestroyed() && mainWindow.destroy(); } catch (e) {}
  app.exit(0);
}

function forceQuitNow() {
  if (centerProc) { try { centerProc.kill(); } catch (e) {} centerProc = null; }
  try { mainWindow && !mainWindow.isDestroyed() && mainWindow.destroy(); } catch (e) {}
  app.exit(0);
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1200, minHeight: 700,
    backgroundColor: '#14141f',
    title: 'AICraft',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 渲染层 window.open（3D/思考窗）：显式放行并开成独立小窗
  // 不能设 parent：Windows 上同一个父窗底下的多个子窗会互相抢 z-order，
  // 表现就是"点 A 不置顶、点 B 反而把 A 顶上来"。改成独立窗口后，点哪个哪个到最前。
  const childWins = [];
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^http:\/\/127\.0\.0\.1:\d+(\/|$|\?|#)/.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960, height: 680, minWidth: 640, minHeight: 480,
          autoHideMenuBar: true, backgroundColor: '#14141f',
        },
      };
    }
    return { action: 'deny' };
  });
  // 记着这些独立小窗，主窗关掉时一并收掉，别留下孤儿窗口
  mainWindow.webContents.on('did-create-window', (child) => {
    childWins.push(child);
    child.on('closed', () => {
      const i = childWins.indexOf(child);
      if (i >= 0) childWins.splice(i, 1);
    });
  });
  // 主窗首屏即渲染挖掘加载屏（splash 合一，不开第二窗）
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 点 × 不立刻关：先进优雅退出等待态，渲染层弹存盘小条
  mainWindow.on('close', (e) => {
    if (!shuttingDown) { e.preventDefault(); beginGracefulShutdown(); }
  });
  mainWindow.on('closed', () => {
    childWins.forEach(w => { try { if (!w.isDestroyed()) w.destroy(); } catch (e) {} });
    childWins.length = 0;
    mainWindow = null;
  });
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ---------- 单实例锁 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二实例：不弹窗、不闪，直接退出（OS 会把焦点交给已有实例）
  app.quit();
} else {
  app.on('second-instance', () => {
    // 主实例：把已有窗口顶到最前
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ---------- IPC ----------
  ipcMain.handle('api', async (e, method, p, body) => {
    try { return await api(method, p, body); }
    catch (err) { return { ok: false, msg: '后端未响应：' + err.message }; }
  });
  ipcMain.handle('open-path', async (e, p) => { try { return await shell.openPath(p); } catch (err) { return String(err); } });
  ipcMain.handle('show-item', async (e, p) => { try { shell.showItemInFolder(p); return true; } catch (err) { return false; } });
  ipcMain.handle('open-external', async (e, url) => { try { return await shell.openExternal(url); } catch (err) { return false; } });
  ipcMain.handle('copy-text', async (e, t) => { try { clipboard.writeText(String(t || '')); return true; } catch (err) { return false; } });
  // 读文本文件（终态屏复制日志正文用；只读 logs 下的已知文件）
  ipcMain.handle('read-tail', async (e, filePath, maxLines) => {
    try {
      const txt = fs.readFileSync(filePath, 'utf8');
      const lines = txt.split(/\r?\n/);
      return lines.slice(-(Number(maxLines) || 200)).join('\n');
    } catch (err) { return ''; }
  });
  ipcMain.on('force-quit', () => forceQuitNow());

  // ---------- 启动 ----------
  app.whenReady().then(() => {
    createWindow();                 // 先开窗，加载屏接管等待，不在这里死等后端
    startCenter();                  // 后台拉起/复用 center
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { if (shutdownTimer) clearTimeout(shutdownTimer); });
}
