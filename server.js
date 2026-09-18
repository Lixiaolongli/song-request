#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const SONGS_FILE = path.join(DATA_DIR, 'songs.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

const PORT = Number(process.env.PORT) || 3000;
const BIND = process.env.BIND || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_PENDING = Number(process.env.MAX_PENDING) || 2;
const MAX_WAITING = Number(process.env.MAX_WAITING) || 60;
const BODY_LIMIT = 16 * 1024;

let qrcode = null;
try { qrcode = require('qrcode'); } catch (_) { qrcode = null; }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let songs = [];
let queue = [];
let accepting = true;
let hostKey = '';

const clients = new Set();

function shortId(prefix) {
  return prefix + crypto.randomBytes(5).toString('hex');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`读取 ${path.basename(file)} 失败，使用默认值：`, err.message);
    return fallback;
  }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const rawSongs = readJson(SONGS_FILE, []);
  songs = (Array.isArray(rawSongs) ? rawSongs : [])
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({
      id: typeof s.id === 'string' && s.id ? s.id : shortId('s'),
      title: clean(s.title, 60),
      artist: clean(s.artist, 40),
      tag: clean(s.tag, 12),
    }));

  const saved = readJson(QUEUE_FILE, null);
  if (saved && typeof saved === 'object') {
    hostKey = typeof saved.hostKey === 'string' && saved.hostKey ? saved.hostKey : shortId('k');
    accepting = saved.accepting !== false;
    queue = Array.isArray(saved.queue) ? saved.queue.filter((r) => r && r.id && r.title) : [];
  } else {
    hostKey = shortId('k');
  }
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = JSON.stringify({ hostKey, accepting, queue }, null, 2);
    fs.writeFile(QUEUE_FILE, payload, (err) => {
      if (err) console.error('保存队列失败：', err.message);
    });
  }, 100);
}

function persistSongs() {
  const payload = JSON.stringify(songs.map(({ title, artist, tag }) => ({ title, artist, tag })), null, 2);
  fs.writeFile(SONGS_FILE, payload, (err) => {
    if (err) console.error('保存歌单失败：', err.message);
  });
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function waitingItems() {
  return queue.filter((r) => r.status === 'waiting');
}

function positionOf(id) {
  const waiting = waitingItems();
  const idx = waiting.findIndex((r) => r.id === id);
  return idx === -1 ? null : idx + 1;
}

function nowPlaying() {
  const item = queue.find((r) => r.status === 'playing');
  return item ? { id: item.id, title: item.title, artist: item.artist, nickname: item.nickname } : null;
}

function songOptions() {
  return songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, tag: s.tag }));
}

function audienceState(clientId) {
  const mine = queue
    .filter((r) => r.clientId === clientId && (r.status === 'waiting' || r.status === 'playing'))
    .map((r) => ({
      id: r.id,
      songId: r.songId,
      title: r.title,
      artist: r.artist,
      status: r.status,
      position: positionOf(r.id),
    }));
  return {
    type: 'state',
    accepting,
    nowPlaying: nowPlaying(),
    waitingCount: waitingItems().length,
    songs: songOptions(),
    mine,
  };
}

function hostState() {
  return {
    type: 'state',
    accepting,
    nowPlaying: nowPlaying(),
    songs: songOptions(),
    queue: queue.map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      nickname: r.nickname,
      message: r.message,
      status: r.status,
      createdAt: r.createdAt,
      position: positionOf(r.id),
    })),
  };
}

function writeEvent(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch (_) {
    /* 连接已断开，由 close 事件清理 */
  }
}

