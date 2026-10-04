const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

let win;
let bridge;
let buffer = '';
let seq = 0;
const pending = new Map();

const REQUEST_TIMEOUTS = {
  login: 300_000,
  login_qr: 300_000,
  login_token: 120_000,
  session: 120_000,
  chats: 30_000,
  history: 30_000,
  send_text: 30_000,
  profile: 20_000,
  mark_read: 20_000,
  diag: 20_000,
  friends: 30_000,
  chat_info: 20_000,
  logout: 15_000,
  message_media: 60_000,
  albums: 30_000,
  album_photos: 45_000,
  album_media: 90_000,
  send_file: 120_000,
  send_sticker: 30_000,
};

function nodeExecutable() {
  // npm_node_execpath is the real Node binary when launched via `npm start`.
  // When Electron is launched directly, `ELECTRON_RUN_AS_NODE=1` makes the
  // Electron binary execute a normal Node entry point.
  return process.env.npm_node_execpath || process.env.NODE || process.execPath;
}

function rejectPending(message) {
  for (const [id, item] of pending) {
    clearTimeout(item.timer);
    pending.delete(id);
    item.reject(new Error(message));
  }
}

function resolveMessage(msg) {
  if (msg?.requestId && pending.has(msg.requestId)) {
    const item = pending.get(msg.requestId);
    pending.delete(msg.requestId);
    clearTimeout(item.timer);
    if (msg.type === 'error') {
      const method = msg.method || item.method || 'unknown';
      const detail = msg.code ? ` [${msg.code}]` : '';
      console.error(`[line bridge request error] ${method}${detail}: ${msg.message || '通信エラー'}`);
      item.reject(new Error(msg.message || `通信エラー (${method})`));
    } else item.resolve(msg);
  }
}

function handleBridgeLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (win && !win.isDestroyed()) win.webContents.send('line:event', msg);
  resolveMessage(msg);
}

function startBridge() {
  if (bridge && !bridge.killed) return;

  buffer = '';
  const executable = nodeExecutable();
  bridge = spawn(executable, [path.join(__dirname, 'bridge/linejs_bridge.mjs')], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  bridge.on('error', (error) => {
    console.error('[line bridge spawn error]', error);
    rejectPending(`通信プロセスを起動できません: ${error.message}`);
    if (win && !win.isDestroyed()) win.webContents.send('line:event', {
      type: 'bridge:error',
      message: error.message,
    });
  });

  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) handleBridgeLine(line);
    }
  });

  bridge.stderr.setEncoding('utf8');
  bridge.stderr.on('data', (data) => console.error('[line bridge]', data.trimEnd()));

  bridge.on('exit', (code, signal) => {
    bridge = null;
    rejectPending(`通信プロセスが終了しました (${code ?? 'unknown'}${signal ? `, ${signal}` : ''})`);
    if (win && !win.isDestroyed()) win.webContents.send('line:event', {
      type: 'bridge:exit',
      code,
      signal,
    });
  });
}

ipcMain.handle('line:pick-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'LINEに送るファイルを選択',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  const metadata = await fs.stat(filePath).catch(() => null);
  return { canceled: false, filePath, fileName: path.basename(filePath), size: metadata?.size ?? 0 };
});

ipcMain.handle('line:request', (_, req) => new Promise((resolve, reject) => {
  const supported = new Set(['login', 'login_qr', 'login_token', 'session', 'chats', 'friends', 'history', 'chat_info', 'message_media', 'albums', 'album_photos', 'album_media', 'send_text', 'send_file', 'send_sticker', 'profile', 'mark_read', 'diag', 'logout']);
  if (!supported.has(req?.method)) return reject(new Error(`Unsupported request: ${req?.method}`));

  try { startBridge(); } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  const requestId = `gui-${++seq}`;
  const timeoutMs = REQUEST_TIMEOUTS[req.method] ?? 30_000;
  const timer = setTimeout(() => {
    const item = pending.get(requestId);
    if (!item) return;
    pending.delete(requestId);
    item.reject(new Error(`応答がタイムアウトしました (${req.method}, ${timeoutMs / 1000}s)`));
  }, timeoutMs);

  pending.set(requestId, { resolve, reject, timer, method: req.method });
  const payload = { ...req, requestId };

  try {
    bridge.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    clearTimeout(timer);
    pending.delete(requestId);
    reject(error instanceof Error ? error : new Error(String(error)));
  }
}));

function create() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#101116',
    title: 'LINE Native',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'gui/index.html'));
}

app.whenReady().then(() => { startBridge(); create(); });
app.on('before-quit', () => { if (bridge) bridge.kill(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
