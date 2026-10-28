/*! 台語課堂搶答・拼音題 — © 2026 詹宗龍（臺中明道中學）保留一切權利。拼音依教育部《臺灣台語羅馬字拼音方案》。 */
/**
 * spell.js — 拼音題（qtype 'spell'）共用資料與工具，學生頁、教師頁、投影頁都用。
 * 聲母／韻母分類與配色、自動標調沿用「羅馬字拼音答題」v10。
 *
 * 答案編碼：「聲母|韻母|調」，例如 ts|iah|8；無聲母聲母欄留空，例如 |a|1。
 * 存在 answers/{round}/{uid}.c、meta.answer、keys/{round}，與是非／選擇題共用欄位。
 */

export const INITIAL_CATS = {
  lip: { name: '雙唇音', bg: '#E53935', fg: '#FFFFFF' },
  tongue: { name: '舌尖音', bg: '#1E5BD8', fg: '#FFFFFF' },
  root: { name: '舌根音', bg: '#12A150', fg: '#FFFFFF' },
  teeth: { name: '齒音', bg: '#8E24AA', fg: '#FFFFFF' },
  throat: { name: '喉音', bg: '#FF8F00', fg: '#111111' },
  zero: { name: '無聲母', bg: 'transparent', fg: '#BDBDBD' },
};
export const INITIAL_ROWS = [
  { cat: 'lip', items: ['p', 'ph', 'm', 'b'] },
  { cat: 'tongue', items: ['t', 'th', 'n', 'l'] },
  { cat: 'root', items: ['k', 'kh', 'ng', 'g'] },
  { cat: 'teeth', items: ['ts', 'tsh', 's', 'j'] },
  { cat: 'throat', items: ['h'], zeroAfter: true },
];
export const FINAL_CATS = {
  vowel: { name: '單元音', bg: '#FFD400', fg: '#111111' },
  syllabic: { name: '聲化韻', bg: '#B388FF', fg: '#111111' },
  diph: { name: '複元音', bg: '#00E5FF', fg: '#111111' },
  nasal: { name: '鼻化韻', bg: '#FF5CB8', fg: '#111111' },
  coda: { name: '鼻音韻尾', bg: '#76FF03', fg: '#111111' },
  stopH: { name: '入聲 -h', bg: '#FFFFFF', fg: '#111111' },
  stopPTK: { name: '入聲 -p -t -k', bg: '#8D6E63', fg: '#FFFFFF' },
};
export const FINAL_TABS = [
  { label: '單元音', title: '單元音／聲化韻', rows: [
    { cat: 'vowel', items: ['a', 'i', 'u', 'e', 'oo', 'o'] },
    { cat: 'syllabic', items: ['m', 'ng'] },
  ] },
  { label: '複元音', title: '複元音', rows: [
    { cat: 'diph', items: ['ai', 'au', 'ia', 'iu', 'io'] },
    { cat: 'diph', items: ['ua', 'ue', 'iau', 'ui', 'uai'] },
  ] },
  { label: '鼻化韻', title: '鼻化韻', rows: [
    { cat: 'nasal', items: ['ann', 'inn', 'enn', 'onn'] },
    { cat: 'nasal', items: ['ainn', 'aunn', 'iann', 'iunn'] },
    { cat: 'nasal', items: ['uinn', 'iaunn', 'uann', 'uainn'] },
  ] },
  { label: '鼻音尾', title: '鼻音韻尾 -m -n -ng', rows: [
    { cat: 'coda', items: ['am', 'im', 'om', 'iam'] },
    { cat: 'coda', items: ['an', 'in', 'un', 'ian', 'uan'] },
    { cat: 'coda', items: ['ang', 'ing', 'ong', 'iang', 'iong', 'uang'] },
  ] },
  { label: '入聲h', title: '入聲 -h', rows: [
    { cat: 'stopH', items: ['ah', 'ih', 'uh', 'eh', 'oh'] },
    { cat: 'stopH', items: ['auh', 'iah', 'iuh', 'ioh'] },
    { cat: 'stopH', items: ['uah', 'uih', 'ueh', 'iauh'] },
    { cat: 'stopH', items: ['annh', 'ennh', 'innh', 'onnh'] },
  ] },
  { label: '入聲ptk', title: '入聲 -p -t -k', rows: [
    { cat: 'stopPTK', items: ['ap', 'ip', 'op', 'iap'] },
    { cat: 'stopPTK', items: ['at', 'it', 'ut', 'iat', 'uat'] },
    { cat: 'stopPTK', items: ['ak', 'ik', 'ok', 'iak', 'iok'] },
  ] },
];
export const TONES = [
  { n: '1', ex: 'a' }, { n: '2', ex: 'á' }, { n: '3', ex: 'à' }, { n: '4', ex: 'ah' },
  { n: '5', ex: 'â' }, { n: '7', ex: 'ā' }, { n: '8', ex: 'a̍h' },
];
/** 第 1～20 組各一個底色（與拼音答題 v10 相同），[底色, 字色] */
export const GROUP_COLORS = [
  ['#E53935', '#FFFFFF'], ['#1E88E5', '#FFFFFF'], ['#43A047', '#FFFFFF'], ['#FDD835', '#111111'],
  ['#8E24AA', '#FFFFFF'], ['#FB8C00', '#111111'], ['#00ACC1', '#111111'], ['#D81B60', '#FFFFFF'],
  ['#6D4C41', '#FFFFFF'], ['#7CB342', '#111111'], ['#3949AB', '#FFFFFF'], ['#F4511E', '#FFFFFF'],
  ['#00897B', '#FFFFFF'], ['#C0CA33', '#111111'], ['#5E35B1', '#FFFFFF'], ['#FFB300', '#111111'],
  ['#039BE5', '#111111'], ['#757575', '#FFFFFF'], ['#F06292', '#111111'], ['#FFFFFF', '#111111'],
];

