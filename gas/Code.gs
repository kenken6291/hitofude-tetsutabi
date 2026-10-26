/**
 * ひとふで鉄旅 — GAS バックエンド
 * v1.0.0
 *
 * 【初回セットアップ】
 * 1. スクリプトプロパティに GEMINI_API_KEY を登録
 *    （任意）GEMINI_MODEL / TTS_MODEL / TTS_VOICE / ADMIN_EMAIL
 * 2. エディタで setup() を1回実行（スプレッドシート・Driveフォルダ・PEPPER を自動作成）
 * 3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *    実行ユーザー：自分 ／ アクセス：全員
 * 4. 発行された URL を config.js の GAS_URL に貼る
 *
 * ※コードを変更したら「デプロイを管理 → 編集 → バージョン：新バージョン」で再デプロイしてください。
 */

const APP_VERSION = 'v1.0.0';
const APP_NAME = 'ひとふで鉄旅';
const PROPS = PropertiesService.getScriptProperties();
const SESSION_TTL = 21600; // 6時間（CacheService の上限）
const MAX_FAIL = 5;
const LOCK_MIN = 15;

const SCHEMA = {
  Users: ['userId', 'email', 'nickname', 'hash', 'salt', 'mustChange', 'failCount', 'lockedUntil', 'createdAt', 'lastLogin', 'agreedAt', 'status'],
  Rides: ['userId', 'kind', 'targetId', 'createdAt'],
  Routes: ['routeId', 'userId', 'title', 'catchcopy', 'hopsJson', 'status', 'ticketNo', 'narration', 'videoUrl', 'mood', 'extraJson', 'createdAt', 'doneAt'],
  Memories: ['memoryId', 'userId', 'stationId', 'routeId', 'title', 'text', 'url', 'fileId', 'fileType', 'lat', 'lng', 'visibility', 'takenAt', 'createdAt', 'updatedAt'],
  Likes: ['memoryId', 'userId', 'createdAt'],
  Comments: ['commentId', 'memoryId', 'userId', 'text', 'createdAt', 'updatedAt'],
  Blocks: ['userId', 'blockedId', 'createdAt']
};

const PUBLIC_ACTIONS = ['ping', 'register', 'login', 'resetPassword'];
const MUST_CHANGE_OK = ['changePassword', 'logout', 'bootstrap'];

const ACTIONS = {
  ping: () => ({ app: APP_NAME, version: APP_VERSION }),
  register, login, logout, changePassword, resetPassword, bootstrap,
  toggleRide, bulkRide,
  saveRoute, setRouteStatus, setRouteVideo, deleteRoute,
  aiRoute, aiText, tts, upload,
  saveMemory, setVisibility, deleteMemory, getMemories,
  toggleLike, getComments, addComment, editComment, deleteComment,
  setBlock, getBlockList
};

/* ============================================================
 * エントリーポイント
 * ========================================================== */