function broadcast() {
  for (const c of clients) {
    writeEvent(c.res, c.host ? hostState() : audienceState(c.clientId));
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function audienceUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

function findRequest(id) {
  return queue.find((r) => r.id === id) || null;
}

function firstWaitingIndex() {
  return queue.findIndex((r) => r.status === 'waiting');
}

function hostAction(action, body) {
  const id = typeof body.id === 'string' ? body.id : '';

  if (action === 'accept' || action === 'pause') {
    accepting = action === 'accept';
    return true;
  }

  if (action === 'clearDone') {
    queue = queue.filter((r) => r.status !== 'done' && r.status !== 'skipped');
    return true;
  }

  if (action === 'clearAll') {
    queue = [];
    return true;
  }

  if (action === 'addSong') {
    const title = clean(body.title, 60);
    if (!title) return false;
    songs.push({ id: shortId('s'), title, artist: clean(body.artist, 40), tag: clean(body.tag, 12) });
    persistSongs();
    return true;
  }

  if (action === 'removeSong') {
    const before = songs.length;
    songs = songs.filter((s) => s.id !== id);
    if (songs.length === before) return false;
    persistSongs();
    return true;
  }

  const item = findRequest(id);
  if (!item) return false;

  if (action === 'play') {
    queue.forEach((r) => { if (r.status === 'playing') r.status = 'waiting'; });
    item.status = 'playing';
    const idx = queue.indexOf(item);
    queue.splice(idx, 1);
    queue.unshift(item);
    return true;
  }
  if (action === 'done') { item.status = 'done'; return true; }
  if (action === 'skip') { item.status = 'skipped'; return true; }
  if (action === 'requeue') { item.status = 'waiting'; return true; }
  if (action === 'remove') {
    queue = queue.filter((r) => r.id !== id);
    return true;
  }
  if (action === 'top') {
    if (item.status !== 'waiting') return false;
    queue = queue.filter((r) => r.id !== id);
    const at = firstWaitingIndex();
    queue.splice(at === -1 ? queue.length : at, 0, item);
    return true;
  }
  return false;
}

function streamFile(res, target) {
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/host') rel = '/host.html';
  // 打赏收款码放 data/ 下：不进版本库，重新部署也不会被覆盖；
  // 没放图片时这里 404，观众端的打赏卡片会自动隐藏
  if (rel === '/tip.png') {
    streamFile(res, path.join(DATA_DIR, 'tip.png'));
    return;
  }
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  streamFile(res, target);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname === '/api/events' && method === 'GET') {
    const key = url.searchParams.get('host') || '';
    const isHost = key !== '' && key === hostKey;
    if (key !== '' && !isHost) {
      json(res, 403, { error: '主持人密钥不正确' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n');

    const client = { res, host: isHost, clientId: clean(url.searchParams.get('clientId'), 64) };
    clients.add(client);
    writeEvent(res, isHost ? hostState() : audienceState(client.clientId));
    req.on('close', () => clients.delete(client));
    return;
  }

  if (pathname === '/api/state' && method === 'GET') {
    json(res, 200, audienceState(clean(url.searchParams.get('clientId'), 64)));
    return;
  }

  if (pathname === '/api/request' && method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (_) {
      json(res, 400, { error: '请求格式不正确' });
      return;
    }
    if (!accepting) {
      json(res, 409, { error: '现在暂停点歌啦，等主持人开放后再点' });
      return;
    }
    const clientId = clean(body.clientId, 64);
    if (!clientId) {
      json(res, 400, { error: '缺少客户端标识，请刷新页面重试' });
      return;
    }
    const song = songs.find((s) => s.id === body.songId);
    if (!song) {
      json(res, 404, { error: '这首歌不在今天的歌单里' });
      return;
    }
    const mine = queue.filter(
      (r) => r.clientId === clientId && (r.status === 'waiting' || r.status === 'playing')
    );
    if (mine.some((r) => r.songId === song.id)) {
      json(res, 409, { error: `《${song.title}》你已经点过了` });
      return;
    }
    if (mine.length >= MAX_PENDING) {
      json(res, 429, { error: `每人最多同时排 ${MAX_PENDING} 首，等唱完再点吧` });
      return;
    }
    if (waitingItems().length >= MAX_WAITING) {
      json(res, 429, { error: '队列已经排满了，稍后再试' });
      return;
    }

    const nickname = clean(body.nickname, 20) || '匿名朋友';
    const message = clean(body.message, 60);
    const item = {
      id: shortId('r'),
      songId: song.id,
      title: song.title,
      artist: song.artist,
      nickname,
      message,
      status: 'waiting',
      clientId,
      createdAt: Date.now(),
    };
    queue.push(item);
    persist();
    broadcast();
    json(res, 200, { ok: true, id: item.id, position: positionOf(item.id) });
    return;
  }

  if (pathname === '/api/qr' && method === 'GET') {
    const target = url.searchParams.get('to') === 'host'
      ? `${audienceUrl(req)}/host?host=${hostKey}`
      : audienceUrl(req);
    if (!qrcode) {
      json(res, 200, { url: target, dataUrl: null, error: '未安装 qrcode，无法生成二维码图片' });
      return;
    }
    try {
      const dataUrl = await qrcode.toDataURL(target, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 520,
        color: { dark: '#111111', light: '#ffffff' },
      });
      json(res, 200, { url: target, dataUrl });
    } catch (err) {
      json(res, 500, { url: target, dataUrl: null, error: err.message });
    }
    return;
  }

  if (pathname === '/api/host' && method === 'POST') {
    const key = url.searchParams.get('key') || clean((req.headers['x-host-key'] || ''), 64);
    if (key !== hostKey) {
      json(res, 403, { error: '主持人密钥不正确' });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (_) {
      json(res, 400, { error: '请求格式不正确' });
      return;
    }
    const action = typeof body.action === 'string' ? body.action : '';
    if (!hostAction(action, body)) {
      json(res, 400, { error: `操作失败：${action || '未知操作'}` });
      return;
    }
    persist();
    broadcast();
    json(res, 200, { ok: true });
    return;
  }

  if (pathname.startsWith('/api/')) {
    json(res, 404, { error: 'no such endpoint' });
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }
  serveStatic(req, res, pathname);
});

const heartbeat = setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }
}, 25000);
heartbeat.unref();

function shutdown(signal) {
  console.log(`\n${signal} 收到，正在保存状态…`);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify({ hostKey, accepting, queue }, null, 2));
  } catch (err) {
    console.error('退出前保存失败：', err.message);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

load();
persist();

server.listen(PORT, BIND, () => {
  const ips = lanAddresses();
  const lines = [];
  lines.push('');
  lines.push('  🎤 扫码点歌已启动');
  lines.push('');
  if (PUBLIC_URL) {
    lines.push(`  观众点歌  ${PUBLIC_URL}`);
  } else {
    lines.push('  观众点歌（手机需与本机同一 WiFi）');
    if (ips.length === 0) lines.push('    http://localhost:' + PORT);
    for (const ip of ips) lines.push(`    http://${ip}:${PORT}`);
  }
  const hostBase = PUBLIC_URL || (ips[0] ? `http://${ips[0]}:${PORT}` : `http://localhost:${PORT}`);
  lines.push('');
  lines.push(`  主持人控制台  ${hostBase}/host?host=${hostKey}`);
  lines.push(`  主持人密钥    ${hostKey}`);
  lines.push('');
  lines.push(`  歌单 ${songs.length} 首 · 队列 ${queue.length} 条 · 点歌${accepting ? '开放中' : '已暂停'}`);
  if (!qrcode) lines.push('  提示：未安装 qrcode 模块，控制台二维码不可用，可执行 npm install');
  lines.push('');
  console.log(lines.join('\n'));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换个端口启动：PORT=3001 node server.js`);
  } else {
    console.error('服务启动失败：', err.message);
  }
  process.exit(1);
});
