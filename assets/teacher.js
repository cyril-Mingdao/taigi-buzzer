/*! 台語課堂搶答 — © 2026 詹宗龍（臺中明道中學）保留一切權利。 */
/**
 * teacher.js — 投影頁（index.html）與手機遙控頁（remote.html）共用的教師端邏輯：
 * 登入關卡、房間訂閱、各種操作、控制面板、自動工作（倒數到時鎖定、自動核准）。
 * 兩個頁面同時開著也沒關係：所有自動工作都是冪等的。
 */
import {
  loadFirebase, currentUser, googleSignIn, authErrorText, isTeacherEmail, showSetupNeeded,
  serverNow, esc, $, toast, ask, playerLabel, groupLabel, rankBuzzes, leaderboard,
  DEFAULT_META, GROUP_MODES, PENALTIES, QTYPES, optionList, optionText, isChoice,
  CORRECT_PTS, choicePoints, isMulti, SAVE_ENDPOINT, googleAccessToken, OTHER_CLASS, cleanClassName, rocDate,
} from './core.js?v=20';

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
          ${who ? `<p class="noperm" role="alert"><b>您無權限建立房間或請切換帳號</b><span>目前登入：${esc(who)}</span></p>` : ''}
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

/* ══ 房間建立／列出（投影頁開場用） ══════════════════════════════════ */

export async function listMyRooms(fb, uid) {
  const snap = await fb.get(fb.ref(fb.db, `buzzOwners/${uid}`));
  const rooms = Object.entries(snap.val() || {}).map(([rid, createdAt]) => ({ rid, createdAt }));
  // 超過 24 小時的舊房間順手清掉（個資不留存）
  const stale = rooms.filter((r) => Date.now() - r.createdAt > 24 * 3600 * 1000);
  for (const r of stale) {
    await fb.remove(fb.ref(fb.db, `buzzLive/${r.rid}`)).catch(() => {});
    await fb.remove(fb.ref(fb.db, `buzzRooms/${r.rid}`)).catch(() => {});
    await fb.remove(fb.ref(fb.db, `buzzOwners/${uid}/${r.rid}`)).catch(() => {});
  }
  return rooms.filter((r) => !stale.includes(r)).sort((a, b) => b.createdAt - a.createdAt);
}

export const teacherName = (u) => String((u && (u.displayName || u.email)) || '老師').slice(0, 40);

export async function createRoom(fb, user, newRoomId, className) {
  const uid = user.uid;
  const ownerName = teacherName(user);
  className = cleanClassName(className);
  if (!className) throw new Error('請輸入班級名稱');
  for (let i = 0; i < 5; i++) {
    const rid = newRoomId();
    const exists = (await fb.get(fb.ref(fb.db, `buzzRooms/${rid}/meta`))).exists();
    if (exists) continue;
    await fb.set(fb.ref(fb.db, `buzzRooms/${rid}/meta`), { ...DEFAULT_META, ownerUid: uid, ownerName, className, createdAt: fb.serverTimestamp() });
    await fb.set(fb.ref(fb.db, `buzzOwners/${uid}/${rid}`), Date.now());
    await fb.set(fb.ref(fb.db, `buzzLive/${rid}`), { ownerUid: uid, ownerName, className, createdAt: Date.now(), phase: 'lobby', n: 0 });
    return rid;
  }
  throw new Error('房間碼重複太多次，請再試一次');
}

/* ══ 房間訂閱與操作 ══════════════════════════════════════════════════ */

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

  const singleConflict = (uid, s, alsoTaken = new Set()) => {
    const p = s.players[uid];
    if (s.meta.groupMode !== 'single' || !p || !p.group) return null;
    if (alsoTaken.has(p.group)) return p.group;
    const other = Object.entries(s.players).find(([u, q]) => u !== uid && q.approved && q.group === p.group);
    return other ? p.group : null;
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

    /** 是非／選擇題：老師選標準答案後核對全部作答並計分（答對 10 分＋前五名速度加成）；
        改選別的答案＝更正，分數依新舊答案差額重算。 */
    reveal(ans) {
      const s = getState();
      const prev = s.meta.answer || null;
      if (prev === ans) return;
      const oldPts = choicePoints(s.answers, prev);
      const newPts = choicePoints(s.answers, ans);
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
      if (g) return toast(`${groupLabel(g)}已經有一台手機了（一組只限一台）`);
      return fb.update(r(`/players/${uid}`), { approved: true, score: s.players[uid].score || 0 }).catch((e) => toast(authErrorText(e)));
    },
    async approveAll() {
      const s = getState();
      const taken = new Set();
      const patch = {};
      for (const [uid, p] of Object.entries(s.players)) {
        if (p.approved) continue;
        if (singleConflict(uid, s, taken)) continue;
        if (p.group) taken.add(p.group);
        patch[`${uid}/approved`] = true;
        patch[`${uid}/score`] = p.score || 0;
      }
      if (Object.keys(patch).length) await fb.update(r('/players'), patch).catch((e) => toast(authErrorText(e)));
    },
    async kick(uid) {
      const p = getState().players[uid];
      if (!(await ask({
        title: `移除「${playerLabel(p || {})}」？`, message: '移除後這支手機不能再加入本房間。', ok: '移除', danger: true,
      }))) return;
      await fb.set(r(`/kicked/${uid}`), true);
      await fb.remove(r(`/players/${uid}`));
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
        title: '關閉並清除資料', message: '刪除本房間所有學生姓名與紀錄，此動作無法復原。', ok: '關閉並清除', danger: true,
      }))) return false;
      await fb.remove(fb.ref(fb.db, `buzzLive/${rid}`)).catch(() => {});
      await fb.remove(r(''));
      await fb.remove(fb.ref(fb.db, `buzzOwners/${fb.auth.currentUser.uid}/${rid}`)).catch(() => {});
      return true;
    },
  };
}

