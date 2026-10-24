// Draws a ScoreLayout on a 2D canvas with SMuFL glyphs from the Bravura font. Ported from the Android app.
import * as M from './model.js';

const G = {
  gClef: '', gClef8vb: '', gClef8va: '', fClef: '', fClef8vb: '', cClef: '', percClef: '',
  whole: '', half: '', black: '', dot: '', segno: '', coda: '', fermata: '',
  breath: '', caesura: '', staccUp: '', staccDown: '', accentUp: '', accentDown: '',
  tenutoUp: '', tenutoDown: '', tuplet3: '', brace: '', metQuarter: '', common: '', cut: '',
};
const RESTS = ['', '', '', '', '', '', ''];
const FLAG_UP = ['', '', '', '', '', '', ''];
const FLAG_DOWN = ['', '', '', '', '', '', ''];
const ACC = ['', '', '', '', ''];
const SHARP_POS = [4, 1, 5, 2, -1, 3, 0], FLAT_POS = [0, 3, -1, 2, -2, 1, -3];
const SHARP_ORDER = [5, 2, 6, 3, 0, 4, 1], FLAT_ORDER = [1, 4, 0, 3, 6, 2, 5];
const FLOW_TEXT = ['Coda', 'Segno', 'Fine', 'To Coda', 'D.C.', 'D.C. al Coda', 'D.C. al Fine', 'D.S.', 'D.S. al Coda', 'D.S. al Fine'];
const TEXT_FONT = '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

const lowest = it => (it.heads.length ? Math.min(...it.heads.map(h => h.pos)) : 0);
const highest = it => (it.heads.length ? Math.max(...it.heads.map(h => h.pos)) : 0);
const minDur = it => (it.heads.length ? Math.min(...it.heads.map(h => h.dur)) : it.dur);
const hasStem = it => M.hasHeads(it) && it.heads.length > 0 && minDur(it) >= M.DUR_HALF;
const adjustKeyPos = p => (p > 5 ? p - 7 : p < -4 ? p + 7 : p);
const digits = n => [...String(n)].map(ch => String.fromCharCode(0xE080 + ch.charCodeAt(0) - 48)).join('');
const dynamicGlyphs = d => [...d].map(ch => ({ p: '', m: '', f: '' })[ch] || '').join('');

export class ScoreRenderer {
  constructor(layout) {
    this.L = layout;
    this.sp = layout.sp;
    this.focusStaff = -1;
    this.ink = '#000';
  }

  setInk(c, staff) {
    this.ink = this.focusStaff >= 0 && staff >= 0 && staff !== this.focusStaff ? '#9e9e9e' : '#000';
    c.fillStyle = this.ink;
    c.strokeStyle = this.ink;
  }

  glyph(c, g, x, y, scale = 1) {
    c.font = `${4 * this.sp * scale}px Bravura`;
    c.fillText(g, x, y);
  }

  glyphWidth(c, g, scale = 1) {
    c.font = `${4 * this.sp * scale}px Bravura`;
    return c.measureText(g).width;
  }

