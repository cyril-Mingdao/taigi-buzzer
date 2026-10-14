/*! 台語課堂搶答 — © 2026 詹宗龍（臺中明道中學）保留一切權利。 */
/** sound.js — 用 Web Audio 即時合成音效，不需要音檔。瀏覽器要求使用者先點過畫面才能發聲。 */

let ctx = null;
let muted = false;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
// 第一次點擊時解鎖音訊
window.addEventListener('pointerdown', () => { try { ac(); } catch {} }, { once: true });

function tone(freq, dur = 0.12, { type = 'square', gain = 0.18, delay = 0 } = {}) {
  if (muted) return;
  try {
    const c = ac();
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {}
}

export const sound = {
  setMuted(v) { muted = !!v; },
  get muted() { return muted; },
  join() { tone(660, 0.08, { type: 'sine' }); tone(990, 0.1, { type: 'sine', delay: 0.08 }); },
  open() { tone(523, 0.1); tone(784, 0.1, { delay: 0.1 }); tone(1047, 0.22, { delay: 0.2 }); },
  first() { tone(880, 0.12, { type: 'sawtooth' }); tone(1175, 0.12, { type: 'sawtooth', delay: 0.12 }); tone(1568, 0.3, { type: 'sawtooth', delay: 0.24 }); },
  buzz() { tone(740, 0.08, { type: 'triangle', gain: 0.25 }); },
  tick() { tone(1200, 0.05, { type: 'sine', gain: 0.12 }); },
  end() { tone(330, 0.35, { type: 'sawtooth', gain: 0.15 }); },
  foul() { tone(200, 0.25, { type: 'square', gain: 0.2 }); tone(150, 0.3, { type: 'square', gain: 0.2, delay: 0.2 }); },
};
