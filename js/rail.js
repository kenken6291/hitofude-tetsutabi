/**
 * ひとふで鉄旅 — 路線グラフ・一筆書き判定・統計・切符SVG・KML
 */
window.Rail = (() => {
  'use strict';
  const ST = window.RAIL_STATIONS;
  const SEG = window.RAIL_SEGMENTS;
  const REG = window.RAIL_REGIONS;
  const segById = {};
  const adj = {};
  const pairKm = {};
  const segsOfStation = {};

  function hav(a, b) {
    const A = ST[a], B = ST[b], R = 6371, r = Math.PI / 180;
    const dLat = (B[1] - A[1]) * r, dLng = (B[2] - A[2]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(A[1] * r) * Math.cos(B[1] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---- グラフ構築 ----
  SEG.forEach(s => {
    segById[s.id] = s;
    const count = {};
    s.st.forEach(id => {
      if (!ST[id]) console.warn('未定義の駅:', id, 'in', s.id);
      count[ST[id][3]] = (count[ST[id][3]] || 0) + 1;
      (segsOfStation[id] = segsOfStation[id] || []).push(s.id);
    });
    s.region = Object.keys(count).sort((x, y) => count[y] - count[x])[0];
    const d = [];
    let tot = 0;
    for (let i = 0; i < s.st.length - 1; i++) { const x = hav(s.st[i], s.st[i + 1]); d.push(x); tot += x; }
    for (let i = 0; i < s.st.length - 1; i++) {
      const a = s.st[i], b = s.st[i + 1], km = s.km * d[i] / tot;
      (adj[a] = adj[a] || []).push({ to: b, seg: s.id, km });
      (adj[b] = adj[b] || []).push({ to: a, seg: s.id, km });
      pairKm[s.id + '|' + a + '|' + b] = km;
      pairKm[s.id + '|' + b + '|' + a] = km;
    }
  });

  const name = id => (ST[id] ? ST[id][0] : id);
  const allowed = (e, opt) => !(opt && opt.localOnly && segById[e.seg].type === 'shinkansen');

  /** 最短経路（km）。avoid に含まれる駅は通らない */
  function shortestPath(a, b, avoid, opt) {
    if (!ST[a] || !ST[b] || a === b) return null;
    if (avoid && avoid.has(b)) return null;
    const dist = { [a]: 0 }, prev = {}, done = new Set();
    for (;;) {
      let u = null, best = Infinity;
      for (const k in dist) if (!done.has(k) && dist[k] < best) { best = dist[k]; u = k; }
      if (u === null) return null;
      if (u === b) break;
      done.add(u);
      (adj[u] || []).forEach(e => {
        if (!allowed(e, opt)) return;
        if (e.to !== b && avoid && avoid.has(e.to)) return;
        const nd = best + e.km;
        if (dist[e.to] === undefined || nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = { from: u, seg: e.seg }; }
      });
    }
    const hops = [];
    let cur = b;
    while (cur !== a) { const p = prev[cur]; hops.unshift({ from: p.from, to: cur, seg: p.seg }); cur = p.from; }
    return hops;
  }

  function edges(a, b, opt) { return (adj[a] || []).filter(e => e.to === b && allowed(e, opt)); }

  /** AI提案などのルートを検証し、つながらない所は補完、2度通る駅があればそこで打ち切る */
  function validateAndRepair(hops, opt) {
    opt = opt || {};
    if (!Array.isArray(hops) || !hops.length) return { ok: false, hops: [], warnings: ['ルートが空でした'] };
    const seq = [];
    const push = id => { if (ST[id] && seq[seq.length - 1] !== id) seq.push(id); };
    push(hops[0].from);
    hops.forEach(h => { push(h.from); push(h.to); });
    const hint = {};
    hops.forEach(h => { hint[h.from + '>' + h.to] = h.seg; });
    const out = [], warn = [];
    if (!seq.length) return { ok: false, hops: [], warnings: ['駅を読み取れませんでした'] };
    const visited = new Set([seq[0]]);
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i + 1];
      if (visited.has(b)) { warn.push(`${name(b)}を2度通るため、${name(a)}で打ち切りました`); break; }
      const direct = edges(a, b, opt);
      if (direct.length) {
        const pick = direct.find(e => e.seg === hint[a + '>' + b]) || direct[0];
        out.push({ from: a, to: b, seg: pick.seg });
        visited.add(b);
        continue;
      }
      const path = shortestPath(a, b, visited, opt);
      if (!path) { warn.push(`${name(a)}から${name(b)}へは一筆書きでつなげませんでした`); break; }
      warn.push(`${name(a)}〜${name(b)}の間を自動でつなぎました`);
      path.forEach(h => { out.push(h); visited.add(h.to); });
    }
    return { ok: out.length > 0, hops: out, warnings: warn };
  }

  function isValid(hops) {
    if (!Array.isArray(hops) || !hops.length) return false;
    const seen = new Set([hops[0].from]);
    for (let i = 0; i < hops.length; i++) {
      const h = hops[i];
      if (i > 0 && hops[i - 1].to !== h.from) return false;
      if (!edges(h.from, h.to).some(e => e.seg === h.seg)) return false;
      if (seen.has(h.to)) return false;
      seen.add(h.to);
    }
    return true;
  }

  const routeStations = hops => (hops && hops.length ? [hops[0].from, ...hops.map(h => h.to)] : []);
  const routeKm = hops => (hops || []).reduce((t, h) => t + (pairKm[h.seg + '|' + h.from + '|' + h.to] || 0), 0);
  const routeSegSet = hops => new Set((hops || []).map(h => h.seg));

  function viaNames(hops) {
    const out = [];
    (hops || []).forEach(h => { const n = segById[h.seg] ? segById[h.seg].name : h.seg; if (out[out.length - 1] !== n) out.push(n); });
    return out;
  }

  /** ルートで全区間を乗り通した線区 */
  function coveredSegs(hops) {
    const pairs = new Set((hops || []).map(h => h.seg + '|' + [h.from, h.to].sort().join('|')));
    return SEG.filter(s => {
      for (let i = 0; i < s.st.length - 1; i++) if (!pairs.has(s.id + '|' + [s.st[i], s.st[i + 1]].sort().join('|'))) return false;
      return true;
    }).map(s => s.id);
  }

  function validDays(km) { return km <= 100 ? 1 : km <= 200 ? 2 : 2 + Math.ceil((km - 200) / 200); }

  /** Gemini に渡す路線グラフ */
  function graphText(opt) {
    const segs = SEG.filter(s => !(opt && opt.localOnly && s.type === 'shinkansen'));
    const used = new Set();
    segs.forEach(s => s.st.forEach(id => used.add(id)));
    const sts = [...used].map(id => `${id}:${name(id)}`).join(', ');
    const lines = segs.map(s => `${s.id}|${s.name}|${s.km}km${s.hikyo ? '|秘境' : ''}|${s.st.join('>')}`).join('\n');
    return `stations: ${sts}\nsegments:\n${lines}`;
  }

  // ---- 統計・レベル・称号 ----
  const LEVEL_TITLES = [[1, '見習い旅人'], [3, '青春きっぷの旅人'], [5, 'ローカル線通'], [8, '乗り鉄の達人'], [12, '一筆書き職人'], [16, '完乗の鉄人'], [19, 'レールの伝説']];
  const levelOf = km => 1 + Math.floor(Math.sqrt(km / 40));
  const kmForLevel = l => 40 * (l - 1) ** 2;

  const BADGES = [
    { id: 'first', name: 'はじめの一歩', desc: 'はじめて線区を乗車記録した', test: c => c.segCount >= 1 },
    { id: 'tokaido', name: '東海道の覇者', desc: '東海道新幹線と東海道本線をすべて完乗', test: c => ['tokaido-shin', 'tokaido-e', 'tokaido-m', 'tokaido-w'].every(id => c.ridden.has(id)) },
    { id: 'shinkansen', name: '新幹線マスター', desc: '全新幹線を完乗', test: c => c.shinTotal > 0 && c.shinDone === c.shinTotal },
    { id: 'hikyo5', name: '秘境線ハンター', desc: '秘境線を5線区完乗', test: c => c.hikyoDone >= 5 },
    { id: 'hikyoAll', name: '秘境線のヌシ', desc: '秘境線をすべて完乗', test: c => c.hikyoTotal > 0 && c.hikyoDone === c.hikyoTotal },
    { id: 'hitofude1', name: '一筆書きデビュー', desc: '一筆書きの旅を1本走破', test: c => c.routesDone >= 1 },
    { id: 'hitofude3', name: '一筆書きマスター', desc: '一筆書きの旅を3本走破', test: c => c.routesDone >= 3 },
    { id: 'long', name: '大回りの王', desc: '1,000km以上の一筆書きを走破', test: c => c.longestDone >= 1000 },
    { id: 'km1000', name: '千キロ乗り', desc: '完乗距離が1,000kmに到達', test: c => c.km >= 1000 },
    { id: 'km5000', name: '五千キロの旅人', desc: '完乗距離が5,000kmに到達', test: c => c.km >= 5000 },
    { id: 'islands', name: '四島制覇', desc: '北海道・本州・四国・九州でそれぞれ乗車', test: c => c.islands >= 4 },
    { id: 'stations30', name: '駅スタンプ帳', desc: '30駅を訪問記録', test: c => c.staCount >= 30 },
    { id: 'memory10', name: '想い出コレクター', desc: '想い出を10件記録', test: c => c.memoryCount >= 10 }
  ].concat(Object.keys(REG).map(k => ({ id: 'reg-' + k, name: REG[k].name + 'の覇者', desc: REG[k].name + 'の線区をすべて完乗', test: c => c.region[k].pct >= 99.95 })));

  function computeStats({ ridden, stations, routes, memoryCount }) {
    let km = 0, total = 0, shinTotal = 0, shinDone = 0, hikyoTotal = 0, hikyoDone = 0, segCount = 0;
    const region = {};
    Object.keys(REG).forEach(k => { region[k] = { total: 0, done: 0, pct: 0 }; });
    const islands = new Set();
    SEG.forEach(s => {
      total += s.km; region[s.region].total += s.km;
      const r = ridden.has(s.id);
      if (r) { km += s.km; segCount++; region[s.region].done += s.km; islands.add(REG[s.region].island); }
      if (s.type === 'shinkansen') { shinTotal++; if (r) shinDone++; }
      if (s.hikyo) { hikyoTotal++; if (r) hikyoDone++; }
    });
    Object.values(region).forEach(r => { r.pct = r.total ? r.done / r.total * 100 : 0; });
    const doneRoutes = (routes || []).filter(r => r.status === 'done');
    const longestDone = doneRoutes.reduce((m, r) => Math.max(m, routeKm(r.hops)), 0);
    const c = {
      ridden, km, totalKm: total, segCount, segTotal: SEG.length, staCount: stations.size,
      staTotal: Object.keys(ST).length, shinTotal, shinDone, hikyoTotal, hikyoDone,
      routesDone: doneRoutes.length, routesTotal: (routes || []).length, longestDone,
      memoryCount: memoryCount || 0, region, islands: islands.size
    };
    const level = levelOf(km);
    let title = LEVEL_TITLES[0][1];
    LEVEL_TITLES.forEach(([l, t]) => { if (level >= l) title = t; });
    return Object.assign(c, {
      pct: total ? km / total * 100 : 0, level, title,
      levelKm: kmForLevel(level), nextKm: kmForLevel(level + 1),
      badges: BADGES.map(b => ({ id: b.id, name: b.name, desc: b.desc, earned: !!b.test(c) }))
    });
  }

  // ---- 切符SVG ----
  const xml = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
  const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  function fmtDate(ms) { const d = new Date(Number(ms) || Date.now()); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; }
  let svgSeq = 0;

  function ticketSVG(route, opt) {
    opt = opt || {};
    const uid = 'tk' + (++svgSeq);
    const st = routeStations(route.hops);
    if (!st.length) return '';
    const from = name(st[0]), to = name(st[st.length - 1]);
    const km = routeKm(route.hops);
    const via = viaNames(route.hops);
    const viaText = via.length > 3 ? via.slice(0, 3).join('・') + ` ほか${via.length - 3}線` : via.join('・');
    const date = fmtDate(route.createdAt);
    const no = route.ticketNo ? 'No.' + route.ticketNo : '見本';
    const title = route.title || '一筆書きの旅';
    const big = (from + to).length > 9 ? 32 : 44;
    const done = opt.done || route.status === 'done';
    const stampDate = fmtDate(route.doneAt || Date.now()).replace(/年|月/g, '.').replace('日', '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 320" role="img" aria-label="${xml(title)}の切符">
<defs>
<pattern id="${uid}p" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 9 Q4.5 2 9 9 T18 9" fill="none" stroke="#B4CA9F" stroke-width="1.1"/><path d="M0 18 Q4.5 11 9 18 T18 18" fill="none" stroke="#CBDBBA" stroke-width=".9"/></pattern>
<mask id="${uid}m"><rect width="600" height="320" fill="#fff"/>${done ? '<path d="M118 0 h20 l-4 18 h-12 z" fill="#000"/>' : ''}</mask>
</defs>
<g mask="url(#${uid}m)">
<rect x="2" y="2" width="596" height="316" rx="10" fill="#E4EDD6" stroke="#93AC7E" stroke-width="2"/>
<rect x="2" y="2" width="596" height="316" rx="10" fill="url(#${uid}p)" opacity=".85"/>
</g>
<g font-family="'Zen Antique','Zen Kaku Gothic New','Hiragino Mincho ProN',serif" fill="#1C2B4A">
<text x="28" y="46" font-size="18">JR　一筆書き乗車券</text>
<text x="572" y="46" font-size="16" text-anchor="end">${xml(no)}</text>
<line x1="28" y1="60" x2="572" y2="60" stroke="#1C2B4A" stroke-width="1.5"/>
<text x="300" y="${big === 44 ? 126 : 120}" font-size="${big}" text-anchor="middle" letter-spacing="2">${xml(from)} → ${xml(to)}</text>
<text x="300" y="166" font-size="20" text-anchor="middle">「${xml(trunc(title, 22))}」</text>
<text x="300" y="200" font-size="14" text-anchor="middle">経由：${xml(trunc(viaText, 38))}</text>
<line x1="28" y1="222" x2="572" y2="222" stroke="#1C2B4A" stroke-width="1" stroke-dasharray="4 4"/>
<text x="28" y="256" font-size="16">営業キロ ${km.toFixed(1)}km</text>
<text x="572" y="256" font-size="16" text-anchor="end">有効${validDays(km)}日間　${st.length}駅</text>
<text x="28" y="292" font-size="14">${xml(date)}発行</text>
<text x="572" y="292" font-size="14" text-anchor="end">ひとふで鉄旅</text>
</g>
${done ? `<g transform="rotate(-14 478 132)" opacity=".86" font-family="'Zen Antique',serif" fill="#B8322A">
<circle cx="478" cy="132" r="54" fill="none" stroke="#B8322A" stroke-width="4"/>
<circle cx="478" cy="132" r="45" fill="none" stroke="#B8322A" stroke-width="1.5"/>
<text x="478" y="138" font-size="30" text-anchor="middle">走破</text>
<text x="478" y="162" font-size="12" text-anchor="middle">${xml(stampDate)}</text></g>` : ''}
</svg>`;
  }

  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めませんでした')); i.src = src; });
  }

  async function svgToPng(svg, scale) {
    scale = scale || 2;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = await loadImg(url);
      const c = document.createElement('canvas');
      c.width = 600 * scale; c.height = 320 * scale;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
  }

  // ---- KML（Google Earth Studio 取り込み用） ----
  function kml(route) {
    const st = routeStations(route.hops);
    const coords = st.map(id => `${ST[id][2]},${ST[id][1]},0`).join(' ');
    const pms = st.map((id, i) => `<Placemark><name>${i + 1}. ${xml(name(id))}</name><Point><coordinates>${ST[id][2]},${ST[id][1]},0</coordinates></Point></Placemark>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>${xml(route.title || '一筆書きの旅')}</name>
<Style id="rt"><LineStyle><color>ff2a32b8</color><width>5</width></LineStyle></Style>
<Placemark><name>${xml(route.title || 'route')}</name><styleUrl>#rt</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>
${pms}
</Document></kml>`;
  }

  return {
    ST, SEG, REG, segById, segsOfStation, name, shortestPath, validateAndRepair, isValid,
    routeStations, routeKm, routeSegSet, viaNames, coveredSegs, validDays, graphText,
    computeStats, ticketSVG, svgToPng, kml, fmtDate, loadImg
  };
})();