  text(c, s, x, y, size, { align = 'left', bold = false, italic = false, color = null } = {}) {
    c.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${TEXT_FONT}`;
    c.textAlign = align;
    if (color) c.fillStyle = color;
    c.fillText(s, x, y);
    c.textAlign = 'left';
    if (color) c.fillStyle = this.ink;
  }

  line(c, x1, y1, x2, y2, w) {
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }

  py(rowTop, pos) {
    return rowTop + 2 * this.sp - pos * this.sp / 2;
  }

  drawTitle(c) {
    const L = this.L, sp = this.sp;
    this.setInk(c, -1);
    if (!L.song.title) return;
    this.text(c, L.song.title, L.width / 2, 3 * sp, 2.3 * sp, { align: 'center', bold: true });
    if (L.song.author) this.text(c, L.song.author, L.width - L.rightMargin, 5.2 * sp, 1.3 * sp, { align: 'right' });
    if (L.song.lyricist) this.text(c, L.song.lyricist, L.leftMargin, 5.2 * sp, 1.3 * sp);
  }

  drawSystem(c, sys, playMeasure, playX, markMeasure) {
    const sp = this.sp, L = this.L;
    if (!sys.measures.length) return;
    c.save();
    c.translate(0, sys.y);
    const lastM = sys.measures[sys.measures.length - 1];
    const right = lastM.x + lastM.width;
    const first = sys.rows[0], lastRow = sys.rows[sys.rows.length - 1];
    for (const mb of sys.measures) {
      if (mb.index !== playMeasure && mb.index !== markMeasure) continue;
      c.fillStyle = mb.index === playMeasure ? 'rgba(255,193,7,0.25)' : 'rgba(30,136,229,0.12)';
      c.fillRect(mb.x, first.top - 1.5 * sp, mb.width, lastRow.top + 7 * sp - first.top);
      if (mb.index === playMeasure && playX >= 0) {
        c.strokeStyle = 'rgba(30,136,229,0.8)';
        this.line(c, playX, first.top - 1.5 * sp, playX, lastRow.top + 5.5 * sp, 0.25 * sp);
      }
    }
    for (const r of sys.rows) {
      this.setInk(c, r.staves[0]);
      this.drawStaffLines(c, r, L.leftMargin, right);
      this.drawHeader(c, sys, r);
      this.drawLabel(c, r);
    }
    this.drawBraces(c, sys);
    this.setInk(c, -1);
    const m1 = sys.measures[0].index + 1;
    if (m1 > 1) this.text(c, String(m1), sys.measures[0].x, first.top - 2.4 * sp, 1.1 * sp, { color: '#616161' });
    for (const mb of sys.measures) {
      this.drawBarline(c, sys, mb);
      if (mb.ending > 0) this.drawEnding(c, sys, mb);
    }
    for (const r of sys.rows) for (const s of r.staves) this.drawStaff(c, sys, r, s);
    c.restore();
  }

  drawStaffLines(c, r, x0, x1) {
    const w = Math.max(1, 0.1 * this.sp);
    if (r.lines === 1) { this.line(c, x0, r.top + 2 * this.sp, x1, r.top + 2 * this.sp, w); return; }
    for (let i = 0; i < 5; i++) this.line(c, x0, r.top + i * this.sp, x1, r.top + i * this.sp, w);
  }

  drawLabel(c, r) {
    const name = M.displayName(this.L.song.staves[r.staves[0]]);
    // Default names like "Staff-2" carry no information.
    if (!name || /^staff(-?\d+)?$/i.test(name)) return;
    this.text(c, name, this.L.leftMargin, r.top - 0.7 * this.sp, 1.05 * this.sp, { color: '#757575' });
  }

  drawHeader(c, sys, r) {
    const s = r.staves[0], sp = this.sp;
    let x = this.L.leftMargin + 0.6 * sp;
    x += this.drawClef(c, r, x, sys.clef[s], sys.clefOctave[s], 1) + 0.6 * sp;
    x += this.drawKey(c, r, x, sys.clef[s], sys.flats[s], sys.sharps[s], 0);
    if (sys.showTime && sys.hasTime[s]) this.drawTime(c, r, x + 0.4 * sp, sys.beats[s], sys.beatValue[s], sys.sigStyle[s]);
  }

  drawClef(c, r, x, clef, octave, scale) {
    let g, pos;
    switch (clef) {
      case M.CLEF_BASS: g = octave === 2 ? G.fClef8vb : G.fClef; pos = 2; break;
      case M.CLEF_ALTO: g = G.cClef; pos = 0; break;
      case M.CLEF_TENOR: g = G.cClef; pos = 2; break;
      case M.CLEF_PERCUSSION: g = G.percClef; pos = 0; break;
      default: g = octave === 2 ? G.gClef8vb : octave === 1 ? G.gClef8va : G.gClef; pos = -2;
    }
    this.glyph(c, g, x, this.py(r.top, pos), scale);
    return this.glyphWidth(c, g, scale);
  }

  drawKey(c, r, x, clef, flats, sharps, cancels) {
    const sp = this.sp;
    const shift = clef === M.CLEF_BASS || clef === M.CLEF_PERCUSSION ? -2 : clef === M.CLEF_ALTO ? -1 : clef === M.CLEF_TENOR ? 1 : 0;
    const x0 = x;
    for (let i = 0; i < 7; i++) {
      const bit = 1 << SHARP_ORDER[i];
      if ((cancels & bit) && !(sharps & bit)) { this.glyph(c, ACC[M.ACC_NATURAL], x, this.py(r.top, adjustKeyPos(SHARP_POS[i] + shift))); x += 0.9 * sp; }
    }
    for (let i = 0; i < 7; i++) if (sharps & (1 << SHARP_ORDER[i])) { this.glyph(c, ACC[M.ACC_SHARP], x, this.py(r.top, adjustKeyPos(SHARP_POS[i] + shift))); x += sp; }
    for (let i = 0; i < 7; i++) if (flats & (1 << FLAT_ORDER[i])) { this.glyph(c, ACC[M.ACC_FLAT], x, this.py(r.top, adjustKeyPos(FLAT_POS[i] + shift))); x += 0.9 * sp; }
    return x - x0;
  }

  drawTime(c, r, x, beats, value, style) {
    if (style === M.SIG_COMMON) { this.glyph(c, G.common, x, this.py(r.top, 0)); return; }
    if (style === M.SIG_ALLA_BREVE) { this.glyph(c, G.cut, x, this.py(r.top, 0)); return; }
    const top = digits(beats), bottom = digits(value);
    const wt = this.glyphWidth(c, top), wb = this.glyphWidth(c, bottom), w = Math.max(wt, wb);
    this.glyph(c, top, x + (w - wt) / 2, this.py(r.top, 2));
    this.glyph(c, bottom, x + (w - wb) / 2, this.py(r.top, -2));
  }

  drawBraces(c, sys) {
    const L = this.L, sp = this.sp;
    this.setInk(c, -1);
    const first = sys.rows[0], lastRow = sys.rows[sys.rows.length - 1];
    this.line(c, L.leftMargin, first.top, L.leftMargin, lastRow.top + 4 * sp, Math.max(1, 0.16 * sp));
    for (let i = 0; i < sys.rows.length - 1; i++) {
      const r = sys.rows[i], n = sys.rows[i + 1];
      const st = L.song.staves[r.staves[r.staves.length - 1]];
      if (st.withNext & M.WITH_BRACE) {
        const h = n.top + 4 * sp - r.top;
        c.save();
        c.translate(L.leftMargin - 0.4 * sp, n.top + 4 * sp);
        c.scale(1, h / (4 * sp));
        this.glyph(c, G.brace, -this.glyphWidth(c, G.brace), 0);
        c.restore();
      } else if (st.withNext & M.WITH_BRACKET) {
        c.fillRect(L.leftMargin - 0.9 * sp, r.top - 0.3 * sp, 0.5 * sp, n.top + 4.6 * sp - r.top);
      }
    }
  }

  drawBarline(c, sys, mb) {
    const sp = this.sp, L = this.L;
    const x = mb.x + mb.width;
    const style = mb.bar ? mb.bar.barStyle : -1;
    const isLast = mb === sys.measures[sys.measures.length - 1];
    if ((!mb.bar && !isLast) || style === M.BAR_TRANSPARENT) return;
    sys.rows.forEach((r, ri) => {
      this.setInk(c, r.staves[0]);
      let y0 = r.top, y1 = r.top + 4 * sp;
      if (r.lines === 1) { y0 = r.top + sp; y1 = r.top + 3 * sp; }
      const st = L.song.staves[r.staves[r.staves.length - 1]];
      if (ri + 1 < sys.rows.length && (st.withNext & M.WITH_CONNECT_BARS)) y1 = sys.rows[ri + 1].top;
      const thin = Math.max(1, 0.16 * sp), thick = 0.5 * sp;
      const dots = xx => { c.beginPath(); c.arc(xx, r.top + 1.5 * sp, 0.25 * sp, 0, 7); c.arc(xx, r.top + 2.5 * sp, 0.25 * sp, 0, 7); c.fill(); };
      switch (style) {
        case M.BAR_DOUBLE: case M.BAR_BROKEN_DOUBLE:
          this.line(c, x - 0.5 * sp, y0, x - 0.5 * sp, y1, thin);
          this.line(c, x, y0, x, y1, thin);
          break;
        case M.BAR_SECTION_CLOSE: case M.BAR_MASTER_REPEAT_CLOSE: case M.BAR_LOCAL_REPEAT_CLOSE:
          c.fillRect(x - thick, y0, thick, y1 - y0);
          this.line(c, x - thick - 0.4 * sp, y0, x - thick - 0.4 * sp, y1, thin);
          if (style !== M.BAR_SECTION_CLOSE) { c.beginPath(); c.arc(x - thick - sp, r.top + 1.5 * sp, 0.25 * sp, 0, 7); c.fill(); c.beginPath(); c.arc(x - thick - sp, r.top + 2.5 * sp, 0.25 * sp, 0, 7); c.fill(); }
          break;
        case M.BAR_SECTION_OPEN: case M.BAR_MASTER_REPEAT_OPEN: case M.BAR_LOCAL_REPEAT_OPEN:
          c.fillRect(x - thick, y0, thick, y1 - y0);
          this.line(c, x + 0.4 * sp, y0, x + 0.4 * sp, y1, thin);
          if (style !== M.BAR_SECTION_OPEN) { c.beginPath(); c.arc(x + 0.9 * sp, r.top + 1.5 * sp, 0.25 * sp, 0, 7); c.fill(); c.beginPath(); c.arc(x + 0.9 * sp, r.top + 2.5 * sp, 0.25 * sp, 0, 7); c.fill(); }
          break;
        default:
          this.line(c, x, y0, x, y1, thin);
      }
      void dots;
    });
    if (style === M.BAR_LOCAL_REPEAT_CLOSE && mb.bar.repeat > 2) {
      this.setInk(c, -1);
      this.text(c, mb.bar.repeat + 'x', x, sys.rows[0].top - 0.6 * sp, 1.2 * sp, { align: 'right' });
    }
  }

  drawEnding(c, sys, mb) {
    const sp = this.sp, r = sys.rows[0];
    this.setInk(c, -1);
    const y = r.top - 3.2 * sp, x0 = mb.x + 0.2 * sp, x1 = mb.x + mb.width - 0.4 * sp;
    const w = Math.max(1, 0.12 * sp);
    this.line(c, x0, y + 1.6 * sp, x0, y, w);
    this.line(c, x0, y, x1, y, w);
    const nums = [];
    for (let b = 0; b < 7; b++) if (mb.ending & (1 << b)) nums.push(b + 1);
    if (nums.length) this.text(c, nums.join(', ') + '.', x0 + 0.4 * sp, y + 1.4 * sp, 1.3 * sp);
  }

  // ---- Staff contents ----------------------------------------------------------------

  drawStaff(c, sys, r, s) {
    this.setInk(c, s);
    const elems = [];
    for (const mb of sys.measures) for (const e of mb.elems) if (e.staff === s) elems.push(e);
    const voice = r.staves.length > 1 ? (r.staves[0] === s ? 1 : 2) : 0;
    for (const e of elems) { e.beamGroupEnd = null; e.inBeam = false; e.stemTip = 0; e.stemDir = 0; }
    this.prepareStems(elems, r, voice);
    for (const e of elems) this.drawElem(c, sys, r, e);
    this.drawBeams(c, elems, r);
    this.drawTiesAndSlurs(c, elems, r, sys);
    this.drawTriplets(c, elems, r);
    this.drawLyrics(c, elems, r, s);
    for (const mb of sys.measures) for (const e of mb.trailing) if (e.staff === s) this.drawMarks(c, r, e);
  }

  prepareStems(elems, r, voice) {
    const sp = this.sp, hw = 1.18 * sp;
    for (let i = 0; i < elems.length; i++) {
      const e = elems[i], it = e.item;
      if (it.kind !== 'NOTE' && it.kind !== 'CHORD' && it.kind !== 'REST_CHORD') continue;
      if (!it.heads.length) continue;
      if (it.beam === 1 && it.kind !== 'REST_CHORD') {
        let j = i;
        const group = [];
        while (j < elems.length) {
          const g = elems[j];
          if (g.item.kind !== 'NOTE' && g.item.kind !== 'CHORD') break;
          if (j > i && g.item.beam !== 2 && g.item.beam !== 3) break;
          group.push(g);
          j++;
          if (g.item.beam === 3) break;
        }
        this.beamGroup(group, r, voice);
        i = j - 1;
        continue;
      }
      const scale = it.grace ? 0.65 : 1;
      const dir = it.stem === 1 ? 1 : it.stem === 2 ? -1 : voice === 1 ? 1 : voice === 2 ? -1 : highest(it) + lowest(it) >= 0 ? -1 : 1;
      e.stemDir = dir;
      const len = 3.5 * sp * scale;
      if (dir > 0) {
        e.stemX = e.x + hw * scale - 0.06 * sp;
        e.stemTip = Math.min(this.py(r.top, highest(it)) - len, this.py(r.top, 0));
      } else {
        e.stemX = e.x + 0.06 * sp;
        e.stemTip = Math.max(this.py(r.top, lowest(it)) + len, this.py(r.top, 0));
      }
      if (it.grace) e.stemTip = dir > 0 ? this.py(r.top, highest(it)) - len : this.py(r.top, lowest(it)) + len;
    }
  }

  beamGroup(group, r, voice) {
    const sp = this.sp, hw = 1.18 * sp;
    let dir = 0;
    for (const g of group) if (g.item.stem !== 0) { dir = g.item.stem === 1 ? 1 : -1; break; }
    if (dir === 0) dir = voice === 1 ? 1 : voice === 2 ? -1 : 0;
    if (dir === 0) dir = group.reduce((s, g) => s + highest(g.item) + lowest(g.item), 0) >= 0 ? -1 : 1;
    let beams = 1;
    for (const g of group) beams = Math.max(beams, minDur(g.item) - 2);
    const scale = group[0].item.grace ? 0.65 : 1;
    const len = (3.25 + 0.5 * (beams - 1)) * sp * scale;
    for (const g of group) {
      g.stemDir = dir;
      g.inBeam = group.length > 1;
      g.stemX = dir > 0 ? g.x + hw * scale - 0.06 * sp : g.x + 0.06 * sp;
    }
    const a = group[0], b = group[group.length - 1];
    const ya = dir > 0 ? this.py(r.top, highest(a.item)) - len : this.py(r.top, lowest(a.item)) + len;
    const yb = dir > 0 ? this.py(r.top, highest(b.item)) - len : this.py(r.top, lowest(b.item)) + len;
    const dx = b.stemX - a.stemX;
    let slope = dx <= 0 ? 0 : (yb - ya) / dx;
    slope = Math.max(-0.25, Math.min(0.25, slope));
    if (Math.abs(yb - ya) < 0.3 * sp) slope = 0;
    // Shift the beam so every stem keeps a minimum length.
    let offset = 0;
    for (const g of group) {
      const lineY = ya + slope * (g.stemX - a.stemX);
      const need = dir > 0 ? this.py(r.top, highest(g.item)) - 2.5 * sp * scale : this.py(r.top, lowest(g.item)) + 2.5 * sp * scale;
      offset = dir > 0 ? Math.min(offset, need - lineY) : Math.max(offset, need - lineY);
    }
    for (const g of group) g.stemTip = ya + offset + slope * (g.stemX - a.stemX);
    if (group.length > 1) a.beamGroupEnd = b;
  }

  drawElem(c, sys, r, e) {
    const it = e.item;
    if (!it.visible && !M.hasHeads(it)) { this.drawMarks(c, r, e); return; }
    switch (it.kind) {
      case 'CLEF': this.drawClef(c, r, e.x, it.clef, it.clefOctave, 0.75); return;
      case 'KEY': {
        const m = e.measure, L = this.L;
        const prev = m > 0 ? L.flatsAt[e.staff][m - 1] | L.sharpsAt[e.staff][m - 1] : 0;
        this.drawKey(c, r, e.x, L.clefAt[e.staff][m], it.flats, it.sharps, prev);
        return;
      }
      case 'TIMESIG': this.drawTime(c, r, e.x, it.beats, it.beatValue, it.sigStyle); return;
      case 'REST': this.drawRest(c, r, e); break;
      case 'REST_CHORD': this.drawRest(c, r, e); this.drawHeads(c, r, e); break;
      case 'NOTE': case 'CHORD': this.drawHeads(c, r, e); break;
    }
    this.drawMarks(c, r, e);
  }

  drawRest(c, r, e) {
    const it = e.item;
    if (!it.visible) return;
    const dur = e.measureRest ? 0 : it.dur;
    let pos = it.restOffset + (dur === 0 ? 2 : 0);
    if (r.staves.length > 1 && it.restOffset === 0) pos += r.staves[0] === e.staff ? 2 : -2;
    const scale = it.grace ? 0.65 : 1;
    const g = RESTS[Math.max(0, Math.min(6, dur))];
    this.glyph(c, g, e.x, this.py(r.top, pos), scale);
    if (!e.measureRest) this.drawDots(c, r, e.x + this.glyphWidth(c, g, scale), 1, it.dots);
  }

  drawDots(c, r, x, pos, dots) {
    const p = (pos & 1) === 0 ? pos + 1 : pos;
    for (let i = 0; i < dots; i++) this.glyph(c, G.dot, x + 0.35 * this.sp + i * 0.5 * this.sp, this.py(r.top, p));
  }

  drawHeads(c, r, e) {
    const it = e.item, sp = this.sp;
    if (!it.heads.length) return;
    const scale = it.grace ? 0.65 : 1;
    const hw = 1.18 * sp * scale;
    const dir = e.stemDir === 0 ? 1 : e.stemDir;
    const lw = Math.max(1, 0.12 * sp);
    const hi = highest(it), lo = lowest(it);
    if (r.lines === 5) {
      for (let p = 6; p <= hi; p += 2) this.line(c, e.x - 0.4 * sp, this.py(r.top, p), e.x + hw + 0.4 * sp, this.py(r.top, p), lw);
      for (let p = -6; p >= lo; p -= 2) this.line(c, e.x - 0.4 * sp, this.py(r.top, p), e.x + hw + 0.4 * sp, this.py(r.top, p), lw);
    }
    // Heads (seconds go to the other side of the stem), accidentals, dots.
    const heads = [...it.heads].sort((a, b) => (dir > 0 ? a.pos - b.pos : b.pos - a.pos));
    let prevPos = null, prevShifted = false, accCol = 0;
    for (const h of heads) {
      const shift = !prevShifted && prevPos !== null && Math.abs(h.pos - prevPos) === 1;
      const hx = e.x + (shift ? dir * (hw - 0.08 * sp) : 0);
      const g = h.dur === M.DUR_WHOLE ? G.whole : h.dur === M.DUR_HALF ? G.half : G.black;
      this.glyph(c, g, hx, this.py(r.top, h.pos), scale);
      if (h.acc !== M.ACC_NONE && h.acc <= M.ACC_DFLAT) {
        const ax = e.x - (1.15 + (accCol++ % 3)) * sp * scale;
        this.glyph(c, ACC[h.acc], ax, this.py(r.top, h.pos), scale);
      }
      if (h.dots > 0) this.drawDots(c, r, e.x + hw * (shift && dir > 0 ? 2 : 1), h.pos, h.dots);
      prevShifted = shift;
      prevPos = h.pos;
    }
    if (hasStem(it) && !e.inBeam && e.stemTip !== 0) {
      const yStart = dir > 0 ? this.py(r.top, lo) : this.py(r.top, hi);
      this.line(c, e.stemX, yStart, e.stemX, e.stemTip, lw);
      if (minDur(it) >= M.DUR_8TH) {
        const d = Math.min(6, minDur(it));
        this.glyph(c, dir > 0 ? FLAG_UP[d] : FLAG_DOWN[d], e.stemX - 0.06 * sp, e.stemTip, scale);
      }
      if (it.grace && it.dur === M.DUR_8TH && it.beam === 0) {
        const y = yStart + (e.stemTip - yStart) * 0.55;
        this.line(c, e.stemX - 0.6 * sp, y + 0.5 * sp * dir, e.stemX + 0.9 * sp, y - 0.7 * sp * dir, Math.max(1, 0.1 * sp));
      }
    }
    // Articulations go on the note-head side opposite the stem.
    const artDir = -dir;
    const ax = e.x + hw / 2 - 0.5 * sp;
    let p = (artDir > 0 ? hi : lo) + artDir * 2;
    if (r.lines === 5 && p > -4 && p < 4 && (p & 1) === 0) p += artDir;
    if (it.staccato) { this.glyph(c, artDir > 0 ? G.staccUp : G.staccDown, ax + 0.25 * sp, this.py(r.top, p)); p += artDir * 2; }
    if (it.tenuto) { this.glyph(c, artDir > 0 ? G.tenutoUp : G.tenutoDown, ax, this.py(r.top, p)); p += artDir * 2; }
    if (it.accent) this.glyph(c, artDir > 0 ? G.accentUp : G.accentDown, ax, this.py(r.top, p));
  }

  drawBeams(c, elems, r) {
    const sp = this.sp;
    for (let i = 0; i < elems.length; i++) {
      const a = elems[i];
      if (!a.beamGroupEnd) continue;
      const j = elems.indexOf(a.beamGroupEnd);
      if (j < 0) continue;
      const g = elems.slice(i, j + 1);
      const scale = a.item.grace ? 0.65 : 1;
      const th = 0.5 * sp * scale, gap = 0.75 * sp * scale, dir = a.stemDir;
      const lw = Math.max(1, 0.12 * sp);
      for (const e of g) {
        const yStart = dir > 0 ? this.py(r.top, lowest(e.item)) : this.py(r.top, highest(e.item));
        this.line(c, e.stemX, yStart, e.stemX, e.stemTip, lw);
      }
      let maxLevel = 0;
      for (const e of g) maxLevel = Math.max(maxLevel, minDur(e.item) - 2);
      for (let level = 1; level <= maxLevel; level++) {
        const off = (level - 1) * gap * dir;
        for (let k = 0; k < g.length; k++) {
          const e = g[k];
          if (minDur(e.item) - 2 < level) continue;
          const n = g[k + 1], p = g[k - 1];
          const nextHas = n && minDur(n.item) - 2 >= level, prevHas = p && minDur(p.item) - 2 >= level;
          if (nextHas) this.beam(c, e.stemX, e.stemTip + off, n.stemX, n.stemTip + off, th, dir);
          else if (!prevHas) {
            const len = 1.1 * sp;
            if (n || !p) {
              const y2 = e.stemTip + (n ? (n.stemTip - e.stemTip) * len / Math.max(1, n.stemX - e.stemX) : 0);
              this.beam(c, e.stemX, e.stemTip + off, e.stemX + len, y2 + off, th, dir);
            } else {
              const y2 = e.stemTip - (e.stemTip - p.stemTip) * len / Math.max(1, e.stemX - p.stemX);
              this.beam(c, e.stemX - len, y2 + off, e.stemX, e.stemTip + off, th, dir);
            }
          }
        }
      }
    }
  }

  beam(c, x1, y1, x2, y2, th, dir) {
    const t = dir > 0 ? th : -th;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.lineTo(x2, y2 + t);
    c.lineTo(x1, y1 + t);
    c.closePath();
    c.fill();
  }

  arc(c, x1, y1, x2, y2, up) {
    const sp = this.sp;
    const h = Math.min(2.2 * sp, Math.max(0.8 * sp, (x2 - x1) * 0.18)) * (up > 0 ? -1 : 1);
    const th = 0.18 * sp * (up > 0 ? -1 : 1);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    c.beginPath();
    c.moveTo(x1, y1);
    c.quadraticCurveTo(mx, my + h, x2, y2);
    c.quadraticCurveTo(mx, my + h + th, x1, y1);
    c.closePath();
    c.fill();
  }

  drawTiesAndSlurs(c, elems, r, sys) {
    const sp = this.sp, hw = 1.18 * sp;
    const lastM = sys.measures[sys.measures.length - 1];
    const sysRight = lastM.x + lastM.width;
    for (let i = 0; i < elems.length; i++) {
      const e = elems[i], it = e.item;
      if (!M.hasHeads(it)) continue;
      for (const h of it.heads) {
        if (!h.tie) continue;
        let next = null;
        for (let j = i + 1; j < elems.length && !next; j++) if (M.hasHeads(elems[j].item)) next = elems[j];
        const up = it.heads.length > 1 ? (h.pos >= (highest(it) + lowest(it)) / 2 ? 1 : -1) : (e.stemDir > 0 ? -1 : 1);
        const y = this.py(r.top, h.pos) + (up > 0 ? -0.5 : 0.5) * sp;
        const x1 = e.x + hw + 0.15 * sp, x2 = next ? next.x - 0.15 * sp : sysRight - 0.3 * sp;
        if (x2 > x1) this.arc(c, x1, y, x2, y, up);
      }
      const startsSlur = it.slur && (i === 0 || !elems[i - 1].item.slur);
      if (startsSlur && it.kind !== 'REST') {
        let j = i;
        while (j + 1 < elems.length && elems[j].item.slur) j++;
        const end = elems[j].item.slur ? null : elems[j];
        const up = e.stemDir > 0 ? -1 : 1;
        const y1 = up > 0 ? this.py(r.top, highest(it)) - sp : this.py(r.top, lowest(it)) + sp;
        const x1 = e.x + hw / 2;
        let x2, y2;
        if (end && M.hasHeads(end.item)) {
          x2 = end.x + hw / 2;
          y2 = up > 0 ? this.py(r.top, highest(end.item)) - sp : this.py(r.top, lowest(end.item)) + sp;
        } else { x2 = sysRight - 0.5 * sp; y2 = y1; }
        if (x2 > x1 + sp) this.arc(c, x1, y1, x2, y2, up);
      }
    }
  }

  drawTriplets(c, elems, r) {
    const sp = this.sp;
    for (let i = 0; i < elems.length; i++) {
      const e = elems[i];
      if (e.item.triplet !== 1) continue;
      let j = i;
      while (j + 1 < elems.length && elems[j].item.triplet !== 3) j++;
      const end = elems[j];
      const dir = e.stemDir === 0 ? 1 : e.stemDir;
      const x = (e.x + end.x + 1.18 * sp) / 2 - 0.5 * sp;
      let y = M.hasHeads(e.item) && e.stemTip !== 0 ? Math.min(e.stemTip, end.stemTip || e.stemTip) : this.py(r.top, 6);
      if (dir < 0) y = Math.max(e.stemTip, end.stemTip) + 2 * sp;
      else y -= 0.6 * sp;
      this.glyph(c, G.tuplet3, x, y, 0.8);
      i = j;
    }
  }

  drawLyrics(c, elems, r, s) {
    const sp = this.sp, L = this.L, verses = L.verses[s];
    if (!verses) return;
    const hw = 1.18 * sp;
    let base = r.lyricY;
    if (r.staves.length > 1 && r.staves[0] !== s) base += verses * 2.1 * sp;
    c.font = `${1.6 * sp}px ${TEXT_FONT}`;
    c.textAlign = 'center';
    for (let v = 0; v < verses; v++) {
      const y = base + v * 2.1 * sp;
      let prev = null, prevText = null;
      for (const e of elems) {
        if (!e.lyrics || v >= e.lyrics.length || e.lyrics[v] === null) continue;
        const t = e.lyrics[v];
        const shown = t.endsWith('-') ? t.slice(0, -1) : t;
        const cx = e.x + hw / 2;
        c.fillText(shown, cx, y);
        if (prev && prevText && prevText.endsWith('-')) {
          const a = prev.x + hw / 2 + c.measureText(prevText).width / 2;
          const b = cx - c.measureText(shown).width / 2;
          if (b - a > 0.6 * sp) c.fillText('-', (a + b) / 2, y);
        }
        prev = e;
        prevText = t;
      }
    }
    c.textAlign = 'left';
  }

  drawMarks(c, r, e) {
    if (!e.marks.length) return;
    const sp = this.sp, L = this.L, x = e.x;
    const below = L.verses[e.staff] > 0 ? r.lyricY + L.verses[e.staff] * 2.1 * sp : r.top + 7 * sp;
    for (const mk of e.marks) {
      if (!mk.visible) continue;
      switch (mk.kind) {
        case 'DYNAMIC':
          this.glyph(c, dynamicGlyphs(M.DYNAMICS[Math.max(0, Math.min(7, mk.dynamic))]), x - 0.3 * sp, below);
          break;
        case 'DYN_VAR': {
          const t = !mk.text || mk.text.startsWith('Cresc') ? 'cresc.' : mk.text.startsWith('Dim') ? 'dim.' : mk.text.startsWith('Decresc') ? 'decresc.' : mk.text.toLowerCase();
          this.text(c, t, x, below, 1.3 * sp, { italic: true });
          break;
        }
        case 'TEXT':
          this.text(c, mk.text, x, this.py(r.top, mk.pos), 1.4 * sp);
          break;
        case 'TEMPO': {
          const y = r.top - 3.3 * sp;
          let tx = x;
          if (mk.text) {
            this.text(c, mk.text, tx, y, 1.5 * sp, { bold: true });
            tx += c.measureText(mk.text).width + sp;
          }
          this.glyph(c, G.metQuarter, tx, y, 0.75);
          this.text(c, ' = ' + mk.tempo, tx + sp, y, 1.4 * sp);
          break;
        }
        case 'FLOW': {
          const y = r.top - 2 * sp;
          if (mk.flow === M.FLOW_SEGNO) this.glyph(c, G.segno, x, y);
          else if (mk.flow === M.FLOW_CODA) this.glyph(c, G.coda, x, y);
          else {
            const t = FLOW_TEXT[Math.min(FLOW_TEXT.length - 1, mk.flow)];
            this.text(c, t, x, y, 1.4 * sp, { bold: true, italic: true });
            if (mk.flow === M.FLOW_TOCODA) this.glyph(c, G.coda, x + c.measureText(t).width + 0.4 * sp, y, 0.7);
          }
          break;
        }
        case 'TEMPO_VAR': {
          const y = Math.min(r.top - sp, e.item && M.hasHeads(e.item) ? this.py(r.top, highest(e.item)) - 1.5 * sp : r.top);
          if (mk.tvStyle === M.TV_FERMATA) this.glyph(c, G.fermata, x, y);
          else if (mk.tvStyle === M.TV_BREATH) this.glyph(c, G.breath, x + 1.5 * sp, r.top - 0.5 * sp);
          else if (mk.tvStyle === M.TV_CAESURA) this.glyph(c, G.caesura, x + 1.5 * sp, r.top + sp);
          else {
            const s = (mk.text || '').toLowerCase();
            const t = !s || s.startsWith('rit') ? 'rit.' : s.startsWith('rall') ? 'rall.' : s.startsWith('accel') ? 'accel.' : s;
            this.text(c, t, x, r.top - 1.2 * sp, 1.3 * sp, { italic: true });
          }
          break;
        }
      }
    }
  }
}