function doGet() {
  return out_({ ok: true, data: { app: APP_NAME, version: APP_VERSION } });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return out_({ ok: false, error: 'リクエストを読み取れませんでした' }); }
  try {
    const fn = ACTIONS[req.action];
    if (!fn) throw err_('不明な操作です');
    let uid = null;
    if (PUBLIC_ACTIONS.indexOf(req.action) < 0) {
      uid = session_(req.token);
      if (!uid) return out_({ ok: false, code: 'AUTH', error: 'ログインの有効期限が切れました。もう一度ログインしてください' });
      const u = getUser_(uid);
      if (!u || u.status === 'suspended') return out_({ ok: false, code: 'AUTH', error: 'このアカウントは利用できません' });
      if (String(u.mustChange) === '1' && MUST_CHANGE_OK.indexOf(req.action) < 0) {
        return out_({ ok: false, code: 'MUST_CHANGE', error: '先に新しいパスワードを設定してください' });
      }
    }
    return out_({ ok: true, data: fn(req, uid) });
  } catch (err) {
    console.error(err && err.stack || err);
    return out_({ ok: false, error: (err && err.message) || 'エラーが発生しました' });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
 * セットアップ
 * ========================================================== */
function setup() {
  let ss;
  const id = PROPS.getProperty('SPREADSHEET_ID');
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create(APP_NAME + '_DB'); PROPS.setProperty('SPREADSHEET_ID', ss.getId()); }
  Object.keys(SCHEMA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  ['Sheet1', 'シート1'].forEach(n => { const s = ss.getSheetByName(n); if (s && ss.getSheets().length > 1) ss.deleteSheet(s); });
  if (!PROPS.getProperty('DRIVE_FOLDER_ID')) {
    const f = DriveApp.createFolder(APP_NAME + '_アップロード');
    PROPS.setProperty('DRIVE_FOLDER_ID', f.getId());
  }
  if (!PROPS.getProperty('PEPPER')) PROPS.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('セットアップ完了：' + ss.getUrl());
  Logger.log('Driveフォルダ：' + PROPS.getProperty('DRIVE_FOLDER_ID'));
  if (!PROPS.getProperty('GEMINI_API_KEY')) Logger.log('※スクリプトプロパティに GEMINI_API_KEY を登録してください');
}

/* ============================================================
 * シート操作
 * ========================================================== */
function ss_() {
  const id = PROPS.getProperty('SPREADSHEET_ID');
  if (!id) throw err_('サーバーの初期設定が済んでいません（setup() を実行してください）');
  return SpreadsheetApp.openById(id);
}
function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw err_('シート ' + name + ' がありません（setup() を実行してください）');
  return sh;
}
function table_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const cols = SCHEMA[name];
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((k, j) => { o[k] = r[j]; });
    return o;
  });
}
/** 文字列は先頭に ' を付けて保存（数式・日付への自動変換を防ぐ） */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return v === '' ? '' : "'" + v;
  return v;
}
function insert_(name, obj) { sheet_(name).appendRow(SCHEMA[name].map(k => cell_(obj[k]))); }
function insertMany_(name, list) {
  if (!list.length) return;
  const sh = sheet_(name);
  const rows = list.map(o => SCHEMA[name].map(k => cell_(o[k])));
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, SCHEMA[name].length).setValues(rows);
}
function patch_(name, row, obj) {
  const sh = sheet_(name);
  const cols = SCHEMA[name];
  const rng = sh.getRange(row, 1, 1, cols.length);
  const cur = rng.getValues()[0];
  const next = cols.map((k, j) => cell_(obj[k] !== undefined ? obj[k] : cur[j]));
  rng.setValues([next]);
}
function removeRows_(name, rows) {
  const sh = sheet_(name);
  rows.slice().sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============================================================
 * ユーティリティ
 * ========================================================== */
function err_(m) { return new Error(m); }
function str_(v, max) { return String(v === null || v === undefined ? '' : v).slice(0, max || 1000); }
function normEmail_(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120 ? s : '';
}
function idOk_(s) { return /^[a-z0-9-]{1,40}$/.test(String(s || '')); }
function urlOk_(u) { return !u || /^https?:\/\/[^\s<>"]+$/i.test(u); }
function num_(v) { const n = Number(v); return isFinite(n) ? n : ''; }

/* ============================================================
 * 認証
 * ========================================================== */
function hash_(pw, salt) {
  const pepper = PROPS.getProperty('PEPPER') || '';
  let h = salt + '|' + pw + '|' + pepper;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + salt, Utilities.Charset.UTF_8));
  }
  return h;
}
function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
    let p = '';
    for (let i = 0; i < 10; i++) p += chars[(bytes[i] + 256) % chars.length];
    if (/\d/.test(p) && /[A-Za-z]/.test(p)) return p;
  }
}
function pwPolicy_(pw) {
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(pw)) throw err_('パスワードは8〜64文字で、英字と数字を両方含めてください');
}
function getUser_(uid) { return table_('Users').filter(u => u.userId === uid)[0]; }
function findUserByEmail_(email) { return table_('Users').filter(u => String(u.email).toLowerCase() === email)[0]; }
function publicUser_(u) {
  return { userId: u.userId, nickname: u.nickname, email: u.email, mustChange: String(u.mustChange) === '1', createdAt: Number(u.createdAt) };
}
function newSession_(uid) {
  const t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + t, uid, SESSION_TTL);
  return t;
}
function session_(t) {
  if (!t || !/^[a-f0-9]{64}$/.test(String(t))) return null;
  const c = CacheService.getScriptCache();
  const uid = c.get('s_' + t);
  if (uid) c.put('s_' + t, uid, SESSION_TTL); // 使うたびに延長
  return uid;
}
function sendTempMail_(email, nickname, temp, kind) {
  const subject = kind === 'register' ? `【${APP_NAME}】会員登録ありがとうございます（仮パスワードのお知らせ）` : `【${APP_NAME}】仮パスワードを再発行しました`;
  const body = `${nickname} 様

${APP_NAME}をご利用いただきありがとうございます。
${kind === 'register' ? '会員登録を受け付けました。' : 'パスワードの再発行を受け付けました。'}

仮パスワード：${temp}

ログイン後、新しいパスワードの設定をお願いします。
※このメールに心当たりがない場合は、破棄してください。

${APP_NAME}`;
  MailApp.sendEmail({ to: email, subject: subject, body: body, name: APP_NAME });
}

function register(req) {
  const email = normEmail_(req.email);
  const nickname = str_(req.nickname, 20).trim();
  if (!email) throw err_('メールアドレスの形式が正しくありません');
  if (!nickname) throw err_('ニックネームを入力してください');
  if (req.agree !== true) throw err_('利用規約・免責事項への同意が必要です');
  return withLock_(() => {
    const users = table_('Users');
    if (users.some(u => String(u.email).toLowerCase() === email)) throw err_('このメールアドレスは登録済みです。「パスワードを忘れた」から再発行できます');
    if (users.some(u => String(u.nickname) === nickname)) throw err_('このニックネームはほかの方が使っています');
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    sendTempMail_(email, nickname, temp, 'register');
    const now = Date.now();
    insert_('Users', {
      userId: Utilities.getUuid(), email: email, nickname: nickname, hash: hash_(temp, salt), salt: salt,
      mustChange: 1, failCount: 0, lockedUntil: 0, createdAt: now, lastLogin: '', agreedAt: now, status: 'active'
    });
    return { message: '仮パスワードをメールで送りました。届いたパスワードでログインしてください' };
  });
}

