// Score model shared by the parsers, playback and layout. Ported from the Android app.

export const KINDS = ['CLEF', 'KEY', 'BAR', 'ENDING', 'INSTRUMENT', 'TIMESIG', 'TEMPO', 'DYNAMIC', 'NOTE', 'REST', 'CHORD', 'PEDAL',
  'FLOW', 'MPC', 'TEMPO_VAR', 'DYN_VAR', 'PERFORMANCE', 'TEXT', 'REST_CHORD', 'USER', 'SPACER', 'MULTIBAR_REST', 'BOUNDARY', 'MARKER'];

export const DUR_WHOLE = 0, DUR_HALF = 1, DUR_4TH = 2, DUR_8TH = 3;
export const ACC_SHARP = 0, ACC_FLAT = 1, ACC_NATURAL = 2, ACC_DSHARP = 3, ACC_DFLAT = 4, ACC_NONE = 5;
export const CLEF_TREBLE = 0, CLEF_BASS = 1, CLEF_ALTO = 2, CLEF_TENOR = 3, CLEF_PERCUSSION = 4;
export const BAR_SINGLE = 0, BAR_DOUBLE = 1, BAR_BROKEN_DOUBLE = 3, BAR_SECTION_OPEN = 4, BAR_SECTION_CLOSE = 5,
  BAR_LOCAL_REPEAT_OPEN = 6, BAR_LOCAL_REPEAT_CLOSE = 7, BAR_MASTER_REPEAT_OPEN = 8, BAR_MASTER_REPEAT_CLOSE = 9, BAR_TRANSPARENT = 10;
export const FLOW_CODA = 0, FLOW_SEGNO = 1, FLOW_FINE = 2, FLOW_TOCODA = 3, FLOW_DACAPO = 4, FLOW_DC_AL_CODA = 5,
  FLOW_DC_AL_FINE = 6, FLOW_DALSEGNO = 7, FLOW_DS_AL_CODA = 8, FLOW_DS_AL_FINE = 9;
export const TV_BREATH = 0, TV_CAESURA = 1, TV_FERMATA = 2;
export const SIG_COMMON = 1, SIG_ALLA_BREVE = 2;
export const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
export const FLOW_NAMES = ['Coda', 'Segno', 'Fine', 'ToCoda', 'DaCapo', 'DCalCoda', 'DCalFine', 'DalSegno', 'DSalCoda', 'DSalFine'];
export const BAR_NAMES = ['Single', 'Double', 'BrokenSingle', 'BrokenDouble', 'SectionOpen', 'SectionClose',
  'LocalRepeatOpen', 'LocalRepeatClose', 'MasterRepeatOpen', 'MasterRepeatClose', 'Transparent'];

export const WITH_BRACKET = 1, WITH_BRACE = 2, WITH_CONNECT_BARS = 4;
export const WHOLE = 1920, QUARTER = 480;

export function newSong() {
  return { title: '', author: '', lyricist: '', copyright1: '', copyright2: '', comments: '', sourceFormat: '', staves: [] };
}

export function newStaff() {
  return {
    name: '', label: '', group: '', channel: 0, patch: 0, volume: 127, pan: 64, transpose: 0, muted: false, visible: true,
    layerWithNext: false, lines: 5, withNext: 0, dynVel: [10, 30, 45, 60, 75, 92, 108, 127], lyrics: [], items: [],
  };
}

export function displayName(st) {
  return st.label || st.name;
}

export function newItem(kind) {
  return {
    kind, visible: true, pos: 0,
    dur: 0, dots: 0, triplet: 0, grace: false, staccato: false, accent: false, tenuto: false, slur: false,
    stem: 0, beam: 0, lyricMode: 0, restOffset: 0, heads: [],
    clef: 0, clefOctave: 0, flats: 0, sharps: 0, beats: 4, beatValue: 4, sigStyle: 0,
    barStyle: 0, repeat: 2, sysBreak: false, endings: 0, closedBracket: false,
    tempo: 120, tempoBase: 2, dynamic: 0, velocity: -1, text: '', flow: 0, tvStyle: 0, pause: 0,
    patch: -1, transpose: 0, boundaryStyle: 0,
  };
}

export function head(pos, acc, tie, dur, dots) {
  return { pos, acc, tie, dur, dots };
}

export const isTimed = it => it.kind === 'NOTE' || it.kind === 'REST' || it.kind === 'CHORD' || it.kind === 'REST_CHORD';
export const hasHeads = it => it.kind === 'NOTE' || it.kind === 'CHORD' || it.kind === 'REST_CHORD';

// ---- Measures -------------------------------------------------------------------

