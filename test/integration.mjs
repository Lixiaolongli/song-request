// 集成测试：起一个真实服务，用多路并发 SSE 客户端验证点歌全流程。
// 跑在独立的临时数据目录里，不会碰 data/ 下的真实歌单和队列，
// 也可以和正在运行的服务同时跑。
//
//   npm test
//   PORT=4321 npm test

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
const QUEUE_FILE = path.join(TMP, 'queue.json');
const SONGS_FILE = path.join(TMP, 'songs.json');
fs.copyFileSync(path.join(DIR, 'data', 'songs.json'), SONGS_FILE);

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

function startServer() {
  const p = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', DATA_DIR: TMP },
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { out += d.toString(); });
  return { proc: p, getOut: () => out };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(getOut, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (getOut().includes('扫码点歌已启动')) return true;
    await sleep(100);
  }
  throw new Error('服务没起来:\n' + getOut());
}

function sse(url) {
  const c = { events: [], status: 0, ctrl: new AbortController() };
  (async () => {
    try {
      const res = await fetch(url, { signal: c.ctrl.signal, headers: { Accept: 'text/event-stream' } });
      c.status = res.status;
      if (!res.ok) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) { try { c.events.push(JSON.parse(line.slice(6))); } catch (_) { /* 心跳等非数据帧 */ } }
        }
      }
    } catch (_) { /* abort */ }
  })();
  c.latest = () => c.events[c.events.length - 1] || null;
  c.close = () => c.ctrl.abort();
  return c;
}

// 服务端是先广播再回 HTTP 响应，所以快照必须在触发动作之前打，
// 否则帧可能在 waitEvent 开始前就已到达，导致漏判。
const snap = (c) => c.events.length;