function login(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  const NG = 'メールアドレスまたはパスワードが違います';
  return withLock_(() => {
    const u = email && findUserByEmail_(email);
    if (!u) throw err_(NG);
    if (u.status === 'suspended') throw err_('このアカウントは利用停止中です');
    const now = Date.now();
    if (Number(u.lockedUntil) > now) {
      throw err_(`ログインに${MAX_FAIL}回失敗したため一時的にロックしています。あと${Math.ceil((Number(u.lockedUntil) - now) / 60000)}分お待ちください`);
    }
    if (hash_(pw, u.salt) !== u.hash) {
      const f = Number(u.failCount || 0) + 1;
      if (f >= MAX_FAIL) {
        patch_('Users', u._row, { failCount: 0, lockedUntil: now + LOCK_MIN * 60000 });
        throw err_(`${MAX_FAIL}回続けて失敗したため、${LOCK_MIN}分間ロックしました`);
      }
      patch_('Users', u._row, { failCount: f });
      throw err_(NG);
    }
    patch_('Users', u._row, { failCount: 0, lockedUntil: 0, lastLogin: now });
    return { token: newSession_(u.userId), user: publicUser_(u) };
  });
}

function logout(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + req.token);
  return { ok: true };
}

function changePassword(req, uid) {
  const cur = String(req.current || ''), next = String(req.newPassword || '');
  pwPolicy_(next);
  if (cur === next) throw err_('いまと同じパスワードは使えません');
  return withLock_(() => {
    const u = getUser_(uid);
    if (hash_(cur, u.salt) !== u.hash) throw err_('いまのパスワード（仮パスワード）が違います');
    const salt = Utilities.getUuid();
    patch_('Users', u._row, { hash: hash_(next, salt), salt: salt, mustChange: 0, failCount: 0 });
    return { ok: true };
  });
}

function resetPassword(req) {
  const email = normEmail_(req.email);
  const msg = { message: '登録済みのメールアドレスであれば、仮パスワードを送りました。メールをご確認ください' };
  if (!email) throw err_('メールアドレスの形式が正しくありません');
  return withLock_(() => {
    const u = findUserByEmail_(email);
    if (!u || u.status === 'suspended') return msg;
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    sendTempMail_(email, u.nickname, temp, 'reset');
    patch_('Users', u._row, { hash: hash_(temp, salt), salt: salt, mustChange: 1, failCount: 0, lockedUntil: 0 });
    return msg;
  });
}

/* ============================================================
 * 初期データ・乗車記録
 * ========================================================== */
function bootstrap(req, uid) {
  const u = getUser_(uid);
  return {
    user: publicUser_(u),
    rides: table_('Rides').filter(r => r.userId === uid).map(r => ({ kind: r.kind, targetId: r.targetId })),
    routes: table_('Routes').filter(r => r.userId === uid).map(routeOut_),
    blocks: table_('Blocks').filter(b => b.userId === uid).map(b => b.blockedId),
    memoryCount: table_('Memories').filter(m => m.userId === uid).length
  };
}

function toggleRide(req, uid) {
  const kind = req.kind === 'sta' ? 'sta' : req.kind === 'seg' ? 'seg' : '';
  if (!kind || !idOk_(req.targetId)) throw err_('記録する対象が正しくありません');
  return withLock_(() => {
    const hit = table_('Rides').filter(r => r.userId === uid && r.kind === kind && r.targetId === req.targetId);
    if (req.on && !hit.length) insert_('Rides', { userId: uid, kind: kind, targetId: req.targetId, createdAt: Date.now() });
    if (!req.on && hit.length) removeRows_('Rides', hit.map(r => r._row));
    return { on: !!req.on };
  });
}

function bulkRide(req, uid) {
  const kind = req.kind === 'sta' ? 'sta' : 'seg';
  const ids = (Array.isArray(req.ids) ? req.ids : []).filter(idOk_).slice(0, 300);
  return withLock_(() => {
    const mine = table_('Rides').filter(r => r.userId === uid && r.kind === kind);
    const have = {};
    mine.forEach(r => { have[r.targetId] = r; });
    if (req.on) {
      const now = Date.now();
      insertMany_('Rides', ids.filter(id => !have[id]).map(id => ({ userId: uid, kind: kind, targetId: id, createdAt: now })));
    } else {
      removeRows_('Rides', ids.filter(id => have[id]).map(id => have[id]._row));
    }
    return { count: ids.length };
  });
}

/* ============================================================
 * 一筆書きルート
 * ========================================================== */
