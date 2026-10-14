/*! 台語課堂搶答 — © 2026 詹宗龍（臺中明道中學）保留一切權利。 */
/**
 * teacher.js — 投影頁（index.html）與手機遙控頁（remote.html）共用的教師端邏輯：
 * 登入關卡、房間訂閱、各種操作、控制面板、自動工作（倒數到時鎖定、自動核准）。
 * 兩個頁面同時開著也沒關係：所有自動工作都是冪等的。
 */
import {
  loadFirebase, currentUser, googleSignIn, authErrorText, isTeacherEmail, showSetupNeeded,
  serverNow, esc, $, toast, playerLabel, groupLabel, rankBuzzes, leaderboard,
  DEFAULT_META, GROUP_MODES, PENALTIES, QTYPES, OPTION_SETS, optionList, optionText,
} from './core.js';

/* ══ 登入關卡 ══════════════════════════════════════════════════════ */

export async function teacherBoot(root) {
  let fb;
  try {
    fb = await loadFirebase();
  } catch (e) {
    if (e.code === 'NO_CONFIG') { showSetupNeeded(root); return null; }
    throw e;
  }

  let user = await currentUser();
  if (user && !user.isAnonymous && isTeacherEmail(user.email)) return { fb, user };

  return new Promise((resolve) => {
    const draw = (msg = '') => {
      const who = user && !user.isAnonymous ? user.email : '';
      root.innerHTML = `
        <div class="card center narrow">
          <h2>教師登入</h2>
          <p>請用學校 Google 帳號（@ms.mingdao.edu.tw）登入。</p>
          ${who ? `<p class="warn">${esc(who)} 不在教師名單內。</p>` : ''}
          <div class="row center">
            <button class="btn btn-yellow" id="tLogin">Google 登入</button>
            ${who ? '<button class="btn" id="tOut">換帳號</button>' : ''}
          </div>
          <p class="note" id="tNote">${esc(msg)}</p>
        </div>`;
      $('#tLogin', root).onclick = async () => {
        try {
          if (user) await fb.signOut(fb.auth);
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
    await fb.remove(fb.ref(fb.db, `buzzRooms/${r.rid}`)).catch(() => {});
    await fb.remove(fb.ref(fb.db, `buzzOwners/${uid}/${r.rid}`)).catch(() => {});
  }
  return rooms.filter((r) => !stale.includes(r)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function createRoom(fb, uid, newRoomId) {
  for (let i = 0; i < 5; i++) {
    const rid = newRoomId();
    const exists = (await fb.get(fb.ref(fb.db, `buzzRooms/${rid}/meta`))).exists();
    if (exists) continue;
    await fb.set(fb.ref(fb.db, `buzzRooms/${rid}/meta`), { ...DEFAULT_META, ownerUid: uid, createdAt: fb.serverTimestamp() });
    await fb.set(fb.ref(fb.db, `buzzOwners/${uid}/${rid}`), Date.now());
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
    setMeta: meta,

    /** 搶答題：老師對搶答者按 ✓／✗。再按一次同一顆＝取消，分數一併還原。答對自動鎖定。 */
    judge(uid, verdict) {
      const s = getState();
      const p = s.players[uid];
      if (!p) return;
      const pts = (v) => (v === 'right' ? 1 : v === 'wrong' ? (s.meta.wrongPts || 0) : 0);
      const old = s.judges[uid] || null;
      const next = old === verdict ? null : verdict;
      const upd = {
        [`judges/${s.meta.round}/${uid}`]: next,
        [`players/${uid}/score`]: (p.score || 0) - pts(old) + pts(next),
      };
      if (next === 'right') upd['meta/state'] = 'locked';
      return fb.update(r(), upd).catch((e) => toast(authErrorText(e)));
    },

    /** 作答題：公布正解並一次更新所有人分數；公布後改按別的選項＝更正，分數自動重算。 */
    reveal(ans) {
      const s = getState();
      const prev = s.meta.answer || null;
      if (prev === ans) return;
      const upd = { 'meta/answer': ans, 'meta/state': 'locked' };
      for (const [uid, a] of Object.entries(s.answers)) {
        const p = s.players[uid];
        if (!p) continue;
        const d = (a.c === ans ? 1 : 0) - (a.c === prev ? 1 : 0);
        if (d) upd[`players/${uid}/score`] = (p.score || 0) + d;
      }
      return fb.update(r(), upd).catch((e) => toast(authErrorText(e)));
    },

    setQtype(qtype) {
      const s = getState();
      if (s.meta.state !== 'idle' && !confirm('本題進行中，切換題型會直接進入下一題，確定？')) return;
      return meta(s.meta.state === 'idle' ? { qtype }
        : { qtype, state: 'idle', round: String((parseInt(s.meta.round, 10) || 0) + 1), openAt: null, answer: null });
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
      if (!confirm(`確定要移除「${playerLabel(p || {})}」？移除後這支手機不能再加入本房間。`)) return;
      await fb.set(r(`/kicked/${uid}`), true);
      await fb.remove(r(`/players/${uid}`));
    },
    rename(uid) {
      const p = getState().players[uid];
      const name = prompt('修改姓名／暱稱（20 字內）', p ? p.name : '');
      if (name == null) return;
      const v = name.trim().slice(0, 20);
      if (!v) return;
      fb.update(r(`/players/${uid}`), { name: v }).catch((e) => toast(authErrorText(e)));
    },
    addScore(uid, d) {
      fb.runTransaction(r(`/players/${uid}/score`), (v) => (v || 0) + d).catch((e) => toast(authErrorText(e)));
    },
    async resetScores() {
      if (!confirm('把所有人的分數歸零？')) return;
      const patch = {};
      for (const uid of Object.keys(getState().players)) patch[`${uid}/score`] = 0;
      await fb.update(r('/players'), patch);
    },
    async clearRoom() {
      if (!confirm('結束本次搶答並刪除所有學生姓名與紀錄？此動作無法復原。')) return false;
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
export const stateText = (m) => (m.state === 'open' && m.qtype === 'answer' ? '作答中' : STATE_TEXT[m.state]);

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

/** 作答題：作答人數、各選項分布、公布後答對名單。 */
export function answerHTML(s, { big = false } = {}) {
  const m = s.meta;
  const opts = optionList(m.options);
  const total = Object.values(s.players).filter((p) => p.approved).length;
  const list = Object.entries(s.answers).filter(([uid]) => s.players[uid]);
  const n = list.length;
  const counts = Object.fromEntries(opts.map((o) => [o, 0]));
  for (const [, a] of list) if (a.c in counts) counts[a.c]++;
  const revealed = !!m.answer;
  const bars = opts.map((o) => {
    const c = counts[o];
    const pct = n ? Math.round((c / n) * 100) : 0;
    return `<div class="bar ${revealed && o === m.answer ? 'correct' : ''} ${revealed && o !== m.answer ? 'dim' : ''}">
      <span class="opt">${optionText(o)}</span>
      <span class="track"><span style="width:${revealed ? pct : 0}%"></span></span>
      <span class="num">${revealed ? c : ''}</span></div>`;
  }).join('');
  const winners = revealed
    ? list.filter(([, a]) => a.c === m.answer).sort((a, b) => a[1].at - b[1].at).map(([uid]) => s.players[uid])
    : [];
  return `<div class="answer-view${big ? ' big' : ''}">
    <div class="answered">已作答 <b>${n}</b> / ${total}</div>
    <div class="bars">${bars}</div>
    ${revealed ? `<h3>答對（${winners.length}）</h3>
      <div class="winners">${winners.map((p) => `<span class="chip">${unitHTML(p, m)}</span>`).join('') || '<span class="muted">沒有人答對</span>'}</div>` : ''}
  </div>`;
}

export function boardHTML(s) {
  const rows = leaderboard(s.players, s.meta);
  if (!rows.length) return '<p class="muted center">還沒有人</p>';
  return `<ol class="board">${rows.map((u, i) => `
    <li><span class="rank">${i + 1}</span><span class="who">${esc(u.name)}</span><b>${u.score}</b></li>`).join('')}</ol>`;
}

export function controlsHTML(s) {
  const m = s.meta;
  const btn = (act, label, cls = '', dis = false, extra = '') =>
    `<button class="btn ${cls}" data-act="${act}" ${extra} ${dis ? 'disabled' : ''}>${label}</button>`;
  const seg = Object.entries(QTYPES).map(([v, t]) => btn('qtype', t, m.qtype === v ? 'on' : '', false, `data-v="${v}"`)).join('');
  const isAns = m.qtype === 'answer';
  const optSel = isAns
    ? `<select data-set="options" ${m.state !== 'idle' ? 'disabled' : ''}>${Object.entries(OPTION_SETS)
      .map(([v, t]) => `<option value="${v}" ${m.options === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : '';
  const reveal = isAns && m.state !== 'idle'
    ? `<div class="reveal"><span>${m.answer ? '已公布正解（點別的可更正）' : '公布正解：'}</span>
        ${optionList(m.options).map((o) => btn('reveal', optionText(o), m.answer === o ? 'btn-yellow' : '', false, `data-v="${o}"`)).join('')}</div>`
    : '';
  return `
    <div class="ctl-status">第 <b>${esc(m.round)}</b> 題 · <span class="badge st-${m.state}">${stateText(m)}</span>
      <span class="cd" data-cd></span></div>
    <div class="seg row wrap">${seg}${optSel}</div>
    <div class="ctl-main">
      ${btn('open', isAns ? '▶ 開始作答' : '▶ 開始搶答', 'btn-yellow big', m.state !== 'idle')}
      ${btn('lock', '■ 鎖定', 'big', m.state !== 'open')}
      ${btn('next', '↻ 重置', 'big')}
    </div>
    ${reveal}`;
}

export function playersHTML(s) {
  const entries = Object.entries(s.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const pending = entries.filter(([, p]) => !p.approved);
  const ok = entries.filter(([, p]) => p.approved);
  const row = ([uid, p]) => `
    <li class="${s.presence[uid] ? '' : 'offline'}">
      <span class="who">${esc(playerLabel(p))}${p.group ? `<small>${groupLabel(p.group)}</small>` : ''}</span>
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
  const cds = { 0: '不倒數', 5: '5 秒', 10: '10 秒', 15: '15 秒', 20: '20 秒', 30: '30 秒', 60: '60 秒' };
  const gcs = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [i + 2, `${i + 2} 組`]));
  return `
    <label>倒數秒數<select data-set="countdownSec" data-num>${opt(cds, m.countdownSec)}</select></label>
    <label>偷跑處罰<select data-set="penaltySec" data-num>${opt(PENALTIES, m.penaltySec)}</select></label>
    <label>搶答答錯<select data-set="wrongPts" data-num>${opt({ 0: '不扣分', '-1': '扣 1 分' }, m.wrongPts)}</select></label>
    <label>加入方式<select data-set="joinMode">${opt({ approve: '老師核准', auto: '自動核准' }, m.joinMode)}</select></label>
    <label>分組規則<select data-set="groupMode">${opt(GROUP_MODES, m.groupMode)}</select></label>
    ${m.groupMode === 'none' ? '' : `<label>組數<select data-set="groupCount" data-num>${opt(gcs, m.groupCount)}</select></label>`}
    <div class="row wrap">
      ${m.phase === 'lobby'
        ? '<button class="btn" data-act="game">進入搶答畫面</button>'
        : '<button class="btn" data-act="lobby">回到加入畫面（大 QR）</button>'}
      <button class="btn" data-act="resetScores">分數歸零</button>
      <button class="btn danger" data-act="clear">結束並清除資料</button>
    </div>`;
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
    if (a === 'clear') { if (await act.clearRoom()) onCleared && onCleared(); return; }
    if (typeof act[a] === 'function') act[a](uid);
  });
  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-set]');
    if (!el) return;
    act.setMeta({ [el.dataset.set]: 'num' in el.dataset ? Number(el.value) : el.value });
  });
}
