// Web Audio playback of a performance with a small built-in synthesizer, so it works offline
// without sample downloads. Part volume and mute changes apply immediately.
import { QUARTER } from './model.js';

const LOOKAHEAD = 0.25; // seconds of notes scheduled ahead
const TICK_MS = 30;

/** Rough timbre family from a General MIDI patch. */
function family(patch, percussion) {
  if (percussion) return 'drum';
  if (patch <= 7) return 'piano';
  if (patch <= 15) return 'bell';
  if (patch <= 23) return 'organ';
  if (patch <= 31) return 'pluck';
  if (patch <= 39) return 'bass';
  if (patch <= 55) return 'strings';
  if (patch <= 79) return 'wind';
  return 'organ';
}

export class Player {
  constructor() {
    this.ctx = null;
    this.perf = null;
    this.song = null;
    this.playing = false;
    this.tempoFactor = 1;
    this.onEnd = null;
  }

  /** Must be called from a user gesture on iOS. */
  ensureContext() {
    if (!this.ctx) {
      // Play through the media channel so the iPhone/iPad silent switch does not mute it.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older Safari */ }
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createDynamicsCompressor();
      this.master.threshold.value = -14;
      this.master.ratio.value = 6;
      const out = this.ctx.createGain();
      out.gain.value = 0.9;
      this.master.connect(out).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  load(song, perf) {
    this.stop();
    this.song = song;
    this.perf = perf;
    this.staffGain = null;
  }

  setupStaves(mix) {
    const ctx = this.ctx;
    this.staffGain = this.song.staves.map((st, s) => {
      const g = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const p = st.pan < 0 || st.pan > 127 ? 64 : st.pan;
      if (pan) { pan.pan.value = (p - 64) / 64 * 0.6; g.connect(pan).connect(this.master); } else g.connect(this.master);
      return g;
    });
    this.applyMix(mix);
  }

  /** mix: {audible[], gain[]} — applied live. */
  applyMix(mix) {
    this.mix = mix;
    if (!this.staffGain) return;
    this.song.staves.forEach((st, s) => {
      const vol = st.volume < 0 || st.volume > 127 ? 127 : st.volume;
      const v = mix.audible[s] ? (vol / 127) * mix.gain[s] : 0;
      this.staffGain[s].gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    });
  }

  /** Tempo segments from a start tick: [{tick, sec, spt}] where spt = seconds per tick. */
  segments(startTick) {
    const segs = [];
    const tempos = this.perf.tempos;
    let bpm = 120;
    for (const [t, b] of tempos) if (t <= startTick) bpm = b;
    let sec = 0, tick = startTick;
    const spt = b => 60 / (b * this.tempoFactor) / QUARTER;
    segs.push({ tick, sec, spt: spt(bpm) });
    for (const [t, b] of tempos) {
      if (t <= startTick) continue;
      const last = segs[segs.length - 1];
      sec = last.sec + (t - last.tick) * last.spt;
      segs.push({ tick: t, sec, spt: spt(b) });
    }
    return segs;
  }

  secAt(tick) {
    const segs = this.segs;
    let s = segs[0];
    for (const x of segs) { if (x.tick > tick) break; s = x; }
    return s.sec + (tick - s.tick) * s.spt;
  }

  tickAt(sec) {
    const segs = this.segs;
    let s = segs[0];
    for (const x of segs) { if (x.sec > sec) break; s = x; }
    return s.tick + (sec - s.sec) / s.spt;
  }

  /** Starts playback at a step index. */
  play(stepIndex, mix) {
    this.ensureContext();
    this.stop();
    if (!this.perf || !this.perf.steps.length) return;
    const step = this.perf.steps[Math.max(0, Math.min(stepIndex, this.perf.steps.length - 1))];
    this.startTick = step.tick;
    this.segs = this.segments(this.startTick);
    this.setupStaves(mix);
    this.patchOf = this.song.staves.map((st, s) => {
      let p = st.patch;
      for (const [t, patch] of this.perf.patches[s]) if (t <= this.startTick) p = patch;
      return p;
    });
    this.nextNote = this.perf.notes.findIndex(n => n.start >= this.startTick);
    if (this.nextNote < 0) this.nextNote = this.perf.notes.length;
    this.t0 = this.ctx.currentTime + 0.1;
    this.endSec = this.secAt(this.perf.length);
    this.playing = true;
    this.voices = new Set();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    if (this.voices) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      for (const v of this.voices) {
        try { v.env.gain.cancelScheduledValues(now); v.env.gain.setTargetAtTime(0, now, 0.02); v.osc.forEach(o => o.stop(now + 0.1)); } catch { /* already stopped */ }
      }
      this.voices.clear();
    }
    if (this.staffGain) {
      const old = this.staffGain;
      setTimeout(() => old.forEach(g => g.disconnect()), 300);
      this.staffGain = null;
    }
  }

  /** Current song tick, or -1 when stopped. */
  position() {
    if (!this.playing) return -1;
    const sec = this.ctx.currentTime - this.t0;
    if (sec < 0) return this.startTick;
    return this.tickAt(sec);
  }

  schedule() {
    if (!this.playing) return;
    const now = this.ctx.currentTime - this.t0;
    const horizon = now + LOOKAHEAD;
    const notes = this.perf.notes;
    while (this.nextNote < notes.length) {
      const n = notes[this.nextNote];
      const start = this.secAt(n.start);
      if (start > horizon) break;
      this.nextNote++;
      if (start < now - 0.05) continue;
      this.voice(n, this.t0 + start, this.t0 + this.secAt(n.end));
    }
    for (const [i, changes] of this.perf.patches.entries()) {
      for (const [t, p] of changes) if (t > this.startTick && this.secAt(t) <= now) this.patchOf[i] = p;
    }
    if (now > this.endSec + 1.5) {
      this.stop();
      if (this.onEnd) this.onEnd();
    }
  }

  voice(n, t, tEnd) {
    const ctx = this.ctx;
    const st = this.song.staves[n.staff];
    const fam = family(this.patchOf[n.staff], st.channel === 9);
    const freq = 440 * Math.pow(2, (n.note - 69) / 12);
    const amp = Math.pow(n.vel / 127, 1.4) * 0.32;
    const env = ctx.createGain();
    env.connect(this.staffGain[n.staff]);
    const osc = [];
    const dur = Math.max(0.05, tEnd - t);
    const add = (type, mult, level, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mult;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(env);
      osc.push(o);
      return o;
    };
    const g = env.gain;
    g.setValueAtTime(0, t);
    let release = 0.12;
    switch (fam) {
      case 'piano': case 'pluck': case 'bell': {
        add('triangle', 1, 1);
        add('sine', 2, fam === 'bell' ? 0.6 : 0.35);
        add('sine', 3, 0.12);
        const decay = fam === 'bell' ? 2.5 : Math.max(0.6, 2.2 - (n.note - 48) * 0.03);
        g.linearRampToValueAtTime(amp * 1.25, t + 0.006);
        g.setTargetAtTime(amp * 0.35, t + 0.006, decay * 0.25);
        g.setTargetAtTime(0.0001, t + dur, 0.08);
        release = 0.5;
        break;
      }
      case 'strings': case 'organ': case 'wind': {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = Math.min(9000, freq * (fam === 'wind' ? 4 : 6));
        filter.Q.value = 0.7;
        env.disconnect();
        env.connect(filter).connect(this.staffGain[n.staff]);
        if (fam === 'organ') { add('sine', 1, 0.8); add('sine', 2, 0.45); add('sine', 4, 0.2); }
        else if (fam === 'wind') { add('triangle', 1, 0.9); add('sine', 2, 0.25); }
        else { add('sawtooth', 1, 0.45, -6); add('sawtooth', 1, 0.45, 6); }
        const attack = fam === 'organ' ? 0.02 : 0.07;
        g.linearRampToValueAtTime(amp, t + attack);
        g.setValueAtTime(amp, t + Math.max(attack, dur));
        g.setTargetAtTime(0.0001, t + Math.max(attack, dur), 0.06);
        release = 0.35;
        break;
      }
      case 'bass':
        add('triangle', 1, 1);
        add('sine', 0.5, 0.4);
        g.linearRampToValueAtTime(amp * 1.2, t + 0.01);
        g.setTargetAtTime(amp * 0.6, t + 0.01, 0.4);
        g.setTargetAtTime(0.0001, t + dur, 0.06);
        break;
      default: { // drum: short filtered noise
        const len = 0.15;
        const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 200 + (n.note - 35) * 120;
        src.connect(f).connect(env);
        osc.push(src);
        g.linearRampToValueAtTime(amp * 1.5, t + 0.002);
        g.setTargetAtTime(0.0001, t + 0.01, 0.05);
        tEnd = t + len;
        release = 0;
      }
    }
    const v = { env, osc };
    this.voices.add(v);
    for (const o of osc) {
      o.start(t);
      o.stop(Math.max(t, tEnd) + release + 0.3);
    }
    osc[0].onended = () => { this.voices.delete(v); env.disconnect(); };
  }
}
