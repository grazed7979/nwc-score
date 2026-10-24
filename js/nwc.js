// NoteWorthy Composer file reading: format detection, NWCTXT parser and the binary
// (NWC 2.0 - 2.5) parser. Ported from the Android app, where it was verified against nwc-conv.
import * as M from './model.js';

const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));

function indexOf(b, pat, from = 0) {
  outer:
  for (let i = from; i <= b.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

function startsWith(b, s) {
  if (b.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** UTF-8 when it decodes more cleanly than the Korean legacy code page that older NWC versions write. */
function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const utf = new TextDecoder('utf-8').decode(bytes);
    const legacy = new TextDecoder('euc-kr').decode(bytes);
    const bad = s => (s.match(/�/g) || []).length;
    return bad(utf) <= bad(legacy) ? utf : legacy;
  }
}

export class NwcError extends Error {}

/** Parses the bytes of a .nwc or .nwctxt file. */
export async function readNwc(bytes) {
  let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (startsWith(data, '[NWZ]')) {
    try {
      data = await inflate(data.subarray(6));
    } catch (e) {
      throw new NwcError('압축을 풀 수 없습니다: ' + e.message);
    }
  }
  if (startsWith(data, '[NoteWorthy ArtWare]')) {
    const text = indexOf(data, ascii('!NoteWorthyComposer'));
    if (text >= 0 && text < 512) {
      // NWC 2.7x stores the song as NWCTXT after a short binary header.
      const endMark = ascii('!NoteWorthyComposer-End');
      const end = indexOf(data, endMark);
      const stop = end > text ? end + endMark.length : data.length;
      return parseText(decodeText(data.subarray(text, stop)));
    }
    return new BinaryParser(data, new TextDecoder('euc-kr')).run();
  }
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  const text = decodeText(data.subarray(bom));
  if (text.trim().startsWith('!NoteWorthyComposer')) return parseText(text);
  throw new NwcError('NoteWorthy Composer 파일(.nwc, .nwctxt)이 아닙니다.');
}

// ---- NWCTXT -----------------------------------------------------------------------

/** Splits a line on '|' outside quoted strings, unescaping quoted values. */
function splitLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && i + 1 < line.length) {
        const n = line[++i];
        cur += n === 'r' ? '\r' : n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === '|') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function fieldsOf(parts) {
  const m = new Map();
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i].indexOf(':');
    if (c > 0) m.set(parts[i].slice(0, c), parts[i].slice(c + 1));
  }
  return m;
}

function num(s, def) {
  if (s === undefined || s === null) return def;
  const t = String(s).trim().replace('+', '');
  if (!/^-?\d+$/.test(t)) return def;
  return parseInt(t, 10);
}

const letterIndexA = c => {
  const i = c.toUpperCase().charCodeAt(0) - 65;
  return i < 0 || i > 6 ? 0 : i;
};

export function parseText(text) {
  const song = M.newSong();
  let staff = null, sawHeader = false;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line.startsWith('!NoteWorthyComposer')) { sawHeader = true; continue; }
    if (!line.startsWith('|')) continue;
    const parts = splitLine(line);
    const type = parts[0];
    const f = fieldsOf(parts);
    const get = k => f.get(k) ?? '';
    switch (type) {
      case 'SongInfo':
        song.title = get('Title'); song.author = get('Author'); song.lyricist = get('Lyricist');
        song.copyright1 = get('Copyright1'); song.copyright2 = get('Copyright2'); song.comments = get('Comments');
        break;
      case 'AddStaff':
        staff = M.newStaff();
        staff.name = get('Name'); staff.label = get('Label'); staff.group = get('Group');
        staff.channel = song.staves.length % 16;
        song.staves.push(staff);
        break;
      case 'StaffProperties':
        if (!staff) break;
        if (f.has('Lines')) staff.lines = num(f.get('Lines'), 5);
        if (f.has('WithNextStaff')) {
          const w = f.get('WithNextStaff');
          staff.withNext = (w.includes('Bracket') ? M.WITH_BRACKET : 0) | (w.includes('Brace') ? M.WITH_BRACE : 0)
            | (w.includes('ConnectBars') ? M.WITH_CONNECT_BARS : 0);
          staff.layerWithNext = w.includes('Layer');
        }
        if (f.has('Visible')) staff.visible = f.get('Visible') !== 'N';
        if (f.has('Muted')) staff.muted = f.get('Muted') === 'Y';
        if (f.has('Volume')) staff.volume = num(f.get('Volume'), 127);
        if (f.has('StereoPan')) staff.pan = num(f.get('StereoPan'), 64);
        if (f.has('Channel')) staff.channel = Math.max(0, num(f.get('Channel'), 1) - 1) & 15;
        break;
      case 'StaffInstrument':
        if (!staff) break;
        if (f.has('Patch')) staff.patch = num(f.get('Patch'), 0);
        if (f.has('Trans')) staff.transpose = num(f.get('Trans'), 0);
        if (f.has('DynVel')) f.get('DynVel').split(',').slice(0, 8).forEach((v, i) => { staff.dynVel[i] = num(v, staff.dynVel[i]); });
        break;
      default: {
        if (!staff) break;
        if (/^Lyric\d/.test(type)) { staff.lyrics.push(get('Text')); break; }
        const it = textItem(type, f, get);
        if (it) staff.items.push(it);
      }
    }
  }
  if (!sawHeader && song.staves.length === 0) throw new NwcError('NWC 텍스트 형식이 아닙니다.');
  song.sourceFormat = 'NWCTXT';
  return song;
}