/** Splits a staff into measures: item ranges [from, to) closed by a bar (or null for a final open measure). */
export function splitMeasures(st) {
  const out = [];
  let start = 0;
  const items = st.items;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'BAR') {
      out.push({ from: start, to: i, bar: items[i] });
      start = i + 1;
    }
  }
  let tail = false;
  for (let i = start; i < items.length; i++) if (isTimed(items[i]) || items[i].kind === 'MULTIBAR_REST') tail = true;
  if (tail || out.length === 0) out.push({ from: start, to: items.length, bar: null });
  return out;
}

/**
 * Ending marks per measure. NWC lets an ending be entered just before the bar line it
 * starts at, so marks after the last note of a measure count for the next one.
 */
export function endingsByMeasure(st, spans) {
  const out = new Array(spans.length).fill(0);
  for (let m = 0; m < spans.length; m++) {
    const sp = spans[m];
    let lastTimed = sp.from - 1;
    for (let k = sp.from; k < sp.to; k++) if (isTimed(st.items[k])) lastTimed = k;
    for (let k = sp.from; k < sp.to; k++) {
      const it = st.items[k];
      if (it.kind !== 'ENDING') continue;
      const trailing = k > lastTimed && lastTimed >= sp.from && m + 1 < spans.length;
      const target = trailing ? m + 1 : m;
      if (it.endings !== 0) out[target] = it.endings;
      else if (out[target] === 0) out[target] = -1;
    }
  }
  return out;
}

export function ticks(dur, dots, triplet) {
  let t = WHOLE >> Math.max(0, Math.min(6, dur));
  if (dots === 1) t = Math.trunc(t * 3 / 2);
  else if (dots >= 2) t = Math.trunc(t * 7 / 4);
  if (triplet !== 0) t = Math.trunc(t * 2 / 3);
  return t;
}

/** How far the time position advances after an item. */
export function advance(it) {
  if (!isTimed(it) || it.grace) return 0;
  let t = Infinity;
  if (it.kind === 'REST' || it.kind === 'REST_CHORD' || it.heads.length === 0) t = ticks(it.dur, it.dots, it.triplet);
  for (const h of it.heads) t = Math.min(t, ticks(h.dur, h.dots, it.triplet));
  return t === Infinity ? 0 : t;
}

/** Diatonic step (C0 = 0) of the middle staff line. */
export function middleLine(clef, octave) {
  let base;
  switch (clef) {
    case CLEF_BASS: case CLEF_PERCUSSION: base = 3 * 7 + 1; break;
    case CLEF_ALTO: base = 4 * 7; break;
    case CLEF_TENOR: base = 3 * 7 + 5; break;
    default: base = 4 * 7 + 6;
  }
  if (octave === 1) base += 7;
  else if (octave === 2) base -= 7;
  return base;
}

const SEMIS = [0, 2, 4, 5, 7, 9, 11];
const fmod = (a, n) => ((a % n) + n) % n;

export function midiNote(diatonic, alter) {
  return 12 * (Math.floor(diatonic / 7) + 1) + SEMIS[fmod(diatonic, 7)] + alter;
}

export function keyAlter(diatonic, flats, sharps) {
  const bit = 1 << ((fmod(diatonic, 7) + 2) % 7);
  if (sharps & bit) return 1;
  if (flats & bit) return -1;
  return 0;
}

export function accAlter(acc) {
  switch (acc) {
    case ACC_SHARP: return 1;
    case ACC_FLAT: return -1;
    case ACC_DSHARP: return 2;
    case ACC_DFLAT: return -2;
    case ACC_NATURAL: return 0;
    default: return null;
  }
}

// ---- Lyrics ---------------------------------------------------------------------

/** Syllables of one verse; a syllable ending in '-' continues its word on the next note. */
export function syllables(text) {
  const out = [];
  let cur = '';
  for (const c of text) {
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
    } else if (c === '-') {
      out.push(cur + '-');
      cur = '';
    } else cur += c === '_' ? ' ' : c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Map item -> syllable per verse, following NWC's standard rules (skip tied-into and slurred notes). */
export function assignLyrics(st) {
  const out = new Map();
  if (st.lyrics.length === 0) return out;
  const verses = st.lyrics.map(syllables);
  const next = verses.map(() => 0);
  let tied = new Set();
  let slurred = false;
  for (const it of st.items) {
    if (!isTimed(it) || it.grace) continue;
    let eligible;
    if (it.kind === 'REST') eligible = it.lyricMode === 1;
    else {
      let tiedInto = it.heads.length > 0;
      for (const h of it.heads) if (!tied.has(h.pos)) { tiedInto = false; break; }
      eligible = it.lyricMode === 1 || (it.lyricMode !== 2 && !tiedInto && !slurred);
      tied = new Set(it.heads.filter(h => h.tie).map(h => h.pos));
      slurred = it.slur;
    }
    if (!eligible) continue;
    const s = verses.map((v, i) => (next[i] < v.length ? v[next[i]++] : null));
    if (s.some(x => x !== null)) out.set(it, s);
  }
  return out;
}
