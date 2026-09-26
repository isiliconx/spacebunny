/**
 * Sound, synthesised on the fly.
 *
 * No audio files: every effect is a couple of oscillators and a noise burst
 * through a filter. That keeps the project a single self-contained folder and
 * lets pitch track gameplay — footstep brightness follows ground speed, the
 * landing thud scales with impact, and each crystal collected walks up a
 * pentatonic scale so a clean sweep sounds like a reward.
 *
 * The context is created on the first user gesture, because browsers refuse
 * to start audio before one.
 */

const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.5];

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.noiseBuffer = null;
    this._collectIndex = 0;
  }

  /** Must be called from a user gesture handler. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;

    // A gentle limiter so a burst of simultaneous effects cannot clip.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    // One second of white noise, reused for every percussive sound.
    const len = Math.floor(this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }
  get t() { return this.ctx.currentTime; }

  setMuted(m) {
    this.muted = m;
    if (this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.t, 0.02);
    }
    return this.muted;
  }

  toggleMute() { return this.setMuted(!this.muted); }

  /** A pitched blip with an exponential tail. */
  tone({ freq = 440, to = null, dur = 0.2, type = 'sine', gain = 0.3, delay = 0, attack = 0.005 }) {
    if (!this.ready || this.muted) return;
    const t0 = this.t + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** A filtered noise burst: footsteps, impacts, dust. */
  noise({ dur = 0.15, freq = 900, q = 1.1, gain = 0.25, delay = 0, type = 'lowpass', sweepTo = null }) {
    if (!this.ready || this.muted) return;
    const t0 = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;

    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    filter.Q.value = q;
    if (sweepTo !== null) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
    }

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ── the actual effects ─────────────────────────────────── */

  jump() {
    this.tone({ freq: 300, to: 620, dur: 0.22, type: 'triangle', gain: 0.22 });
    this.noise({ dur: 0.1, freq: 500, gain: 0.08, sweepTo: 1800 });
  }

  doubleJump() {
    this.tone({ freq: 520, to: 980, dur: 0.26, type: 'triangle', gain: 0.2 });
    this.tone({ freq: 780, to: 1560, dur: 0.2, type: 'sine', gain: 0.12, delay: 0.03 });
  }

  land(impact = 0.5) {
    const i = Math.min(1, impact);
    this.noise({ dur: 0.16 + i * 0.18, freq: 260 + i * 220, q: 0.8, gain: 0.16 + i * 0.3, sweepTo: 70 });
    this.tone({ freq: 120 - i * 30, to: 48, dur: 0.2 + i * 0.2, type: 'sine', gain: 0.18 + i * 0.2 });
  }

  step(speedFrac = 0.5) {
    // Brighter and snappier the faster you are moving.
    this.noise({
      dur: 0.075,
      freq: 1400 + speedFrac * 2200,
      q: 1.6,
      gain: 0.055 + speedFrac * 0.06,
      type: 'bandpass',
    });
  }

  collect(index = 0) {
    const f = PENTATONIC[index % PENTATONIC.length];
    this.tone({ freq: f, dur: 0.14, type: 'sine', gain: 0.2 });
    this.tone({ freq: f * 2, dur: 0.1, type: 'sine', gain: 0.1, delay: 0.015 });
    this.tone({ freq: f * 1.5, dur: 0.22, type: 'triangle', gain: 0.07, delay: 0.06 });
  }

  bounce() {
    this.tone({ freq: 180, to: 1500, dur: 0.42, type: 'sawtooth', gain: 0.2 });
    this.noise({ dur: 0.4, freq: 400, gain: 0.16, sweepTo: 3000, type: 'bandpass', q: 0.9 });
    this.tone({ freq: 90, to: 40, dur: 0.3, type: 'sine', gain: 0.22, delay: 0.02 });
  }

  plant() {
    // A short, bright fanfare.
    [0, 2, 4, 5].forEach((step, i) => {
      this.tone({
        freq: PENTATONIC[step] * 1.5,
        dur: 0.3,
        type: 'triangle',
        gain: 0.18,
        delay: i * 0.11,
      });
    });
    this.noise({ dur: 0.5, freq: 1200, gain: 0.06, sweepTo: 300, delay: 0.1 });
  }

  complete() {
    // Mission complete: the pentatonic run, then a chord.
    for (let i = 0; i < 5; i++) {
      this.tone({ freq: PENTATONIC[i], dur: 0.2, type: 'sine', gain: 0.16, delay: i * 0.09 });
    }
    [0, 2, 4, 6].forEach((step, i) => {
      this.tone({ freq: PENTATONIC[step] * 2, dur: 1.1, type: 'triangle', gain: 0.1, delay: 0.5 + i * 0.02 });
    });
  }

  emote() {
    for (let i = 0; i < 4; i++) {
      this.tone({
        freq: 700 + (i % 2) * 300,
        dur: 0.09,
        type: 'square',
        gain: 0.055,
        delay: i * 0.075,
      });
    }
  }
}
