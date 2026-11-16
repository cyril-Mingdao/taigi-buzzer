/*! 台語課堂搶答 — © 2026 詹宗龍（臺中明道中學）保留一切權利。 */
/**
 * teacher.js — 投影頁（index.html）與手機遙控頁（remote.html）共用的教師端邏輯：
 * 登入關卡、教室訂閱、各種操作、控制面板、自動工作（倒數到時鎖定、自動核准）。
 * 兩個頁面同時開著也沒關係：所有自動工作都是冪等的。
 */
import {
  loadFirebase, currentUser, googleSignIn, authErrorText, isTeacherEmail, showSetupNeeded,
  serverNow, esc, $, toast, ask, playerLabel, groupLabel, byGroupSeat, rankBuzzes, leaderboard,
  DEFAULT_META, GROUP_MODES, PENALTIES, QTYPES, optionList, optionText, isChoice,
  groupCap, groupScored, CORRECT_PTS, roundPoints, isMulti, isSpell, isSort, isSortCode, sortChipsHTML, SORT_N, answerMatches, SAVE_ENDPOINT, googleAccessToken, OTHER_CLASS, cleanClassName, rocDate,
} from './core.js?v=38';
import { parseTailo, encode, decode, spellText, spellChipHTML, spellParts, initialCat, finalCat, toneFinal, SPELL_PTS } from './spell.js?v=38';

/* ══ 登入關卡 ══════════════════════════════════════════════════════ */

/** 載入 Firebase 並取得目前登入者（不擋人）。沒有設定檔時顯示設定說明並回傳 null。 */
export async function bootFirebase(root) {
  try {
    const fb = await loadFirebase();
    return { fb, user: await currentUser() };
  } catch (e) {
    if (e.code === 'NO_CONFIG') { showSetupNeeded(root); return null; }
    throw e;
  }
}
export const isTeacherUser = (u) => !!u && !u.isAnonymous && isTeacherEmail(u.email);

export async function teacherBoot(root) {
  const boot = await bootFirebase(root);
  if (!boot) return null;
  const { fb } = boot;
  let { user } = boot;
  if (isTeacherUser(user)) return { fb, user };

  return new Promise((resolve) => {
    const draw = (msg = '') => {
      const who = user && !user.isAnonymous ? user.email : '';
      root.innerHTML = `
        <div class="card center narrow">
          <h2>教師登入</h2>
          <p>請用學校 Google 帳號（@ms.mingdao.edu.tw）登入。</p>
          ${who ? `<p class="noperm" role="alert"><b>您無權限建立教室或請切換帳號</b><span>目前登入：${esc(who)}</span></p>` : ''}
          <div class="row center">
            <button class="btn btn-yellow" id="tLogin">${who ? '⇄ 切換帳號' : 'Google 登入'}</button>
            ${who ? '<button class="btn" id="tOut">登出</button>' : ''}
          </div>
          <p class="note" id="tNote">${esc(msg)}</p>
        </div>`;
      $('#tLogin', root).onclick = async () => {
        try {
          // 直接開 Google 選帳號視窗（先登出再開會失去點擊手勢而被擋）
          const u = await googleSignIn();
          user = u;
          if (isTeacherEmail(u.email)) resolve({ fb, user: u });
          else draw();
        } catch (e) { draw(authErrorText(e)); }
      };
      const out = $('#tOut', root);
      if (out) out.onclick = async () => { await fb.signOut(fb.auth); user = null; draw(); };
    };
    draw();
  });
}

/** 頂列帳號選單：切換帳號（直接開 Google 選帳號視窗）、登出。 */
export function mountAccountMenu(fb, user) {
  const who = $('#who');
  if (!who) return;
  who.innerHTML = `
    <button class="btn sm acct-btn" id="acctBtn" aria-haspopup="menu" aria-expanded="false">
      <span class="acct-mail">${esc(user.email)}</span> ▾</button>
    <div class="acct-menu" id="acctMenu" role="menu" hidden>
      <button role="menuitem" data-acct="switch">⇄ 切換帳號</button>
      <button role="menuitem" data-acct="out">⏻ 登出</button>
    </div>`;
  const btn = $('#acctBtn', who);
  const menu = $('#acctMenu', who);
  const toggle = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); toggle(menu.hidden); };
  document.addEventListener('click', (e) => { if (!who.contains(e.target)) toggle(false); });
  menu.onclick = async (e) => {
    const a = e.target.closest('[data-acct]');
    if (!a) return;
    toggle(false);
    try {
      // 切換帳號要在點擊當下開彈出視窗（先登出再開會被瀏覽器擋），登入成功即取代目前帳號
      if (a.dataset.acct === 'switch') await googleSignIn();
      else await fb.signOut(fb.auth);
      location.reload();
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user') toast(authErrorText(err));
    }
  };
}

/* ══ 教室建立／列出（投影頁開場用） ══════════════════════════════════ */

export async function listMyRooms(fb, uid) {
  const snap = await fb.get(fb.ref(fb.db, `buzzOwners/${uid}`));
  const rooms = Object.entries(snap.val() || {}).map(([rid, createdAt]) => ({ rid, createdAt }));
  // 超過 24 小時的舊教室順手清掉（個資不留存）
  const stale = rooms.filter((r) => Date.now() - r.createdAt > 24 * 3600 * 1000);
  for (const r of stale) {
    await fb.remove(fb.ref(fb.db, `buzzLive/${r.rid}`)).catch(() => {});
    await fb.remove(fb.ref(fb.db, `buzzRooms/${r.rid}`)).catch(() => {});
    await fb.remove(fb.ref(fb.db, `buzzOwners/${uid}/${r.rid}`)).catch(() => {});
  }
  return rooms.filter((r) => !stale.includes(r)).sort((a, b) => b.createdAt - a.createdAt);
}