function textItem(type, f, get) {
  let it;
  switch (type) {
    case 'Clef': {
      it = M.newItem('CLEF');
      const t = get('Type');
      it.clef = t === 'Bass' ? M.CLEF_BASS : t === 'Alto' ? M.CLEF_ALTO : t === 'Tenor' ? M.CLEF_TENOR : t === 'Percussion' ? M.CLEF_PERCUSSION : M.CLEF_TREBLE;
      const o = get('OctaveShift');
      it.clefOctave = o.includes('Up') ? 1 : o.includes('Down') ? 2 : 0;
      break;
    }
    case 'Key':
      it = M.newItem('KEY');
      for (const s of get('Signature').split(',')) {
        if (s.length < 2) continue;
        const bit = 1 << letterIndexA(s[0]);
        if (s[1] === 'b') it.flats |= bit;
        else if (s[1] === '#') it.sharps |= bit;
      }
      break;
    case 'TimeSig': {
      it = M.newItem('TIMESIG');
      const s = get('Signature');
      if (s === 'Common') { it.sigStyle = M.SIG_COMMON; it.beats = 4; it.beatValue = 4; }
      else if (s === 'AllaBreve') { it.sigStyle = M.SIG_ALLA_BREVE; it.beats = 2; it.beatValue = 2; }
      else {
        const sl = s.indexOf('/');
        if (sl > 0) { it.beats = num(s.slice(0, sl), 4); it.beatValue = num(s.slice(sl + 1), 4); }
      }
      break;
    }
    case 'Tempo': {
      it = M.newItem('TEMPO');
      it.tempo = num(get('Tempo'), 120);
      const b = get('Base');
      it.tempoBase = b.startsWith('Eighth') ? (b.includes('Dotted') ? 1 : 0) : b.startsWith('Half') ? (b.includes('Dotted') ? 5 : 4) : b.includes('Dotted') ? 3 : 2;
      it.text = get('Text');
      break;
    }
    case 'Dynamic': {
      it = M.newItem('DYNAMIC');
      const i = M.DYNAMICS.indexOf(get('Style'));
      if (i >= 0) it.dynamic = i;
      const v = opt(get, 'Velocity');
      if (v !== null) it.velocity = num(v, -1);
      break;
    }
    case 'Bar': {
      it = M.newItem('BAR');
      const i = M.BAR_NAMES.indexOf(get('Style'));
      if (i >= 0) it.barStyle = i;
      it.repeat = num(get('Repeat'), 2);
      it.sysBreak = get('SysBreak') === 'Y';
      break;
    }
    case 'Ending':
      it = M.newItem('ENDING');
      for (const s of get('Endings').split(',')) {
        if (s === 'D') it.endings |= 0x80;
        else { const n = num(s, 0); if (n >= 1 && n <= 7) it.endings |= 1 << (n - 1); }
      }
      it.closedBracket = get('ClosedBracket') === 'Y';
      break;
    case 'Flow': {
      it = M.newItem('FLOW');
      const i = M.FLOW_NAMES.indexOf(get('Style'));
      if (i >= 0) it.flow = i;
      break;
    }
    case 'TempoVariance': {
      it = M.newItem('TEMPO_VAR');
      const s = get('Style');
      it.tvStyle = s.startsWith('Breath') ? M.TV_BREATH : s === 'Caesura' ? M.TV_CAESURA : s === 'Fermata' ? M.TV_FERMATA : 3;
      it.text = s;
      it.pause = num(get('Pause'), 0);
      break;
    }
    case 'Instrument':
      it = M.newItem('INSTRUMENT');
      if (f.has('Patch')) it.patch = num(f.get('Patch'), 0);
      it.transpose = num(get('Trans'), 0);
      it.text = get('Name');
      break;
    case 'Text': it = M.newItem('TEXT'); it.text = get('Text'); break;
    case 'Boundary': it = M.newItem('BOUNDARY'); it.boundaryStyle = get('Style') === 'NewSystem' ? 5 : 0; break;
    case 'Note': case 'Chord': case 'Rest': case 'RestChord': it = timedItem(type, f, get); break;
    case 'SustainPedal': it = M.newItem('PEDAL'); break;
    case 'MPC': it = M.newItem('MPC'); break;
    case 'DynamicVariance': it = M.newItem('DYN_VAR'); it.text = get('Style'); break;
    case 'PerformanceStyle': it = M.newItem('PERFORMANCE'); it.text = get('Style'); break;
    case 'Spacer': it = M.newItem('SPACER'); break;
    case 'User': it = M.newItem('USER'); break;
    case 'RestMultiBar': it = M.newItem('MULTIBAR_REST'); it.repeat = num(get('NumBars'), 1); break;
    default: return null;
  }
  if (f.has('Pos') && !M.hasHeads(it)) it.pos = num(f.get('Pos'), 0);
  if (f.get('Visibility') === 'Never') it.visible = false;
  return it;
}

