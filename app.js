/**
 * ひとふで鉄旅 — フロントエンド本体
 */
(() => {
  'use strict';
  const C = window.APP_CONFIG || {};
  const ST = window.RAIL_STATIONS, SEGS = window.RAIL_SEGMENTS, REG = window.RAIL_REGIONS;
  const R = window.Rail;
  const COLORS = { none: '#9AA3A8', ridden: '#11804A', challenge: '#D98A1C', done: '#B8322A' };
  const STATUS_LABEL = { none: '未乗車', ridden: '完乗', challenge: '一筆書き挑戦中', done: '一筆書き走破済み' };
  const MOODS = ['雪景色', '駅弁・グルメ巡り', '海沿いの絶景', '山あいの秘境', '温泉でのんびり', '新幹線でスピード旅', '歴史と城下町', '桜・紅葉', 'ローカル線の旅情', '鉄橋とトンネル'];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtKm = n => Number(n || 0).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const stName = id => (ST[id] ? ST[id][0] : '不明な駅');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} }
  };

  const S = {
    token: store.get('htf_token'), user: null,
    rides: { seg: new Set(), sta: new Set() },
    routes: [], blocks: new Set(), memoryCount: 0,
    doneSegs: new Set(), challengeSegs: new Set(),
    quick: false, builder: null, shownRoute: null, aiDraft: null,
    map: null, L: {}, started: false, tempPw: '', moods: new Set(),
    tl: { items: [], offset: 0, hasMore: false, scope: 'public', stationId: '', loaded: false }
  };

  /* =========================================================
   * API
   * ======================================================= */
  let busyCount = 0;
  function loading(on) { busyCount = Math.max(0, busyCount + (on ? 1 : -1)); document.body.classList.toggle('is-busy', busyCount > 0); }

  async function api(action, data = {}, { silent = false } = {}) {
    if (!C.GAS_URL || C.GAS_URL.includes('XXXX')) throw new Error('config.js の GAS_URL を設定してください');
    if (!silent) loading(true);
    try {
      let res;
      try {
        res = await fetch(C.GAS_URL, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ action, token: S.token }, data))
        });
      } catch (_) { throw new Error('通信できませんでした。電波の状態を確認して、もう一度お試しください'); }
      let j;
      try { j = await res.json(); } catch (_) { throw new Error('サーバーの応答を読み取れませんでした。GASのデプロイ設定を確認してください'); }
      if (!j.ok) {
        if (j.code === 'AUTH') forceLogout(j.error);
        else if (j.code === 'MUST_CHANGE') showAuth('change');
        const e = new Error(j.error || '処理に失敗しました'); e.code = j.code; throw e;
      }
      return j.data;
    } finally { if (!silent) loading(false); }
  }
  window.API = { call: api };

  /* =========================================================
   * 共通UI
   * ======================================================= */
  function toast(msg, kind = 'info') {
    const d = document.createElement('div');
    d.className = 'toast ' + kind; d.textContent = msg;
    $('#toast').appendChild(d);
    setTimeout(() => d.classList.add('out'), 3400);
    setTimeout(() => d.remove(), 3900);
  }
  function stamp(text) {
    const s = $('#stamp');
    s.querySelector('.stamp-text').textContent = text;
    s.classList.remove('show'); void s.offsetWidth; s.classList.add('show');
    clearTimeout(stamp._t); stamp._t = setTimeout(() => s.classList.remove('show'), 1700);
  }
  function openModal(html, opt = {}) {
    const box = $('#modalBox');
    box.className = 'sheet' + (opt.wide ? ' wide' : '');
    box.innerHTML = '<button type="button" class="sheet-close" aria-label="閉じる">×</button><div class="sheet-body"></div>';
    const body = box.querySelector('.sheet-body');
    body.innerHTML = html; // 開くたびに新しい要素にして、イベントの二重登録を防ぐ
    $('#modal').hidden = false;
    box.querySelector('.sheet-close').onclick = closeModal;
    box.scrollTop = 0;
    return body;
  }
  function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; window.Tts.stop(); stopMic(); }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  function showView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.tabbar button').forEach(b => b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false'));
    if (name === 'map') setTimeout(() => S.map && S.map.invalidateSize(), 60);
    if (name === 'memories' && !S.tl.loaded) loadTimeline(true).catch(e => toast(e.message, 'warn'));
    window.scrollTo(0, 0);
  }
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

  // パスワード表示切替
  document.addEventListener('click', e => {
    const eye = e.target.closest('.eye');
    if (eye) {
      const inp = eye.parentElement.querySelector('input');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      eye.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      eye.textContent = show ? '🙈' : '👁';
    }
  });

  // 音声入力
  let activeMic = null;
  function stopMic() { if (activeMic) activeMic.vi.stop(); }
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-mic]');
    if (!btn) return;
    e.preventDefault();
    const target = $(btn.dataset.mic, btn.closest('.sheet, .view, form') || document) || $(btn.dataset.mic);
    if (activeMic && activeMic.btn === btn) { activeMic.vi.stop(); return; }
    stopMic();
    if (!window.VoiceInput.supported()) { toast('このブラウザは音声入力に対応していません（Chrome または Safari をお使いください）', 'warn'); return; }
    const base = target.value.trim() ? target.value.replace(/\s+$/, '') + '\n' : '';
    const vi = new window.VoiceInput({
      onText: (fin, interim) => { target.value = base + fin + interim; },
      onState: s => {
        if (s === 'listening') { btn.classList.add('on'); btn.textContent = '■ 完了'; btn.setAttribute('aria-label', '音声入力を終える'); }
        if (s === 'stopped' || s === 'denied') {
          btn.classList.remove('on'); btn.textContent = '🎤'; btn.setAttribute('aria-label', '音声で入力');
          target.value = base + vi.finalText;
          if (activeMic && activeMic.vi === vi) activeMic = null;
          if (s === 'denied') toast('マイクの使用が許可されていません。ブラウザの設定を確認してください', 'warn');
        }
      }
    });
    activeMic = { btn, vi };
    try { vi.start(); } catch (err) { activeMic = null; toast(err.message, 'warn'); }
  });

  // AI車掌の読み上げボタン
  const ttsTexts = new Map();
  let ttsSeq = 0, ttsActive = null;
  function ttsBtn(text, label = '▶ AI車掌の声で聞く') {
    if (!text) return '';
    const id = 't' + (++ttsSeq);
    ttsTexts.set(id, text);
    return `<button type="button" class="btn ghost small" data-tts="${id}" data-label="${esc(label)}">${esc(label)}</button>`;
  }
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-tts]');
    if (!btn) return;
    if (ttsActive === btn) { window.Tts.stop(); return; }
    window.Tts.stop();
    ttsActive = btn;
    const label = btn.dataset.label;
    await window.Tts.speak(ttsTexts.get(btn.dataset.tts), {
      onstate: s => {
        if (s === 'loading') btn.textContent = '… 準備中';
        else if (s === 'playing') btn.textContent = '■ 止める';
        else {
          btn.textContent = label;
          if (s === 'error') toast('音声を作れませんでした。時間をおいて再度お試しください', 'warn');
          if (ttsActive === btn) ttsActive = null;
        }
      }
    });
  });

  function download(filename, content, mime) {
    const url = typeof content === 'string' && content.startsWith('data:') ? content : URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    if (!url.startsWith('data:')) setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function stationOptions(selected, { empty } = {}) {
    let html = empty ? `<option value="">${esc(empty)}</option>` : '';
    Object.keys(REG).forEach(rk => {
      const ids = Object.keys(ST).filter(id => ST[id][3] === rk);
      html += `<optgroup label="${esc(REG[rk].name)}">` + ids.map(id => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(ST[id][0])}</option>`).join('') + '</optgroup>';
    });
    return html;
  }

  /* =========================================================
   * 認証
   * ======================================================= */
  function showAuth(panel) {
    $('#auth').hidden = false;
    $$('#auth [data-panel]').forEach(p => { p.hidden = p.dataset.panel !== panel; });
    if (panel === 'change') { $('#chgCurrent').value = S.tempPw || ''; $('#chgNew').focus(); }
  }
  function hideAuth() { $('#auth').hidden = true; }
  function forceLogout(msg) {
    S.token = null; store.del('htf_token');
    closeModal();
    showAuth('login');
    if (msg) toast(msg, 'warn');
  }
  $$('#auth [data-go]').forEach(b => b.addEventListener('click', () => showAuth(b.dataset.go)));
  $('#regAgree').addEventListener('change', e => { $('#regSubmit').disabled = !e.target.checked; });

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const pw = $('#loginPw').value;
      const d = await api('login', { email: $('#loginEmail').value, password: pw });
      S.token = d.token; store.set('htf_token', d.token);
      $('#loginPw').value = '';
      if (d.user.mustChange) { S.tempPw = pw; showAuth('change'); return; }
      await boot();
    } catch (err) { toast(err.message, 'warn'); }
  });

  $('#registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!$('#regAgree').checked) { toast('利用規約・免責事項への同意が必要です', 'warn'); return; }
    try {
      const d = await api('register', { email: $('#regEmail').value, nickname: $('#regNick').value, agree: true });
      toast(d.message || '仮パスワードをメールで送りました');
      $('#loginEmail').value = $('#regEmail').value;
      $('#registerForm').reset(); $('#regSubmit').disabled = true;
      showAuth('login');
    } catch (err) { toast(err.message, 'warn'); }
  });

  $('#forgotForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const d = await api('resetPassword', { email: $('#forgotEmail').value });
      toast(d.message);
      $('#loginEmail').value = $('#forgotEmail').value;
      showAuth('login');
    } catch (err) { toast(err.message, 'warn'); }
  });

  $('#changeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const n1 = $('#chgNew').value, n2 = $('#chgNew2').value;
    if (n1 !== n2) { toast('新しいパスワードが一致しません', 'warn'); return; }
    try {
      await api('changePassword', { current: $('#chgCurrent').value, newPassword: n1 });
      S.tempPw = '';
      $('#changeForm').reset();
      toast('パスワードを変更しました');
      await boot();
    } catch (err) { toast(err.message, 'warn'); }
  });
  $('#chgLogout').addEventListener('click', () => logout());

  async function logout() {
    try { await api('logout', {}, { silent: true }); } catch (_) {}
    forceLogout('ログアウトしました');
  }

  async function boot() {
    try {
      const d = await api('bootstrap');
      applyBoot(d);
      if (d.user.mustChange) { showAuth('change'); return; }
      hideAuth();
      startApp();
    } catch (err) {
      if (err.code !== 'AUTH' && err.code !== 'MUST_CHANGE') { toast(err.message, 'warn'); showAuth('login'); }
    }
  }

  function applyBoot(d) {
    S.user = d.user;
    S.rides.seg = new Set(d.rides.filter(r => r.kind === 'seg').map(r => r.targetId));
    S.rides.sta = new Set(d.rides.filter(r => r.kind === 'sta').map(r => r.targetId));
    S.routes = d.routes || [];
    S.blocks = new Set(d.blocks || []);
    S.memoryCount = d.memoryCount || 0;
    recomputeRouteSegs();
  }

  /* =========================================================
   * 状態・統計
   * ======================================================= */
  function recomputeRouteSegs() {
    S.doneSegs = new Set(); S.challengeSegs = new Set();
    S.routes.forEach(r => (r.hops || []).forEach(h => (r.status === 'done' ? S.doneSegs : S.challengeSegs).add(h.seg)));
  }
  function segStatus(id) {
    if (S.doneSegs.has(id)) return 'done';
    if (S.rides.seg.has(id)) return 'ridden';
    if (S.challengeSegs.has(id)) return 'challenge';
    return 'none';
  }
  const stats = () => R.computeStats({ ridden: S.rides.seg, stations: S.rides.sta, routes: S.routes, memoryCount: S.memoryCount });

  function announceGains(before) {
    const after = stats();
    const had = new Set(before.badges.filter(b => b.earned).map(b => b.id));
    let delay = 900;
    if (after.level > before.level) { setTimeout(() => toast(`レベルアップ！ Lv.${after.level}「${after.title}」`, 'gold'), delay); delay += 1000; }
    after.badges.filter(b => b.earned && !had.has(b.id)).forEach(b => { setTimeout(() => toast(`称号を獲得しました：「${b.name}」`, 'gold'), delay); delay += 1000; });
    Object.keys(REG).forEach(k => {
      if (before.region[k].done === 0 && after.region[k].done > 0) { setTimeout(() => toast(`${REG[k].name}エリアが開放されました`, 'gold'), delay); delay += 1000; }
    });
  }

  function renderAll() { renderHero(); drawMap(); renderRegions(); renderRoutes(); renderTickets(); renderMe(); }

  /* =========================================================
   * マップ
   * ======================================================= */
  function initMap() {
    const m = L.map('map', { zoomControl: true, attributionControl: true }).setView(C.MAP_CENTER || [36.2, 138], C.MAP_ZOOM || 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(m);
    S.L.lines = L.layerGroup().addTo(m);
    S.L.route = L.layerGroup().addTo(m);
    S.L.builder = L.layerGroup().addTo(m);
    S.L.stations = L.layerGroup().addTo(m);
    S.map = m;
    let lastBand = m.getZoom() >= 7;
    m.on('zoomend', () => { const band = m.getZoom() >= 7; if (band !== lastBand) { lastBand = band; drawStations(); } });
  }

  function drawMap() { if (!S.map) return; drawLines(); drawStations(); drawRouteOverlay(); }

  function drawLines() {
    const g = S.L.lines; g.clearLayers();
    SEGS.forEach(seg => {
      const ll = seg.st.map(id => [ST[id][1], ST[id][2]]);
      const st = segStatus(seg.id);
      const w = seg.type === 'shinkansen' ? 7 : 4;
      L.polyline(ll, { color: '#ffffff', weight: w + 4, opacity: .9, interactive: false, lineCap: 'round' }).addTo(g);
      L.polyline(ll, { color: COLORS[st], weight: w, opacity: 1, interactive: false, lineCap: 'round' }).addTo(g);
      if (seg.type === 'shinkansen') L.polyline(ll, { color: '#ffffff', weight: 1.5, opacity: .9, interactive: false }).addTo(g);
      const hit = L.polyline(ll, { color: '#000', weight: 22, opacity: 0.01 }).addTo(g);
      hit.on('click', e => { L.DomEvent.stopPropagation(e); onSegClick(seg, e.latlng); });
    });
  }

  function drawStations() {
    const g = S.L.stations; g.clearLayers();
    const z = S.map.getZoom();
    Object.keys(ST).forEach(id => {
      const s = ST[id];
      const m = L.circleMarker([s[1], s[2]], {
        radius: z >= 7 ? 6.5 : 4.5, color: '#1C2B4A', weight: 2,
        fillColor: S.rides.sta.has(id) ? '#B8322A' : '#FFFFFF', fillOpacity: 1
      });
      m.bindTooltip(s[0], { permanent: z >= 7, direction: 'right', offset: [6, 0], className: 'st-label' });
      m.on('click', e => { L.DomEvent.stopPropagation(e); onStationClick(id, e.latlng); });
      m.addTo(g);
    });
  }

  function drawRouteOverlay() {
    const g = S.L.route; g.clearLayers();
    const r = S.shownRoute;
    $('#routeChip').hidden = !r;
    if (!r) return;
    const ll = R.routeStations(r.hops).map(id => [ST[id][1], ST[id][2]]);
    const col = r.status === 'done' ? COLORS.done : COLORS.challenge;
    L.polyline(ll, { color: '#ffffff', weight: 12, opacity: .85, interactive: false }).addTo(g);
    L.polyline(ll, { color: col, weight: 7, opacity: 1, dashArray: '12 8', interactive: false }).addTo(g);
    L.circleMarker(ll[0], { radius: 9, color: '#1C2B4A', weight: 3, fillColor: '#11804A', fillOpacity: 1, interactive: false }).addTo(g);
    L.circleMarker(ll[ll.length - 1], { radius: 9, color: '#1C2B4A', weight: 3, fillColor: col, fillOpacity: 1, interactive: false }).addTo(g);
    $('#routeChip').innerHTML = `<span>表示中：${esc(r.title || '一筆書きの旅')}</span><button type="button" aria-label="ルート表示を消す">×</button>`;
    $('#routeChip button').onclick = () => { S.shownRoute = null; drawRouteOverlay(); };
  }

  function showRouteOnMap(route) {
    S.shownRoute = route;
    closeModal();
    showView('map');
    setTimeout(() => {
      drawRouteOverlay();
      const ll = R.routeStations(route.hops).map(id => [ST[id][1], ST[id][2]]);
      if (ll.length) S.map.fitBounds(L.latLngBounds(ll), { padding: [40, 40] });
    }, 80);
  }

  function onSegClick(seg, latlng) {
    if (S.builder) return;
    if (S.quick) { toggleSeg(seg.id, !S.rides.seg.has(seg.id)); return; }
    const st = segStatus(seg.id);
    const ridden = S.rides.seg.has(seg.id);
    const div = document.createElement('div');
    div.className = 'pop';
    div.innerHTML = `<h3>${esc(seg.name)}</h3>
      <p class="meta">${seg.type === 'shinkansen' ? '新幹線' : '在来線'}　約${fmtKm(seg.km)}km　${esc(REG[seg.region].name)}　${seg.hikyo ? '秘境線　' : ''}<br>状態：${STATUS_LABEL[st]}</p>
      ${seg.note ? `<p class="note">${esc(seg.note)}</p>` : ''}
      <div class="pop-actions"><button type="button" class="btn ${ridden ? 'ghost' : 'go'}" data-act="toggle">${ridden ? '乗車記録を取り消す' : '乗った！'}</button></div>`;
    div.querySelector('[data-act="toggle"]').onclick = () => { S.map.closePopup(); toggleSeg(seg.id, !ridden); };
    L.popup().setLatLng(latlng).setContent(div).openOn(S.map);
  }

  async function toggleSeg(id, on) {
    const before = stats();
    if (on) S.rides.seg.add(id); else S.rides.seg.delete(id);
    renderAll();
    if (on) { stamp('乗車'); announceGains(before); }
    else toast(`${R.segById[id].name} の乗車記録を取り消しました`);
    try { await api('toggleRide', { kind: 'seg', targetId: id, on }, { silent: true }); }
    catch (err) { if (on) S.rides.seg.delete(id); else S.rides.seg.add(id); renderAll(); toast('保存できませんでした：' + err.message, 'warn'); }
  }

  async function toggleStation(id, on) {
    const before = stats();
    if (on) S.rides.sta.add(id); else S.rides.sta.delete(id);
    renderAll();
    if (on) { stamp('到着'); announceGains(before); }
    try { await api('toggleRide', { kind: 'sta', targetId: id, on }, { silent: true }); }
    catch (err) { if (on) S.rides.sta.delete(id); else S.rides.sta.add(id); renderAll(); toast('保存できませんでした：' + err.message, 'warn'); }
  }

  function onStationClick(id, latlng) {
    if (S.builder) { builderAdd(id); return; }
    const s = ST[id];
    const visited = S.rides.sta.has(id);
    const segs = R.segsOfStation[id] || [];
    const div = document.createElement('div');
    div.className = 'pop';
    div.innerHTML = `<h3>${esc(s[0])}</h3>
      <p class="meta">${esc(REG[s[3]].name)}　${segs.length}線区が通ります</p>
      <ul class="pop-lines">${segs.map(sid => {
        const r = S.rides.seg.has(sid);
        return `<li><span>${esc(R.segById[sid].name)}</span><button type="button" class="btn small ${r ? 'ghost' : 'go'}" data-seg="${sid}">${r ? '乗車済み ✓' : '乗った'}</button></li>`;
      }).join('')}</ul>
      <div class="pop-actions">
        <button type="button" class="btn small ${visited ? 'ghost' : 'primary'}" data-act="visit">${visited ? '訪問済み ✓' : 'この駅に来た'}</button>
        <button type="button" class="btn small" data-act="memo">想い出を記録</button>
        <button type="button" class="btn small" data-act="list">この駅の想い出</button>
        <button type="button" class="btn small" data-act="ai">AI車掌の駅ガイド</button>
      </div>
      <div class="pop-ai" data-ai></div>`;
    div.querySelectorAll('[data-seg]').forEach(b => b.onclick = () => { S.map.closePopup(); toggleSeg(b.dataset.seg, !S.rides.seg.has(b.dataset.seg)); });
    div.querySelector('[data-act="visit"]').onclick = () => { S.map.closePopup(); toggleStation(id, !visited); };
    div.querySelector('[data-act="memo"]').onclick = () => { S.map.closePopup(); openMemoryForm(null, id); };
    div.querySelector('[data-act="list"]').onclick = () => { S.map.closePopup(); S.tl.stationId = id; S.tl.scope = 'public'; S.tl.loaded = true; syncSegTabs(); showView('memories'); loadTimeline(true).catch(e => toast(e.message, 'warn')); };
    div.querySelector('[data-act="ai"]').onclick = async (ev) => {
      const box = div.querySelector('[data-ai]');
      ev.target.disabled = true;
      box.textContent = 'AI車掌が案内文を書いています…';
      try {
        const d = await api('aiText', { mode: 'station', stationName: s[0], region: REG[s[3]].name, lines: segs.map(x => R.segById[x].name) });
        box.innerHTML = `<p>${esc(d.summary)}</p>${ttsBtn(d.narration || d.summary)}`;
      } catch (err) { box.textContent = err.message; ev.target.disabled = false; }
    };
    L.popup().setLatLng(latlng).setContent(div).openOn(S.map);
  }

  /* =========================================================
   * ヒーロー・地方
   * ======================================================= */
  function renderHero() {
    const st = stats();
    const pct = Math.min(100, st.pct);
    $('#hero').innerHTML = `
      <span class="hero-lv">Lv.${st.level}<small>${esc(st.title)}</small></span>
      <span class="hero-rate"><strong>完乗 ${st.pct.toFixed(1)}%</strong>${fmtKm(st.km)} / ${fmtKm(st.totalKm)}km</span>
      <span class="rail-progress" role="progressbar" aria-label="完乗率" aria-valuenow="${pct.toFixed(1)}" aria-valuemin="0" aria-valuemax="100">
        <span class="rail-fill" style="width:${pct}%"></span><span class="rail-train" style="left:${Math.max(2, Math.min(98, pct))}%">🚃</span>
      </span>`;
    // 乗るほど地図に色が戻ってくる演出
    if (S.map) S.map.getPane('tilePane').style.filter = `saturate(${(0.18 + 0.82 * Math.sqrt(pct / 100)).toFixed(2)})`;
  }
  $('#hero').addEventListener('click', () => showView('me'));

  function renderRegions() {
    const st = stats();
    $('#regions').innerHTML = Object.keys(REG).map(k => {
      const r = st.region[k], open = r.done > 0;
      return `<div class="region ${open ? '' : 'locked'}" style="${open ? `border-color:${REG[k].color}` : ''}">
        <b>${esc(REG[k].name)}</b>${open ? r.pct.toFixed(0) + '%' : '未開放'}
        <div class="bar"><i style="width:${r.pct}%;background:${REG[k].color}"></i></div></div>`;
    }).join('');
  }

  /* =========================================================
   * ルート作成（手動）
   * ======================================================= */
  function startBuilder() {
    S.builder = { start: null, hops: [], steps: [], localOnly: false };
    S.shownRoute = null;
    showView('map');
    renderBuilder();
    toast('出発駅をタップしてください');
  }
  function builderStations() { const b = S.builder; return b.start ? [b.start, ...b.hops.map(h => h.to)] : []; }

  function builderAdd(id) {
    const b = S.builder;
    if (!b.start) { b.start = id; b.steps.push(0); renderBuilder(); return; }
    const sts = builderStations();
    const last = sts[sts.length - 1];
    if (id === last) return;
    const visited = new Set(sts);
    if (visited.has(id)) { toast('同じ駅は2度通れません（一筆書きのルール）', 'warn'); return; }
    const path = R.shortestPath(last, id, visited, { localOnly: b.localOnly });
    if (!path) { toast(`${stName(id)}へは、通った駅を避けてつなげません`, 'warn'); return; }
    b.hops.push(...path); b.steps.push(path.length);
    renderBuilder();
  }

  function renderBuilder() {
    const bar = $('#builderBar');
    const b = S.builder;
    bar.hidden = !b;
    S.L.builder && S.L.builder.clearLayers();
    if (!b) return;
    const sts = builderStations();
    const km = R.routeKm(b.hops);
    bar.innerHTML = `<div class="bb-info">${b.start
      ? `<strong>${esc(stName(sts[0]))} → ${esc(stName(sts[sts.length - 1]))}</strong><span>${sts.length}駅　${fmtKm(km)}km　次の駅をタップ</span>`
      : '<strong>出発駅をタップ</strong><span>同じ駅は2度通れません</span>'}</div>
      <div class="bb-actions">
        <label class="mini-check"><input type="checkbox" id="bbLocal" ${b.localOnly ? 'checked' : ''}> 在来線のみ</label>
        <button type="button" class="btn ghost small" id="bbUndo" ${b.start ? '' : 'disabled'}>1つ戻す</button>
        <button type="button" class="btn ghost small" id="bbCancel">やめる</button>
        <button type="button" class="btn primary small" id="bbDone" ${b.hops.length ? '' : 'disabled'}>このルートにする</button>
      </div>`;
    $('#bbLocal').onchange = e => { b.localOnly = e.target.checked; };
    $('#bbUndo').onclick = () => { const n = b.steps.pop(); if (n === 0) b.start = null; else b.hops.splice(b.hops.length - n, n); renderBuilder(); };
    $('#bbCancel').onclick = () => { S.builder = null; renderBuilder(); };
    $('#bbDone').onclick = () => openRouteSave({ hops: b.hops.slice(), title: '', catchcopy: '', narration: '', mood: '自分で作成' });
    if (sts.length) {
      const ll = sts.map(id => [ST[id][1], ST[id][2]]);
      if (ll.length > 1) {
        L.polyline(ll, { color: '#ffffff', weight: 12, opacity: .85, interactive: false }).addTo(S.L.builder);
        L.polyline(ll, { color: COLORS.challenge, weight: 7, dashArray: '10 8', interactive: false }).addTo(S.L.builder);
      }
      L.circleMarker(ll[0], { radius: 10, color: '#1C2B4A', weight: 3, fillColor: '#11804A', fillOpacity: 1, interactive: false }).addTo(S.L.builder);
    }
  }
  $('#builderStart').addEventListener('click', startBuilder);

  /* =========================================================
   * AI車掌の旅提案
   * ======================================================= */
  function initTripForm() {
    $('#moodChips').innerHTML = MOODS.map(m => `<button type="button" class="chip" aria-pressed="false" data-mood="${esc(m)}">${esc(m)}</button>`).join('');
    $$('#moodChips .chip').forEach(c => c.addEventListener('click', () => {
      const on = c.getAttribute('aria-pressed') !== 'true';
      c.setAttribute('aria-pressed', String(on));
      if (on) S.moods.add(c.dataset.mood); else S.moods.delete(c.dataset.mood);
    }));
    $('#aiStart').innerHTML = stationOptions('', { empty: 'おまかせ' });
  }

  $('#aiGo').addEventListener('click', async () => {
    const btn = $('#aiGo');
    const localOnly = $('#aiLocal').checked;
    const start = $('#aiStart').value;
    const daysSel = $('#aiDays');
    btn.disabled = true; btn.textContent = 'AI車掌が時刻表をめくっています…';
    try {
      const res = await api('aiRoute', {
        moods: [...S.moods], days: daysSel.value, daysLabel: daysSel.options[daysSel.selectedIndex].text,
        start: start ? { id: start, name: stName(start) } : null,
        free: $('#aiFree').value, graph: R.graphText({ localOnly }),
        ridden: $('#aiUnridden').checked ? [...S.rides.seg] : [], localOnly
      });
      const fixed = R.validateAndRepair(res.hops || [], { localOnly });
      if (!fixed.ok) throw new Error('一筆書きのルートを組み立てられませんでした。条件を変えてもう一度お試しください');
      S.aiDraft = {
        title: res.title || '一筆書きの旅', catchcopy: res.catchcopy || '', hops: fixed.hops,
        narration: res.narration || '', mood: [...S.moods].join('、') || 'おまかせ',
        extra: { highlights: res.highlights || [], ekiben: res.ekiben || [] }, warnings: fixed.warnings, createdAt: Date.now()
      };
      renderAiResult();
    } catch (err) { toast(err.message, 'warn'); }
    finally { btn.disabled = false; btn.textContent = '旅を提案してもらう'; }
  });

  function renderAiResult() {
    const d = S.aiDraft, box = $('#aiResult');
    if (!d) { box.innerHTML = ''; return; }
    const st = R.routeStations(d.hops);
    box.innerHTML = `<div class="ai-card">
      <div class="ticket-svg">${R.ticketSVG(d)}</div>
      ${d.catchcopy ? `<p class="catch">${esc(d.catchcopy)}</p>` : ''}
      <p class="hint">${st.length}駅　約${fmtKm(R.routeKm(d.hops))}km　経由：${esc(R.viaNames(d.hops).join('、'))}</p>
      ${d.extra.highlights.length ? `<h3>見どころ</h3><ul>${d.extra.highlights.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      ${d.extra.ekiben.length ? `<h3>駅弁・ごちそう</h3><ul>${d.extra.ekiben.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      ${d.warnings.length ? `<div class="warn-list">${d.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="btn-row">${ttsBtn(d.narration)}</div>
      <div class="btn-row">
        <button type="button" class="btn" id="aiMap">マップで見る</button>
        <button type="button" class="btn" id="aiEdit">名前を変えて保存</button>
        <button type="button" class="btn go" id="aiSave">この旅に出る（切符を発行）</button>
      </div>
      <p class="hint">※一筆書きの判定は「同じ駅を2度通らない」で簡略化しています。実際の乗車券の発券可否は駅でご確認ください。</p>
    </div>`;
    $('#aiMap').onclick = () => showRouteOnMap(Object.assign({ status: 'challenge' }, d));
    $('#aiEdit').onclick = () => openRouteSave(Object.assign({}, d));
    $('#aiSave').onclick = () => saveRouteDraft(d, 'challenge');
  }

  /* =========================================================
   * ルート保存・詳細
   * ======================================================= */
  function openRouteSave(draft) {
    draft.extra = draft.extra || { highlights: [], ekiben: [] };
    const box = openModal(`<h2>旅に名前をつける</h2>
      <div class="ticket-svg" id="rsTicket"></div>
      <label class="field">旅のタイトル<input id="rsTitle" maxlength="40" value="${esc(draft.title)}" placeholder="例：海と山をつなぐ二日間"></label>
      <label class="field">ひとこと<input id="rsCatch" maxlength="80" value="${esc(draft.catchcopy)}"></label>
      <div class="btn-row"><button type="button" class="btn" id="rsAi">AI車掌に名前とナレーションを考えてもらう</button></div>
      <div id="rsNarr"></div>
      <div class="btn-row">
        <button type="button" class="btn go" id="rsGo">この旅に出る（挑戦中）</button>
        <button type="button" class="btn" id="rsDone">もう走破した旅として保存</button>
      </div>`);
    const refresh = () => {
      draft.title = $('#rsTitle', box).value.trim(); draft.catchcopy = $('#rsCatch', box).value.trim();
      $('#rsTicket', box).innerHTML = R.ticketSVG(Object.assign({}, draft, { title: draft.title || '（タイトル未定）' }));
      $('#rsNarr', box).innerHTML = draft.narration ? `<p class="hint">${esc(draft.narration)}</p>${ttsBtn(draft.narration)}` : '';
    };
    refresh();
    $('#rsTitle', box).oninput = refresh; $('#rsCatch', box).oninput = refresh;
    $('#rsAi', box).onclick = async e => {
      e.target.disabled = true;
      try {
        const sts = R.routeStations(draft.hops);
        const d = await api('aiText', { mode: 'name', stations: sts.map(stName), via: R.viaNames(draft.hops), km: R.routeKm(draft.hops).toFixed(1) });
        $('#rsTitle', box).value = d.title || ''; $('#rsCatch', box).value = d.catchcopy || '';
        draft.narration = d.narration || ''; draft.extra.highlights = d.highlights || [];
        refresh();
      } catch (err) { toast(err.message, 'warn'); }
      e.target.disabled = false;
    };
    $('#rsGo', box).onclick = () => { refresh(); if (!draft.title) draft.title = '一筆書きの旅'; saveRouteDraft(draft, 'challenge'); };
    $('#rsDone', box).onclick = () => { refresh(); if (!draft.title) draft.title = '一筆書きの旅'; saveRouteDraft(draft, 'done'); };
  }

  async function saveRouteDraft(draft, status) {
    if (!R.isValid(draft.hops)) { toast('一筆書きのルールを満たしていません', 'warn'); return; }
    try {
      const route = await api('saveRoute', { route: { title: draft.title, catchcopy: draft.catchcopy, hops: draft.hops, narration: draft.narration, mood: draft.mood, extra: draft.extra } });
      S.routes.unshift(route);
      S.builder = null; renderBuilder();
      S.aiDraft = null; renderAiResult();
      recomputeRouteSegs();
      if (status === 'done') { await completeRoute(route, { quiet: true }); }
      else { stamp('発券'); renderAll(); }
      closeModal();
      toast(`切符 No.${route.ticketNo} を発行しました`);
      openRouteDetail(route.routeId);
    } catch (err) { toast(err.message, 'warn'); }
  }

  async function completeRoute(route, { quiet } = {}) {
    if (!quiet && !window.confirm(`「${route.title}」を走破済みにしますか？\n全区間を乗り通した線区は自動で「完乗」になります。`)) return;
    const before = stats();
    const segIds = R.coveredSegs(route.hops).filter(id => !S.rides.seg.has(id));
    const staIds = R.routeStations(route.hops).filter(id => !S.rides.sta.has(id));
    try {
      if (segIds.length) await api('bulkRide', { kind: 'seg', ids: segIds, on: true });
      if (staIds.length) await api('bulkRide', { kind: 'sta', ids: staIds, on: true });
      const r = await api('setRouteStatus', { routeId: route.routeId, status: 'done' });
      segIds.forEach(id => S.rides.seg.add(id));
      staIds.forEach(id => S.rides.sta.add(id));
      Object.assign(route, r);
      const i = S.routes.findIndex(x => x.routeId === route.routeId);
      if (i >= 0) S.routes[i] = route;
      recomputeRouteSegs();
      renderAll();
      stamp('走破');
      announceGains(before);
      if (!quiet) openRouteDetail(route.routeId);
    } catch (err) { toast(err.message, 'warn'); }
  }

  function renderRoutes() {
    const box = $('#routeList');
    if (!S.routes.length) { box.innerHTML = '<p class="empty">まだ一筆書きの旅がありません。AI車掌に相談するか、マップで線を引いてみましょう。</p>'; return; }
    box.innerHTML = S.routes.slice().sort((a, b) => b.createdAt - a.createdAt).map(r => {
      const st = R.routeStations(r.hops);
      return `<button type="button" class="route-row" data-route="${esc(r.routeId)}">
        <span class="rr-status ${r.status}">${r.status === 'done' ? '走破済み' : '挑戦中'}</span>
        <span class="rr-title">${esc(r.title)}</span>
        <span class="rr-sub">${esc(stName(st[0]))} → ${esc(stName(st[st.length - 1]))}　${fmtKm(R.routeKm(r.hops))}km　切符No.${esc(r.ticketNo)}</span>
      </button>`;
    }).join('');
    $$('.route-row', box).forEach(b => b.onclick = () => openRouteDetail(b.dataset.route));
  }

  function videoEmbed(url) {
    if (!url) return '';
    const yt = url.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
    if (yt) return `<iframe src="https://www.youtube.com/embed/${yt[1]}" title="フライスルー動画" allowfullscreen loading="lazy"></iframe>`;
    const dr = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/);
    if (dr) return `<iframe src="https://drive.google.com/file/d/${dr[1]}/preview" title="フライスルー動画" allow="autoplay" allowfullscreen loading="lazy"></iframe>`;
    if (/\.(mp4|webm)(\?|$)/i.test(url)) return `<video src="${esc(url)}" controls playsinline></video>`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener">動画を開く</a>`;
  }

  function openRouteDetail(routeId) {
    const r = S.routes.find(x => x.routeId === routeId);
    if (!r) return;
    const st = R.routeStations(r.hops);
    const km = R.routeKm(r.hops);
    const hl = (r.extra && r.extra.highlights) || [];
    const box = openModal(`<h2>${esc(r.title)}</h2>
      ${r.catchcopy ? `<p class="lead">${esc(r.catchcopy)}</p>` : ''}
      <div class="ticket-svg">${R.ticketSVG(r)}</div>
      <p class="hint">${st.length}駅　約${fmtKm(km)}km　有効${R.validDays(km)}日間　${r.status === 'done' ? '走破済み' : '挑戦中'}</p>
      <div class="btn-row">
        <button type="button" class="btn" data-a="map">マップで見る</button>
        ${r.status !== 'done' ? '<button type="button" class="btn go" data-a="done">走破した！</button>' : ''}
        <button type="button" class="btn ghost" data-a="png">切符を画像で保存</button>
        ${ttsBtn(r.narration)}
      </div>
      ${hl.length ? `<p class="section-title">見どころ</p><ul>${hl.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      <p class="section-title">停車駅</p>
      <p>${st.map(id => esc(stName(id))).join(' → ')}</p>
      <p class="hint">経由：${esc(R.viaNames(r.hops).join('、'))}</p>

      <p class="section-title">旅のふりかえり</p>
      <p class="hint">この旅に紐づけた想い出から、AI車掌が旅の要約と解説を作ります。</p>
      <div id="rdSummary"></div>
      <button type="button" class="btn ghost" data-a="summary">AI車掌に旅をまとめてもらう</button>

      <p class="section-title">空撮フライスルー（Google Earth Studio）</p>
      <p class="hint">ルートをKMLで書き出し、Google Earth Studioに読み込んで空撮動画を作れます。できた動画はYouTubeかGoogleドライブのリンクを登録するか、ここからアップロードしてください。</p>
      <div class="video-box">${videoEmbed(r.videoUrl)}</div>
      <div class="btn-row"><button type="button" class="btn" data-a="kml">KMLを書き出す</button></div>
      <label class="field">動画のURL<input id="rdVideo" type="url" value="${esc(r.videoUrl)}" placeholder="https://youtu.be/… または ドライブの共有リンク"></label>
      <div class="btn-row">
        <button type="button" class="btn" data-a="video">動画URLを保存</button>
        <label class="btn ghost">動画をアップロード<input type="file" accept="video/*" id="rdUpload" hidden></label>
      </div>

      <p class="section-title">そのほか</p>
      <div class="btn-row">
        <button type="button" class="btn ghost" data-a="memo">この旅の想い出を記録</button>
        <button type="button" class="btn danger" data-a="delete">この旅を削除</button>
      </div>`, { wide: true });

    box.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      const act = a.dataset.a;
      try {
        if (act === 'map') showRouteOnMap(r);
        else if (act === 'done') completeRoute(r);
        else if (act === 'png') download(`切符_${r.ticketNo}.png`, await R.svgToPng(R.ticketSVG(r)), 'image/png');
        else if (act === 'kml') download(`${(r.title || 'route').replace(/[\\/:*?"<>|]/g, '_')}.kml`, R.kml(r), 'application/vnd.google-earth.kml+xml');
        else if (act === 'summary') {
          a.disabled = true;
          $('#rdSummary', box).innerHTML = '<p class="hint">AI車掌がふりかえりを書いています…</p>';
          const d = await api('aiText', { mode: 'summary', routeId: r.routeId, stations: st.map(stName), via: R.viaNames(r.hops) });
          $('#rdSummary', box).innerHTML = `<p>${esc(d.summary)}</p><div class="btn-row">${ttsBtn(d.narration || d.summary)}</div>`;
          a.disabled = false;
        } else if (act === 'video') {
          const url = $('#rdVideo', box).value.trim();
          if (url && !/^https:\/\//.test(url)) throw new Error('https:// から始まるURLを入力してください');
          await api('setRouteVideo', { routeId: r.routeId, videoUrl: url });
          r.videoUrl = url; toast('動画を登録しました'); openRouteDetail(r.routeId);
        } else if (act === 'memo') openMemoryForm(null, st[st.length - 1], r.routeId);
        else if (act === 'delete') {
          if (!window.confirm('この旅と切符を削除します。元に戻せません。よろしいですか？\n（乗車記録や想い出は残ります）')) return;
          await api('deleteRoute', { routeId: r.routeId });
          S.routes = S.routes.filter(x => x.routeId !== r.routeId);
          if (S.shownRoute && S.shownRoute.routeId === r.routeId) S.shownRoute = null;
          recomputeRouteSegs(); renderAll(); closeModal(); toast('旅を削除しました');
        }
      } catch (err) { a.disabled = false; toast(err.message, 'warn'); }
    });

    $('#rdUpload', box).addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        toast('動画をアップロードしています…');
        const up = await api('upload', await fileToPayload(f));
        const url = `https://drive.google.com/file/d/${up.fileId}/view`;
        await api('setRouteVideo', { routeId: r.routeId, videoUrl: url });
        r.videoUrl = url; toast('動画をアップロードしました'); openRouteDetail(r.routeId);
      } catch (err) { toast(err.message, 'warn'); }
    });
  }

  /* =========================================================
   * 切符帳
   * ======================================================= */
  function renderTickets() {
    const g = $('#ticketGrid');
    if (!S.routes.length) { g.innerHTML = '<p class="empty">まだ切符がありません。「旅を作る」から最初の一枚を発行しましょう。</p>'; return; }
    g.innerHTML = S.routes.slice().sort((a, b) => String(a.ticketNo).localeCompare(String(b.ticketNo)))
      .map(r => `<button type="button" data-route="${esc(r.routeId)}" aria-label="${esc(r.title)}の切符"><div class="ticket-svg">${R.ticketSVG(r)}</div></button>`).join('');
    $$('button', g).forEach(b => b.onclick = () => openRouteDetail(b.dataset.route));
  }

  /* =========================================================
   * 想い出（トレカ）
   * ======================================================= */
  function syncSegTabs() { $$('#view-memories .seg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.scope === S.tl.scope))); }
  $$('#view-memories .seg button').forEach(b => b.addEventListener('click', () => {
    S.tl.scope = b.dataset.scope; syncSegTabs(); loadTimeline(true).catch(e => toast(e.message, 'warn'));
  }));
  $('#tlMore').addEventListener('click', () => loadTimeline(false).catch(e => toast(e.message, 'warn')));
  $('#newMemory').addEventListener('click', () => openMemoryForm(null));

  async function loadTimeline(reset) {
    const tl = S.tl;
    if (reset) { tl.items = []; tl.offset = 0; }
    const d = await api('getMemories', { scope: tl.scope, stationId: tl.stationId || '', offset: tl.offset, limit: 20 });
    tl.items.push(...d.items); tl.offset += d.items.length; tl.hasMore = d.hasMore; tl.loaded = true;
    renderTimeline();
  }

  function rarity(m) {
    const segs = R.segsOfStation[m.stationId] || [];
    if (segs.some(s => R.segById[s].hikyo)) return 'SR';
    if (segs.length >= 3) return 'R';
    return 'N';
  }

  function mediaHtml(m) {
    if (m.fileId && m.fileType === 'video') return `<iframe src="https://drive.google.com/file/d/${esc(m.fileId)}/preview" title="動画" allow="autoplay" allowfullscreen loading="lazy"></iframe>`;
    if (m.fileId) return `<img src="https://lh3.googleusercontent.com/d/${esc(m.fileId)}=w800" alt="${esc(m.title || stName(m.stationId))}の写真" loading="lazy">`;
    return `<span class="noimg">${esc(stName(m.stationId))}</span>`;
  }

  function cardHtml(m) {
    const reg = ST[m.stationId] ? REG[ST[m.stationId][3]] : null;
    const d = m.takenAt || Rail.fmtDate(m.createdAt);
    return `<article class="tcard" style="--rc:${reg ? reg.color : '#1C2B4A'}" data-id="${esc(m.memoryId)}">
      <div class="tcard-top"><span class="tcard-station">${esc(stName(m.stationId))}</span><span class="tcard-rarity">${rarity(m)}${m.fileType === 'video' ? '＋動画' : ''}</span></div>
      <div class="tcard-media">${mediaHtml(m)}</div>
      <div class="tcard-body">
        ${m.title ? `<h3>${esc(m.title)}</h3>` : ''}
        ${m.text ? `<p>${esc(m.text)}</p>` : ''}
        ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a>` : ''}
      </div>
      <div class="tcard-meta">
        <span>${esc(d)}</span>
        ${m.lat !== '' && m.lat != null ? `<span>${Number(m.lat).toFixed(3)}N ${Number(m.lng).toFixed(3)}E</span>` : ''}
        <span>${esc(m.nickname)}</span>
        ${m.mine ? `<button type="button" class="vis btn small ghost" data-act="vis">${m.visibility === 'public' ? '公開中' : '非公開'}</button>` : ''}
      </div>
      <div class="tcard-actions">
        <button type="button" class="btn ${m.liked ? 'liked' : 'ghost'}" data-act="like" ${m.mine ? 'disabled title="自分の投稿です"' : ''}>出発進行！ ${m.likes}</button>
        <button type="button" class="btn ghost" data-act="comment">コメント ${m.comments}</button>
        <button type="button" class="btn ghost" data-act="more" aria-label="その他の操作">…</button>
      </div>
    </article>`;
  }

  function renderTimeline() {
    const tl = S.tl;
    $('#tlFilter').innerHTML = tl.stationId ? `<span class="filter-chip">${esc(stName(tl.stationId))}駅の想い出<button type="button" aria-label="絞り込みを解除">×</button></span>` : '';
    const fb = $('#tlFilter button');
    if (fb) fb.onclick = () => { tl.stationId = ''; loadTimeline(true).catch(e => toast(e.message, 'warn')); };
    $('#timeline').innerHTML = tl.items.length ? tl.items.map(cardHtml).join('')
      : `<p class="empty">${tl.scope === 'mine' ? 'まだ想い出がありません。駅をタップして、最初の一枚を記録しましょう。' : '公開されている想い出はまだありません。あなたの旅を最初に公開してみませんか。'}</p>`;
    $('#tlMore').hidden = !tl.hasMore;
  }

  $('#timeline').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.tcard');
    const m = S.tl.items.find(x => x.memoryId === card.dataset.id);
    if (!m) return;
    try {
      if (btn.dataset.act === 'like') {
        const d = await api('toggleLike', { memoryId: m.memoryId }, { silent: true });
        m.liked = d.liked; m.likes = d.count; renderTimeline();
      } else if (btn.dataset.act === 'comment') openComments(m);
      else if (btn.dataset.act === 'vis') {
        const v = m.visibility === 'public' ? 'private' : 'public';
        await api('setVisibility', { memoryId: m.memoryId, visibility: v }, { silent: true });
        m.visibility = v; renderTimeline();
        toast(v === 'public' ? '会員に公開しました' : '非公開にしました（自分だけが見られます）');
      } else if (btn.dataset.act === 'more') openMoreMenu(m);
    } catch (err) { toast(err.message, 'warn'); }
  });

  function openMoreMenu(m) {
    const box = openModal(`<h2>${esc(m.title || stName(m.stationId))}</h2>
      <div class="btn-row">${m.mine
        ? '<button type="button" class="btn" data-x="edit">編集する</button><button type="button" class="btn danger" data-x="delete">削除する</button>'
        : `<button type="button" class="btn danger" data-x="block">${esc(m.nickname)}さんをブロック</button>`}</div>
      ${m.mine ? '' : '<p class="hint">ブロックすると、お互いの投稿・コメントが見えなくなり、いいねやコメントもできなくなります。</p>'}`);
    box.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]');
      if (!x) return;
      try {
        if (x.dataset.x === 'edit') openMemoryForm(m);
        else if (x.dataset.x === 'delete') {
          if (!window.confirm('この想い出を削除します。写真・動画・コメントも削除されます。よろしいですか？')) return;
          await api('deleteMemory', { memoryId: m.memoryId });
          S.tl.items = S.tl.items.filter(i => i.memoryId !== m.memoryId);
          S.memoryCount = Math.max(0, S.memoryCount - 1);
          closeModal(); renderTimeline(); renderMe(); toast('削除しました');
        } else if (x.dataset.x === 'block') {
          if (!window.confirm(`${m.nickname}さんをブロックしますか？\nマイページからいつでも解除できます。`)) return;
          await api('setBlock', { targetUserId: m.userId, on: true });
          S.blocks.add(m.userId);
          closeModal(); await loadTimeline(true); toast('ブロックしました');
        }
      } catch (err) { toast(err.message, 'warn'); }
    });
  }

  async function openComments(m) {
    const box = openModal(`<h2>コメント</h2>
      <p class="hint">${esc(stName(m.stationId))}　${esc(m.title || '')}</p>
      <div id="cmList"><p class="hint">読み込み中…</p></div>
      <form id="cmForm">
        <label class="field">コメントを書く
          <span class="with-mic"><textarea id="cmText" rows="2" maxlength="500" required></textarea><button type="button" class="mic" data-mic="#cmText" aria-label="音声で入力">🎤</button></span>
        </label>
        <button type="submit" class="btn primary">送信</button>
      </form>`);
    const draw = async () => {
      const list = await api('getComments', { memoryId: m.memoryId }, { silent: true });
      m.comments = list.length; renderTimeline();
      $('#cmList', box).innerHTML = list.length ? `<ul class="block-list">${list.map(c => `<li data-c="${esc(c.commentId)}">
          <span><b>${esc(c.nickname)}</b>　${esc(c.text)}<br><small class="hint">${esc(Rail.fmtDate(c.createdAt))}${c.updatedAt && c.updatedAt !== c.createdAt ? '（編集済み）' : ''}</small></span>
          <span>${c.mine ? '<button type="button" class="btn small ghost" data-c-edit>編集</button>' : ''}${c.canDelete ? '<button type="button" class="btn small danger" data-c-del>削除</button>' : ''}</span>
        </li>`).join('')}</ul>` : '<p class="empty">まだコメントはありません。</p>';
      $$('[data-c-edit]', box).forEach(b => b.onclick = async () => {
        const li = b.closest('li'); const c = list.find(x => x.commentId === li.dataset.c);
        const t = window.prompt('コメントを編集', c.text);
        if (t === null || !t.trim()) return;
        try { await api('editComment', { commentId: c.commentId, text: t }); await draw(); } catch (err) { toast(err.message, 'warn'); }
      });
      $$('[data-c-del]', box).forEach(b => b.onclick = async () => {
        if (!window.confirm('このコメントを削除しますか？')) return;
        try { await api('deleteComment', { commentId: b.closest('li').dataset.c }); await draw(); } catch (err) { toast(err.message, 'warn'); }
      });
    };
    $('#cmForm', box).addEventListener('submit', async e => {
      e.preventDefault(); stopMic();
      const t = $('#cmText', box).value.trim();
      if (!t) return;
      try { await api('addComment', { memoryId: m.memoryId, text: t }); $('#cmText', box).value = ''; await draw(); } catch (err) { toast(err.message, 'warn'); }
    });
    try { await draw(); } catch (err) { $('#cmList', box).innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
  }

  async function fileToPayload(file) {
    if (file.type.startsWith('image/') && !/gif|svg/.test(file.type)) {
      const url = URL.createObjectURL(file);
      try {
        const img = await R.loadImg(url);
        const max = 1600, r = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', 0.86);
        return { mimeType: 'image/jpeg', base64: data.split(',')[1], name: file.name.replace(/\.\w+$/, '') + '.jpg' };
      } finally { URL.revokeObjectURL(url); }
    }
    if (!/^(image|video)\//.test(file.type)) throw new Error('写真または動画を選んでください');
    if (file.size > (C.MAX_UPLOAD_MB || 20) * 1024 * 1024) throw new Error(`ファイルは${C.MAX_UPLOAD_MB || 20}MBまでです。短く編集してからお試しください`);
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = () => rej(new Error('ファイルを読み込めませんでした'));
      fr.readAsDataURL(file);
    });
    return { mimeType: file.type, base64: b64, name: file.name };
  }

  function openMemoryForm(m, presetStation, presetRoute) {
    const isEdit = !!m;
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const v = m || { stationId: presetStation || '', routeId: presetRoute || '', title: '', text: '', url: '', visibility: 'private', takenAt: todayStr };
    const box = openModal(`<h2>${isEdit ? '想い出を編集' : '想い出を記録'}</h2>
      <form id="mf">
        <label class="field">駅<select id="mfStation" required>${stationOptions(v.stationId, { empty: '駅を選んでください' })}</select></label>
        <label class="field">一筆書きの旅（任意）<select id="mfRoute"><option value="">紐づけない</option>${S.routes.map(r => `<option value="${esc(r.routeId)}" ${r.routeId === v.routeId ? 'selected' : ''}>${esc(r.title)}</option>`).join('')}</select></label>
        <label class="field">タイトル<input id="mfTitle" maxlength="40" value="${esc(v.title)}" placeholder="例：朝もやの鉄橋"></label>
        <label class="field">メモ
          <span class="with-mic"><textarea id="mfText" rows="4" maxlength="2000">${esc(v.text)}</textarea><button type="button" class="mic" data-mic="#mfText" aria-label="音声で入力">🎤</button></span>
        </label>
        <label class="field">WebサイトのURL（任意）<input id="mfUrl" type="url" value="${esc(v.url)}" placeholder="https://"></label>
        <label class="field">写真・動画（任意）<input id="mfFile" type="file" accept="image/*,video/*"></label>
        ${isEdit && m.fileId ? '<label class="check"><input type="checkbox" id="mfRemoveFile"> いまの写真・動画を外す</label>' : ''}
        <div class="row2">
          <label class="field">日付<input id="mfDate" type="date" value="${esc(v.takenAt || todayStr)}"></label>
          <label class="field">位置<select id="mfPos"><option value="station">駅の位置</option><option value="here">現在地を使う</option>${isEdit && m.lat !== '' ? '<option value="keep" selected>いまの位置のまま</option>' : ''}</select></label>
        </div>
        <label class="check"><input type="checkbox" id="mfPublic" ${v.visibility === 'public' ? 'checked' : ''}> 会員に公開する（オフなら自分だけが見られます）</label>
        <button type="submit" class="btn primary wide">${isEdit ? '変更を保存' : '記録する'}</button>
      </form>`);

    $('#mf', box).addEventListener('submit', async e => {
      e.preventDefault(); stopMic();
      const stationId = $('#mfStation', box).value;
      if (!ST[stationId]) { toast('駅を選んでください', 'warn'); return; }
      const url = $('#mfUrl', box).value.trim();
      if (url && !/^https?:\/\//i.test(url)) { toast('URLは http:// か https:// から始めてください', 'warn'); return; }
      const submit = $('button[type="submit"]', box);
      submit.disabled = true;
      try {
        let lat = ST[stationId][1], lng = ST[stationId][2];
        const pos = $('#mfPos', box).value;
        if (pos === 'keep') { lat = m.lat; lng = m.lng; }
        if (pos === 'here') {
          const p = await new Promise((res, rej) => {
            if (!navigator.geolocation) return rej(new Error('位置情報が使えません'));
            navigator.geolocation.getCurrentPosition(res, () => rej(new Error('現在地を取得できませんでした。位置情報の許可を確認してください')), { enableHighAccuracy: true, timeout: 12000 });
          });
          lat = p.coords.latitude; lng = p.coords.longitude;
        }
        let fileId = isEdit ? m.fileId : '', fileType = isEdit ? m.fileType : '';
        if ($('#mfRemoveFile', box) && $('#mfRemoveFile', box).checked) { fileId = ''; fileType = ''; }
        const f = $('#mfFile', box).files[0];
        if (f) {
          submit.textContent = 'アップロード中…';
          const up = await api('upload', await fileToPayload(f));
          fileId = up.fileId; fileType = up.fileType;
        }
        submit.textContent = '保存中…';
        const saved = await api('saveMemory', { memory: {
          memoryId: isEdit ? m.memoryId : '', stationId, routeId: $('#mfRoute', box).value,
          title: $('#mfTitle', box).value, text: $('#mfText', box).value, url, fileId, fileType,
          lat, lng, takenAt: $('#mfDate', box).value, visibility: $('#mfPublic', box).checked ? 'public' : 'private'
        } });
        const before = stats();
        if (!isEdit) { S.memoryCount++; announceGains(before); stamp('記録'); }
        closeModal();
        toast(isEdit ? '変更を保存しました' : '想い出をトレカにしました');
        renderMe();
        if (isEdit) {
          const i = S.tl.items.findIndex(x => x.memoryId === saved.memoryId);
          if (i >= 0) { S.tl.items[i] = saved; renderTimeline(); }
        } else {
          S.tl.scope = 'mine'; S.tl.stationId = ''; S.tl.loaded = true; syncSegTabs();
          showView('memories');
          loadTimeline(true).catch(err => toast(err.message, 'warn'));
        }
      } catch (err) { toast(err.message, 'warn'); submit.disabled = false; submit.textContent = isEdit ? '変更を保存' : '記録する'; }
    });
  }

  /* =========================================================
   * マイページ
   * ======================================================= */
  function renderMe() {
    if (!S.user) return;
    const st = stats();
    const toNext = Math.max(0, st.nextKm - st.km);
    $('#meBox').innerHTML = `
      <div class="me-head"><div class="me-head-in">
        <div class="me-level">Lv.${st.level}<small>${esc(st.title)}</small></div>
        <p class="hint">${esc(S.user.nickname)} さん　次のレベルまであと${fmtKm(toNext)}km</p>
        <dl class="stats">
          <div><dt>完乗率</dt><dd>${st.pct.toFixed(1)}%</dd></div>
          <div><dt>完乗距離</dt><dd>${fmtKm(st.km)}km</dd></div>
          <div><dt>完乗線区</dt><dd>${st.segCount} / ${st.segTotal}</dd></div>
          <div><dt>訪問駅</dt><dd>${st.staCount} / ${st.staTotal}</dd></div>
          <div><dt>一筆書き走破</dt><dd>${st.routesDone} / ${st.routesTotal}本</dd></div>
          <div><dt>想い出</dt><dd>${st.memoryCount}件</dd></div>
        </dl>
      </div></div>
      <div class="pane">
        <h2>称号</h2>
        <div class="badges">${st.badges.map(b => `<div class="badge ${b.earned ? '' : 'locked'}"><b>${b.earned ? '' : '🔒 '}${esc(b.name)}</b><span>${esc(b.desc)}</span></div>`).join('')}</div>
      </div>
      <div class="pane">
        <h2>地方ごとの完乗率</h2>
        <div class="region-list">${Object.keys(REG).map(k => `<div class="region-row"><span>${esc(REG[k].name)}</span><span class="bar"><i style="width:${st.region[k].pct}%;background:${REG[k].color}"></i></span><span>${st.region[k].pct.toFixed(1)}%</span></div>`).join('')}</div>
      </div>
      <div class="pane">
        <h2>アカウント</h2>
        <form id="pwForm">
          <label class="field">いまのパスワード<span class="pw"><input type="password" id="pwCur" autocomplete="current-password" required><button type="button" class="eye" aria-label="パスワードを表示">👁</button></span></label>
          <label class="field">新しいパスワード（8文字以上・英字と数字）<span class="pw"><input type="password" id="pwNew" autocomplete="new-password" minlength="8" required><button type="button" class="eye" aria-label="パスワードを表示">👁</button></span></label>
          <label class="field">新しいパスワード（確認）<span class="pw"><input type="password" id="pwNew2" autocomplete="new-password" minlength="8" required><button type="button" class="eye" aria-label="パスワードを表示">👁</button></span></label>
          <button type="submit" class="btn">パスワードを変更する</button>
        </form>
        <p class="section-title">ブロック中のユーザー</p>
        <div id="blockBox"><button type="button" class="btn ghost small" id="loadBlocks">一覧を表示</button></div>
        <div class="btn-row">
          <button type="button" class="btn ghost" data-tutorial>使い方ガイド</button>
          <button type="button" class="btn danger" id="logoutBtn">ログアウト</button>
        </div>
        <p class="hint">${esc(C.APP_NAME || 'ひとふで鉄旅')} ${esc(C.VERSION || '')}　路線データは主要駅・主要線区の簡略版で、営業キロは概算です。</p>
      </div>`;
    $('#logoutBtn').onclick = logout;
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      if ($('#pwNew').value !== $('#pwNew2').value) { toast('新しいパスワードが一致しません', 'warn'); return; }
      try { await api('changePassword', { current: $('#pwCur').value, newPassword: $('#pwNew').value }); $('#pwForm').reset(); toast('パスワードを変更しました'); }
      catch (err) { toast(err.message, 'warn'); }
    };
    $('#loadBlocks').onclick = loadBlocks;
  }

  async function loadBlocks() {
    const box = $('#blockBox');
    try {
      const list = await api('getBlockList');
      box.innerHTML = list.length ? `<ul class="block-list">${list.map(b => `<li><span>${esc(b.nickname)}</span><button type="button" class="btn small ghost" data-unblock="${esc(b.userId)}">解除</button></li>`).join('')}</ul>` : '<p class="hint">ブロック中のユーザーはいません。</p>';
      $$('[data-unblock]', box).forEach(b => b.onclick = async () => {
        try { await api('setBlock', { targetUserId: b.dataset.unblock, on: false }); S.blocks.delete(b.dataset.unblock); toast('ブロックを解除しました'); S.tl.loaded = false; loadBlocks(); }
        catch (err) { toast(err.message, 'warn'); }
      });
    } catch (err) { toast(err.message, 'warn'); }
  }

  /* =========================================================
   * 使い方ガイド
   * ======================================================= */
  const TUT = [
    { t: 'ようこそ、ひとふで鉄旅へ', p: '乗ったJR線を地図に塗り、旅の想い出をトレカにして集めるアプリです。乗るほど地図に色が戻り、レベルと称号が上がります。',
      svg: '<svg viewBox="0 0 320 160"><rect x="10" y="20" width="300" height="120" rx="10" fill="#E4EDD6" stroke="#93AC7E" stroke-width="2"/><text x="160" y="82" text-anchor="middle" font-size="26" fill="#1C2B4A" font-family="serif">はじまり → どこまでも</text><text x="160" y="116" text-anchor="middle" font-size="14" fill="#1C2B4A">JR 一筆書き乗車券</text></svg>' },
    { t: '線をタップして乗車記録', p: 'マップの線をタップして「乗った！」を押すと完乗です。上の「タップで乗車」をオンにすると、線をタップするだけで記録できます。駅をタップすると訪問記録や想い出の登録ができます。',
      svg: '<svg viewBox="0 0 320 160"><path d="M30 120 C110 40 210 140 290 40" stroke="#9AA3A8" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M30 120 C80 70 120 75 160 92" stroke="#11804A" stroke-width="8" fill="none" stroke-linecap="round"/><circle cx="160" cy="92" r="10" fill="#fff" stroke="#1C2B4A" stroke-width="3"/><text x="200" y="128" font-size="18" fill="#B8322A" font-family="serif">乗車！</text></svg>' },
    { t: 'AI車掌が一筆書きの旅を提案', p: '「旅を作る」で気分や日数を選ぶと、同じ駅を2度通らない一筆書きルートを提案します。自分で駅を順にタップして作ることもできます。決めた旅にはオリジナル切符が発行されます。',
      svg: '<svg viewBox="0 0 320 160"><circle cx="70" cy="80" r="40" fill="#1C2B4A"/><text x="70" y="88" text-anchor="middle" font-size="22" fill="#fff">車掌</text><rect x="130" y="40" width="170" height="80" rx="10" fill="#E4EDD6" stroke="#93AC7E" stroke-width="2"/><text x="215" y="76" text-anchor="middle" font-size="14" fill="#1C2B4A">雪景色の</text><text x="215" y="98" text-anchor="middle" font-size="14" fill="#1C2B4A">ひとふで二日旅</text></svg>' },
    { t: '想い出はトレカになる', p: '写真や動画、メモ、URLを駅ごとに記録すると旅の記念トレカになります。会員に公開するか自分だけにするかはワンタップで切り替えられます。公開した記録には「出発進行！」やコメントが届きます。',
      svg: '<svg viewBox="0 0 320 160"><rect x="110" y="10" width="100" height="140" rx="10" fill="#fff" stroke="#3E86C4" stroke-width="5"/><rect x="118" y="34" width="84" height="60" fill="#E4EDD6"/><text x="160" y="28" text-anchor="middle" font-size="12" fill="#3E86C4">稚内</text><text x="160" y="120" text-anchor="middle" font-size="11" fill="#1C2B4A">出発進行！ 12</text></svg>' },
    { t: '走破したら空撮動画も', p: '旅を走破したら「走破した！」を押しましょう。乗り通した線区が自動で完乗になります。ルートはKMLで書き出してGoogle Earth Studioで空撮動画にでき、旅のページで再生できます。',
      svg: '<svg viewBox="0 0 320 160"><path d="M20 130 L100 80 L170 100 L300 30" stroke="#B8322A" stroke-width="6" stroke-dasharray="12 8" fill="none"/><circle cx="240" cy="70" r="40" fill="none" stroke="#B8322A" stroke-width="4"/><text x="240" y="80" text-anchor="middle" font-size="24" fill="#B8322A" font-family="serif">走破</text></svg>' }
  ];
  function openTutorial() {
    let i = 0;
    const draw = () => {
      const s = TUT[i];
      const box = openModal(`<div class="tut-slide"><h2>${esc(s.t)}</h2>${s.svg}<p>${esc(s.p)}</p></div>
        <div class="tut-dots">${TUT.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
        <div class="tut-nav">
          <button type="button" class="btn ghost" id="tutPrev" ${i === 0 ? 'disabled' : ''}>もどる</button>
          <button type="button" class="btn primary" id="tutNext">${i === TUT.length - 1 ? 'はじめる' : 'つぎへ'}</button>
        </div>`);
      $('#tutPrev', box).onclick = () => { i--; draw(); };
      $('#tutNext', box).onclick = () => { if (i === TUT.length - 1) { store.set('htf_tutorial', '1'); closeModal(); } else { i++; draw(); } };
    };
    draw();
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-tutorial]')) openTutorial(); });
  $('#helpBtn').addEventListener('click', openTutorial);

  /* =========================================================
   * 起動
   * ======================================================= */
  $('#quickToggle').addEventListener('change', e => {
    S.quick = e.target.checked;
    toast(S.quick ? '線をタップするだけで乗車記録します（もう一度タップで取り消し）' : '線をタップすると詳細を表示します');
  });

  function startApp() {
    if (!S.started) { S.started = true; initMap(); initTripForm(); }
    renderAll();
    setTimeout(() => S.map.invalidateSize(), 100);
    if (!store.get('htf_tutorial')) openTutorial();
  }

  $('#ver').textContent = C.VERSION || '';
  if (S.token) boot();
  else { showAuth('login'); if (!store.get('htf_tutorial')) openTutorial(); }
})();