/** 每組作答數：1～99 的整數，不合法回傳 null。 */
export const cleanCap = (v) => {
  const n = Number(String(v ?? '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).trim());
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
};
/** 建教室時老師輸入的每組作答數與組數（只接受合法值）。 */
function pickGroupOpts({ groupCap, groupCount } = {}) {
  const o = {};
  const c = cleanCap(groupCap);
  if (c) { o.groupMode = 'cap'; o.groupCap = c; }
  const n = Number(groupCount);
  if (Number.isInteger(n) && n >= 2 && n <= 20) o.groupCount = n;
  return o;
}
/** 「每組作答數」（老師輸入數字）＋「組數」：建教室表單、等候畫面、手機遙控「加入」分頁、設定共用。
    withAttr＝true 時用 data-set，改了直接寫進教室設定；false 時給建教室表單用 id。
    教室若是舊的分組規則（個人賽等），輸入每組作答數後會改成「每組作答數自訂」。 */
export function groupSettingsHTML(m, { withAttr = true } = {}) {
  const opt = (obj, cur) => Object.entries(obj).map(([v, t]) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${t}</option>`).join('');
  const gcs = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [i + 2, `${i + 2} 組`]));
  const a = (set, id) => (withAttr ? `data-set="${set}"` : `id="${id}"`);
  const cap = groupCap(m);
  const note = withAttr && !cap ? `<small class="muted">目前：${esc(GROUP_MODES[m.groupMode] || '')}（不限）</small>` : '';
  return `<div class="group-set">
    <label>每組作答數<input ${a('groupCap', 'gCap')} type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
      value="${cap || ''}" placeholder="例如 2" autocomplete="off">${note}</label>
    <label>組數<select ${a('groupCount', 'gCount')} data-num>${opt(gcs, m.groupCount)}</select></label></div>`;
}

export const teacherName = (u) => String((u && (u.displayName || u.email)) || '老師').slice(0, 40);

export async function createRoom(fb, user, newRoomId, className, opts = {}) {
  const uid = user.uid;
  const ownerName = teacherName(user);
  className = cleanClassName(className);
  if (!className) throw new Error('請輸入班級名稱');
  for (let i = 0; i < 5; i++) {
    const rid = newRoomId();
    const exists = (await fb.get(fb.ref(fb.db, `buzzRooms/${rid}/meta`))).exists();
    if (exists) continue;
    await fb.set(fb.ref(fb.db, `buzzRooms/${rid}/meta`), { ...DEFAULT_META, ...pickGroupOpts(opts), ownerUid: uid, ownerName, className, createdAt: fb.serverTimestamp() });
    await fb.set(fb.ref(fb.db, `buzzOwners/${uid}/${rid}`), Date.now());
    await fb.set(fb.ref(fb.db, `buzzLive/${rid}`), { ownerUid: uid, ownerName, className, createdAt: Date.now(), phase: 'lobby', n: 0 });
    return rid;
  }
  throw new Error('教室碼重複太多次，請再試一次');
}

/* ══ 教室訂閱與操作 ══════════════════════════════════════════════════ */

export function watchRoom(fb, rid, onChange) {
  return fb.onValue(fb.ref(fb.db, `buzzRooms/${rid}`), (snap) => {
    const v = snap.val();
    if (!v || !v.meta) return onChange(null);
    const meta = { ...DEFAULT_META, ...v.meta };
    const players = v.players || {};
    const round = meta.round;
    onChange({
      rid, meta, players,
      presence: v.presence || {},
      kicked: v.kicked || {},
      buzzes: (v.buzzes || {})[round] || {},
      fouls: (v.fouls || {})[round] || {},
      answers: (v.answers || {})[round] || {},
      judges: (v.judges || {})[round] || {},
      ranked: rankBuzzes((v.buzzes || {})[round], players, meta),
      raw: v,
    });
  });
}

export function makeActions(fb, rid, getState) {
  const r = (p = '') => fb.ref(fb.db, `buzzRooms/${rid}${p}`);
  const meta = (patch) => fb.update(r('/meta'), patch).catch((e) => toast(authErrorText(e)));

  /** 核准會不會超過「一組只限 N 台手機」：回傳額滿的組別，沒問題回傳 null。alsoTaken＝這次批次已核准的 { 組別: 人數 }。 */
  // v38：被移除者的分數暫存本機（同一支手機重新加入時補回）
  const KEEP = `buzz.kept.${rid}`;
  const kept = () => { try { return JSON.parse(localStorage.getItem(KEEP) || '{}'); } catch { return {}; } };
  const keepScore = (uid, pts) => { try { const k = kept(); k[uid] = (k[uid] || 0) + pts; localStorage.setItem(KEEP, JSON.stringify(k)); } catch {} };
  const takeScore = (uid) => { try { const k = kept(); const v = k[uid] || 0; if (v) { delete k[uid]; localStorage.setItem(KEEP, JSON.stringify(k)); } return v; } catch { return 0; } };

  const singleConflict = (uid, s, alsoTaken = new Map()) => {
    const p = s.players[uid];
    const cap = groupCap(s.meta);
    if (!cap || !p || !p.group) return null;
    const n = Object.entries(s.players).filter(([u, q]) => u !== uid && q.approved && q.group === p.group).length + (alsoTaken.get(p.group) || 0);
    return n >= cap ? p.group : null;
  };

  return {
    open: () => meta({ phase: 'game', state: 'open', openAt: fb.serverTimestamp() }),
    lock: () => meta({ state: 'locked' }),
    next: () => meta({ phase: 'game', state: 'idle', round: String((parseInt(getState().meta.round, 10) || 0) + 1), openAt: null, answer: null }),
    lobby: () => meta({ phase: 'lobby', state: 'idle' }),
    game: () => meta({ phase: 'game' }),
    async end() {
      if (!(await ask({ title: '結束活動', message: '投影頁會顯示冠軍、亞軍、季軍與各組得分。結束後仍可「繼續活動」。', ok: '結束活動' }))) return;
      return meta({ phase: 'ended', state: 'locked' });
    },
    resume: () => meta({ phase: 'game' }),
    save: () => saveScores(fb, rid, getState),
    getMeta: () => getState().meta,
    setMeta: meta,

    /** 搶答題：老師對搶答者按 ✓／✗。再按一次同一顆＝取消，分數一併還原。答對自動鎖定。 */
    judge(uid, verdict) {
      const s = getState();
      const p = s.players[uid];
      if (!p) return;
      const pts = (v) => (v === 'right' ? CORRECT_PTS : v === 'wrong' ? (s.meta.wrongPts || 0) : 0);
      const old = s.judges[uid] || null;
      const next = old === verdict ? null : verdict;
      const upd = {
        [`judges/${s.meta.round}/${uid}`]: next,
        [`players/${uid}/score`]: (p.score || 0) - pts(old) + pts(next),
      };
      if (next === 'right') upd['meta/state'] = 'locked';
      return fb.update(r(), upd).catch((e) => toast(authErrorText(e)));
    },

    /** 是非／選擇／拼音題：老師選標準答案後核對全部作答並計分（答對 10 分＋前五名速度加成；
        拼音題聲母、韻母、聲調分開給分）；改選別的答案＝更正，分數依新舊答案差額重算。 */
    reveal(ans) {
      const s = getState();
      const prev = s.meta.answer || null;
      if (prev === ans) return;
      const oldPts = roundPoints(s.meta, s.answers, prev);
      const newPts = roundPoints(s.meta, s.answers, ans);
      const upd = { 'meta/answer': ans, 'meta/state': 'locked', [`keys/${s.meta.round}`]: ans };
      for (const uid of new Set([...Object.keys(oldPts), ...Object.keys(newPts)])) {
        const p = s.players[uid];
        if (!p) continue;
        const d = (newPts[uid] || 0) - (oldPts[uid] || 0);
        if (d) upd[`players/${uid}/score`] = (p.score || 0) + d;
      }
      return fb.update(r(), upd).catch((e) => toast(authErrorText(e)));
    },

    async setQtype(qtype) {
      const s = getState();
      if (s.meta.state !== 'idle' && !(await ask({
        title: '切換題型', message: '本題進行中，切換題型會直接進入下一題。', ok: '切換並進入下一題',
      }))) return;
      return meta(s.meta.state === 'idle' ? { qtype }
        : { qtype, state: 'idle', round: String((parseInt(s.meta.round, 10) || 0) + 1), openAt: null, answer: null });
    },

    /** 單選／複選切換（預設單選＝不寫 multi 欄位）。本題進行中切換會直接進入下一題。 */
    async setMulti(on) {
      const s = getState();
      if (!!s.meta.multi === on) return;
      if (s.meta.state !== 'idle' && !(await ask({
        title: on ? '改成複選' : '改成單選', message: '本題進行中，切換會直接進入下一題。', ok: '切換並進入下一題',
      }))) return;
      const v = on ? true : null;
      return meta(s.meta.state === 'idle' ? { multi: v }
        : { multi: v, state: 'idle', round: String((parseInt(s.meta.round, 10) || 0) + 1), openAt: null, answer: null });
    },

    approve(uid) {
      const s = getState();
      const g = singleConflict(uid, s);
      if (g) return toast(`${groupLabel(g)}已經額滿了（每組作答數 ${groupCap(s.meta)}）`);
      const back = takeScore(uid);
      return fb.update(r(`/players/${uid}`), { approved: true, score: (s.players[uid].score || 0) + back }).catch((e) => toast(authErrorText(e)));
    },
    async approveAll() {
      const s = getState();
      const taken = new Map();
      const patch = {};
      for (const [uid, p] of Object.entries(s.players)) {
        if (p.approved) continue;
        if (singleConflict(uid, s, taken)) continue;
        if (p.group) taken.set(p.group, (taken.get(p.group) || 0) + 1);
        patch[`${uid}/approved`] = true;
        patch[`${uid}/score`] = (p.score || 0) + takeScore(uid);
      }
      if (Object.keys(patch).length) await fb.update(r('/players'), patch).catch((e) => toast(authErrorText(e)));
    },
    /**
     * v38：學生手機當機／卡住時，老師按「移除」只刪掉這筆名單（釋放同組名額），
     * 同一支手機重新整理後可再加入，也可以換另一支手機加入同組；要永久擋掉才選「封鎖」。
     * 分組計分時，被移除者的分數轉給同組還在的組員（組分不變）；沒有組員就記在本機，
     * 同一支手機重新加入並在這台裝置核准時補回。
     */
    async kick(uid) {
      const s = getState();
      const p = s.players[uid];
      const pts = (p && p.score) || 0;
      const mate = pts && p.group && groupScored(s.meta)
        ? Object.entries(s.players).find(([u, q]) => u !== uid && q.approved && q.group === p.group) : null;
      const scoreNote = !pts ? '' : mate
        ? `（${pts} 分會轉給同組的 ${playerLabel(mate[1])}，組分不變）`
        : `（${pts} 分：同一支手機重新加入時，在這台裝置核准會自動補回）`;
      const res = await ask({
        title: `移除「${playerLabel(p || {})}」？`,
        message: `移除：釋放名額，這支手機重新整理後可以再加入，或換另一支手機加入同組${scoreNote}。封鎖：這支手機不能再加入本教室。`,
        ok: '移除', alt: '封鎖', altDanger: true,
      });
      if (!res) return;
      try {
        if (res === 'alt') await fb.set(r(`/kicked/${uid}`), true);
        if (mate) await fb.update(r(`/players/${mate[0]}`), { score: (mate[1].score || 0) + pts });
        else if (pts) keepScore(uid, pts);
        await fb.remove(r(`/players/${uid}`));
        toast(res === 'alt' ? '已封鎖這支手機' : '已移除，名額已釋放');
      } catch (e) { toast(authErrorText(e)); }
    },
    async unkickAll() {
      if (!(await ask({ title: '解除封鎖？', message: '被封鎖的手機都可以重新加入本教室。', ok: '解除封鎖' }))) return;
      // 規則只開放 kicked/$uid 層級寫入，所以逐筆清掉
      const patch = Object.fromEntries(Object.keys(getState().kicked || {}).map((u) => [`kicked/${u}`, null]));
      if (!Object.keys(patch).length) return;
      fb.update(r(), patch).then(() => toast('已解除封鎖')).catch((e) => toast(authErrorText(e)));
    },
    async rename(uid) {
      const p = getState().players[uid];
      const name = await ask({ title: '修改姓名／暱稱', message: '20 字內', input: p ? p.name : '', ok: '儲存' });
      if (name == null) return;
      const v = name.trim().slice(0, 20);
      if (!v) return;
      fb.update(r(`/players/${uid}`), { name: v }).catch((e) => toast(authErrorText(e)));
    },
    addScore(uid, d) {
      fb.runTransaction(r(`/players/${uid}/score`), (v) => (v || 0) + d).catch((e) => toast(authErrorText(e)));
    },
    async resetScores() {
      if (!(await ask({ title: '分數歸零', message: '把所有人的分數歸零？', ok: '歸零', danger: true }))) return;
      const patch = {};
      for (const uid of Object.keys(getState().players)) patch[`${uid}/score`] = 0;
      await fb.update(r('/players'), patch);
    },
    async clearRoom({ confirm = true } = {}) {
      if (confirm && !(await ask({
        title: '關閉並清除資料', message: '刪除本教室所有學生姓名與紀錄，此動作無法復原。', ok: '關閉並清除', danger: true,
      }))) return false;
      await fb.remove(fb.ref(fb.db, `buzzLive/${rid}`)).catch(() => {});
      await fb.remove(r(''));
      await fb.remove(fb.ref(fb.db, `buzzOwners/${fb.auth.currentUser.uid}/${rid}`)).catch(() => {});
      return true;
    },
  };
}

/** 倒數到時自動鎖定、自動核准。每次教室資料變動與每 250ms 呼叫一次。 */
export function runJobs(s, act) {
  if (!s) return;
  const m = s.meta;
  if (m.state === 'open' && m.countdownSec > 0 && typeof m.openAt === 'number'
      && serverNow() >= m.openAt + m.countdownSec * 1000 && runJobs.lockedRound !== m.round) {
    runJobs.lockedRound = m.round;
    act.lock();
  }
  if (m.joinMode === 'auto' && Object.values(s.players).some((p) => !p.approved)) {
    if (!runJobs.busy) { runJobs.busy = true; act.approveAll().finally(() => { runJobs.busy = false; }); }
  }
}

/** 倒數剩餘秒數（無倒數或未開放回傳 null）。 */
export function remainingSec(m) {
  if (m.state !== 'open' || !(m.countdownSec > 0) || typeof m.openAt !== 'number') return null;
  return Math.max(0, Math.ceil((m.openAt + m.countdownSec * 1000 - serverNow()) / 1000));
}

export const STATE_TEXT = { idle: '準備中', open: '搶答中', locked: '已鎖定' };
export { qtypeLabel } from './core.js?v=38';
export const stateText = (m) => (m.phase === 'ended' ? '活動結束'
  : m.state === 'open' && isChoice(m) ? '作答中' : STATE_TEXT[m.state]);

/* ══ 控制面板（遙控頁全版、投影頁抽屜共用） ══════════════════════════ */

/** 只在 HTML 字串有變時才替換，避免下拉選單開著時被重繪關掉。 */
export function patch(el, html) {
  if (!el || el._html === html) return;
  // 重繪時保住輸入框的焦點與游標（拼音題老師打字到一半，學生答案進來也不會被打斷）
  const a = document.activeElement;
  const key = a && el.contains(a) ? a.getAttribute('data-keep-focus') : null;
  const sel = key ? [a.selectionStart, a.selectionEnd] : null;
  el._html = html; el.innerHTML = html;
  if (key) {
    const n = el.querySelector(`[data-keep-focus="${key}"]`);
    if (n) { n.focus(); try { n.setSelectionRange(sel[0], sel[1]); } catch {} }
  }
}

const grouped = groupScored;
const unitHTML = (p, m) => (grouped(m) && p.group
  ? `${groupLabel(p.group)}<small>${esc(playerLabel(p))}</small>`
  : `${esc(playerLabel(p))}${p.group ? `<small>${groupLabel(p.group)}</small>` : ''}`);

/** 搶答題：搶答順序。judging=true 時每列有 ✓／✗（老師端）。 */
export function orderHTML(s, { judging = true, big = false } = {}) {
  if (!s.ranked.length) {
    return `<p class="muted center">${s.meta.state === 'open' ? '等待學生按下…' : '本題還沒有人搶答'}</p>`;
  }
  // 目前輪到誰：第一個還沒被判錯的人（已有人答對就沒有）
  const someoneRight = s.ranked.some((it) => s.judges[it.uid] === 'right');
  const turn = someoneRight ? null : (s.ranked.find((it) => s.judges[it.uid] !== 'wrong') || {}).uid;
  return `<ol class="order${big ? ' big' : ''}">${s.ranked.map((it, i) => {
    const p = it.player;
    const j = s.judges[it.uid];
    const dt = typeof s.meta.openAt === 'number' ? ((it.at - s.meta.openAt) / 1000).toFixed(2) : '';
    const cls = [it.uid === turn ? 'first' : '', j === 'wrong' ? 'wrong' : '', j === 'right' ? 'right' : ''].join(' ');
    return `<li class="${cls}">
      <span class="rank">${i + 1}</span>
      <span class="who">${unitHTML(p, s.meta)}</span>
      <span class="dt">${j === 'right' ? '✔ 答對' : j === 'wrong' ? '✘ 答錯' : dt ? `+${dt}s` : ''}</span>
      ${judging ? `<span class="score-btns">
        <button class="btn sm ok ${j === 'right' ? 'on' : ''}" data-act="judge" data-uid="${it.uid}" data-v="right">✓</button>
        <button class="btn sm ng ${j === 'wrong' ? 'on' : ''}" data-act="judge" data-uid="${it.uid}" data-v="wrong">✗</button>
        <b>${p.score || 0}</b>
      </span>` : ''}
    </li>`;
  }).join('')}</ol>`;
}

/** 是非／選擇題：作答人數、各選項分布、公布後答對名單（含本題得分）。 */
export function answerHTML(s, { big = false } = {}) {
  const m = s.meta;
  if (isSpell(m)) return spellAnswerHTML(s, { big });
  if (isSort(m)) return sortAnswerHTML(s, { big });
  const opts = optionList(m);
  const total = Object.values(s.players).filter((p) => p.approved).length;
  const list = Object.entries(s.answers).filter(([uid]) => s.players[uid]);
  const n = list.length;
  const counts = Object.fromEntries(opts.map((o) => [o, 0]));
  for (const [, a] of list) for (const ch of String(a.c || '')) if (ch in counts) counts[ch]++;
  const revealed = !!m.answer;
  const isKey = (o) => revealed && String(m.answer).includes(o);
  const bars = opts.map((o) => {
    const c = counts[o];
    const pct = n ? Math.round((c / n) * 100) : 0;
    return `<div class="bar ${isKey(o) ? 'correct' : ''} ${revealed && !isKey(o) ? 'dim' : ''}">
      <span class="opt">${optionText(o)}</span>
      <span class="track"><span style="width:${revealed ? pct : 0}%"></span></span>
      <span class="num">${revealed ? c : ''}</span></div>`;
  }).join('');
  const pts = revealed ? roundPoints(m, s.answers, m.answer) : {};
  const winners = Object.keys(pts).filter((uid) => s.players[uid])
    .sort((a, b) => pts[b] - pts[a] || s.answers[a].at - s.answers[b].at);
  return `<div class="answer-view${big ? ' big' : ''} ${opts.length > 5 ? 'many' : ''}" style="--n:${opts.length}">
    <div class="answered">已作答 <b>${n}</b> / ${total}${revealed ? `　標準答案 <b>${optionText(m.answer)}</b>` : ''}</div>
    <div class="bars">${bars}</div>
    ${revealed ? `<div class="winners-box"><h3>答對（${winners.length}）</h3>
      <div class="winners">${winners.map((uid) => `<span class="chip">${unitHTML(s.players[uid], m)}<b>+${pts[uid]}</b></span>`).join('')
        || '<span class="muted">沒有人答對</span>'}</div></div>` : ''}
  </div>`;
}

/** 遙控頁專用（只給老師看）：每位學生的即時作答——選了什麼、第幾個交、花幾秒；未作答的列在後面。
    公布前就顯示各選項人數，公布後標出對錯與本題得分。 */
export function liveAnswersHTML(s) {
  const m = s.meta;
  const opts = optionList(m);
  const players = Object.entries(s.players).filter(([, p]) => p.approved);
  const done = players.filter(([uid]) => s.answers[uid])
    .sort((a, b) => s.answers[a[0]].at - s.answers[b[0]].at);
  const wait = players.filter(([uid]) => !s.answers[uid])
    .sort((a, b) => playerLabel(a[1]).localeCompare(playerLabel(b[1]), 'zh-Hant'));
  const counts = Object.fromEntries(opts.map((o) => [o, 0]));
  for (const [uid] of done) for (const ch of String(s.answers[uid].c || '')) if (ch in counts) counts[ch]++;
  const revealed = !!m.answer;
  const pts = revealed ? roundPoints(m, s.answers, m.answer) : {};
  const tally = isSpell(m) ? spellTallyHTML(s) : isSort(m) ? sortTallyHTML(s) : '';
  const dist = tally || opts.map((o) => `<span class="dist-item ${revealed && String(m.answer).includes(o) ? 'correct' : ''}">
    <b>${optionText(o)}</b>${counts[o]}</span>`).join('');
  const off = (uid) => (s.presence[uid] ? '' : ' offline');
  const doneRows = done.map(([uid, p], i) => {
    const a = s.answers[uid];
    const dt = typeof m.openAt === 'number' ? `${Math.max(0, (a.at - m.openAt) / 1000).toFixed(1)}s` : '';
    const mark = !revealed ? '' : answerMatches(a.c, m.answer) ? 'right' : 'wrong';
    return `<li class="${mark}${off(uid)}"><span class="rank">${i + 1}</span>
      <span class="who"><span class="nm">${esc(playerLabel(p))}</span><span class="pick">${optionText(a.c)}</span>${p.group ? `<small>${groupLabel(p.group)}</small>` : ''}</span>
      <span class="dt">${dt}</span>
      <span class="gain">${revealed ? (pts[uid] ? `+${pts[uid]}` : '✘') : ''}</span></li>`;
  }).join('');
  const waitRows = wait.map(([uid, p]) => `<li class="waiting${off(uid)}"><span class="rank">–</span>
    <span class="who"><span class="nm">${esc(playerLabel(p))}</span><span class="pick none">未作答</span>${p.group ? `<small>${groupLabel(p.group)}</small>` : ''}</span></li>`).join('');
  return `<div class="live-ans">
    <div class="live-head">已作答 <b>${done.length}</b> / ${players.length}
      ${wait.length ? `<span class="muted">（未作答 ${wait.length}）</span>` : '<span class="ok-all">全員作答</span>'}</div>
    ${tally || `<div class="dist">${dist}</div>`}
    <ol class="live-list">${doneRows}${waitRows || ''}</ol>
    ${players.length ? '' : '<p class="muted center">還沒有已核准的學生</p>'}
  </div>`;
}

/** 電腦教師模式（只在老師登入的投影頁顯示）：每位學生的答案小卡，例：王曉明 A。
    依交卷先後排列，未作答的排在後面；公布答案後標出對錯。 */
export function liveChipsHTML(s) {
  const m = s.meta;
  const players = Object.entries(s.players).filter(([, p]) => p.approved);
  const done = players.filter(([uid]) => s.answers[uid])
    .sort((a, b) => s.answers[a[0]].at - s.answers[b[0]].at);
  const wait = players.filter(([uid]) => !s.answers[uid])
    .sort((a, b) => playerLabel(a[1]).localeCompare(playerLabel(b[1]), 'zh-Hant'));
  const off = (uid) => (s.presence[uid] ? '' : ' offline');
  const chip = ([uid, p]) => {
    const a = s.answers[uid];
    const mark = !a ? ' waiting' : !m.answer ? '' : answerMatches(a.c, m.answer) ? ' right' : ' wrong';
    // 卡片只放姓名（班級前綴會把名字擠掉），完整標籤放在滑鼠提示
    return `<span class="lchip${mark}${off(uid)}" title="${esc(playerLabel(p))}"><span class="nm">${esc(p.name || playerLabel(p))}</span>`
      + `<b>${a ? (isSortCode(a.c) ? a.c : optionText(a.c)) : '—'}</b></span>`;
  };
  return `<div class="live-chips">
    ${isSpell(m) ? spellTallyHTML(s) : isSort(m) ? sortTallyHTML(s) : ''}
    <div class="live-head">學生作答 <b>${done.length}</b> / ${players.length}
      ${players.length && !wait.length ? '<span class="ok-all">全員作答</span>' : ''}</div>
    <div class="lchips">${[...done, ...wait].map(chip).join('') || '<span class="muted">還沒有已核准的學生</span>'}</div>
  </div>`;
}

/** 本題畫面頂端：還沒核准的學生（中途加入的人常被漏掉，學生手機會一直停在「等待核准」）。 */
export function pendingBarHTML(s) {
  const pend = Object.entries(s.players).filter(([, p]) => !p.approved)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (!pend.length) return '';
  return `<div class="pend-bar" role="alert">
    <div class="pend-head"><b>⚠ ${pend.length} 人等待核准</b>，核准後才能作答
      ${pend.length > 1 ? '<button class="btn sm btn-yellow" data-act="approveAll">全部核准</button>' : ''}</div>
    <div class="pend-list">${pend.map(([uid, p]) => `<span class="pend-item">${esc(playerLabel(p))}
      <button class="btn sm btn-yellow" data-act="approve" data-uid="${uid}">核准</button>
      <button class="btn sm danger" data-act="kick" data-uid="${uid}">移除</button></span>`).join('')}</div>
  </div>`;
}

/** 遙控頁：搶答題尚未按下的學生。 */
export function notBuzzedHTML(s) {
  const players = Object.entries(s.players).filter(([uid, p]) => p.approved && !s.buzzes[uid]);
  const total = Object.values(s.players).filter((p) => p.approved).length;
  if (!total || s.meta.state === 'idle') return '';
  return `<div class="live-head small">已搶答 <b>${total - players.length}</b> / ${total}</div>
    ${players.length ? `<div class="wait-chips">${players.map(([uid, p]) =>
      `<span class="wchip${s.presence[uid] ? '' : ' offline'}">${unitHTML(p, s.meta)}</span>`).join('')}</div>` : ''}`;
}

export function boardHTML(s) {
  const rows = leaderboard(s.players, s.meta);
  if (!rows.length) return '<p class="muted center">還沒有人</p>';
  return `<ol class="board">${rows.map((u, i) => `
    <li><span class="rank">${i + 1}</span><span class="who">${esc(u.name)}</span><b>${u.score}</b></li>`).join('')}</ol>`;
}

/** v37：分組名次下方列出組員「座號 姓名」（個人名次本身已含座號姓名，不重複）。 */
const membersHTML = (u, cls) => (u.key.startsWith('g') && u.members.length
  ? `<div class="${cls}">${u.members.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : '');

/** 活動結束：冠軍、亞軍、季軍頒獎台＋其餘各組（或個人）得分。同分同名次。 */
export function podiumHTML(s) {
  const rows = leaderboard(s.players, s.meta);
  if (!rows.length) return '<div class="bigmsg">活動結束</div>';
  let rank = 0;
  rows.forEach((u, i) => { if (i === 0 || u.score !== rows[i - 1].score) rank = i + 1; u.rank = rank; });
  const medal = { 1: ['🥇', '冠軍'], 2: ['🥈', '亞軍'], 3: ['🥉', '季軍'] };
  const top = rows.filter((u) => u.rank <= 3);
  const rest = rows.filter((u) => u.rank > 3);
  const col = (u) => `<div class="pod pod-${u.rank}"><div class="pod-medal">${medal[u.rank][0]}</div>
    <div class="pod-title">${medal[u.rank][1]}</div><div class="pod-name">${esc(u.name)}</div>${membersHTML(u, 'pod-members')}<div class="pod-score">${u.score} 分</div></div>`;
  // 頒獎台排列：亞軍－冠軍－季軍
  const order = [...top.filter((u) => u.rank === 2), ...top.filter((u) => u.rank === 1), ...top.filter((u) => u.rank === 3)];
  return `<div class="ended">
    <h2 class="ended-title">🏆 ${s.meta.className ? `${esc(s.meta.className)} ` : ''}活動結束</h2>
    <div class="podium">${order.map(col).join('')}</div>
    ${rest.length ? `<ol class="board rest">${rest.map((u) => `
      <li><span class="rank">${u.rank}</span><span class="who">${esc(u.name)}${membersHTML(u, 'rest-members')}</span><b>${u.score}</b></li>`).join('')}</ol>` : ''}
  </div>`;
}

export function controlsHTML(s) {
  const m = s.meta;
  const btn = (act, label, cls = '', dis = false, extra = '') =>
    `<button class="btn ${cls}" data-act="${act}" ${extra} ${dis ? 'disabled' : ''}>${label}</button>`;
  if (m.phase === 'ended') {
    return `
      <div class="ctl-status"><span class="badge st-locked">活動結束</span>　共 ${esc(m.round)} 題</div>
      <div class="ctl-main">
        ${btn('save', '💾 儲存成績', 'btn-yellow big')}
        ${btn('resume', '↩ 繼續活動', 'big')}
        ${btn('clear', '✕ 關閉教室', 'big danger')}
      </div>
      <p class="note">「儲存成績」存成「民國日期＋班級名稱＋_教師名」的 CSV 到雲端硬碟，成功後自動關閉教室；「關閉教室」不存檔直接刪除本教室資料。</p>`;
  }
  const choice = isChoice(m);
  const seg = Object.entries(QTYPES).map(([v, t]) => btn('qtype', t, m.qtype === v ? 'on' : '', false, `data-v="${v}"`)).join('');
  const multi = isMulti(m);
  const modeSeg = choice && m.qtype !== 'tf' && !isSpell(m) && !isSort(m)
    ? `<div class="seg mode-seg">${btn('multi', '單選', multi ? '' : 'on', false, 'data-v="0"')}${btn('multi', '複選', multi ? 'on' : '', false, 'data-v="1"')}</div>`
    : '';
  let reveal = '';
  if (isSpell(m) && m.state !== 'idle') {
    // 拼音題：主要從「本題」學生答案清單點選正解；清單裡沒有正解時在這裡輸入臺羅
    const draft = spellDrafts.get(m.round) ?? '';
    const pv = spellPreview(draft, m);
    reveal = `<div class="reveal spell-in"><span>${m.answer ? `標準答案 <b class="sp-key-txt">${esc(spellText(m.answer))}</b>（點清單別列或重新輸入＝更正）`
        : '點學生答案清單裡的正解，或輸入臺羅：'}</span>
      <div class="spell-row"><input data-spellin data-keep-focus="spell" value="${esc(draft)}" placeholder="例：tsiah8 或 tsia̍h"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
        ${btn('sreveal', '✔ 公布', 'btn-yellow', !pv.code)}</div>
      <div class="spell-prev" data-spellprev>${pv.html}</div></div>`;
  } else if (isSort(m) && m.state !== 'idle') {
    reveal = sortRevealHTML(m);
  } else if (choice && m.state !== 'idle' && !multi) {
    reveal = `<div class="reveal"><span>${m.answer ? '標準答案（點別的可更正）' : '選擇標準答案：'}</span>
        ${optionList(m).map((o) => btn('reveal', optionText(o), m.answer === o ? 'btn-yellow' : '', false, `data-v="${o}"`)).join('')}</div>`;
  } else if (choice && m.state !== 'idle') {
    // 複選：先點選所有正確選項，再按「公布答案」；公布後可改選再按一次＝更正
    const sel = keyDraft(m);
    reveal = `<div class="reveal multi"><span>${m.answer ? `標準答案 ${esc(m.answer)}（改選後再按公布＝更正）` : '複選：點選所有正確選項後按公布'}</span>
        ${optionList(m).map((o) => btn('kpick', optionText(o), sel.has(o) ? 'btn-yellow' : '', false, `data-v="${o}"`)).join('')}
        ${btn('kreveal', '✔ 公布答案', 'btn-yellow kreveal', !sel.size || [...sel].sort().join('') === m.answer)}</div>`;
  }
  return `
    <div class="ctl-status">第 <b>${esc(m.round)}</b> 題 · <span class="badge st-${m.state}">${stateText(m)}</span>
      <span class="cd" data-cd></span></div>
    <div class="seg qtype-seg">${seg}</div>
    ${modeSeg}
    <div class="ctl-main">
      ${btn('open', choice ? '▶ 開始作答' : '▶ 開始搶答', 'btn-yellow big', m.state !== 'idle')}
      ${btn('lock', '■ 鎖定', 'big', m.state !== 'open')}
      ${btn('next', '↻ 下一題', 'big')}
    </div>
    ${reveal}
    <div class="row end-row">${btn('end', '🏁 結束活動', 'danger')}</div>`;
}

export function playersHTML(s) {
  const entries = Object.entries(s.players).sort(byGroupSeat);
  const pending = entries.filter(([, p]) => !p.approved);
  const ok = entries.filter(([, p]) => p.approved);
  const blocked = Object.keys(s.kicked || {}).length;
  // 是非／選擇題作答中或已鎖定：名字後面直接顯示本題選的答案（只有老師手機看得到）
  const showPick = isChoice(s.meta) && s.meta.state !== 'idle' && s.meta.phase !== 'ended';
  const pickTag = (uid) => {
    if (!showPick) return '';
    const a = s.answers[uid];
    if (!a) return '<span class="pick none">未作答</span>';
    const mark = !s.meta.answer ? '' : answerMatches(a.c, s.meta.answer) ? ' right' : ' wrong';
    return `<span class="pick${mark}">${optionText(a.c)}</span>`;
  };
  const row = ([uid, p]) => `
    <li class="${s.presence[uid] ? '' : 'offline'}">
      <span class="who">${esc(playerLabel(p))}${pickTag(uid)}${p.group ? `<small>${groupLabel(p.group)}</small>` : ''}</span>
      <span class="acts">
        ${p.approved
          ? `<button class="btn sm" data-act="score" data-uid="${uid}" data-v="-1">−</button><b class="pts">${p.score || 0}</b><button class="btn sm" data-act="score" data-uid="${uid}" data-v="1">＋</button>`
          : `<button class="btn sm btn-yellow" data-act="approve" data-uid="${uid}">核准</button>`}
        <button class="btn sm" data-act="rename" data-uid="${uid}">改名</button>
        <button class="btn sm danger" data-act="kick" data-uid="${uid}">移除</button>
      </span>
    </li>`;
  return `
    <div class="row between"><h3>待核准（${pending.length}）</h3>
      ${pending.length ? '<button class="btn sm btn-yellow" data-act="approveAll">全部核准</button>' : ''}</div>
    <ul class="plist">${pending.map(row).join('') || '<li class="muted">沒有</li>'}</ul>
    <h3>已加入（${ok.length}）</h3>
    <ul class="plist">${ok.map(row).join('') || '<li class="muted">沒有</li>'}</ul>
    ${blocked ? `<div class="row between"><span class="muted">已封鎖 ${blocked} 支手機</span>
      <button class="btn sm" data-act="unkickAll">解除封鎖</button></div>` : ''}`;
}

export function settingsHTML(s) {
  const m = s.meta;
  const opt = (obj, cur) => Object.entries(obj).map(([v, t]) => `<option value="${v}" ${String(cur) === v ? 'selected' : ''}>${t}</option>`).join('');
  const cds = { 0: '不限', 5: '5 秒', 10: '10 秒', 15: '15 秒', 20: '20 秒', 30: '30 秒', 60: '60 秒' };
  const gcs = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [i + 2, `${i + 2} 組`]));
  return `
    <label>班級名稱<input data-set="className" maxlength="20" value="${esc(m.className || '')}" placeholder="例如 KJ21"></label>
    <label>題型<select data-set="qtype">${opt(QTYPES, m.qtype)}</select></label>
    <label>倒數秒數<select data-set="countdownSec" data-num>${opt(cds, m.countdownSec)}</select></label>
    <label>偷跑處罰<select data-set="penaltySec" data-num>${opt(PENALTIES, m.penaltySec)}</select></label>
    <label>搶答答錯<select data-set="wrongPts" data-num>${opt({ 0: '不扣分', '-5': '扣 5 分', '-10': '扣 10 分' }, m.wrongPts)}</select></label>
    <label>加入方式<select data-set="joinMode">${opt({ approve: '老師核准', auto: '自動核准' }, m.joinMode)}</select></label>
    ${groupSettingsHTML(m)}
    <p class="note">計分：答對 ${CORRECT_PTS} 分；是非／選擇題答對者依交卷先後再加 +5、+4、+3、+2、+1。
      拼音題聲母 ${SPELL_PTS.i}、韻母 ${SPELL_PTS.f}、聲調 ${SPELL_PTS.t} 分分開給分，全對者同樣加速度分。排序題順序全對才給分。</p>
    <div class="row wrap">
      ${m.phase === 'lobby'
        ? '<button class="btn" data-act="game">進入搶答畫面</button>'
        : '<button class="btn" data-act="lobby">回到加入畫面（大 QR）</button>'}
      <button class="btn" data-act="resetScores">分數歸零</button>
      <button class="btn danger" data-act="clear">關閉並清除資料</button>
    </div>`;
}

/* ══ 拼音題 ══════════════════════════════════════════════════════════ */

/** 老師輸入框的草稿（每題一份，只存在這個頁面）。 */
const spellDrafts = new Map();

/** 輸入框下方的預覽：ts ＋ iah ＋ 第 8 調；回傳 { code, html }，code 為空表示不能公布。 */
function spellPreview(text, m) {
  if (!String(text).trim()) return { code: '', html: '' };
  const r = parseTailo(text);
  if (r.error) return { code: '', html: `<span class="sp-err">✘ ${esc(r.error)}</span>` };
  const code = encode(r);
  const same = code === m.answer;
  return {
    code: same ? '' : code,
    html: `${spellChipHTML(code)} <span class="sp-parts-txt">${r.i ? esc(r.i) : '無聲母'} ＋ ${esc(r.f)} ＋ 第 ${r.t} 調</span>${same ? ' <span class="muted">（已公布）</span>' : ''}`,
  };
}

/** 學生答案歸類（人數多的在前、同數依最早交卷），老師點一列＝公布該答案為正解。 */
export function spellTallyHTML(s) {
  const m = s.meta;
  const groups = new Map();
  for (const [uid, a] of Object.entries(s.answers)) {
    if (!s.players[uid] || !decode(a.c)) continue;
    const g = groups.get(a.c) || { c: a.c, n: 0, at: Infinity };
    g.n++; g.at = Math.min(g.at, a.at || 0);
    groups.set(a.c, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.n - a.n || a.at - b.at);
  if (!rows.length) return `<div class="sp-tally"><p class="muted center">${m.state === 'open' ? '等待學生送出拼音…' : '沒有人作答'}</p></div>`;
  return `<div class="sp-tally">
    <div class="sp-tally-head">${m.answer ? '點別列可更正標準答案' : '👆 點選正確的拼音＝公布答案'}</div>
    ${rows.map((g) => {
      const parts = m.answer ? spellParts(g.c, m.answer) : null;
      const cls = !parts ? '' : parts.all ? ' correct' : ' wrong';
      return `<button class="sp-row${cls}" data-act="reveal" data-v="${esc(g.c)}">${spellChipHTML(g.c, { parts: parts && !parts.all ? parts : null })}
        <b class="sp-n">×${g.n}</b></button>`;
    }).join('')}</div>`;
}

/** 投影頁：拼音題作答人數；公布後顯示正解大色塊、聲母／韻母／聲調各自答對率與常見錯誤、得分名單。 */
function spellAnswerHTML(s, { big = false } = {}) {
  const m = s.meta;
  const total = Object.values(s.players).filter((p) => p.approved).length;
  const list = Object.entries(s.answers).filter(([uid, a]) => s.players[uid] && decode(a.c));
  const n = list.length;
  const head = `<div class="answered">已作答 <b>${n}</b> / ${total}</div>`;
  if (!m.answer) return `<div class="answer-view spell${big ? ' big' : ''}">${head}<div class="bigmsg sp-wait">✍ 拼音作答中…</div></div>`;
  const k = decode(m.answer);
  const ic = initialCat(k.i);
  const fc = finalCat(k.f);
  const key = `<div class="sp-key">
    <span class="sp-kb${k.i ? '' : ' zero'}" style="${k.i ? `background:${ic.bg};color:${ic.fg}` : ''}">${k.i || '∅'}<small>${ic.name}</small></span>
    <span class="sp-kb" style="background:${fc.bg};color:${fc.fg}">${toneFinal(k.f, k.t)}<small>${fc.name}</small></span>
    <span class="sp-kt">第 <b>${k.t}</b> 調</span></div>`;
  const part = (label, f, show) => {
    const ok = list.filter(([, a]) => decode(a.c)[f] === k[f]).length;
    const wrong = new Map();
    for (const [, a] of list) { const v = decode(a.c)[f]; if (v !== k[f]) wrong.set(v, (wrong.get(v) || 0) + 1); }
    const top = [...wrong.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([v, c]) => `<span class="sp-wr">${esc(show(v))} ×${c}</span>`).join('');
    const pct = n ? Math.round((ok / n) * 100) : 0;
    return `<div class="sp-part"><span class="sp-pl">${label}</span>
      <span class="track"><span style="width:${pct}%"></span></span><span class="num">${ok}/${n}</span>
      <span class="sp-wrong">${top || (n ? '<span class="muted">全對</span>' : '')}</span></div>`;
  };
  const pts = roundPoints(m, s.answers, m.answer);
  const winners = Object.keys(pts).filter((uid) => s.players[uid])
    .sort((a, b) => pts[b] - pts[a] || s.answers[a].at - s.answers[b].at);
  return `<div class="answer-view spell${big ? ' big' : ''}">${head}${key}
    <div class="sp-parts">${part('聲母', 'i', (v) => v || '∅')}${part('韻母', 'f', (v) => v)}${part('聲調', 't', (v) => `${v} 調`)}</div>
    <div class="winners-box"><h3>得分（${winners.length}）</h3>
      <div class="winners">${winners.map((uid) => `<span class="chip">${unitHTML(s.players[uid], m)}<b>+${pts[uid]}</b></span>`).join('')
        || '<span class="muted">沒有人得分</span>'}</div></div>
  </div>`;
}

/* ══ 排序題 ══════════════════════════════════════════════════════════ */

/** 老師正在排的一組順序（依序點 1–6）與已勾選的正解（可多個）；每題一份，只存在這個頁面。 */
const sortDrafts = new Map();
const sortDraft = (m) => sortDrafts.get(m.round) ?? '';
const sortSels = new Map();
function sortSel(m) {
  if (!sortSels.has(m.round)) sortSels.set(m.round, new Set(String(m.answer || '').split(',').filter(isSortCode)));
  return sortSels.get(m.round);
}
const selKey = (sel) => [...sel].sort().join(',');
/** 老師在這個頁面上改了勾選／草稿：請 index.html、remote.html 重畫（本題清單與控制面板都會反映）。 */
const redraw = () => window.dispatchEvent(new Event('buzz:redraw'));

/** 控制面板的公布區：勾選學生答案清單裡的正解（可多個），或依序點 1–6 排出順序按「加入」；最後按公布。 */
function sortRevealHTML(m) {
  const d = sortDraft(m);
  const sel = sortSel(m);
  const changed = selKey(sel) !== (m.answer || '');
  const chosen = [...sel].sort().map((k) => `<button class="sort-sel" data-act="sunsel" data-v="${k}" title="取消這個正解">${sortChipsHTML(k)}<span class="x">✕</span></button>`).join('');
  return `<div class="reveal sort-in"><span>${m.answer ? `已公布 ${m.answer.split(',').length} 個正解（改勾選後再按公布＝更正）`
      : '勾選學生答案清單裡的正解（可以不只一個），或依序點出順序（可少於 6 個）後按「加入」：'}</span>
    <div class="sort-chosen">${chosen || '<span class="muted">尚未勾選正解</span>'}</div>
    <div class="sort-draft">${d ? sortChipsHTML(d) : ''}${'<span class="sc empty"></span>'.repeat(SORT_N - d.length)}</div>
    <div class="sort-pad">${Array.from({ length: SORT_N }, (_, i) => String(i + 1))
      .map((n) => `<button class="btn sm" data-act="spick" data-v="${n}" ${d.includes(n) ? 'disabled' : ''}>${n}</button>`).join('')}
      <button class="btn sm" data-act="sclear" ${d ? '' : 'disabled'}>清除</button>
      <button class="btn sm" data-act="sadd" ${d.length && !sel.has(d) ? '' : 'disabled'}>＋ 加入</button></div>
    <button class="btn btn-yellow" data-act="sortreveal" ${sel.size && changed ? '' : 'disabled'}>✔ 公布答案${sel.size > 1 ? `（${sel.size} 個正解）` : ''}</button></div>`;
}

/** 學生答案歸類（人數多的在前、同數依最早交卷）；老師點一列＝勾選／取消為正解，再按公布。 */
export function sortTallyHTML(s) {
  const m = s.meta;
  const sel = sortSel(m);
  const groups = new Map();
  for (const [uid, a] of Object.entries(s.answers)) {
    if (!s.players[uid] || !isSortCode(a.c)) continue;
    const g = groups.get(a.c) || { c: a.c, n: 0, at: Infinity };
    g.n++; g.at = Math.min(g.at, a.at || 0);
    groups.set(a.c, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.n - a.n || a.at - b.at);
  if (!rows.length) return `<div class="sp-tally"><p class="muted center">${m.state === 'open' ? '等待學生送出排序…' : '沒有人作答'}</p></div>`;
  return `<div class="sp-tally sort-tally">
    <div class="sp-tally-head">👆 勾選正確的順序（可以多個），再按「公布答案」</div>
    ${rows.map((g) => {
      const on = sel.has(g.c);
      const cls = (on ? ' picked' : '') + (!m.answer ? '' : answerMatches(g.c, m.answer) ? ' correct' : ' wrong');
      return `<button class="sp-row${cls}" data-act="stoggle" data-v="${esc(g.c)}"><span class="ck">${on ? '☑' : '☐'}</span>
        ${sortChipsHTML(g.c, { key: m.answer && !answerMatches(g.c, m.answer) ? m.answer : null })}
        <b class="sp-n">×${g.n}</b></button>`;
    }).join('')}
    ${m.state !== 'idle' && m.phase !== 'ended' ? `<button class="btn btn-yellow" data-act="sortreveal" ${sel.size && selKey(sel) !== (m.answer || '') ? '' : 'disabled'}>✔ 公布答案${sel.size > 1 ? `（${sel.size} 個正解）` : ''}</button>` : ''}</div>`;
}

/** 投影頁：排序題作答人數；公布後顯示正確順序大色塊（可多個）與答對名單。 */
function sortAnswerHTML(s, { big = false } = {}) {
  const m = s.meta;
  const total = Object.values(s.players).filter((p) => p.approved).length;
  const list = Object.entries(s.answers).filter(([uid, a]) => s.players[uid] && isSortCode(a.c));
  const n = list.length;
  const right = m.answer ? list.filter(([, a]) => answerMatches(a.c, m.answer)).length : 0;
  const head = `<div class="answered">已作答 <b>${n}</b> / ${total}${m.answer ? `　答對 <b>${right}</b> 人` : ''}</div>`;
  if (!m.answer) return `<div class="answer-view sort${big ? ' big' : ''}">${head}<div class="bigmsg sp-wait">🔢 排序作答中…</div></div>`;
  const keys = m.answer.split(',');
  const keyHTML = keys.map((k) => {
    const c = list.filter(([, a]) => a.c === k).length;
    return `<div class="sort-keyrow">${sortChipsHTML(k, { cls: 'big' })}<span class="num">${c} 人</span></div>`;
  }).join(keys.length > 1 ? '<div class="sort-or">或</div>' : '');
  const pts = roundPoints(m, s.answers, m.answer);
  const winners = Object.keys(pts).filter((uid) => s.players[uid])
    .sort((a, b) => pts[b] - pts[a] || s.answers[a].at - s.answers[b].at);
  return `<div class="answer-view sort${big ? ' big' : ''}">${head}
    <div class="sort-key${keys.length > 1 ? ' multi' : ''}">${keyHTML}</div>
    <div class="winners-box"><h3>答對（${winners.length}）</h3>
      <div class="winners">${winners.map((uid) => `<span class="chip">${unitHTML(s.players[uid], m)}<b>+${pts[uid]}</b></span>`).join('')
        || '<span class="muted">沒有人答對</span>'}</div></div>
  </div>`;
}

/** 複選題老師正在勾選的標準答案（每題一份，只存在這個頁面）；已公布過就從公布的答案開始。 */
const keyDrafts = new Map();
function keyDraft(m) {
  if (!keyDrafts.has(m.round)) keyDrafts.set(m.round, new Set(String(m.answer || '').split('').filter(Boolean)));
  return keyDrafts.get(m.round);
}

/** 事件委派：控制面板裡所有 data-act / data-set 元素。 */
export function bindControls(root, act, { onCleared } = {}) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const { act: a, uid, v } = b.dataset;
    if (a === 'score') return act.addScore(uid, Number(v));
    if (a === 'judge') return act.judge(uid, v);
    if (a === 'reveal') return act.reveal(v);
    if (a === 'qtype') return act.setQtype(v);
    if (a === 'multi') return act.setMulti(v === '1');
    if (a === 'kpick' || a === 'kreveal') {
      const panel = b.closest('.reveal');
      const m = act.getMeta();
      const sel = keyDraft(m);
      if (a === 'kpick') {
        if (sel.has(v)) sel.delete(v); else sel.add(v);
        b.classList.toggle('btn-yellow', sel.has(v));
        const go = panel && panel.querySelector('.kreveal');
        if (go) go.disabled = !sel.size || [...sel].sort().join('') === m.answer;
        return;
      }
      if (sel.size) return act.reveal([...sel].sort().join(''));
      return;
    }
    if (['spick', 'sclear', 'sadd', 'stoggle', 'sunsel', 'sortreveal'].includes(a)) {
      const m = act.getMeta();
      const d = sortDraft(m);
      const sel = sortSel(m);
      if (a === 'sortreveal') { if (sel.size) act.reveal(selKey(sel)); return; }
      if (a === 'spick') sortDrafts.set(m.round, (d + v).slice(0, SORT_N));
      if (a === 'sclear') sortDrafts.set(m.round, '');
      if (a === 'sadd' && isSortCode(d)) { sel.add(d); sortDrafts.set(m.round, ''); }
      if (a === 'stoggle') { if (sel.has(v)) sel.delete(v); else sel.add(v); }
      if (a === 'sunsel') sel.delete(v);
      redraw();
      return;
    }
    if (a === 'sreveal') {
      const m = act.getMeta();
      const pv = spellPreview(spellDrafts.get(m.round) ?? '', m);
      if (pv.code) return act.reveal(pv.code);
      return;
    }
    if (a === 'clear') { if (await act.clearRoom()) onCleared && onCleared(); return; }
    if (a === 'save') { if (await act.save()) onCleared && onCleared(); return; }
    if (typeof act[a] === 'function') act[a](uid);
  });
  // 拼音題輸入臺羅：即時預覽拆解結果，不重繪整個面板
  root.addEventListener('input', (e) => {
    const el = e.target.closest('[data-spellin]');
    if (!el) return;
    const m = act.getMeta();
    spellDrafts.set(m.round, el.value);
    const box = el.closest('.spell-in');
    const pv = spellPreview(el.value, m);
    box.querySelector('[data-spellprev]').innerHTML = pv.html;
    box.querySelector('[data-act="sreveal"]').disabled = !pv.code;
  });
  root.addEventListener('input', (e) => {
    const el = e.target.closest('[data-set="groupCap"]');
    if (el) el.value = el.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/\D/g, '').slice(0, 2);
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-spellin]');
    if (!el || e.key !== 'Enter') return;
    e.preventDefault();
    const b = el.closest('.spell-in').querySelector('[data-act="sreveal"]');
    if (!b.disabled) b.click();
  });
  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-set]');
    if (!el) return;
    if (el.dataset.set === 'qtype') { act.setQtype(el.value); return; }
    if (el.dataset.set === 'groupCap') {
      const c = cleanCap(el.value);
      if (!c) { toast('每組作答數請輸入 1～99 的數字'); return; }
      act.setMeta({ groupCap: c, groupMode: 'cap' });
      return;
    }
    if (el.dataset.set === 'className') {
      const v = cleanClassName(el.value);
      if (!v) { toast('班級名稱不能空白'); return; }
      act.setMeta({ className: v });
      return;
    }
    act.setMeta({ [el.dataset.set]: 'num' in el.dataset ? Number(el.value) : el.value });
  });
}

