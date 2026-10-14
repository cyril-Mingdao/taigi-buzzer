/*! 台語課堂搶答 — © 2026 詹宗龍（臺中明道中學）保留一切權利。 */
/**
 * core.js — 三個頁面共用：Firebase 初始化、登入、房間碼、班級清單、伺服器時間、小工具。
 *
 * 身分模型：
 *   - 教師：Google 登入，信箱必須在 TEACHERS（與 taigi-quiz 收件程式 CONFIG.TEACHERS 相同）。
 *     真正擋得住的是 database.rules.json 的同一份白名單，這裡只是前端提示。
 *   - 學生：匿名登入（不限學校帳號）。匿名 uid 會存在瀏覽器裡，重新整理身分不變。
 *     學生頁用獨立的 Firebase app 名稱，才不會跟同一台電腦上的教師登入狀態互相覆蓋。
 */

const SDK = 'https://www.gstatic.com/firebasejs/10.12.5';

export const TEACHERS = [
  'cyril@ms.mingdao.edu.tw',
  'peichi.liu@ms.mingdao.edu.tw',
  'suyu.chang@ms.mingdao.edu.tw',
  'mike.hsu@ms.mingdao.edu.tw',
];
export const isTeacherEmail = (email) => TEACHERS.includes(String(email || '').toLowerCase());

/* ── 房間碼：6 碼，去掉 0/O/1/I/L（沿用電子白板的字母表，抄在黑板上不會認錯） ── */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const newRoomId = () => Array.from({ length: 6 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
export const normalizeRoom = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6);

/* ── 班級清單（與 taigi-quiz 的 DEPARTMENTS 一致，另加「其他」給非本校學生） ── */
const range = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + (i + 1));
export const DEPARTMENTS = [
  { name: '高中部', classes: range('高一', 12) },
  { name: '技高部', classes: [...range('商二', 4), ...range('餐二', 3), ...range('廣二', 3), ...range('美二', 2),
    ...range('英二', 2), ...range('訊二', 2), ...range('子二', 2), ...range('觀二', 1)] },
  { name: '國中部', classes: [...range('國一', 20), ...range('國二', 20)] },
  { name: '國際部', classes: ['701', '702', '1001', '1002'] },
];
export const OTHER_CLASS = '其他';

/* ── 房間預設值 ── */
export const DEFAULT_META = {
  phase: 'lobby',        // lobby：大 QR 等人加入；game：進入搶答
  state: 'idle',         // idle：準備（此時按＝偷跑）；open：開放搶答；locked：鎖定
  round: '1',            // 字串，因為規則裡要跟路徑 $round 比對
  countdownSec: 10,      // 0 = 不倒數
  penaltySec: 3,         // 偷跑鎖幾秒；-1 = 本題不能搶；0 = 不處罰
  groupMode: 'none',     // none 個人賽｜first 一組只算第一個按的｜each 每人各自計算｜single 一組只限一台手機
  groupCount: 6,
  joinMode: 'approve',   // approve 老師核准｜auto 自動核准
  qtype: 'buzz',         // buzz 搶答題（搶到者口頭回答，老師按 ✓／✗）｜answer 作答題（全班在手機選答案）
  options: 'ABCD',       // 作答題的選項組
  wrongPts: 0,           // 搶答題答錯扣幾分（0 或負數）
  // answer：作答題老師公布的正解（未公布時不存在）
};
export const QTYPES = { buzz: '搶答題', answer: '作答題' };
export const OPTION_SETS = { OX: '⭕ ❌', AB: 'A B', ABC: 'A B C', ABCD: 'A B C D', ABCDE: 'A B C D E' };
export const optionList = (set) => (set === 'OX' ? ['O', 'X'] : set.split(''));
export const optionText = (c) => ({ O: '⭕', X: '❌' }[c] || c);
export const GROUP_MODES = {
  none: '個人賽（不分組）',
  first: '分組：一組只算第一個按的人',
  each: '分組：每人各自計算',
  single: '分組：一組只限一台手機',
};
export const PENALTIES = { 0: '不處罰', 3: '鎖 3 秒', 5: '鎖 5 秒', '-1': '本題不能搶' };