function routeOut_(r) {
  let hops = [], extra = {};
  try { hops = JSON.parse(r.hopsJson || '[]'); } catch (e) {}
  try { extra = JSON.parse(r.extraJson || '{}'); } catch (e) {}
  return {
    routeId: r.routeId, title: r.title, catchcopy: r.catchcopy, hops: hops, status: r.status,
    ticketNo: String(r.ticketNo), narration: r.narration, videoUrl: r.videoUrl, mood: r.mood, extra: extra,
    createdAt: Number(r.createdAt), doneAt: Number(r.doneAt) || 0
  };
}
function ownRoute_(routeId, uid) {
  const r = table_('Routes').filter(x => x.routeId === routeId)[0];
  if (!r || r.userId !== uid) throw err_('旅が見つかりません');
  return r;
}

function saveRoute(req, uid) {
  const d = req.route || {};
  const hops = Array.isArray(d.hops) ? d.hops.slice(0, 300) : [];
  if (!hops.length) throw err_('ルートが空です');
  // 形式チェックと一筆書き（同じ駅を2度通らない）チェック
  const seen = {};
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    if (!idOk_(h.from) || !idOk_(h.to) || !idOk_(h.seg)) throw err_('ルートの形式が正しくありません');
    if (i > 0 && hops[i - 1].to !== h.from) throw err_('ルートがつながっていません');
    if (i === 0) seen[h.from] = 1;
    if (seen[h.to]) throw err_('同じ駅を2度通るルートは保存できません');
    seen[h.to] = 1;
  }
  const clean = hops.map(h => ({ from: h.from, to: h.to, seg: h.seg }));
  const extra = d.extra || {};
  const extraClean = {
    highlights: (extra.highlights || []).slice(0, 8).map(s => str_(s, 120)),
    ekiben: (extra.ekiben || []).slice(0, 6).map(s => str_(s, 80))
  };
  return withLock_(() => {
    const all = table_('Routes');
    const now = Date.now();
    const obj = {
      routeId: Utilities.getUuid(), userId: uid, title: str_(d.title, 40) || '一筆書きの旅', catchcopy: str_(d.catchcopy, 80),
      hopsJson: JSON.stringify(clean), status: 'challenge', ticketNo: ('00000' + (all.length + 1)).slice(-5),
      narration: str_(d.narration, 1200), videoUrl: '', mood: str_(d.mood, 120), extraJson: JSON.stringify(extraClean),
      createdAt: now, doneAt: ''
    };
    insert_('Routes', obj);
    return routeOut_(obj);
  });
}

function setRouteStatus(req, uid) {
  const status = req.status === 'done' ? 'done' : 'challenge';
  return withLock_(() => {
    const r = ownRoute_(req.routeId, uid);
    const doneAt = status === 'done' ? Date.now() : '';
    patch_('Routes', r._row, { status: status, doneAt: doneAt });
    r.status = status; r.doneAt = doneAt;
    return routeOut_(r);
  });
}

function setRouteVideo(req, uid) {
  const url = str_(req.videoUrl, 500).trim();
  if (url && !/^https:\/\/[^\s<>"]+$/i.test(url)) throw err_('https:// から始まるURLを入力してください');
  return withLock_(() => {
    const r = ownRoute_(req.routeId, uid);
    patch_('Routes', r._row, { videoUrl: url });
    return { videoUrl: url };
  });
}

function deleteRoute(req, uid) {
  return withLock_(() => {
    const r = ownRoute_(req.routeId, uid);
    removeRows_('Routes', [r._row]);
    return { ok: true };
  });
}

/* ============================================================
 * Gemini（テキスト）
 * ========================================================== */
const SYS_CONDUCTOR = 'あなたはJR線の旅を案内する、明るく親しみやすいAI車掌です。' +
  '日本の鉄道・駅・沿線の風景や名物に詳しく、旅心をくすぐる言葉で案内します。' +
  '不確かな情報（具体的な時刻・料金・営業状況）は断定しません。出力は指定された JSON のみです。';

const NARRATION_RULE = 'narration は音声でそのまま読み上げる本文だけを書きます。' +
  '「以下」「読み上げ」「ナレーション」などの前置きや説明、括弧書きのト書き、記号、絵文字、URL は入れません。' +
  '車掌アナウンス風に「ご乗車ありがとうございます。」などで始め、です・ます調で明るく、150〜220字にします。';

function gemini_(prompt, opt) {
  opt = opt || {};
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) throw err_('AI機能の設定が済んでいません（GEMINI_API_KEY）');
  const model = PROPS.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: opt.temperature === undefined ? 0.8 : opt.temperature }
  };
  if (opt.json) body.generationConfig.responseMimeType = 'application/json';
  if (opt.system) body.systemInstruction = { parts: [{ text: opt.system }] };
  const j = fetchGemini_(model, body, key);
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text) throw err_('AIから応答がありませんでした。時間をおいてもう一度お試しください');
  return text;
}

function fetchGemini_(model, body, key) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  let last = '';
  for (let i = 0; i < 3; i++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    last = code + ' ' + res.getContentText().slice(0, 300);
    if ([429, 500, 503].indexOf(code) < 0) break;
    Utilities.sleep(1500 * (i + 1));
  }
  console.error('Gemini error: ' + last);
  throw err_('AIが混み合っているか、設定に問題があります。時間をおいてもう一度お試しください');
}

