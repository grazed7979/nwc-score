// Engraving layout: aligns all staves of a measure on shared time columns, breaks measures
// into systems that fit the page width and justifies them. Ported from the Android app.
// Coordinates are CSS pixels; the staff space `sp` is the unit.
import * as M from './model.js';

const KIND_ORDER = Object.fromEntries(M.KINDS.map((k, i) => [k, i]));
const bitCount = n => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };

export class ScoreLayout {
  /**
   * @param song parsed song
   * @param show per-staff visibility
   * @param sp staff space in px
   * @param width page width in px
   * @param measureLyric function(text) -> width in px of lyric text
   */
  constructor(song, show, sp, width, measureLyric) {
    this.song = song;
    this.sp = sp;
    this.width = width;
    this.measureLyric = measureLyric;
    this.leftMargin = 1.5 * sp;
    this.rightMargin = 1.0 * sp;
    const ns = song.staves.length;
    this.spans = song.staves.map(M.splitMeasures);
    this.lyrics = song.staves.map(M.assignLyrics);
    this.verses = song.staves.map(st => st.lyrics.length);

    const shown = [];
    for (let s = 0; s < ns; s++) if (show[s]) shown.push(s);
    this.rows = [];
    for (let i = 0; i < shown.length; i++) {
      const r = [shown[i]];
      while (song.staves[shown[i]].layerWithNext && i + 1 < shown.length && shown[i + 1] === shown[i] + 1) { i++; r.push(shown[i]); }
      this.rows.push({ staves: r, lines: Math.max(1, Math.min(5, song.staves[r[0]].lines)) });
    }

    let mCount = 0;
    for (const s of shown) mCount = Math.max(mCount, this.spans[s].length);
    const grid = () => Array.from({ length: ns }, () => new Array(mCount).fill(0));
    this.clefAt = grid(); this.octAt = grid(); this.flatsAt = grid(); this.sharpsAt = grid();
    this.beatsAt = grid(); this.beatValAt = grid(); this.sigAt = grid();
    this.leadClef = grid(); this.leadKey = grid(); this.leadTime = grid(); this.timeSeen = grid();
    for (let s = 0; s < ns; s++) this.signatureStates(s, mCount);

    this.firstEndings = shown.length ? M.endingsByMeasure(song.staves[shown[0]], this.spans[shown[0]]) : [];
    this.measures = [];
    for (let m = 0; m < mCount; m++) this.measures.push(this.buildMeasure(m, shown));
    this.systems = [];
    this.breakSystems();
  }

  signatureStates(s, mCount) {
    const st = this.song.staves[s], l = this.spans[s];
    let clef = 0, oct = 0, fl = 0, sh = 0, beats = 4, bv = 4, sig = 0, seen = 0;
    for (let m = 0; m < mCount; m++) {
      if (m < l.length) {
        let lead = true;
        for (let k = l[m].from; k < l[m].to; k++) {
          const it = st.items[k];
          if (M.isTimed(it)) lead = false;
          if (!lead) continue;
          if (it.kind === 'CLEF') { clef = it.clef; oct = it.clefOctave; this.leadClef[s][m] = 1; }
          if (it.kind === 'KEY') { fl = it.flats; sh = it.sharps; this.leadKey[s][m] = 1; }
          if (it.kind === 'TIMESIG') { beats = it.beats; bv = it.beatValue; sig = it.sigStyle; seen = 1; this.leadTime[s][m] = 1; }
        }
      }
      this.clefAt[s][m] = clef; this.octAt[s][m] = oct; this.flatsAt[s][m] = fl; this.sharpsAt[s][m] = sh;
      this.beatsAt[s][m] = beats; this.beatValAt[s][m] = bv; this.sigAt[s][m] = sig; this.timeSeen[s][m] = seen;
      if (m < l.length) {
        for (let k = l[m].from; k < l[m].to; k++) {
          const it = st.items[k];
          if (it.kind === 'CLEF') { clef = it.clef; oct = it.clefOctave; }
          if (it.kind === 'KEY') { fl = it.flats; sh = it.sharps; }
          if (it.kind === 'TIMESIG') { beats = it.beats; bv = it.beatValue; sig = it.sigStyle; seen = 1; }
        }
      }
    }
  }

  durGap(dt) {
    if (dt <= 0) return 0;
    return this.sp * (1.1 + 1.25 * Math.log2(1 + dt / 120));
  }