const INITIAL_CAT_OF = Object.fromEntries(INITIAL_ROWS.flatMap((r) => r.items.map((i) => [i, r.cat])));
INITIAL_CAT_OF[''] = 'zero';
const FINAL_CAT_OF = Object.fromEntries(FINAL_TABS.flatMap((t) => t.rows.flatMap((r) => r.items.map((f) => [f, r.cat]))));
export const INITIALS = Object.keys(INITIAL_CAT_OF);
export const FINALS = Object.keys(FINAL_CAT_OF);
const TONE_SET = new Set(TONES.map((t) => t.n));
export const initialCat = (i) => INITIAL_CATS[INITIAL_CAT_OF[i]] || INITIAL_CATS.zero;
export const finalCat = (f) => FINAL_CATS[FINAL_CAT_OF[f]] || FINAL_CATS.vowel;

/* ── 自動標調符：a > oo/o > e > (iu、ui 標後一字) > i/u > 成音節 m、ng ── */
const TONE_MARK = { 2: '́', 3: '̀', 5: '̂', 7: '̄', 8: '̍' };
function markIndex(fin) {
  const core = fin.replace(/nn(h?)$/, '$1');
  let i;
  if ((i = core.indexOf('a')) >= 0) return i;
  if ((i = core.indexOf('o')) >= 0) return i;
  if ((i = core.indexOf('e')) >= 0) return i;
  if ((i = core.indexOf('iu')) >= 0) return i + 1;
  if ((i = core.indexOf('ui')) >= 0) return i + 1;
  if ((i = core.indexOf('i')) >= 0) return i;
  if ((i = core.indexOf('u')) >= 0) return i;
  if (fin === 'm' || fin === 'ng') return 0;
  return -1;
}
export function toneFinal(fin, tone) {
  const mark = TONE_MARK[tone];
  if (!mark) return fin;
  const idx = markIndex(fin);
  if (idx < 0) return fin;
  return (fin.slice(0, idx + 1) + mark + fin.slice(idx + 1)).normalize('NFC');
}

/* ── 編碼 ── */
export const encode = ({ i, f, t }) => `${i}|${f}|${t}`;
export function decode(c) {
  const p = String(c || '').split('|');
  return p.length === 3 ? { i: p[0], f: p[1], t: p[2] } : null;
}
export const isSpellCode = (c) => !!decode(c);
/** 顯示用：ts|iah|8 → tsia̍h */
export function spellText(c) {
  const d = decode(c);
  return d ? d.i + toneFinal(d.f, d.t) : String(c || '');
}

