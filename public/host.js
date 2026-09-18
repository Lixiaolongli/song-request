'use strict';

(function () {
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // 与观众端同一套取色规则，保证同一个分类在两端颜色一致
  var TAG_PALETTE = [335, 265, 195, 145, 15, 290, 215, 95, 350, 38];
  var tagHueMap = {};
  function hueOf(s) {
    if (!(s in tagHueMap)) {
      tagHueMap[s] = TAG_PALETTE[Object.keys(tagHueMap).length % TAG_PALETTE.length];
    }
    return tagHueMap[s];
  }

  function tagPill(text) {
    var t = el('span', 'tag', text);
    t.style.setProperty('--h', String(hueOf(text)));
    return t;
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2400);
  }

  var key = '';
  try { key = new URLSearchParams(location.search).get('host') || localStorage.getItem('sr_hostkey') || ''; } catch (_) { key = ''; }

  var state = { accepting: true, nowPlaying: null, songs: [], queue: [] };
  var es = null;
  var gotMessage = false;
  var qrData = { audience: null, host: null };

  function saveKey(k) {
    key = k;
    try { localStorage.setItem('sr_hostkey', k); } catch (_) { /* ignore */ }
  }

  function setConn(on, text) {
    var c = $('conn');
    c.className = 'conn' + (on ? '' : ' off');
    $('connText').textContent = text || (on ? '已连接' : '连接断开');
  }

  function showGate(bad) {
    $('app').hidden = true;
    $('gate').hidden = false;
    if (es) { es.close(); es = null; }
    if (bad) {
      $('gateKey').value = '';
      toast('密钥不正确', true);
    }
    setTimeout(function () { $('gateKey').focus(); }, 50);
  }

  function showApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
  }

  function connect() {
    if (!key) { showGate(false); return; }
    if (es) es.close();
    gotMessage = false;
    es = new EventSource('/api/events?host=' + encodeURIComponent(key));
    es.onmessage = function (e) {
      gotMessage = true;
      setConn(true);
      showApp();
      try { applyState(JSON.parse(e.data)); } catch (_) { /* 忽略异常帧 */ }
    };
    es.onerror = function () {
      if (!gotMessage) {
        setConn(false, '密钥无效');
        showGate(true);
      } else {
        setConn(false, '重连中…');
      }
    };
  }

  function act(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    return fetch('/api/host?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) { toast(d.error || '操作失败', true); return false; }
        return true;
      });
    }).catch(function () {
      toast('网络异常，操作没成功', true);
      return false;
    });
  }

  function btn(label, cls, action, payload) {
    var b = el('button', 'btn-sm' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', function () {
      b.disabled = true;
      act(action, payload).then(function () { b.disabled = false; });
    });
    return b;
  }

  function timeAgo(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    return Math.floor(s / 3600) + ' 小时前';
  }

  function qrow(item, playing) {
    var row = el('div', 'qrow' + (playing ? ' playing' : '') + (item.status === 'done' || item.status === 'skipped' ? ' done' : ''));
    row.appendChild(el('div', 'pos', playing ? '♪' : (item.position ? String(item.position) : '—')));

    var info = el('div', 'info');
    info.appendChild(el('div', 't', item.title));
    var meta = item.artist || '';
    var extra = [];
    if (item.nickname) extra.push(item.nickname);
    if (item.status === 'skipped') extra.push('已跳过');
    if (item.createdAt) extra.push(timeAgo(item.createdAt));
    if (extra.length) meta += (meta ? ' · ' : '') + extra.join(' · ');
    info.appendChild(el('div', 'm', meta + (item.message ? '　「' + item.message + '」' : '')));
    row.appendChild(info);

    var acts = el('div', 'acts');
    if (playing) {
      acts.appendChild(btn('唱完了', 'ok', 'done', { id: item.id }));
      acts.appendChild(btn('放回队列', '', 'requeue', { id: item.id }));
    } else if (item.status === 'waiting') {
      acts.appendChild(btn('唱这首', 'live', 'play', { id: item.id }));
      acts.appendChild(btn('置顶', 'accent', 'top', { id: item.id }));
      acts.appendChild(btn('跳过', '', 'skip', { id: item.id }));
    } else {
      acts.appendChild(btn('重新入队', '', 'requeue', { id: item.id }));
    }
    acts.appendChild(btn('删除', '', 'remove', { id: item.id }));
    row.appendChild(acts);
    return row;
  }

  function emptyBox(box, text) {
    box.appendChild(el('div', 'empty', text));
  }

  function renderQueue() {
    var wait = state.queue.filter(function (r) { return r.status === 'waiting'; });
    var done = state.queue.filter(function (r) { return r.status === 'done' || r.status === 'skipped'; });

    var pb = $('playingBox');
    pb.textContent = '';
    if (state.nowPlaying) {
      var cur = state.queue.filter(function (r) { return r.id === state.nowPlaying.id; })[0];
      pb.appendChild(qrow(cur || state.nowPlaying, true));
    } else {
      emptyBox(pb, '现在没有正在唱的歌');
    }

    var wb = $('waitBox');
    wb.textContent = '';
    if (wait.length === 0) emptyBox(wb, '队列是空的，等观众点歌');
    else wait.forEach(function (r) { wb.appendChild(qrow(r, false)); });

    var db = $('doneBox');
    db.textContent = '';
    if (done.length === 0) emptyBox(db, '还没有唱完的歌');
    else done.forEach(function (r) { db.appendChild(qrow(r, false)); });

    $('stWait').textContent = String(wait.length);
    $('stDone').textContent = String(done.length);
    $('stSongs').textContent = String(state.songs.length);
    $('waitHint').textContent = wait.length ? wait.length + ' 首' : '';
  }

  function renderAccept() {
    var t = $('acceptToggle');
    t.className = 'toggle' + (state.accepting ? ' on' : '');
    $('acceptHint').textContent = state.accepting ? '观众现在可以扫码点歌' : '已暂停，观众端会提示稍后再点';
  }

  function renderSongs() {
    var box = $('songBox');
    box.textContent = '';
    $('songCount').textContent = state.songs.length + ' 首';
    if (state.songs.length === 0) { emptyBox(box, '歌单是空的，先在上面加几首'); return; }
    state.songs.forEach(function (s) {
      var row = el('div', 'qrow');
      var info = el('div', 'info');
      var t = el('div', 't', s.title);
      if (s.tag) t.appendChild(tagPill(s.tag));
      info.appendChild(t);
      info.appendChild(el('div', 'm', s.artist || '—'));
      row.appendChild(info);
      var acts = el('div', 'acts');
      acts.appendChild(btn('删除', '', 'removeSong', { id: s.id }));
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  function applyState(next) {
    state = next;
    renderAccept();
    renderQueue();
    renderSongs();
  }

  function loadQr() {
    ['audience', 'host'].forEach(function (kind) {
      fetch('/api/qr?to=' + kind)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          qrData[kind] = d;
          var box = $(kind === 'audience' ? 'qrImg' : 'qrImgHost');
          var urlBox = $(kind === 'audience' ? 'qrUrl' : 'qrUrlHost');
          box.textContent = '';
          if (d.dataUrl) {
            var img = document.createElement('img');
            img.src = d.dataUrl;
            img.alt = kind === 'audience' ? '观众点歌二维码' : '主持人控制台二维码';
            box.appendChild(img);
          } else {
            box.appendChild(el('div', 'empty', d.error || '二维码不可用'));
          }
          urlBox.textContent = d.url || '';
        })
        .catch(function () { /* 二维码非核心功能，失败时保留占位 */ });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, function () { toast('复制失败，请手动选中', true); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (_) { toast('复制失败，请手动选中', true); }
    document.body.removeChild(ta);
  }

  function download(kind) {
    var d = qrData[kind];
    if (!d || !d.dataUrl) { toast('二维码还没加载好', true); return; }
    var a = document.createElement('a');
    a.href = d.dataUrl;
    a.download = kind === 'audience' ? '观众点歌二维码.png' : '主持人控制台二维码.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // 交互绑定
  $('gateBtn').addEventListener('click', function () {
    var v = $('gateKey').value.trim();
    if (!v) { toast('请输入密钥', true); return; }
    saveKey(v);
    connect();
  });
  $('gateKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('gateBtn').click(); });

  $('acceptToggle').addEventListener('click', function () {
    act(state.accepting ? 'pause' : 'accept');
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      ['queue', 'songs', 'qr'].forEach(function (name) {
        $('tab-' + name).hidden = name !== tab.dataset.tab;
      });
      if (tab.dataset.tab === 'qr') loadQr();
    });
  });

  $('clearDoneBtn').addEventListener('click', function () { act('clearDone'); });
  $('clearAllBtn').addEventListener('click', function () {
    if (window.confirm('确定清空全部队列？正在唱和待唱的歌都会被删掉。')) act('clearAll');
  });

  $('addSongBtn').addEventListener('click', function () {
    var title = $('newTitle').value.trim();
    if (!title) { toast('歌名不能为空', true); return; }
    act('addSong', { title: title, artist: $('newArtist').value.trim(), tag: $('newTag').value.trim() })
      .then(function (ok) {
        if (!ok) return;
        $('newTitle').value = '';
        $('newArtist').value = '';
        $('newTag').value = '';
        toast('已加入歌单');
      });
  });

  $('copyUrlBtn').addEventListener('click', function () {
    if (qrData.audience && qrData.audience.url) copyText(qrData.audience.url);
  });
  $('dlQrBtn').addEventListener('click', function () { download('audience'); });
  var copyHostBtn = $('copyUrlHostBtn');
  if (copyHostBtn) {
    copyHostBtn.addEventListener('click', function () {
      if (qrData.host && qrData.host.url) copyText(qrData.host.url);
    });
  }
  var dlHostBtn = $('dlQrHostBtn');
  if (dlHostBtn) dlHostBtn.addEventListener('click', function () { download('host'); });

  if (key) {
    connect();
    loadQr();
  } else {
    showGate(false);
  }
})();