/* ══ 公開教室清單（buzzLive）：教師端維護摘要，投影頁不用登入也看得到 ══════════ */

export function syncLive(fb, rid, s) {
  if (!s) return;
  const n = Object.values(s.players).filter((p) => p.approved).length;
  const sig = `${s.meta.phase}|${n}|${s.meta.className || ''}`;
  if (syncLive.last === `${rid}|${sig}`) return;
  syncLive.last = `${rid}|${sig}`;
  fb.update(fb.ref(fb.db, `buzzLive/${rid}`), {
    ownerUid: s.meta.ownerUid, ownerName: s.meta.ownerName || '老師', className: s.meta.className || '',
    createdAt: s.meta.createdAt || Date.now(), phase: s.meta.phase, n,
  }).catch(() => {});
}

/* ══ 儲存成績：每班一個 CSV → Apps Script 寫進雲端硬碟資料夾 → 關閉教室 ══════════ */

const csvCell = (v) => {
  const t = String(v ?? '');
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
/** 學生自己輸入的文字（姓名、班級、組別）：像 1-1、1/2、3:30、001、1e5、1月1日 這種 Excel 會自動轉成日期或數字的，
    以及開頭是 = + - @ 會被當公式的，包成 ="1-1"，Excel／Google 試算表開啟時原樣顯示為文字。 */
const textCell = (v) => {
  const t = String(v ?? '');
  const risky = /^[=+\-@]/.test(t)
    || (/\d/.test(t) && /^[\s\d\-\/.:,+%$eE年月日時分秒]+$/.test(t))
    || /^\d{1,4}\s*[-\/.]\s*[A-Za-z]{3,9}$|^[A-Za-z]{3,9}\s*[-\/.]\s*\d{1,4}$/.test(t);   // 1-Jan、Jan-1
  return risky ? `="${t.replace(/"/g, '""')}"` : t;
};
const stamp = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** 產生成績 CSV：一個教室一個檔，檔名＝民國日期＋班級名稱＋_教師名（例如 1151016KM21_詹宗龍.csv）。
    答對題數＝是非／選擇題答對＋搶答被判 ✓；作答次數＝作答＋搶答次數；之後每題一欄作答明細。 */
export function buildScoreFiles(s, when = new Date()) {
  const raw = s.raw || {};
  const keys = raw.keys || {};
  const correct = {};
  const tried = {};
  for (const [round, list] of Object.entries(raw.answers || {})) {
    for (const [uid, a] of Object.entries(list || {})) {
      tried[uid] = (tried[uid] || 0) + 1;
      if (keys[round] && answerMatches(a.c, keys[round])) correct[uid] = (correct[uid] || 0) + 1;
    }
  }
  for (const list of Object.values(raw.buzzes || {})) for (const uid of Object.keys(list || {})) tried[uid] = (tried[uid] || 0) + 1;
  for (const list of Object.values(raw.judges || {})) {
    for (const [uid, v] of Object.entries(list || {})) if (v === 'right') correct[uid] = (correct[uid] || 0) + 1;
  }
  const list = Object.entries(s.players).filter(([, p]) => p.approved).map(([uid, p]) => ({ uid, ...p }));
  if (!list.length) return [];
  list.sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name, 'zh-Hant'));
  // 逐題作答明細：每題一欄，欄名附標準答案；格子＝學生答案＋✓／✗，搶答題記「搶答 ✓／✗」，沒作答留空
  const roundNos = [...new Set([...Object.keys(raw.answers || {}), ...Object.keys(raw.buzzes || {}), ...Object.keys(keys)])]
    .map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const roundHead = roundNos.map((n) => (keys[n] ? `第${n}題（${optionText(keys[n])}）` : `第${n}題`));
  const roundCell = (uid, n) => {
    const a = ((raw.answers || {})[n] || {})[uid];
    if (a) return keys[n] ? `${optionText(a.c)} ${answerMatches(a.c, keys[n]) ? '✓' : '✗'}` : optionText(a.c);
    if (((raw.buzzes || {})[n] || {})[uid]) {
      const j = ((raw.judges || {})[n] || {})[uid];
      return j === 'right' ? '搶答 ✓' : j === 'wrong' ? '搶答 ✗' : '搶答';
    }
    return '';
  };
  let rank = 0;
  const rows = list.map((p, i) => {
    if (i === 0 || (p.score || 0) !== (list[i - 1].score || 0)) rank = i + 1;
    return [rank, textCell(p.cls || OTHER_CLASS), textCell(p.name), p.group ? groupLabel(p.group) : '', p.score || 0, correct[p.uid] || 0, tried[p.uid] || 0,
      ...roundNos.map((n) => roundCell(p.uid, n))];
  });
  const className = cleanClassName(s.meta.className) || '未命名班級';
  // 教師名取建房帳號的 Google 顯示名稱；沒有顯示名稱時用信箱 @ 前面那段
  const teacher = cleanClassName(String(s.meta.ownerName || '').split('@')[0]) || '老師';
  const csv = [
    ['台語課堂搶答成績', `班級 ${className}`, `教室 ${s.rid}`, `題數 ${s.meta.round}`, when.toLocaleString('zh-TW', { hour12: false })],
    ['名次', '學生班級', '姓名', '組別', '總分', '答對題數', '作答次數', ...roundHead],
    ...rows,
  ].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return [{ name: `${rocDate(when)}${className}_${teacher}.csv`, csv }];
}