function opt(get, key) {
  for (const o of get('Opts').split(',')) if (o.startsWith(key + '=')) return o.slice(key.length + 1);
  return null;
}

function timedItem(type, f, get) {
  const kind = type === 'Note' ? 'NOTE' : type === 'Chord' ? 'CHORD' : type === 'Rest' ? 'REST' : 'REST_CHORD';
  const it = M.newItem(kind);
  applyDur(it, get('Dur'));
  for (const o of get('Opts').split(',')) {
    if (o === 'Stem=Up') it.stem = 1;
    else if (o === 'Stem=Down') it.stem = 2;
    else if (o === 'Beam') it.beam = 2;
    else if (o === 'Beam=First') it.beam = 1;
    else if (o === 'Beam=End') it.beam = 3;
    else if (o === 'Lyric=Always') it.lyricMode = 1;
    else if (o === 'Lyric=Never') it.lyricMode = 2;
    else if (o.startsWith('VertOffset=')) it.restOffset = num(o.slice(11), 0);
  }
  if (kind === 'NOTE' || kind === 'CHORD') addHeads(it, get('Pos'), it.dur, it.dots);
  if (f.has('Pos2')) {
    const d2 = M.newItem('NOTE');
    applyDur(d2, get('Dur2'));
    addHeads(it, get('Pos2'), d2.dur, d2.dots);
  }
  return it;
}

const DUR_NAMES = { Whole: 0, Half: 1, '4th': 2, '8th': 3, '16th': 4, '32nd': 5, '64th': 6 };

function applyDur(it, dur) {
  for (const t of dur.split(',')) {
    if (t in DUR_NAMES) it.dur = DUR_NAMES[t];
    else if (t === 'Dotted') it.dots = 1;
    else if (t === 'DblDotted') it.dots = 2;
    else if (t === 'Triplet') it.triplet = 2;
    else if (t === 'Triplet=First') it.triplet = 1;
    else if (t === 'Triplet=End') it.triplet = 3;
    else if (t === 'Grace') it.grace = true;
    else if (t === 'Slur') it.slur = true;
    else if (t === 'Staccato') it.staccato = true;
    else if (t === 'Accent') it.accent = true;
    else if (t === 'Tenuto') it.tenuto = true;
  }
}

const ACC_CHARS = { '#': M.ACC_SHARP, b: M.ACC_FLAT, n: M.ACC_NATURAL, x: M.ACC_DSHARP, v: M.ACC_DFLAT };

