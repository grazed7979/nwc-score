// Playback order (repeats, endings, D.C./D.S./Coda/Fine) and the note list for playback.
// Ported from the Android app, where it was verified against NWC's own MIDI export.
import * as M from './model.js';

function endingPlays(endings, pass) {
  if (pass <= 7 && (endings & (1 << (pass - 1)))) return true;
  return (endings & 0x80) !== 0 && (endings & 0x7f & ~((1 << pass) - 1)) === 0;
}

/** Passes of a master repeat: 2, or the highest ending number used in the repeated section. */
function maxPass(spans, st, from, close) {
  let max = 2;
  for (let m = from; m < spans.length && m <= close + 64; m++) {
    const sp = spans[m];
    for (let k = sp.from; k < sp.to; k++) {
      const it = st.items[k];
      if (it.kind === 'ENDING') {
        for (let b = 6; b >= 0; b--) if (it.endings & (1 << b)) { max = Math.max(max, b + 1); break; }
      }
    }
    if (m > close && sp.bar && sp.bar.barStyle === M.BAR_MASTER_REPEAT_OPEN) break;
  }
  return max;
}

/**
 * Playback order as [measure, fromTick, toTick] entries computed from the staff with the most
 * measures. toTick is -1 for the end of the measure; mid-measure To Coda marks jump from that point.
 */
export function playOrder(song) {
  let spans = null, master = null;
  for (const st of song.staves) {
    const s = M.splitMeasures(st);
    if (!spans || s.length > spans.length) { spans = s; master = st; }
  }
  const order = [];
  if (!spans) return order;
  const n = spans.length;
  let segno = -1, coda = -1, codaFrom = 0;
  for (let m = 0; m < n; m++) {
    let t = 0;
    for (let i = spans[m].from; i < spans[m].to; i++) {
      const it = master.items[i];
      if (it.kind === 'FLOW') {
        if (it.flow === M.FLOW_SEGNO && segno < 0) segno = m;
        if (it.flow === M.FLOW_CODA && coda < 0) { coda = m; codaFrom = t; }
      }
      t += M.advance(it);
    }
  }
  const endings = M.endingsByMeasure(master, spans);
  let i = 0, repeatStart = 0, pass = 1, localStart = -1, localPass = 1, activeEnding = 0;
  let jumped = false, enteringCoda = false;
  while (i < n && order.length < 5000) {
    const sp = spans[i];
    const open = i > 0 ? spans[i - 1].bar : null;
    if (open && open.barStyle === M.BAR_MASTER_REPEAT_OPEN && !jumped && repeatStart !== i) { repeatStart = i; pass = 1; }
    if (open && open.barStyle === M.BAR_LOCAL_REPEAT_OPEN) localStart = i;
    if (endings[i] > 0) activeEnding = endings[i];
    let flowAfter = -1, flowTime = 0, t = 0;
    for (let k = sp.from; k < sp.to; k++) {
      const it = master.items[k];
      if (it.kind === 'FLOW' && flowAfter < 0) {
        const leaves = jumped ? it.flow === M.FLOW_FINE || (it.flow === M.FLOW_TOCODA && coda >= 0) : it.flow >= M.FLOW_DACAPO;
        if (leaves) { flowAfter = it.flow; flowTime = t; }
      }
      t += M.advance(it);
    }
    if (activeEnding !== 0 && !jumped && !endingPlays(activeEnding, pass)) {
      if (sp.bar && sp.bar.barStyle !== M.BAR_SINGLE) activeEnding = 0;
      i++;
      continue;
    }
    const from = enteringCoda && i === coda ? Math.min(codaFrom, t) : 0;
    enteringCoda = false;
    // A mark entered before the first note acts before the measure is played at all.
    const leaveBefore = flowAfter >= 0 && flowTime <= from && t > from;
    if (!leaveBefore) order.push([i, from, flowAfter >= 0 && flowTime > from && flowTime < t ? flowTime : -1]);
    const bar = sp.bar;
    if (bar && bar.barStyle !== M.BAR_SINGLE && bar.barStyle !== M.BAR_TRANSPARENT) activeEnding = 0;
    if (jumped && flowAfter === M.FLOW_FINE) break;
    if (jumped && flowAfter === M.FLOW_TOCODA) { i = coda; enteringCoda = true; continue; }
    if (!jumped && flowAfter >= M.FLOW_DACAPO) {
      const fromStart = flowAfter === M.FLOW_DACAPO || flowAfter === M.FLOW_DC_AL_CODA || flowAfter === M.FLOW_DC_AL_FINE;
      jumped = true;
      activeEnding = 0;
      pass = 1;
      i = fromStart || segno < 0 ? 0 : segno;
      continue;
    }
    if (bar && !jumped) {
      if (bar.barStyle === M.BAR_MASTER_REPEAT_CLOSE) {
        if (pass < maxPass(spans, master, repeatStart, i)) { pass++; i = repeatStart; continue; }
        // Keep the pass number so a following "2." ending still plays; a new repeat resets it.
      } else if (bar.barStyle === M.BAR_LOCAL_REPEAT_CLOSE) {
        if (localPass < Math.max(2, bar.repeat)) {
          localPass++;
          i = localStart >= 0 ? localStart : repeatStart;
          if (i <= repeatStart) { pass = 1; activeEnding = 0; repeatStart = i; }
          continue;
        }
        localPass = 1;
      }
    }
    i++;
  }
  return order;
}

