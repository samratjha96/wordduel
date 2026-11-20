// Small Web Audio synth. The context is created on the first touch (iOS requires a gesture).
let ctx = null;
let out = null;
let muted = localStorage.getItem('wd:muted') === '1';

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export const isMuted = () => muted;
export function setMuted(v) {
  muted = v;
  localStorage.setItem('wd:muted', v ? '1' : '0');
}

function tone(freq, { at = 0, dur = 0.15, type = 'sine', gain = 0.3, to = null, attack = 0.005 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise({ at = 0, dur = 0.12, gain = 0.15, freq = 900 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const src = ctx.createBufferSource();
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  src.buffer = buf;
  f.type = 'lowpass';
  f.frequency.value = freq;
  g.gain.value = gain;
  src.connect(f).connect(g).connect(out);
  src.start(t);
}

// Pentatonic steps so a long swipe climbs pleasantly.
const STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];
const note = (base, step) => base * 2 ** (STEPS[Math.min(step, STEPS.length - 1)] / 12);

export const sfx = {
  tick(n) { tone(note(392, n), { dur: 0.06, type: 'triangle', gain: 0.07 }); },
  word() {
    tone(659.25, { dur: 0.18, type: 'triangle', gain: 0.28 });
    tone(987.77, { at: 0.07, dur: 0.26, type: 'triangle', gain: 0.24 });
  },
  long() {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) =>
      tone(f, { at: i * 0.055, dur: 0.42 - i * 0.03, type: 'triangle', gain: 0.22 }));
    tone(2093, { at: 0.28, dur: 0.6, type: 'sine', gain: 0.06 });
  },
  miss() {
    tone(196, { dur: 0.22, type: 'sine', gain: 0.32, to: 110 });
    noise({ dur: 0.09, gain: 0.12, freq: 500 });
  },
  dup() { tone(440, { dur: 0.09, type: 'sine', gain: 0.12 }); tone(440, { at: 0.1, dur: 0.09, type: 'sine', gain: 0.1 }); },
  go() { tone(880, { dur: 0.12, type: 'triangle', gain: 0.18 }); },
  end() {
    tone(392, { dur: 0.5, type: 'triangle', gain: 0.25 });
    tone(523.25, { at: 0.12, dur: 0.6, type: 'triangle', gain: 0.22 });
  },
};