function addHeads(it, pos, dur, dots) {
  if (!pos) return;
  for (const p of pos.split(',')) {
    let i = 0, acc = M.ACC_NONE;
    if (p[0] in ACC_CHARS) { acc = ACC_CHARS[p[0]]; i++; }
    let j = i;
    if (p[j] === '-' || p[j] === '+') j++;
    while (j < p.length && p[j] >= '0' && p[j] <= '9') j++;
    it.heads.push(M.head(num(p.slice(i, j), 0), acc, p.indexOf('^', j) >= 0, dur, dots));
  }
}

// ---- Binary NWC 2.0 - 2.5 --------------------------------------------------------------

class BinaryParser {
  constructor(b, decoder) {
    this.b = b;
    this.dec = decoder;
    this.p = 0;
    this.ver = 0;
    this.headerStrings = 5;
  }

  fail(msg) {
    return new NwcError(msg + ' (@' + this.p.toString(16) + ')');
  }

  u16(q) { return this.b[q] | (this.b[q + 1] << 8); }
  s16(q) { const v = this.u16(q); return v >= 0x8000 ? v - 0x10000 : v; }
  s8(q) { const v = this.b[q]; return v >= 0x80 ? v - 0x100 : v; }

  cstr() {
    const s = this.p;
    while (this.p < this.b.length && this.b[this.p] !== 0) this.p++;
    const r = this.dec.decode(this.b.subarray(s, this.p));
    this.p++;
    return r;
  }

  run() {
    const b = this.b;
    let p = indexOf(b, ascii('[NoteWorthy Composer]'));
    if (p < 0) throw this.fail('NWC 파일이 아닙니다.');
    p += 22;
    this.ver = b[p + 1] * 100 + b[p];
    if (this.ver < 200) throw this.fail('NWC 1.x 파일은 지원하지 않습니다. NoteWorthy Composer 2에서 다시 저장해 주세요.');
    this.p = p + 6;
    this.cstr(); this.cstr();
    this.p += 10;
    const song = M.newSong();
    song.title = this.cstr(); song.author = this.cstr(); song.lyricist = this.cstr();
    song.copyright1 = this.cstr(); song.copyright2 = this.cstr(); song.comments = this.cstr();
    song.sourceFormat = 'NWC ' + Math.floor(this.ver / 100) + '.' + String(this.ver % 100).padStart(2, '0');

    let margins = false;
    for (let i = 0; i < 12 && !margins; i++) margins = /^[0-9.]+ [0-9.]+ [0-9.]+ [0-9.]+$/.test(this.cstr());
    if (!margins) throw this.fail('페이지 설정을 읽을 수 없습니다.');

    let fontsEnd = -1;
    for (let q = this.p; q < this.p + 200 && fontsEnd < 0; q++) {
      const size = this.u16(q);
      if (size >= 4 && size <= 60) fontsEnd = this.fonts(q + 2);
    }
    if (fontsEnd < 0) throw this.fail('글꼴 정보를 읽을 수 없습니다.');

    let staffCount = -1;
    const counts = this.ver >= 205 ? [5, 4, 6, 3] : [4, 5, 3, 6];
    for (let pass = 0; pass < counts.length && staffCount < 0; pass++) {
      for (let q = fontsEnd; q < fontsEnd + 64; q++) {
        const n = this.u16(q);
        if (n >= 1 && n <= 256 && b[q + 2] !== 0 && this.headerEnd(q + 2, counts[pass], true) > 0) {
          staffCount = n;
          this.headerStrings = counts[pass];
          this.p = q + 2;
          break;
        }
      }
    }
    if (staffCount < 0) throw this.fail('보표 정보를 찾을 수 없습니다.');
    for (let i = 0; i < staffCount; i++) song.staves.push(this.staff());
    return song;
  }

  fonts(q) {
    const b = this.b;
    let named = 0;
    for (let i = 0; i < 12; i++) {
      const s = q;
      while (q < b.length && b[q] !== 0) {
        if (b[q] < 0x20) return -1;
        q++;
      }
      if (q - s > 64 || q + 5 > b.length) return -1;
      if (q > s) named++;
      q++;
      const size = b[q + 1];
      if (b[q + 2] !== 0 || size < 1 || size > 127) return -1;
      q += 4;
    }
    return named > 0 ? q : -1;
  }