function applyState(s, it, dynVel) {
  switch (it.kind) {
    case 'CLEF': s.clef = it.clef; s.octave = it.clefOctave; break;
    case 'KEY': s.flats = it.flats; s.sharps = it.sharps; break;
    case 'DYNAMIC': s.velocity = it.velocity > 0 ? it.velocity : dynVel[Math.max(0, Math.min(7, it.dynamic))]; break;
    case 'INSTRUMENT':
      if (it.patch >= 0) s.patch = it.patch & 127;
      s.transpose = it.transpose;
      break;
  }
}

/**
 * Builds the full performance: steps (measures in playback order on a tick timeline),
 * notes {staff, start, end, note, vel} and tempo changes [tick, quarterBpm].
 */
export function buildPerformance(song) {
  const ns = song.staves.length;
  const spans = song.staves.map(M.splitMeasures);
  const startState = song.staves.map((st, s) => {
    const cur = { clef: 0, octave: 0, flats: 0, sharps: 0, velocity: st.dynVel[4], patch: st.patch, transpose: st.transpose };
    return spans[s].map(sp => {
      const copy = { ...cur };
      for (let k = sp.from; k < sp.to; k++) applyState(cur, st.items[k], st.dynVel);
      return copy;
    });
  });

  const steps = [];
  let tick = 0;
  const timeSig = [4, 4];
  for (const [m, eFrom, eTo] of playOrder(song)) {
    let len = 0, anyTimed = false;
    for (let s = 0; s < ns; s++) {
      const l = spans[s];
      if (m >= l.length) continue;
      let t = 0, timed = 0, wholeRest = false;
      for (let k = l[m].from; k < l[m].to; k++) {
        const it = song.staves[s].items[k];
        if (it.kind === 'TIMESIG') { timeSig[0] = it.beats; timeSig[1] = it.beatValue; }
        if (M.isTimed(it) && !it.grace) {
          timed++;
          wholeRest = it.kind === 'REST' && it.dur === M.DUR_WHOLE && it.dots === 0;
        }
        t += it.kind === 'MULTIBAR_REST' ? Math.trunc(it.repeat * M.WHOLE * timeSig[0] / timeSig[1]) : M.advance(it);
      }
      // A lone whole rest means "rest for the whole measure" whatever the meter.
      if (timed === 1 && wholeRest) t = 0;
      if (timed > 0) anyTimed = true;
      len = Math.max(len, t);
    }
    if (len === 0 && anyTimed) len = Math.trunc(M.WHOLE * timeSig[0] / Math.max(1, timeSig[1]));
    const from = Math.min(eFrom, len), to = eTo < 0 ? len : Math.min(len, eTo);
    steps.push({ measure: m, tick, length: Math.max(0, to - from), from });
    tick += Math.max(0, to - from);
  }

  const notes = [];
  const tempos = new Map([[0, 120]]);
  const patches = [];
  for (let s = 0; s < ns; s++) {
    const st = song.staves[s];
    const l = spans[s];
    const ties = new Map();
    const patchChanges = [];
    let lastPatch = -1;
    const emit = rec => {
      if (rec.note >= 0 && rec.note <= 127) notes.push({ staff: s, start: rec.start, end: Math.max(rec.start + 1, rec.end), note: rec.note, vel: Math.max(1, Math.min(127, rec.vel)) });
    };
    for (const step of steps) {
      if (step.measure >= l.length) continue;
      const state = { ...startState[s][step.measure] };
      if (state.patch !== lastPatch) { patchChanges.push([step.tick, state.patch]); lastPatch = state.patch; }
      const accidentals = new Map();
      let t = step.tick - step.from;
      const stepEnd = step.tick + step.length;
      const sp = l[step.measure];
      for (let k = sp.from; k < sp.to; k++) {
        const it = st.items[k];
        applyState(state, it, st.dynVel);
        const inside = t >= step.tick && (t < stepEnd || (step.length === 0 && t === step.tick));
        if (!inside && M.isTimed(it)) { t += M.advance(it); continue; }
        if (it.kind === 'TEMPO') {
          const b = it.tempoBase;
          const baseTicks = b === 0 ? 240 : b === 1 ? 360 : b === 3 ? 720 : b === 4 ? 960 : b === 5 ? 1440 : 480;
          tempos.set(t, Math.max(10, Math.trunc(it.tempo * baseTicks / 480)));
        }
        if (it.kind === 'INSTRUMENT' && state.patch !== lastPatch) { patchChanges.push([t, state.patch]); lastPatch = state.patch; }
        if (M.hasHeads(it) && !it.grace) {
          const middle = M.middleLine(state.clef, state.octave);
          for (const h of it.heads) {
            const d = middle + h.pos;
            let alter;
            const a = M.accAlter(h.acc);
            if (a !== null) { alter = a; accidentals.set(d, a); }
            else if (accidentals.has(d)) alter = accidentals.get(d);
            else alter = M.keyAlter(d, state.flats, state.sharps);
            const note = M.midiNote(d, alter) + state.transpose;
            const len = M.ticks(h.dur, h.dots, it.triplet);
            const end = t + (it.staccato ? Math.trunc(len / 2) : h.tie || it.slur ? len : Math.trunc(len * 92 / 100));
            let rec = ties.get(h.pos);
            ties.delete(h.pos);
            if (!rec) rec = { note, start: t, end, vel: state.velocity };
            else rec.end = end;
            if (h.tie) ties.set(h.pos, rec);
            else emit(rec);
          }
        }
        t += it.kind === 'MULTIBAR_REST' ? it.repeat * step.length : M.advance(it);
      }
    }
    for (const rec of ties.values()) emit(rec);
    patches.push(patchChanges);
  }
  notes.sort((a, b) => a.start - b.start || a.note - b.note);
  const tempoList = [...tempos.entries()].sort((a, b) => a[0] - b[0]);
  return { steps, notes, tempos: tempoList, patches, length: tick };
}