  buildMeasure(m, shown) {
    const sp = this.sp;
    const mb = { index: m, x: 0, width: 0, natural: 0, length: 0, bar: null, ending: 0, cols: [], elems: [], trailing: [], forceBreakBefore: false, scale: 1 };
    const cols = new Map();
    const column = (key, time) => {
      let c = cols.get(key);
      if (!c) { c = { key, time, left: 0, right: 0, lyrLeft: 0, lyrRight: 0, x: 0, elems: [] }; cols.set(key, c); }
      return c;
    };
    let len = 0, anyTimed = false;
    for (const s of shown) {
      const l = this.spans[s];
      if (m >= l.length) continue;
      const st = this.song.staves[s];
      const span = l[m];
      if (!mb.bar || (span.bar && span.bar.barStyle !== M.BAR_SINGLE)) mb.bar = span.bar;
      if (s === shown[0]) mb.ending = this.firstEndings[m] || 0;
      let timed = 0, only = null;
      for (let k = span.from; k < span.to; k++) {
        const it = st.items[k];
        if (M.isTimed(it) && !it.grace) { timed++; only = it; }
        if (it.kind === 'BOUNDARY' && it.boundaryStyle === 5) mb.forceBreakBefore = true;
      }
      const measureRest = timed === 1 && only.kind === 'REST' && only.dur === M.DUR_WHOLE && only.dots === 0;
      let t = 0, grace = 0, pending = [];
      const lyr = this.lyrics[s];
      for (let k = span.from; k < span.to; k++) {
        const it = st.items[k];
        switch (it.kind) {
          case 'CLEF': case 'KEY': case 'TIMESIG': {
            const leading = t === 0 && (it.kind === 'CLEF' ? this.leadClef[s][m] : it.kind === 'KEY' ? this.leadKey[s][m] : this.leadTime[s][m]);
            if (m === 0 && leading) break; // shown in the first system header
            const c = column(t * 64 + 4 + KIND_ORDER[it.kind], t);
            const e = this.elem(it, s, t, c, m);
            c.elems.push(e);
            mb.elems.push(e);
            const prev = m > 0 ? this.flatsAt[s][m - 1] | this.sharpsAt[s][m - 1] : 0;
            const w = it.kind === 'CLEF' ? 2.4 : it.kind === 'TIMESIG' ? 2.2 : bitCount(it.flats) + bitCount(it.sharps) + bitCount(prev) + 0.6;
            c.right = Math.max(c.right, w * sp);
            break;
          }
          case 'NOTE': case 'CHORD': case 'REST': case 'REST_CHORD': {
            if (measureRest && it === only) {
              const e = this.elem(it, s, 0, null, m);
              e.measureRest = true;
              e.marks.push(...pending);
              pending = [];
              mb.elems.push(e);
              anyTimed = true;
              break;
            }
            const key = it.grace ? t * 64 + 16 + Math.min(20, grace++) : t * 64 + 40;
            if (!it.grace) grace = 0;
            const c = column(key, t);
            const e = this.elem(it, s, t, c, m);
            e.marks.push(...pending);
            pending = [];
            e.lyrics = lyr.get(it) || null;
            c.elems.push(e);
            mb.elems.push(e);
            this.measureNeeds(c, e);
            if (!it.grace) anyTimed = true;
            t += M.advance(it);
            break;
          }
          case 'MULTIBAR_REST':
            t += Math.trunc(it.repeat * M.WHOLE * this.beatsAt[s][m] / Math.max(1, this.beatValAt[s][m]));
            break;
          case 'BOUNDARY': case 'SPACER': case 'MPC': case 'USER': case 'MARKER': case 'ENDING':
            break;
          default:
            pending.push(it);
        }
      }
      if (pending.length) {
        const e = this.elem(null, s, t, null, m);
        e.marks.push(...pending);
        mb.trailing.push(e);
      }
      if (!measureRest) len = Math.max(len, t);
    }
    if (len === 0 && anyTimed) {
      const s0 = shown.length ? shown[0] : 0;
      len = Math.trunc(M.WHOLE * this.beatsAt[s0][m] / Math.max(1, this.beatValAt[s0][m]));
    }
    mb.length = len;
    mb.cols = [...cols.values()].sort((a, b) => a.key - b.key);

    // Horizontal spacing.
    let x = sp * 1.2, prev = null;
    for (const c of mb.cols) {
      if (!prev) x += c.left;
      else {
        let gap = Math.max(this.durGap(c.time - prev.time), prev.right + c.left + 0.35 * sp);
        gap = Math.max(gap, prev.lyrRight + c.lyrLeft + 0.6 * sp);
        x += gap;
      }
      c.x = x;
      prev = c;
    }
    if (!prev) mb.natural = anyTimed || len > 0 ? sp * 7 : sp * 0.8;
    else {
      let end = Math.max(this.durGap(len - prev.time), prev.right + 0.8 * sp);
      end = Math.max(end, prev.lyrRight + 0.4 * sp);
      mb.natural = x + end;
    }
    const bs = mb.bar ? mb.bar.barStyle : -1;
    if (bs === M.BAR_MASTER_REPEAT_CLOSE || bs === M.BAR_LOCAL_REPEAT_CLOSE || bs === M.BAR_MASTER_REPEAT_OPEN || bs === M.BAR_LOCAL_REPEAT_OPEN) mb.natural += sp;
    mb.width = mb.natural;
    return mb;
  }