/** 倒數到時自動鎖定、自動核准。每次房間資料變動與每 250ms 呼叫一次。 */
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
export { qtypeLabel } from './core.js?v=20';
export const stateText = (m) => (m.phase === 'ended' ? '活動結束'
  : m.state === 'open' && isChoice(m) ? '作答中' : STATE_TEXT[m.state]);

/* ══ 控制面板（遙控頁全版、投影頁抽屜共用） ══════════════════════════ */

/** 只在 HTML 字串有變時才替換，避免下拉選單開著時被重繪關掉。 */
export function patch(el, html) {
  if (el && el._html !== html) { el._html = html; el.innerHTML = html; }
}

const grouped = (m) => m.groupMode === 'first' || m.groupMode === 'single';
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
  const pts = revealed ? choicePoints(s.answers, m.answer) : {};
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
  const pts = revealed ? choicePoints(s.answers, m.answer) : {};
  const dist = opts.map((o) => `<span class="dist-item ${revealed && String(m.answer).includes(o) ? 'correct' : ''}">
    <b>${optionText(o)}</b>${counts[o]}</span>`).join('');
  const off = (uid) => (s.presence[uid] ? '' : ' offline');
  const doneRows = done.map(([uid, p], i) => {
    const a = s.answers[uid];
    const dt = typeof m.openAt === 'number' ? `${Math.max(0, (a.at - m.openAt) / 1000).toFixed(1)}s` : '';
    const mark = !revealed ? '' : a.c === m.answer ? 'right' : 'wrong';
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
    <div class="dist">${dist}</div>
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
    const mark = !a ? ' waiting' : !m.answer ? '' : a.c === m.answer ? ' right' : ' wrong';
    // 卡片只放姓名（班級前綴會把名字擠掉），完整標籤放在滑鼠提示
    return `<span class="lchip${mark}${off(uid)}" title="${esc(playerLabel(p))}"><span class="nm">${esc(p.name || playerLabel(p))}</span>`
      + `<b>${a ? optionText(a.c) : '—'}</b></span>`;
  };
  return `<div class="live-chips">
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
    <div class="pod-title">${medal[u.rank][1]}</div><div class="pod-name">${esc(u.name)}</div><div class="pod-score">${u.score} 分</div></div>`;
  // 頒獎台排列：亞軍－冠軍－季軍
  const order = [...top.filter((u) => u.rank === 2), ...top.filter((u) => u.rank === 1), ...top.filter((u) => u.rank === 3)];
  return `<div class="ended">
    <h2 class="ended-title">🏆 ${s.meta.className ? `${esc(s.meta.className)} ` : ''}活動結束</h2>
    <div class="podium">${order.map(col).join('')}</div>
    ${rest.length ? `<ol class="board rest">${rest.map((u) => `
      <li><span class="rank">${u.rank}</span><span class="who">${esc(u.name)}</span><b>${u.score}</b></li>`).join('')}</ol>` : ''}
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
        ${btn('clear', '✕ 關閉房間', 'big danger')}
      </div>
      <p class="note">「儲存成績」存成「民國日期＋班級名稱＋_教師名」的 CSV 到雲端硬碟，成功後自動關閉房間；「關閉房間」不存檔直接刪除本房間資料。</p>`;
  }
  const choice = isChoice(m);
  const seg = Object.entries(QTYPES).map(([v, t]) => btn('qtype', t, m.qtype === v ? 'on' : '', false, `data-v="${v}"`)).join('');
  const multi = isMulti(m);
  const modeSeg = choice && m.qtype !== 'tf'
    ? `<div class="seg mode-seg">${btn('multi', '單選', multi ? '' : 'on', false, 'data-v="0"')}${btn('multi', '複選', multi ? 'on' : '', false, 'data-v="1"')}</div>`
    : '';
  let reveal = '';
  if (choice && m.state !== 'idle' && !multi) {
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
    <div class="seg row wrap">${seg}</div>
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
  const entries = Object.entries(s.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const pending = entries.filter(([, p]) => !p.approved);
  const ok = entries.filter(([, p]) => p.approved);
  // 是非／選擇題作答中或已鎖定：名字後面直接顯示本題選的答案（只有老師手機看得到）
  const showPick = isChoice(s.meta) && s.meta.state !== 'idle' && s.meta.phase !== 'ended';
  const pickTag = (uid) => {
    if (!showPick) return '';
    const a = s.answers[uid];
    if (!a) return '<span class="pick none">未作答</span>';
    const mark = !s.meta.answer ? '' : a.c === s.meta.answer ? ' right' : ' wrong';
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
    <ul class="plist">${ok.map(row).join('') || '<li class="muted">沒有</li>'}</ul>`;
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
    <label>分組規則<select data-set="groupMode">${opt(GROUP_MODES, m.groupMode)}</select></label>
    ${m.groupMode === 'none' ? '' : `<label>組數<select data-set="groupCount" data-num>${opt(gcs, m.groupCount)}</select></label>`}
    <p class="note">計分：答對 ${CORRECT_PTS} 分；是非／選擇題答對者依交卷先後再加 +5、+4、+3、+2、+1。</p>
    <div class="row wrap">
      ${m.phase === 'lobby'
        ? '<button class="btn" data-act="game">進入搶答畫面</button>'
        : '<button class="btn" data-act="lobby">回到加入畫面（大 QR）</button>'}
      <button class="btn" data-act="resetScores">分數歸零</button>
      <button class="btn danger" data-act="clear">關閉並清除資料</button>
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
    if (a === 'clear') { if (await act.clearRoom()) onCleared && onCleared(); return; }
    if (a === 'save') { if (await act.save()) onCleared && onCleared(); return; }
    if (typeof act[a] === 'function') act[a](uid);
  });
  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-set]');
    if (!el) return;
    if (el.dataset.set === 'qtype') { act.setQtype(el.value); return; }
    if (el.dataset.set === 'className') {
      const v = cleanClassName(el.value);
      if (!v) { toast('班級名稱不能空白'); return; }
      act.setMeta({ className: v });
      return;
    }
    act.setMeta({ [el.dataset.set]: 'num' in el.dataset ? Number(el.value) : el.value });
  });
}

/* ══ 公開房間清單（buzzLive）：教師端維護摘要，投影頁不用登入也看得到 ══════════ */

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

/* ══ 儲存成績：每班一個 CSV → Apps Script 寫進雲端硬碟資料夾 → 關閉房間 ══════════ */

const csvCell = (v) => {
  const t = String(v ?? '');
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const stamp = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** 產生成績 CSV：一個房間一個檔，檔名＝民國日期＋班級名稱＋_教師名（例如 1151016KM21_詹宗龍.csv）。
    答對題數＝是非／選擇題答對＋搶答被判 ✓；作答次數＝作答＋搶答次數。 */
export function buildScoreFiles(s, when = new Date()) {
  const raw = s.raw || {};
  const keys = raw.keys || {};
  const correct = {};
  const tried = {};
  for (const [round, list] of Object.entries(raw.answers || {})) {
    for (const [uid, a] of Object.entries(list || {})) {
      tried[uid] = (tried[uid] || 0) + 1;
      if (keys[round] && a.c === keys[round]) correct[uid] = (correct[uid] || 0) + 1;
    }
  }
  for (const list of Object.values(raw.buzzes || {})) for (const uid of Object.keys(list || {})) tried[uid] = (tried[uid] || 0) + 1;
  for (const list of Object.values(raw.judges || {})) {
    for (const [uid, v] of Object.entries(list || {})) if (v === 'right') correct[uid] = (correct[uid] || 0) + 1;
  }
  const list = Object.entries(s.players).filter(([, p]) => p.approved).map(([uid, p]) => ({ uid, ...p }));
  if (!list.length) return [];
  list.sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name, 'zh-Hant'));
  let rank = 0;
  const rows = list.map((p, i) => {
    if (i === 0 || (p.score || 0) !== (list[i - 1].score || 0)) rank = i + 1;
    return [rank, p.cls || OTHER_CLASS, p.name, p.group ? groupLabel(p.group) : '', p.score || 0, correct[p.uid] || 0, tried[p.uid] || 0];
  });
  const className = cleanClassName(s.meta.className) || '未命名班級';
  // 教師名取建房帳號的 Google 顯示名稱；沒有顯示名稱時用信箱 @ 前面那段
  const teacher = cleanClassName(String(s.meta.ownerName || '').split('@')[0]) || '老師';
  const csv = [
    ['台語課堂搶答成績', `班級 ${className}`, `房間 ${s.rid}`, `題數 ${s.meta.round}`, when.toLocaleString('zh-TW', { hour12: false })],
    ['名次', '學生班級', '姓名', '組別', '總分', '答對題數', '作答次數'],
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
    message: `將存成 ${files.map((f) => f.name).join('、')}。成功後會關閉房間。`,
    ok: '儲存並關閉房間',
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
      title: '✅ 成績已儲存，房間已關閉',
      message: result.files.map((f) => f.name).join('\n'),
      ok: '好', cancel: '關閉',
    });
    return true;
  } catch (e) {
    const msg = e.code === 'auth/popup-closed-by-user' ? '已取消 Google 驗證'
      : e.code === 'auth/popup-blocked' ? '瀏覽器擋住了 Google 驗證視窗，請允許彈出式視窗後再按一次'
      : (e.message || String(e));
    const dl = await ask({
      title: '⚠ 成績尚未存到雲端硬碟（房間保留）',
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