/**
 * 老師輸入的臺羅拆成 { i, f, t }，失敗回傳 { error }。
 * 接受數字調（tsiah8）、調符（tsia̍h）、大小寫、白話字的 o͘／ⁿ；無調號時依韻尾判斷第 1 或第 4 調。
 */
export function parseTailo(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return { error: '請輸入臺羅' };
  if (/[\s\-–]/.test(s)) return { error: '一次只能輸入一個音節' };
  s = s.normalize('NFD').replace(/͘/g, 'o').replace(/ⁿ/g, 'nn');
  const marks = { '́': '2', '̀': '3', '̂': '5', '̄': '7', '̍': '8' };
  let tone = null;
  let bare = '';
  for (const ch of s) {
    if (marks[ch]) {
      if (tone && tone !== marks[ch]) return { error: '調符重複' };
      tone = marks[ch];
    } else if (/[̀-ͯ]/.test(ch)) {
      return { error: '看不懂的調符' };
    } else bare += ch;
  }
  const dm = bare.match(/^([a-z]+)([0-9])?$/);
  if (!dm) return { error: '只能有英文字母與結尾的數字調' };
  bare = dm[1];
  if (dm[2]) {
    if (!TONE_SET.has(dm[2])) return { error: `沒有第 ${dm[2]} 調` };
    if (tone && tone !== dm[2]) return { error: '調符和數字調不一致' };
    tone = dm[2];
  }
  // 最長字首比對聲母，剩下的必須是韻母（ng 單獨出現時是聲化韻）
  const byLen = [...INITIALS].sort((a, b) => b.length - a.length);
  for (const i of byLen) {
    if (!bare.startsWith(i)) continue;
    const f = bare.slice(i.length);
    if (FINAL_CAT_OF[f]) {
      const t = tone || (/[hptk]$/.test(f) ? '4' : '1');
      return { i, f, t };
    }
  }
  return { error: `「${bare}」拆不出聲母＋韻母` };
}

/* ── 計分：聲母、韻母、聲調分開給分；全對者再依交卷先後加 +5～+1 ── */
export const SPELL_PTS = { i: 3, f: 4, t: 3 };
const SPEED_BONUS = [5, 4, 3, 2, 1];
/** 各部分對錯 { i, f, t, all }（布林）。 */
export function spellParts(c, key) {
  const a = decode(c);
  const k = decode(key);
  if (!a || !k) return null;
  const r = { i: a.i === k.i, f: a.f === k.f, t: a.t === k.t };
  r.all = r.i && r.f && r.t;
  return r;
}
/** 某一題的得分表 { uid: 分數 }（只列有得分的人）。 */
export function spellPoints(answers, key) {
  const pts = {};
  if (!decode(key)) return pts;
  const full = [];
  for (const [uid, a] of Object.entries(answers || {})) {
    const r = a && spellParts(a.c, key);
    if (!r) continue;
    const p = (r.i ? SPELL_PTS.i : 0) + (r.f ? SPELL_PTS.f : 0) + (r.t ? SPELL_PTS.t : 0);
    if (p) pts[uid] = p;
    if (r.all) full.push([uid, a.at]);
  }
  full.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .forEach(([uid], i) => { pts[uid] += SPEED_BONUS[i] || 0; });
  return pts;
}

/** 小型色塊（名單、統計清單用）：聲母塊＋韻母塊（含調符），可另標各部分對錯。 */
export function spellChipHTML(c, { parts = null } = {}) {
  const d = decode(c);
  if (!d) return '';
  const ic = initialCat(d.i);
  const fc = finalCat(d.f);
  const ok = (v) => (parts ? (v ? ' ok' : ' ng') : '');
  return `<span class="sp-chip"><span class="sp-b${d.i ? '' : ' zero'}${ok(parts && parts.i)}" style="${d.i ? `background:${ic.bg};color:${ic.fg}` : ''}">${d.i || '∅'}</span>`
    + `<span class="sp-b${ok(parts && parts.f)}" style="background:${fc.bg};color:${fc.fg}">${toneFinal(d.f, d.t)}</span>`
    + `<span class="sp-t${ok(parts && parts.t)}">${d.t}</span></span>`;
}