  elem(item, staff, time, col, measure) {
    return { item, staff, time, col, measure, x: 0, marks: [], lyrics: null, measureRest: false, stemDir: 0, stemX: 0, stemTip: 0, beamGroupEnd: null, inBeam: false };
  }

  measureNeeds(c, e) {
    const it = e.item, sp = this.sp;
    const scale = it.grace ? 0.65 : 1;
    const hw = 1.18 * sp * scale;
    let left = 0, right = hw;
    if (it.kind === 'REST') right = 1.3 * sp;
    let accs = 0, seconds = false;
    for (let i = 0; i < it.heads.length; i++) {
      const h = it.heads[i];
      if (h.acc !== M.ACC_NONE) accs++;
      for (let j = i + 1; j < it.heads.length; j++) if (Math.abs(it.heads[j].pos - h.pos) === 1) seconds = true;
    }
    if (accs > 0) left = (1.1 * Math.min(3, accs) + 0.2) * sp * scale;
    if (seconds) { right += hw; left += hw * 0.2; }
    if (it.dots > 0) right += (0.45 + 0.5 * it.dots) * sp;
    if (it.kind === 'NOTE' && it.dur >= M.DUR_8TH && it.beam === 0 && it.stem !== 2) right += 0.9 * sp * scale;
    c.left = Math.max(c.left, left);
    c.right = Math.max(c.right, right);
    if (e.lyrics) {
      let w = 0;
      for (const s of e.lyrics) if (s) w = Math.max(w, this.measureLyric(s.endsWith('-') ? s.slice(0, -1) : s));
      c.lyrLeft = Math.max(c.lyrLeft, w / 2 - hw / 2);
      c.lyrRight = Math.max(c.lyrRight, w / 2 + hw / 2);
    }
  }

  headerWidth(m, showTime) {
    const sp = this.sp;
    let w = 0;
    for (const r of this.rows) {
      const s = r.staves[0];
      let rw = 3.2 * sp + sp * (bitCount(this.flatsAt[s][m]) + bitCount(this.sharpsAt[s][m]));
      if (showTime) rw += 2.6 * sp;
      w = Math.max(w, rw);
    }
    return w + 0.6 * sp;
  }