  headerEnd(q, n, strict) {
    const b = this.b;
    let r = q;
    for (let i = 0; i < n; i++) {
      const s = r;
      while (r < b.length && b[r] !== 0) r++;
      if (r >= b.length || r - s >= 256) return -1;
      r++;
    }
    const v = r + 13;
    if (v + 8 > b.length) return -1;
    for (let i = 0; i < 8; i++) {
      const x = b[v + i];
      if (x > 127 || (strict && (x < 1 || (i > 0 && x < b[v + i - 1])))) return -1;
    }
    return r;
  }

  staff() {
    const b = this.b;
    const st = M.newStaff();
    const n = this.headerStrings;
    if (this.headerEnd(this.p, n, false) < 0) throw this.fail('보표 머리글을 읽을 수 없습니다.');
    const s = [];
    for (let i = 0; i < n; i++) s.push(this.cstr());
    st.name = s[0];
    st.label = n > 1 ? s[1] : '';
    st.group = s[n - 1];
    const f = this.p;
    st.muted = (b[f + 1] & 1) !== 0;
    st.channel = b[f + 3] & 0x0f;
    st.patch = Math.max(0, b[f + 11] - 1);
    for (let i = 0; i < 8; i++) st.dynVel[i] = b[f + 13 + i] & 0x7f;
    this.p += 21;
    st.withNext = this.u16(this.p) & 7;
    this.p += 6;
    st.lines = b[this.p];
    st.layerWithNext = (b[this.p + 1] & 1) !== 0;
    this.p += 3;
    st.transpose = this.s16(this.p);
    st.volume = this.s16(this.p + 2);
    st.pan = this.s16(this.p + 4);
    this.p += 6;
    st.visible = (b[this.p] & 1) === 0 && st.group.toLowerCase() !== 'hidden';
    this.p += 1;
    const lyricsOn = this.u16(this.p), lines = this.u16(this.p + 2);
    this.p += 6;
    if (lyricsOn !== 0) {
      for (let i = 0; i < lines; i++) {
        this.p += 2;
        const size = this.u16(this.p);
        this.p += 2;
        st.lyrics.push(this.lyricText(this.p, size));
        this.p += size;
      }
      this.p += 6;
    }
    const count = this.u16(this.p);
    this.p += 2;
    for (let i = 0; i < count - 2; i++) st.items.push(this.object());
    return st;
  }

  lyricText(q, size) {
    const b = this.b;
    const len = Math.min(this.u16(q), size - 2);
    const s = q + 2;
    const out = [];
    // Syllables are NUL-terminated and start with their separator; a space inside a syllable is NWCTXT's '_'.
    let syllableStart = true;
    for (let i = s; i < s + len && i < b.length; i++) {
      let c = b[i];
      if (c === 0) { syllableStart = true; continue; }
      if (c < 0x20 && c !== 13 && c !== 10) continue;
      if (c === 32 && !syllableStart) c = 95;
      if (c !== 32 && c !== 45 && c !== 13 && c !== 10) syllableStart = false;
      out.push(c);
    }
    return this.dec.decode(Uint8Array.from(out));
  }