/* ── Firebase ── */
let fb = null;
export async function loadFirebase({ appName } = {}) {
  // 本機測試：?mock=1 改用 tests/mock-firebase.js（tests/ 不部署，正式站上這段不會生效）
  try {
    const q = new URL(location.href).searchParams.get('mock');
    if (q === '1') localStorage.setItem('buzz.mock', '1');
    if (q === '0') localStorage.removeItem('buzz.mock');
    if (localStorage.getItem('buzz.mock') === '1') {
      const { createMock } = await import('../tests/mock-firebase.js');
      fb = createMock(appName || 'default');
      return fb;
    }
  } catch {}
  let cfg;
  try {
    cfg = await import('../config/firebase-config.js');
  } catch {
    throw Object.assign(new Error('NO_CONFIG'), { code: 'NO_CONFIG' });
  }
  const [appMod, authMod, dbMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-database.js`),
  ]);
  const app = appMod.initializeApp(cfg.firebaseConfig, appName || '[DEFAULT]');
  const auth = authMod.getAuth(app);
  const db = dbMod.getDatabase(app);
  fb = { app, auth, db, ...authMod, ...dbMod };

  // 伺服器時間差：倒數與偷跑鎖定都以伺服器時間計，避免學生手機時鐘不準
  fb.onValue(fb.ref(db, '.info/serverTimeOffset'), (s) => { serverOffset = s.val() || 0; });
  return fb;
}
let serverOffset = 0;
export const serverNow = () => Date.now() + serverOffset;

/** 等第一次 auth 狀態回報（含從瀏覽器還原的登入）。 */
export function currentUser() {
  return new Promise((resolve) => {
    const off = fb.onAuthStateChanged(fb.auth, (u) => { off(); resolve(u); });
  });
}

export async function googleSignIn() {
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ hd: 'ms.mingdao.edu.tw', prompt: 'select_account' });
  // 只用彈出視窗：轉址登入在 github.io ≠ firebaseapp.com 時會被瀏覽器的第三方儲存限制吃掉登入結果
  return (await fb.signInWithPopup(fb.auth, provider)).user;
}

export function authErrorText(e) {
  const c = e && e.code;
  if (c === 'auth/popup-closed-by-user') return '登入視窗被關掉了，再按一次試試。';
  if (c === 'auth/popup-blocked') return '瀏覽器擋住了登入視窗，請允許此網站的彈出式視窗後再按一次。';
  if (c === 'auth/unauthorized-domain') return `這個網址還沒加進 Firebase「已授權網域」：${location.hostname}`;
  if (c === 'auth/operation-not-allowed') return 'Firebase Console 還沒啟用這種登入方式（Authentication → Sign-in method）。';
  if (c === 'auth/admin-restricted-operation') return 'Firebase Console 還沒啟用「匿名」登入（Authentication → Sign-in method → 匿名）。';
  if (c === 'PERMISSION_DENIED' || /permission/i.test(e && e.message)) return '資料庫拒絕這個動作（權限不足）。';
  return `發生錯誤：${(e && (e.code || e.message)) || e}`;
}

/* ── 小工具 ── */
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const groupLabel = (g) => (g ? `第 ${g} 組` : '');
export const playerLabel = (p) => [p.cls && p.cls !== OTHER_CLASS ? p.cls : '', p.name].filter(Boolean).join(' ');

export function toast(msg, ms = 2600) {
  let box = $('#toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  box.textContent = msg;
  box.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => box.classList.remove('show'), ms);
}

/**
 * 頁內對話框，取代瀏覽器的 confirm()／prompt()（那種「網站顯示」視窗會被部分瀏覽器封鎖或勾選停用）。
 * 回傳 Promise：確認框 → true/false；有 input 時 → 輸入字串或 null（取消）。
 */
export function ask({ title = '', message = '', ok = '確定', cancel = '取消', danger = false, input = null, maxlength = 20 } = {}) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.innerHTML = `
      <div class="card dialog">
        ${title ? `<h3>${esc(title)}</h3>` : ''}
        ${message ? `<p>${esc(message)}</p>` : ''}
        ${input != null ? `<input class="dlg-input" maxlength="${maxlength}" value="${esc(input)}" autocomplete="off">` : ''}
        <div class="dlg-actions">
          <button class="btn" data-r="0">${esc(cancel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-yellow'}" data-r="1">${esc(ok)}</button>
        </div>
      </div>`;
    const inp = m.querySelector('.dlg-input');
    const done = (v) => { document.removeEventListener('keydown', onKey, true); m.remove(); resolve(v); };
    const yes = () => done(inp ? inp.value : true);
    const no = () => done(inp ? null : false);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); no(); }
      if (e.key === 'Enter') { e.preventDefault(); yes(); }
    };
    m.addEventListener('click', (e) => {
      if (e.target === m) return no();
      const b = e.target.closest('[data-r]');
      if (b) (b.dataset.r === '1' ? yes : no)();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(m);
    if (inp) { inp.focus(); inp.select(); } else m.querySelector('[data-r="1"]').focus();
  });
}

/** 沒有 config/firebase-config.js 時顯示設定說明。 */
export function showSetupNeeded(root) {
  root.innerHTML = `
    <div class="card center narrow">
      <h2>尚未設定 Firebase</h2>
      <p>請把 <code>config/firebase-config.example.js</code> 複製成 <code>config/firebase-config.js</code>，
      填入 Firebase 專案設定，並把 <code>database.rules.json</code> 貼到 Realtime Database 規則。
      詳細步驟見 README.md。</p>
    </div>`;
}

/**
 * 搶答順序：依伺服器時間排序；分組模式 first/single 時同組只留最早的一筆。
 * 回傳 [{ uid, at, player, unit }]，unit 是畫面顯示與計分的單位名稱。
 */
export function rankBuzzes(buzzes, players, meta) {
  const list = Object.entries(buzzes || {})
    .filter(([uid]) => players[uid])       // 被移除的人不列入（也不佔同組名額）
    .map(([uid, b]) => ({ uid, at: b.at, player: players[uid] }))
    .sort((a, b) => a.at - b.at || (a.uid < b.uid ? -1 : 1));
  const grouped = meta.groupMode === 'first' || meta.groupMode === 'single';
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const g = grouped && item.player.group ? item.player.group : 0;
    if (g) {
      if (seen.has(g)) continue;
      seen.add(g);
    }
    out.push(item);
  }
  return out;
}

/** 排行榜：分組模式（each 除外）以組加總，其餘以個人計。 */
export function leaderboard(players, meta) {
  const byGroup = meta.groupMode === 'first' || meta.groupMode === 'single';
  const units = new Map();
  for (const [uid, p] of Object.entries(players || {})) {
    if (!p.approved) continue;
    const key = byGroup && p.group ? `g${p.group}` : uid;
    const name = byGroup && p.group ? groupLabel(p.group) : playerLabel(p);
    const u = units.get(key) || { key, name, score: 0, members: [] };
    u.score += p.score || 0;
    u.members.push(p.name);
    units.set(key, u);
  }
  return [...units.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hant'));
}