async function waitEvent(client, from, pred, ms = 4000) {
  const start = Date.now();
  const hit = (e) => { try { return !!pred(e); } catch (_) { return false; } };
  while (Date.now() - start < ms) {
    if (client.events.slice(from).some(hit)) return true;
    await sleep(40);
  }
  return false;
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const waiting = (q) => (q || []).filter((x) => x.status === 'waiting');

const { proc, getOut } = startServer();
await waitReady(getOut);
const hostKey = getOut().match(/主持人密钥\s+(\S+)/)[1];
console.log(`临时数据目录 ${TMP}\n主持人密钥 ${hostKey}\n`);
const hpost = (body, k = hostKey) => post(`${BASE}/api/host?key=${k}`, body);
const req = (body) => post(`${BASE}/api/request`, body);

let second = null;
try {
  // ── 1. 静态页与安全基线 ──
  console.log('[1] 页面与安全基线');
  for (const [p, marker] of [['/', '现场点歌'], ['/host', '主持人控制台'], ['/style.css', '--accent'], ['/app.js', 'EventSource'], ['/host.js', 'EventSource']]) {
    const r = await fetch(BASE + p);
    const t = await r.text();
    ok(`GET ${p}`, r.status === 200 && t.includes(marker), `status=${r.status}`);
  }
  const trav = await fetch(BASE + '/../server.js');
  ok('路径穿越被拦截', trav.status === 404 || !(await trav.text()).includes('http.createServer'));

  const unsafe = /innerHTML|outerHTML|insertAdjacentHTML|document\.write/;
  const offenders = ['app.js', 'host.js'].filter((f) => unsafe.test(fs.readFileSync(path.join(DIR, 'public', f), 'utf8')));
  ok('前端未用 innerHTML 等不安全写入（防存储型 XSS）', offenders.length === 0, offenders.join(', '));

  const tipMissing = await fetch(BASE + '/tip.png');
  ok('未放收款码时 /tip.png 404（观众端卡片自动隐藏）', tipMissing.status === 404, `status=${tipMissing.status}`);
  fs.writeFileSync(path.join(TMP, 'tip.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const tipNow = await fetch(BASE + '/tip.png');
  ok('放收款码后 /tip.png 返回 image/png', tipNow.status === 200 && tipNow.headers.get('content-type') === 'image/png',
    `status=${tipNow.status} type=${tipNow.headers.get('content-type')}`);

  // ── 2. 连接与初始状态 ──
  console.log('\n[2] 连接与初始状态');
  const A = sse(`${BASE}/api/events?clientId=cidAAA`);
  const B = sse(`${BASE}/api/events?clientId=cidBBB`);
  const H = sse(`${BASE}/api/events?host=${hostKey}`);
  const badHost = sse(`${BASE}/api/events?host=wrongkey`);
  await sleep(600);
  const songTotal = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8')).length;
  ok(`观众 A 收到 ${songTotal} 首歌单`, A.latest()?.songs?.length === songTotal, `got ${A.latest()?.songs?.length}`);
  ok('观众初始 mine 为空', A.latest()?.mine?.length === 0);
  ok('初始队列为空', H.latest()?.queue?.length === 0);
  ok('错误密钥的主持人连接被拒(403)', badHost.status === 403, `status=${badHost.status}`);

  const songs0 = A.latest().songs;
  const songTitle = songs0[0].title;

  // ── 3. 点歌与实时广播 ──
  console.log('\n[3] 点歌 + 三方实时同步');
  let mA = snap(A), mB = snap(B), mH = snap(H);
  const r1 = await req({ songId: songs0[0].id, nickname: '小明', message: '送给我妈', clientId: 'cidAAA' });
  ok('A 点歌成功且排第 1', r1.status === 200 && r1.data.position === 1, JSON.stringify(r1.data));
  ok('A 的 mine 实时更新', await waitEvent(A, mA, (e) => e.mine?.length === 1 && e.mine[0].position === 1));
  ok('主持人队列实时收到（含昵称留言）', await waitEvent(H, mH, (e) => e.queue?.length === 1 && e.queue[0].nickname === '小明' && e.queue[0].message === '送给我妈'));
  ok('B 看到排队数变为 1', await waitEvent(B, mB, (e) => e.waitingCount === 1));
  ok('B 的 mine 仍为空（不串号）', B.latest().mine.length === 0);

  mH = snap(H);
  const r2 = await req({ songId: songs0[1].id, clientId: 'cidBBB' });
  ok('B 点歌排第 2', r2.status === 200 && r2.data.position === 2, JSON.stringify(r2.data));
  ok('未填昵称回落为「匿名朋友」', await waitEvent(H, mH, (e) => e.queue?.some((q) => q.nickname === '匿名朋友')));

  // ── 4. 非法输入 ──
  console.log('\n[4] 异常输入防护');
  ok('同一人重复点同一首被拒(409)', (await req({ songId: songs0[0].id, clientId: 'cidAAA' })).status === 409);

  await req({ songId: songs0[2].id, clientId: 'cidCCC' });
  await req({ songId: songs0[3].id, clientId: 'cidCCC' });
  const over = await req({ songId: songs0[4].id, clientId: 'cidCCC' });
  ok('超过每人 2 首上限被拒(429)', over.status === 429, JSON.stringify(over.data));

  ok('不存在的歌曲 id 被拒(404)', (await req({ songId: 'nope', clientId: 'cidDDD' })).status === 404);
  ok('缺 clientId 被拒(400)', (await req({ songId: songs0[0].id })).status === 400);
  ok('空 body 被拒', (await req({})).status >= 400);

  mH = snap(H);
  const xss = await req({ songId: songs0[5].id, clientId: 'cidEEE', nickname: '<img src=x onerror=alert(1)>', message: 'a'.repeat(500) });
  ok('注入 HTML 的昵称截到 20 字、留言截到 60 字', xss.status === 200 && await waitEvent(H, mH, (e) => {
    const it = e.queue?.find((q) => typeof q.nickname === 'string' && q.nickname.startsWith('<img'));
    return it && it.nickname.length === 20 && it.message.length === 60;
  }));

  // ── 5. 主持人操作 ──
  console.log('\n[5] 主持人操作');
  ok('无密钥操作被拒(403)', (await hpost({ action: 'clearAll' }, 'bad')).status === 403);
  await sleep(300);

  const q0 = H.latest().queue;
  const firstId = q0[0].id;
  const secondId = q0[1].id;
  ok('此时至少有 2 首待唱', waiting(q0).length >= 2, `got ${waiting(q0).length}`);

  mH = snap(H);
  await hpost({ action: 'top', id: secondId });
  ok('置顶生效', await waitEvent(H, mH, (e) => waiting(e.queue)[0]?.id === secondId));

  mH = snap(H); mA = snap(A);
  await hpost({ action: 'play', id: firstId });
  ok('标记正在唱', await waitEvent(H, mH, (e) => e.nowPlaying?.id === firstId));
  ok('观众端同步到正在唱的歌名', await waitEvent(A, mA, (e) => e.nowPlaying?.title === songTitle));
  ok('A 看到自己那首变成 playing', await waitEvent(A, mA, (e) => e.mine?.some((m) => m.status === 'playing')));
  await sleep(250);
  ok('正在唱的那首不计入排队数', A.latest().waitingCount === waiting(H.latest().queue).length,
    `${A.latest().waitingCount} vs ${waiting(H.latest().queue).length}`);

  const play2 = H.latest().queue.find((x) => x.status === 'waiting');
  mH = snap(H);
  await hpost({ action: 'play', id: play2.id });
  ok('同时只有一首处于 playing', await waitEvent(H, mH, (e) => e.queue?.filter((x) => x.status === 'playing').length === 1));
  ok('上一首自动退回待唱', await waitEvent(H, mH, (e) => waiting(e.queue).some((x) => x.id === firstId)));

  mH = snap(H); mA = snap(A);
  await hpost({ action: 'play', id: firstId });
  await hpost({ action: 'done', id: firstId });
  ok('标记唱完', await waitEvent(H, mH, (e) => e.queue?.find((x) => x.id === firstId)?.status === 'done'));
  ok('唱完后从观众的「我点的歌」消失', await waitEvent(A, mA, (e) => Array.isArray(e.mine) && !e.mine.some((m) => m.id === firstId)));

  const skipTarget = H.latest().queue.find((x) => x.status === 'waiting');
  mH = snap(H);
  await hpost({ action: 'skip', id: skipTarget.id });
  ok('跳过生效', await waitEvent(H, mH, (e) => e.queue?.find((x) => x.id === skipTarget.id)?.status === 'skipped'));
  mH = snap(H);
  await hpost({ action: 'requeue', id: skipTarget.id });
  ok('重新入队生效', await waitEvent(H, mH, (e) => e.queue?.find((x) => x.id === skipTarget.id)?.status === 'waiting'));

  const delTarget = H.latest().queue.find((x) => x.status === 'waiting');
  const beforeDel = H.latest().queue.length;
  mH = snap(H);
  await hpost({ action: 'remove', id: delTarget.id });
  ok('删除生效', await waitEvent(H, mH, (e) => e.queue?.length === beforeDel - 1 && !e.queue.some((x) => x.id === delTarget.id)));
  ok('对不存在的 id 操作返回失败(400)', (await hpost({ action: 'done', id: 'ghost' })).status === 400);
  ok('未知 action 返回失败(400)', (await hpost({ action: 'launchMissiles' })).status === 400);

  // ── 6. 开放/暂停点歌 ──
  console.log('\n[6] 开放/暂停点歌');
  mA = snap(A);
  await hpost({ action: 'pause' });
  ok('暂停状态广播给观众', await waitEvent(A, mA, (e) => e.accepting === false));
  const blocked = await req({ songId: songs0[9].id, clientId: 'cidZZZ' });
  ok('暂停期间点歌被拒(409)', blocked.status === 409, JSON.stringify(blocked.data));
  mA = snap(A);
  await hpost({ action: 'accept' });
  ok('恢复开放', await waitEvent(A, mA, (e) => e.accepting === true));
  ok('恢复后可正常点歌', (await req({ songId: songs0[9].id, clientId: 'cidZZZ' })).status === 200);

  // ── 7. 歌单管理 ──
  console.log('\n[7] 歌单管理');
  const n0 = H.latest().songs.length;
  mH = snap(H); mA = snap(A);
  await hpost({ action: 'addSong', title: '测试歌曲', artist: '测试歌手', tag: '测试' });
  ok('加歌后主持人端更新', await waitEvent(H, mH, (e) => e.songs?.length === n0 + 1));
  ok('加歌后观众端同步', await waitEvent(A, mA, (e) => e.songs?.length === n0 + 1));
  ok('空歌名被拒(400)', (await hpost({ action: 'addSong', title: '   ' })).status === 400);

  await sleep(250);
  const newId = H.latest().songs.find((s) => s.title === '测试歌曲').id;
  mH = snap(H);
  await hpost({ action: 'removeSong', id: newId });
  ok('删歌生效', await waitEvent(H, mH, (e) => e.songs?.length === n0 && !e.songs.some((s) => s.id === newId)));
  ok('删歌不影响已点的历史记录', H.latest().queue.length > 0);
  await sleep(250);
  ok('歌单变更已落盘', JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8')).length === n0);

  // ── 8. 二维码 ──
  console.log('\n[8] 二维码');
  const qrA = await (await fetch(`${BASE}/api/qr`)).json();
  ok('观众二维码生成 PNG', qrA.dataUrl?.startsWith('data:image/png;base64,'), qrA.error || '');
  ok('观众二维码指向首页', qrA.url === BASE, qrA.url);
  const qrH = await (await fetch(`${BASE}/api/qr?to=host`)).json();
  ok('控制台二维码带上密钥', qrH.url === `${BASE}/host?host=${hostKey}`, qrH.url);

  // ── 9. 持久化与重启恢复 ──
  console.log('\n[9] 持久化与重启恢复');
  const persistReq = await req({ songId: H.latest().songs[12].id, nickname: '重启验证', clientId: 'cidPERSIST' });
  ok('重启前先点一首留着', persistReq.status === 200, JSON.stringify(persistReq.data));
  await sleep(400);
  const beforeRestart = H.latest().queue.length;
  const songsBefore = H.latest().songs.length;

  proc.kill('SIGINT');
  await sleep(600);
  ok('收到 SIGINT 时写盘', fs.existsSync(QUEUE_FILE));

  second = startServer();
  await waitReady(second.getOut);
  const key2 = second.getOut().match(/主持人密钥\s+(\S+)/)[1];
  ok('主持人密钥重启后不变', key2 === hostKey, `${key2} vs ${hostKey}`);

  const H2 = sse(`${BASE}/api/events?host=${key2}`);
  const P2 = sse(`${BASE}/api/events?clientId=cidPERSIST`);
  await sleep(700);
  ok('队列重启后完整恢复', H2.latest()?.queue?.length === beforeRestart, `${H2.latest()?.queue?.length} vs ${beforeRestart}`);
  ok('歌单重启后完整恢复', H2.latest()?.songs?.length === songsBefore);
  const mine2 = P2.latest()?.mine || [];
  ok('观众重连后仍认得自己点的歌', mine2.length === 1 && mine2[0].status === 'waiting' && typeof mine2[0].position === 'number',
    JSON.stringify(mine2));

  second.proc.kill('SIGINT');
  await sleep(500);
  second = null;
  [A, B, H, H2, P2, badHost].forEach((c) => c.close());
} catch (err) {
  fail++;
  console.error('\n测试异常中断:', err);
} finally {
  for (const p of [proc, second && second.proc]) {
    if (p && p.exitCode === null) { try { p.kill('SIGKILL'); } catch (_) { /* 已退出 */ } }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n════ 通过 ${pass} · 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
