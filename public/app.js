'use strict';

(function () {
  var $ = function (id) { return document.getElementById(id); };

  function clientId() {
    var key = 'sr_cid';
    var id = null;
    try { id = localStorage.getItem(key); } catch (_) { id = null; }
    if (!id) {
      id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      try { localStorage.setItem(key, id); } catch (_) { /* 隐私模式下忽略 */ }
    }
    return id;
  }

  var CID = clientId();

  function savedNick() {
    try { return localStorage.getItem('sr_nick') || ''; } catch (_) { return ''; }
  }
  function rememberNick(v) {
    try { localStorage.setItem('sr_nick', v); } catch (_) { /* ignore */ }
  }

  var state = { accepting: true, nowPlaying: null, waitingCount: 0, songs: [], mine: [] };
  var keyword = '';
  var activeTag = '全部';
  var pendingSong = null;

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function myStatus(songId) {
    var mine = state.mine || [];
    for (var i = 0; i < mine.length; i++) {
      if (mine[i].songId === songId) return mine[i];
    }
    return null;
  }

  function renderNow() {
    var np = state.nowPlaying;
    $('nowIdle').hidden = !!np;
    $('nowInfo').hidden = !np;
    if (np) {
      $('nowTitle').textContent = np.title;
      var who = np.artist ? np.artist : '';
      if (np.nickname) who += (who ? ' · ' : '') + np.nickname + ' 点唱';
      $('nowArtist').textContent = who || '';
      $('nowIdle').textContent = '';
    } else {
      $('nowIdle').textContent = state.accepting ? '还没开始，先来点一首吧' : '暂停点歌中，稍等一下';
    }
  }

  function renderStatus() {
    var badge = $('openBadge');
    badge.textContent = state.accepting ? '点歌开放中' : '暂停点歌';
    badge.className = 'badge' + (state.accepting ? '' : ' closed');
    var n = state.waitingCount;
    $('waitInfo').textContent = n > 0 ? ('前面还有 ' + n + ' 首') : '现在点，马上唱';
  }

  function renderMine() {
    var wrap = $('mineWrap');
    var box = $('mine');
    box.textContent = '';
    var items = state.mine || [];
    wrap.hidden = items.length === 0;
    items.forEach(function (m) {
      var row = el('div', 'mine-item' + (m.status === 'playing' ? ' playing' : ''));
      var rank = el('div', 'rank', m.status === 'playing' ? '♪' : (m.position ? String(m.position) : '—'));
      var info = el('div', 'info');
      info.appendChild(el('div', 'name', m.title));
      info.appendChild(el('div', 'who', (m.artist || '') + ' · ' + (m.status === 'playing' ? '正在唱这首歌' : '排队中')));
      row.appendChild(rank);
      row.appendChild(info);
      box.appendChild(row);
    });
  }

  function tags() {
    var seen = ['全部'];
    state.songs.forEach(function (s) {
      if (s.tag && seen.indexOf(s.tag) === -1) seen.push(s.tag);
    });
    return seen;
  }

  function renderChips() {
    var box = $('chips');
    box.textContent = '';
    var list = tags();
    if (list.length <= 1) { box.hidden = true; return; }
    box.hidden = false;
    list.forEach(function (t) {
      var chip = el('button', 'chip' + (t === activeTag ? ' active' : ''), t);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        activeTag = t;
        renderChips();
        renderSongs();
      });
      box.appendChild(chip);
    });
  }

  function renderSongs() {
    var box = $('songs');
    box.textContent = '';
    var kw = keyword.trim().toLowerCase();
    var shown = state.songs.filter(function (s) {
      if (activeTag !== '全部' && s.tag !== activeTag) return false;
      if (!kw) return true;
      return (s.title || '').toLowerCase().indexOf(kw) !== -1 ||
             (s.artist || '').toLowerCase().indexOf(kw) !== -1;
    });
    $('noResult').hidden = shown.length !== 0;

    shown.forEach(function (s) {
      var picked = myStatus(s.id);
      var btn = el('button', 'song' + (picked ? ' picked' : ''));
      btn.type = 'button';

      var meta = el('div', 'meta');
      meta.appendChild(el('div', 'name', s.title));
      meta.appendChild(el('div', 'who', s.artist || ''));
      btn.appendChild(meta);
      btn.appendChild(el('div', 'go', picked ? (picked.status === 'playing' ? '正在唱' : '已点') : '点歌'));

      if (picked) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () { openSheet(s); });
      }
      box.appendChild(btn);
    });
  }

  function openSheet(song) {
    if (!state.accepting) { toast('主持人暂停点歌了，等一下再点', true); return; }
    pendingSong = song;
    $('pickName').textContent = '《' + song.title + '》' + (song.artist ? ' — ' + song.artist : '');
    $('nick').value = savedNick();
    $('msg').value = '';
    $('mask').classList.add('show');
    setTimeout(function () { $('nick').focus(); }, 60);
  }

  function closeSheet() {
    pendingSong = null;
    $('mask').classList.remove('show');
  }

  function submit() {
    if (!pendingSong) return;
    var song = pendingSong;
    var nick = $('nick').value.trim();
    var msg = $('msg').value.trim();
    rememberNick(nick);
    var btn = $('sendBtn');
    btn.disabled = true;
    btn.textContent = '提交中…';

    fetch('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: song.id, nickname: nick, message: msg, clientId: CID })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, data: d }; });
    }).then(function (res) {
      if (!res.ok) {
        toast(res.data.error || '点歌失败，请重试', true);
        return;
      }
      closeSheet();
      toast('点歌成功，排在第 ' + res.data.position + ' 位 🎉');
    }).catch(function () {
      toast('网络不太稳，再点一次试试', true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '确认点歌';
    });
  }

  function applyState(next) {
    state = next;
    renderNow();
    renderStatus();
    renderMine();
    renderChips();
    renderSongs();
  }

  function setConn(on) {
    var c = $('conn');
    c.className = 'conn' + (on ? '' : ' off');
    $('connText').textContent = on ? '已连接' : '重连中…';
  }

  var es = new EventSource('/api/events?clientId=' + encodeURIComponent(CID));
  es.onmessage = function (e) {
    setConn(true);
    try { applyState(JSON.parse(e.data)); } catch (_) { /* 忽略异常帧 */ }
  };
  es.onerror = function () { setConn(false); };

  $('q').addEventListener('input', function (e) {
    keyword = e.target.value;
    renderSongs();
  });
  $('cancelBtn').addEventListener('click', closeSheet);
  $('sendBtn').addEventListener('click', submit);
  $('mask').addEventListener('click', function (e) { if (e.target === $('mask')) closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
})();