function parseJson_(t) {
  let s = String(t || '').replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { throw err_('AIの返答を読み取れませんでした。もう一度お試しください'); }
}

function aiRoute(req) {
  const moods = (Array.isArray(req.moods) ? req.moods : []).slice(0, 10).map(m => str_(m, 30));
  const daysLabel = str_(req.daysLabel || req.days, 20);
  const graph = str_(req.graph, 24000);
  if (!graph) throw err_('路線データがありません');
  const ridden = (Array.isArray(req.ridden) ? req.ridden : []).filter(idOk_).slice(0, 200);
  const start = req.start && idOk_(req.start.id) ? req.start : null;
  const kmGuide = { '1': '150〜400km', '2': '300〜800km', '3': '500〜1200km', '5': '800〜2500km' }[String(req.days)] || '300〜800km';

  const prompt = `次の路線グラフだけを使って、JRの「一筆書き」の旅を1つ提案してください。

## 路線グラフ
（stations は「駅ID:駅名」、segments は「線区ID|線区名|営業キロ|(秘境)|通過駅IDを > でつないだもの」。> で隣り合う駅の間だけ移動できます）
${graph}

## 条件
- 気分タグ：${moods.length ? moods.join('、') : 'おまかせ'}
- 日数：${daysLabel}（総距離の目安 ${kmGuide}）
- 出発駅：${start ? start.name + '（' + start.id + '）' : 'おまかせ'}
- ${req.localOnly ? '新幹線は使わない（在来線のみ）' : '新幹線も使ってよい'}
${ridden.length ? '- まだ乗っていない線区を優先する。乗車済みの線区ID：' + ridden.join(', ') : ''}
${req.free ? '- 利用者からのリクエスト：' + str_(req.free, 300) : ''}

## 一筆書きのルール（必ず守る）
- 同じ駅を2度通らない（出発駅に戻る周回もしない）
- hops は隣り合う駅どうしの移動を順番に並べる。from と to は駅ID、seg はその2駅が隣り合う線区ID
- hops[n].to と hops[n+1].from は同じ駅
- 存在しない駅IDや線区IDを作らない

## 出力（この JSON だけを返す）
{
  "title": "ドラマチックな旅のタイトル（20字以内）",
  "catchcopy": "旅のひとこと（40字以内）",
  "hops": [{"from":"駅ID","to":"駅ID","seg":"線区ID"}],
  "highlights": ["車窓や途中下車の見どころ（3〜5個、各40字以内）"],
  "ekiben": ["沿線の駅弁・名物（2〜4個、各30字以内）"],
  "narration": "出発前の車掌アナウンス"
}
${NARRATION_RULE}`;
  const obj = parseJson_(gemini_(prompt, { json: true, system: SYS_CONDUCTOR, temperature: 0.9 }));
  return {
    title: str_(obj.title, 40), catchcopy: str_(obj.catchcopy, 80),
    hops: (Array.isArray(obj.hops) ? obj.hops : []).slice(0, 300).map(h => ({ from: str_(h.from, 40), to: str_(h.to, 40), seg: str_(h.seg, 40) })),
    highlights: (obj.highlights || []).slice(0, 6).map(s => str_(s, 120)),
    ekiben: (obj.ekiben || []).slice(0, 5).map(s => str_(s, 80)),
    narration: sanitizeForTts_(obj.narration)
  };
}

function aiText(req, uid) {
  const mode = String(req.mode || '');
  let prompt;
  if (mode === 'station') {
    prompt = `${str_(req.stationName, 20)}駅（${str_(req.region, 10)}地方）を、旅人向けに紹介してください。
この駅を通る線区：${(req.lines || []).slice(0, 10).map(s => str_(s, 40)).join('、')}
駅の雰囲気、乗り換えの楽しみ、周辺の見どころや名物を盛り込みます。
出力（JSONのみ）：{"summary":"画面に表示する紹介文（120〜180字）","narration":"同じ内容の読み上げ用本文"}
${NARRATION_RULE}`;
  } else if (mode === 'name') {
    prompt = `次の一筆書きルートに、旅心をくすぐる名前とアナウンスを付けてください。
経由する駅：${(req.stations || []).slice(0, 120).map(s => str_(s, 20)).join('→')}
経由する線区：${(req.via || []).slice(0, 40).map(s => str_(s, 40)).join('、')}
総距離：約${num_(req.km)}km
出力（JSONのみ）：{"title":"ドラマチックな旅のタイトル（20字以内）","catchcopy":"ひとこと（40字以内）","highlights":["見どころ3〜5個（各40字以内）"],"narration":"出発前の車掌アナウンス"}
${NARRATION_RULE}`;
  } else if (mode === 'summary') {
    const r = ownRoute_(req.routeId, uid);
    const mems = table_('Memories').filter(m => m.userId === uid && m.routeId === r.routeId)
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt)).slice(0, 30)
      .map(m => `・${str_(m.takenAt, 10)} ${str_(m.title, 40)}：${str_(m.text, 200)}`).join('\n');
    prompt = `一筆書きの旅「${str_(r.title, 40)}」をふりかえります。
経由する駅：${(req.stations || []).slice(0, 120).map(s => str_(s, 20)).join('→')}
経由する線区：${(req.via || []).slice(0, 40).map(s => str_(s, 40)).join('、')}
旅人の記録：
${mems || '（記録はまだありません。ルートの魅力を中心にまとめてください）'}
旅人の記録を大切にしながら、旅の要約と沿線の解説を温かくまとめてください。
出力（JSONのみ）：{"summary":"画面に表示する旅のまとめ（200〜300字）","narration":"同じ内容を車掌が語りかける読み上げ用本文"}
${NARRATION_RULE.replace('150〜220字', '200〜300字')}`;
  } else throw err_('不明なAIモードです');
  const obj = parseJson_(gemini_(prompt, { json: true, system: SYS_CONDUCTOR }));
  return {
    title: str_(obj.title, 40), catchcopy: str_(obj.catchcopy, 80), summary: str_(obj.summary, 800),
    highlights: (obj.highlights || []).slice(0, 6).map(s => str_(s, 120)),
    narration: sanitizeForTts_(obj.narration)
  };
}