  object() {
    const b = this.b;
    const t = this.u16(this.p);
    if (t >= M.KINDS.length) throw this.fail('알 수 없는 객체 형식 ' + t);
    const d = this.p + 2;
    const it = M.newItem(M.KINDS[t]);
    it.visible = (b[d] & 0x05) !== 0x05;
    it.pos = -this.s8(d + 1);
    const ver = this.ver;
    switch (it.kind) {
      case 'CLEF':
        it.clef = b[d + 1] & 7; it.clefOctave = b[d + 3] & 3; it.pos = 0;
        this.p = d + 5;
        break;
      case 'KEY':
        it.flats = b[d + 1] & 0x7f; it.sharps = b[d + 3] & 0x7f; it.pos = 0;
        this.p = d + (ver < 205 ? 11 : 13);
        break;
      case 'BAR':
        it.barStyle = b[d + 1] & 0x7f;
        // Version 2.00 numbers master repeats before local repeats.
        if (ver < 205 && it.barStyle >= 6 && it.barStyle <= 9) it.barStyle ^= 0x0e;
        it.sysBreak = (b[d + 1] & 0x80) !== 0;
        it.repeat = b[d + 2];
        it.pos = 0;
        this.p = d + 3;
        break;
      case 'ENDING':
        it.endings = b[d + 1];
        it.closedBracket = ver >= 205 && (b[d + 3] & 1) !== 0;
        it.pos = 0;
        this.p = d + (ver < 205 ? 3 : 6);
        break;
      case 'INSTRUMENT':
        it.patch = Math.max(0, this.u16(d + 7) - 1);
        this.p = d + 9;
        it.text = this.cstr();
        it.transpose = this.s8(this.p);
        this.p += 9;
        break;
      case 'TIMESIG':
        it.beats = this.u16(d + 1);
        it.beatValue = 1 << Math.min(6, this.u16(d + 3));
        it.sigStyle = b[d + 5] & 3;
        it.pos = 0;
        this.p = d + 7;
        break;
      case 'TEMPO':
        it.tempo = this.u16(d + 3);
        it.tempoBase = b[d + 5] & 7;
        this.p = d + 6;
        it.text = this.cstr();
        break;
      case 'DYNAMIC':
        it.dynamic = b[d + 3] & 7;
        if (b[d + 3] & 0x20) it.velocity = this.s16(d + 4);
        this.p = d + 8;
        break;
      case 'NOTE':
        this.note(it, d);
        break;
      case 'REST':
        this.timedFlags(it, d);
        it.restOffset = -this.s16(d + 7);
        this.p = d + 9;
        break;
      case 'CHORD': {
        this.note(it, d);
        it.heads = [];
        const n = this.u16(this.p);
        this.p += 2;
        for (let i = 0; i < n; i++) {
          const child = this.object();
          // Child notes of the chord's main duration may omit the dot flag.
          for (const h of child.heads) if (h.dur === it.dur && h.dots === 0) h.dots = it.dots;
          it.heads.push(...child.heads);
        }
        break;
      }
      case 'REST_CHORD': {
        this.timedFlags(it, d);
        it.restOffset = -this.s16(d + 7);
        this.p = d + 9;
        const n = this.u16(this.p);
        this.p += 2;
        for (let i = 0; i < n; i++) it.heads.push(...this.object().heads);
        break;
      }
      case 'PEDAL': case 'DYN_VAR': case 'PERFORMANCE':
        this.p = d + 4;
        break;
      case 'FLOW':
        it.flow = b[d + 3] & 0x0f;
        this.p = d + 5;
        break;
      case 'MPC':
        this.p = d + 35;
        break;
      case 'TEMPO_VAR':
        it.tvStyle = b[d + 3] & 0x0f;
        it.pause = it.tvStyle <= M.TV_FERMATA ? b[d + 4] : 0;
        this.p = d + 5;
        break;
      case 'TEXT':
        this.p = d + 4;
        it.text = this.cstr();
        break;
      case 'SPACER':
        this.p = d + 5;
        break;
      case 'BOUNDARY':
        it.boundaryStyle = b[d + 1] & 0x0f;
        this.p = d + (it.boundaryStyle === 5 ? 3 : 4);
        break;
      default:
        throw this.fail('지원하지 않는 객체 형식 ' + t);
    }
    return it;
  }

  timedFlags(it, d) {
    const b = this.b;
    it.dur = b[d + 1] & 7;
    const d3 = b[d + 3], d4 = b[d + 4], d5 = b[d + 5], d6 = b[d + 6];
    it.beam = d3 & 3;
    it.triplet = (d3 >> 2) & 3;
    it.stem = (d3 >> 4) & 3;
    it.lyricMode = d3 & 0x80 ? 1 : d4 & 1 ? 2 : 0;
    it.dots = d5 & 0x04 ? 1 : d5 & 0x01 ? 2 : 0;
    it.staccato = (d5 & 0x02) !== 0;
    it.accent = (d5 & 0x20) !== 0;
    it.slur = (d6 & 0x01) !== 0;
    it.tenuto = (d6 & 0x04) !== 0;
    it.grace = (d6 & 0x20) !== 0;
    it.pos = 0;
  }

  note(it, d) {
    const b = this.b;
    this.timedFlags(it, d);
    const acc = b[d + 8] & 7;
    it.heads.push(M.head(-this.s8(d + 7), acc > 5 ? M.ACC_NONE : acc, (b[d + 5] & 0x10) !== 0, it.dur, it.dots));
    this.p = d + 9 + (b[d + 8] & 0x40 ? 1 : 0);
  }
}