async function saveScores(fb, rid, getState) {
  const s = getState();
  const files = buildScoreFiles(s);
  if (!files.length) { toast('還沒有已核准的學生，沒有成績可存'); return false; }
  if (!(await ask({
    title: '儲存成績到雲端硬碟',
    message: `將存成 ${files.map((f) => f.name).join('、')}。成功後會關閉教室。`,
    ok: '儲存並關閉教室',
  }))) return false;
  try {
    let result;
    if (fb.isMock) {
      result = { ok: true, files: files.map((f) => ({ name: f.name, url: '#' })) };
      console.log('[mock] 成績檔', files);
    } else {
      if (!SAVE_ENDPOINT) throw new Error('尚未設定存檔網址（core.js 的 SAVE_ENDPOINT）');
      const accessToken = await googleAccessToken();     // 在點擊當下開 Google 驗證視窗
      toast('儲存中…', 10000);
      const res = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },     // 避免 CORS 預檢
        body: JSON.stringify({ accessToken, room: rid, files }),
      });
      if (!res.ok) throw new Error(`存檔服務回應 HTTP ${res.status}`);
      result = await res.json();
    }
    if (!result.ok) throw new Error(result.error || '存檔失敗');
    await fb.remove(fb.ref(fb.db, `buzzLive/${rid}`)).catch(() => {});
    await fb.remove(fb.ref(fb.db, `buzzRooms/${rid}`));
    await fb.remove(fb.ref(fb.db, `buzzOwners/${fb.auth.currentUser.uid}/${rid}`)).catch(() => {});
    await ask({
      title: '✅ 成績已儲存，教室已關閉',
      message: result.files.map((f) => f.name).join('\n'),
      ok: '好', cancel: '關閉',
    });
    return true;
  } catch (e) {
    const msg = e.code === 'auth/popup-closed-by-user' ? '已取消 Google 驗證'
      : e.code === 'auth/popup-blocked' ? '瀏覽器擋住了 Google 驗證視窗，請允許彈出式視窗後再按一次'
      : (e.message || String(e));
    const dl = await ask({
      title: '⚠ 成績尚未存到雲端硬碟（教室保留）',
      message: `原因：${msg}\n可以再按一次「儲存成績」，或先把成績下載到這台裝置。`,
      ok: '下載 CSV', cancel: '關閉',
    });
    if (dl) downloadFiles(files);
    return false;
  }
}

/** 備案：把 CSV 直接下載到目前裝置（加 BOM，Excel 開中文不亂碼）。 */
function downloadFiles(files) {
  for (const f of files) {
    const url = URL.createObjectURL(new Blob(['\uFEFF' + f.csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