  breakSystems() {
    const sp = this.sp;
    this.titleHeight = this.song.title ? 7 * sp : 2 * sp;
    let y = this.titleHeight, m = 0;
    const n = this.measures.length, ns = this.song.staves.length;
    while (m < n) {
      let showTime = m === 0 && this.rows.some(r => this.timeSeen[r.staves[0]][0]);
      for (const r of this.rows) if (this.leadTime[r.staves[0]][m]) showTime = true;
      const sys = { y: 0, height: 0, rows: [], measures: [], showTime, headerW: this.headerWidth(m, showTime) };
      const avail = this.width - this.leftMargin - this.rightMargin - sys.headerW;
      let used = 0;
      const start = m;
      while (m < n) {
        const mb = this.measures[m];
        if (m > start && (used + mb.natural > avail || mb.forceBreakBefore)) break;
        sys.measures.push(mb);
        used += mb.natural;
        m++;
        if (mb.bar && mb.bar.sysBreak) break;
      }
      const last = m >= n;
      let k = used <= 0 ? 1 : avail / used;
      if (last && k > 1.4) k = 1;
      if (k < 1 && sys.measures.length > 1) k = Math.max(k, 0.5);
      let x = this.leftMargin + sys.headerW;
      for (const mb of sys.measures) {
        mb.scale = k;
        mb.width = mb.natural * k;
        mb.x = x;
        x += mb.width;
      }
      for (const mb of sys.measures) {
        for (const e of mb.elems) e.x = e.measureRest ? mb.x + mb.width / 2 - 0.6 * sp : mb.x + e.col.x * k;
        for (const e of mb.trailing) e.x = mb.x + mb.width - 1.5 * sp;
      }
      const pick = a => Array.from({ length: ns }, (_, s) => (start < a[s].length ? a[s][start] : 0));
      sys.clef = pick(this.clefAt); sys.clefOctave = pick(this.octAt); sys.flats = pick(this.flatsAt); sys.sharps = pick(this.sharpsAt);
      sys.hasTime = pick(this.timeSeen); sys.beats = pick(this.beatsAt); sys.beatValue = pick(this.beatValAt); sys.sigStyle = pick(this.sigAt);
      this.verticalLayout(sys, y);
      this.systems.push(sys);
      y += sys.height + 1.5 * sp;
    }
    this.totalHeight = y + 4 * sp;
  }

  verticalLayout(sys, y) {
    const sp = this.sp;
    sys.y = y;
    let cur = 0;
    this.rows.forEach((proto, ri) => {
      const r = { staves: proto.staves, lines: proto.lines, top: 0, lyricY: 0 };
      let above = 2.5 * sp, below = 2.5 * sp, maxVerses = 0, minPos = -4, dyn = false, topMarks = false;
      for (const mb of sys.measures) {
        if (ri === 0 && mb.ending !== 0) topMarks = true;
        for (const e of mb.elems) {
          if (!r.staves.includes(e.staff)) continue;
          for (const h of e.item.heads) {
            minPos = Math.min(minPos, h.pos);
            const up = h.pos + (e.item.stem !== 2 && h.pos < 0 ? 7 : 0);
            const down = h.pos - (e.item.stem !== 1 && h.pos >= 0 ? 7 : 0);
            above = Math.max(above, (up - 4) / 2 * sp + 1.5 * sp);
            below = Math.max(below, (-4 - down) / 2 * sp + 1.5 * sp);
          }
          if (e.lyrics) e.lyrics.forEach((v, i) => { if (v !== null) maxVerses = Math.max(maxVerses, i + 1); });
          for (const mk of e.marks) {
            if (mk.kind === 'DYNAMIC' || mk.kind === 'DYN_VAR') dyn = true;
            if (mk.kind === 'TEMPO' || mk.kind === 'FLOW' || (mk.kind === 'TEXT' && mk.pos > 0)) topMarks = true;
          }
        }
      }
      if (topMarks) above = Math.max(above, 5.5 * sp);
      // Lyrics sit below the lowest note head of the row in this system.
      const lyricOffset = Math.max(2.6 * sp, (-4 - minPos) / 2 * sp + 2.4 * sp);
      const lyr = maxVerses > 0 ? lyricOffset + maxVerses * r.staves.length * 2.1 * sp - 0.8 * sp : 0;
      below = Math.max(below, lyr + (dyn ? 2.2 * sp : 0) + 1.0 * sp);
      if (dyn && maxVerses === 0) below = Math.max(below, 4.5 * sp);
      cur += above;
      r.top = cur;
      r.lyricY = cur + 4 * sp + lyricOffset;
      cur += 4 * sp + below;
      sys.rows.push(r);
    });
    sys.height = cur;
  }

  systemOf(m) {
    return this.systems.findIndex(s => s.measures.length && s.measures[0].index <= m && s.measures[s.measures.length - 1].index >= m);
  }

  /** Horizontal position of a tick inside a measure, interpolated between columns. */
  xAt(mb, tick) {
    const sp = this.sp;
    let prevX = mb.x + sp, prevT = 0;
    const endX = mb.x + mb.width - sp;
    for (const c of mb.cols) {
      const cx = mb.x + c.x * mb.scale;
      if (c.time >= tick) {
        if (c.time === prevT) return cx;
        return prevX + (cx - prevX) * (tick - prevT) / (c.time - prevT);
      }
      prevX = cx;
      prevT = c.time;
    }
    if (mb.length <= prevT) return prevX;
    return prevX + (endX - prevX) * (tick - prevT) / (mb.length - prevT);
  }
}