/* ============================================================
 * Gemini TTS（AI車掌の声）
 * ========================================================== */
/**
 * 読み上げ原稿のサニタイズ。
 * メタ文（「以下を読み上げます」「明るい口調で」等）・ト書き・記号を除き、純粋な本文だけを TTS に渡す。
 * 声の明るさはテキストに書かず、声のプリセット（TTS_VOICE）で表現する＝指示文が発声されない。
 */
function sanitizeForTts_(t) {
  let s = String(t || '');
  s = s.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/https?:\/\/\S+/g, '');
  s = s.replace(/[*#_`>~|]/g, '');
  s = s.replace(/^\s*[-・●■◆◇○]\s*/gm, '');
  s = s.replace(/^\s*(ナレーション|読み上げ(原稿|文)?|原稿|本文|AI車掌|車掌|セリフ|台詞|音声|narration|script)\s*[:：]\s*/gim, '');
  s = s.replace(/[（(][^（）()]{0,30}(読み|口調|トーン|声|調子|間を|笑|SE|BGM|効果音|ゆっくり|明るく|元気)[^（）()]{0,30}[）)]/g, '');
  s = s.replace(/[\[【〔][^\]】〕]{0,40}[\]】〕]/g, '');
  const meta = [
    /読み上げ(て|ます|る|を|用|原稿)/, /^以下(を|は|の|に)/, /(トーン|口調|声色|話し方|調子)で(読|話|お願い)/,
    /ナレーション(を|です|として|案)/, /(承知|かしこまり)ました/, /^(はい|了解|わかりました)[、。!！]?\s*$/,
    /(プロンプト|システム指示|内部指示)/, /^(here|sure|okay|ok)\b/i
  ];
  s = s.split(/\n+/).map(l => l.trim()).filter(l => l && !meta.some(r => r.test(l))).join('\n');
  s = s.replace(/^[「『"“]+/, '').replace(/[」』"”]+$/, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

function tts(req) {
  const text = sanitizeForTts_(req.text).slice(0, 1200);
  if (!text) throw err_('読み上げる文章がありません');
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) throw err_('AI機能の設定が済んでいません（GEMINI_API_KEY）');
  const model = PROPS.getProperty('TTS_MODEL') || 'gemini-2.5-flash-preview-tts';
  const voice = /^[A-Za-z]{2,20}$/.test(String(req.voice || '')) ? req.voice : (PROPS.getProperty('TTS_VOICE') || 'Puck');
  // contents には本文だけを入れる（指示文を混ぜると発声されてしまうため）
  const body = {
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const j = fetchGemini_(model, body, key);
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const audio = parts.filter(p => p.inlineData && p.inlineData.data)[0];
  if (!audio) throw err_('音声を作れませんでした');
  return { mimeType: audio.inlineData.mimeType, data: audio.inlineData.data };
}

/* ============================================================
 * Drive アップロード
 * ========================================================== */
function userFolder_(uid) {
  const root = DriveApp.getFolderById(PROPS.getProperty('DRIVE_FOLDER_ID'));
  const it = root.getFoldersByName(uid);
  return it.hasNext() ? it.next() : root.createFolder(uid);
}

function upload(req, uid) {
  const mime = String(req.mimeType || '');
  if (!/^(image|video)\/[\w.+-]+$/.test(mime) || /svg/.test(mime)) throw err_('写真または動画だけアップロードできます');
  if (!req.base64) throw err_('ファイルが空です');
  const bytes = Utilities.base64Decode(req.base64);
  if (bytes.length > 25 * 1024 * 1024) throw err_('ファイルが大きすぎます');
  const name = (Date.now() + '_' + str_(req.name, 80)).replace(/[\\/:*?"<>|]/g, '_');
  const file = userFolder_(uid).createFile(Utilities.newBlob(bytes, mime, name));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (e) { console.warn('共有設定に失敗：' + e.message); }
  return { fileId: file.getId(), fileType: mime.indexOf('video') === 0 ? 'video' : 'image' };
}

function trashFile_(fileId, uid) {
  if (!fileId) return;
  try {
    const f = DriveApp.getFileById(fileId);
    const parents = f.getParents();
    if (parents.hasNext() && parents.next().getName() === uid) f.setTrashed(true);
  } catch (e) { console.warn('ファイル削除失敗：' + e.message); }
}

/* ============================================================
 * 想い出・いいね・コメント・ブロック
 * ========================================================== */
function hiddenSet_(uid) {
  const h = {};
  table_('Blocks').forEach(b => {
    if (b.userId === uid) h[b.blockedId] = 1;
    if (b.blockedId === uid) h[b.userId] = 1;
  });
  return h;
}
function nickMap_() {
  const m = {};
  table_('Users').forEach(u => { m[u.userId] = u.nickname; });
  return m;
}
function visibleMemory_(memoryId, uid) {
  const m = table_('Memories').filter(x => x.memoryId === memoryId)[0];
  if (!m) throw err_('想い出が見つかりません');
  if (m.userId !== uid) {
    if (m.visibility !== 'public') throw err_('この想い出は非公開です');
    if (hiddenSet_(uid)[m.userId]) throw err_('この想い出は表示できません');
  }
  return m;
}
function memOut_(m, uid, ctx) {
  return {
    memoryId: m.memoryId, userId: m.userId, nickname: ctx.nick[m.userId] || '退会したユーザー',
    stationId: m.stationId, routeId: m.routeId, title: m.title, text: m.text, url: m.url,
    fileId: m.fileId, fileType: m.fileType, lat: m.lat, lng: m.lng, visibility: m.visibility,
    takenAt: m.takenAt, createdAt: Number(m.createdAt), updatedAt: Number(m.updatedAt),
    likes: ctx.likes[m.memoryId] || 0, liked: !!ctx.liked[m.memoryId], comments: ctx.comments[m.memoryId] || 0,
    mine: m.userId === uid
  };
}
function ctx_(uid) {
  const hidden = hiddenSet_(uid);
  const likes = {}, liked = {}, comments = {};
  table_('Likes').forEach(l => {
    if (hidden[l.userId]) return;
    likes[l.memoryId] = (likes[l.memoryId] || 0) + 1;
    if (l.userId === uid) liked[l.memoryId] = 1;
  });
  table_('Comments').forEach(c => { if (!hidden[c.userId]) comments[c.memoryId] = (comments[c.memoryId] || 0) + 1; });
  return { hidden: hidden, likes: likes, liked: liked, comments: comments, nick: nickMap_() };
}

function getMemories(req, uid) {
  const scope = req.scope === 'mine' ? 'mine' : 'public';
  const ctx = ctx_(uid);
  let list = table_('Memories');
  if (scope === 'mine') list = list.filter(m => m.userId === uid);
  else list = list.filter(m => (m.visibility === 'public' || m.userId === uid) && !ctx.hidden[m.userId]);
  if (req.stationId && idOk_(req.stationId)) list = list.filter(m => m.stationId === req.stationId);
  list.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  const offset = Math.max(0, Number(req.offset) || 0);
  const limit = Math.min(50, Math.max(1, Number(req.limit) || 20));
  return {
    items: list.slice(offset, offset + limit).map(m => memOut_(m, uid, ctx)),
    hasMore: offset + limit < list.length, total: list.length
  };
}

function saveMemory(req, uid) {
  const d = req.memory || {};
  if (!idOk_(d.stationId)) throw err_('駅を選んでください');
  const url = str_(d.url, 500).trim();
  if (!urlOk_(url)) throw err_('URLは http:// か https:// から始めてください');
  const fileId = str_(d.fileId, 100);
  if (fileId && !/^[\w-]+$/.test(fileId)) throw err_('ファイルの指定が正しくありません');
  const takenAt = /^\d{4}-\d{2}-\d{2}$/.test(String(d.takenAt || '')) ? d.takenAt : Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const fields = {
    stationId: d.stationId, routeId: str_(d.routeId, 40), title: str_(d.title, 40), text: str_(d.text, 2000), url: url,
    fileId: fileId, fileType: d.fileType === 'video' ? 'video' : (fileId ? 'image' : ''),
    lat: num_(d.lat), lng: num_(d.lng), visibility: d.visibility === 'public' ? 'public' : 'private', takenAt: takenAt,
    updatedAt: Date.now()
  };
  if (fields.routeId) ownRoute_(fields.routeId, uid);
  return withLock_(() => {
    let row;
    if (d.memoryId) {
      const m = table_('Memories').filter(x => x.memoryId === d.memoryId)[0];
      if (!m || m.userId !== uid) throw err_('編集できるのは自分の想い出だけです');
      if (m.fileId && m.fileId !== fields.fileId) trashFile_(m.fileId, uid);
      patch_('Memories', m._row, fields);
      row = Object.assign({}, m, fields);
    } else {
      row = Object.assign({ memoryId: Utilities.getUuid(), userId: uid, createdAt: Date.now() }, fields);
      insert_('Memories', row);
    }
    return memOut_(row, uid, ctx_(uid));
  });
}

function setVisibility(req, uid) {
  const v = req.visibility === 'public' ? 'public' : 'private';
  return withLock_(() => {
    const m = table_('Memories').filter(x => x.memoryId === req.memoryId)[0];
    if (!m || m.userId !== uid) throw err_('変更できるのは自分の想い出だけです');
    patch_('Memories', m._row, { visibility: v, updatedAt: Date.now() });
    return { visibility: v };
  });
}

function deleteMemory(req, uid) {
  return withLock_(() => {
    const m = table_('Memories').filter(x => x.memoryId === req.memoryId)[0];
    if (!m || m.userId !== uid) throw err_('削除できるのは自分の想い出だけです');
    trashFile_(m.fileId, uid);
    removeRows_('Likes', table_('Likes').filter(l => l.memoryId === m.memoryId).map(l => l._row));
    removeRows_('Comments', table_('Comments').filter(c => c.memoryId === m.memoryId).map(c => c._row));
    removeRows_('Memories', [table_('Memories').filter(x => x.memoryId === req.memoryId)[0]._row]);
    return { ok: true };
  });
}

function toggleLike(req, uid) {
  const m = visibleMemory_(req.memoryId, uid);
  if (m.userId === uid) throw err_('自分の想い出には押せません');
  return withLock_(() => {
    const all = table_('Likes').filter(l => l.memoryId === m.memoryId);
    const mine = all.filter(l => l.userId === uid);
    let liked;
    if (mine.length) { removeRows_('Likes', mine.map(l => l._row)); liked = false; }
    else { insert_('Likes', { memoryId: m.memoryId, userId: uid, createdAt: Date.now() }); liked = true; }
    const hidden = hiddenSet_(uid);
    const count = table_('Likes').filter(l => l.memoryId === m.memoryId && !hidden[l.userId]).length;
    return { liked: liked, count: count };
  });
}

function getComments(req, uid) {
  const m = visibleMemory_(req.memoryId, uid);
  const hidden = hiddenSet_(uid);
  const nick = nickMap_();
  return table_('Comments').filter(c => c.memoryId === m.memoryId && !hidden[c.userId])
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
    .map(c => ({
      commentId: c.commentId, userId: c.userId, nickname: nick[c.userId] || '退会したユーザー', text: c.text,
      createdAt: Number(c.createdAt), updatedAt: Number(c.updatedAt),
      mine: c.userId === uid, canDelete: c.userId === uid || m.userId === uid
    }));
}

function addComment(req, uid) {
  const m = visibleMemory_(req.memoryId, uid);
  const text = str_(req.text, 500).trim();
  if (!text) throw err_('コメントを入力してください');
  return withLock_(() => {
    const now = Date.now();
    insert_('Comments', { commentId: Utilities.getUuid(), memoryId: m.memoryId, userId: uid, text: text, createdAt: now, updatedAt: now });
    return { ok: true };
  });
}

function editComment(req, uid) {
  const text = str_(req.text, 500).trim();
  if (!text) throw err_('コメントを入力してください');
  return withLock_(() => {
    const c = table_('Comments').filter(x => x.commentId === req.commentId)[0];
    if (!c || c.userId !== uid) throw err_('編集できるのは自分のコメントだけです');
    patch_('Comments', c._row, { text: text, updatedAt: Date.now() });
    return { ok: true };
  });
}

function deleteComment(req, uid) {
  return withLock_(() => {
    const c = table_('Comments').filter(x => x.commentId === req.commentId)[0];
    if (!c) throw err_('コメントが見つかりません');
    const m = table_('Memories').filter(x => x.memoryId === c.memoryId)[0];
    // 自分のコメント、または自分の想い出についたコメントは削除できる
    if (c.userId !== uid && !(m && m.userId === uid)) throw err_('削除できません');
    removeRows_('Comments', [c._row]);
    return { ok: true };
  });
}

function setBlock(req, uid) {
  const target = String(req.targetUserId || '');
  if (!target || target === uid) throw err_('ブロックする相手が正しくありません');
  if (!getUser_(target)) throw err_('ユーザーが見つかりません');
  return withLock_(() => {
    const hit = table_('Blocks').filter(b => b.userId === uid && b.blockedId === target);
    if (req.on && !hit.length) insert_('Blocks', { userId: uid, blockedId: target, createdAt: Date.now() });
    if (!req.on && hit.length) removeRows_('Blocks', hit.map(b => b._row));
    return { on: !!req.on };
  });
}

function getBlockList(req, uid) {
  const nick = nickMap_();
  return table_('Blocks').filter(b => b.userId === uid).map(b => ({ userId: b.blockedId, nickname: nick[b.blockedId] || '退会したユーザー' }));
}
