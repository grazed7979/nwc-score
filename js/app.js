// App shell: score library (IndexedDB), viewer with scrolling canvas, playback controls and parts dialog.
import { readNwc } from './nwc.js';
import { buildPerformance, playOrder } from './perform.js';
import { ScoreLayout } from './layout.js';
import { ScoreRenderer } from './render.js';
import { Player } from './audio.js';
import { displayName } from './model.js';
import { renderPages, buildPdf, savePdf, printPages } from './print.js';

const $ = id => document.getElementById(id);

// ---- Library storage ------------------------------------------------------------------

const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('nwc-scores', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('scores', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(mode, fn) {
  const d = await db;
  return new Promise((resolve, reject) => {
    const tx = d.transaction('scores', mode);
    const r = fn(tx.objectStore('scores'));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}

const listScores = async () => (await store('readonly', s => s.getAll())).sort((a, b) => b.opened - a.opened);
const putScore = rec => store('readwrite', s => s.put(rec));
const deleteScore = id => store('readwrite', s => s.delete(id));

// ---- Home -------------------------------------------------------------------------------

async function refreshLibrary() {
  const items = await listScores();
  const ul = $('library');
  ul.replaceChildren();
  for (const rec of items) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'open';
    const b = document.createElement('b');
    b.textContent = rec.title || rec.name;
    const span = document.createElement('span');
    span.textContent = rec.title && rec.title !== rec.name ? rec.name : new Date(rec.added).toLocaleDateString('ko-KR');
    open.append(b, span);
    open.onclick = () => openScore(rec);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '삭제';
    del.onclick = async () => {
      if (!confirm(`'${rec.title || rec.name}'을(를) 목록에서 삭제할까요?`)) return;
      await deleteScore(rec.id);
      refreshLibrary();
    };
    li.append(open, del);
    ul.append(li);
  }
  $('empty').hidden = items.length > 0;
}

async function importFiles(files) {
  let last = null;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const song = await readNwc(bytes);
      last = { id: file.name + ':' + file.size, name: file.name, title: song.title, bytes, added: Date.now(), opened: Date.now() };
      await putScore(last);
    } catch (e) {
      alert(`'${file.name}'을(를) 열 수 없습니다.\n${e.message}`);
    }
  }
  await refreshLibrary();
  if (last && files.length === 1) openScore(last);
}

$('file-input').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter(f => /\.nwc(txt)?$/i.test(f.name));
  if (files.length) importFiles(files);
});

// ---- Viewer -------------------------------------------------------------------------------

const player = new Player();
const canvas = $('canvas'), scroller = $('scroller'), sizer = $('sizer');
let song = null, perf = null, order = null, layout = null, renderer = null;
let shown = [], audible = [], gain = [], focus = -1, quietOthers = false;
let zoom = parseFloat(localStorage.getItem('zoom') || '1') || 1;
let startStep = 0, markMeasure = -1, playMeasure = -1, playTick = 0, lastUserScroll = 0, raf = 0;
let fontReady = null;

function loadFont() {
  if (!fontReady) {
    const face = new FontFace('Bravura', 'url(fonts/Bravura.otf)');
    fontReady = face.load().then(f => document.fonts.add(f));
  }
  return fontReady;
}

async function openScore(rec) {
  $('home').hidden = true;
  $('viewer').hidden = false;
  $('score-title').textContent = rec.title || rec.name;
  currentName = rec.name;
  $('loading').hidden = false;
  history.pushState({ view: 'score' }, '');
  rec.opened = Date.now();
  putScore(rec);
  try {
    await loadFont();
    song = await readNwc(rec.bytes);
  } catch (e) {
    alert('열 수 없는 파일입니다.\n' + e.message);
    closeViewer();
    return;
  }
  perf = buildPerformance(song);
  order = playOrder(song);
  player.load(song, perf);
  const n = song.staves.length;
  shown = song.staves.map(st => st.visible);
  audible = song.staves.map(st => !st.muted);
  gain = new Array(n).fill(1);
  focus = -1;
  startStep = 0;
  markMeasure = playMeasure = -1;
  $('loading').hidden = true;
  scroller.scrollTop = 0;
  relayout();
  setStatus(`${song.sourceFormat} · 보표 ${n}개 · 마디를 누르면 그 위치부터 재생`);
}

function closeViewer() {
  stopPlayback();
  song = perf = layout = renderer = null;
  $('viewer').hidden = true;
  $('home').hidden = false;
  refreshLibrary();
}

$('back').onclick = () => history.back();
window.addEventListener('popstate', () => { if (!$('viewer').hidden) closeViewer(); });

function setStatus(s) { $('status').textContent = s; }

function relayout() {
  if (!song) return;
  const w = scroller.clientWidth;
  const sp = Math.max(6.5, w / 78) * zoom;
  const ctx = canvas.getContext('2d');
  ctx.font = `${1.6 * sp}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
  const anchor = layout ? scroller.scrollTop / Math.max(1, layout.totalHeight) : 0;
  layout = new ScoreLayout(song, shown, sp, w, t => ctx.measureText(t).width);
  renderer = new ScoreRenderer(layout);
  renderer.focusStaff = focus;
  sizer.style.height = layout.totalHeight + 'px';
  scroller.scrollTop = anchor * layout.totalHeight;
  draw();
}

function draw() {
  if (!layout) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const c = canvas.getContext('2d');
  const top = scroller.scrollTop;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#fff';
  c.fillRect(0, 0, w, h);
  c.setTransform(dpr, 0, 0, dpr, 0, -top * dpr);
  c.textBaseline = 'alphabetic';
  if (top < layout.titleHeight) renderer.drawTitle(c);
  for (const sys of layout.systems) {
    if (sys.y + sys.height < top || sys.y > top + h) continue;
    let px = -1;
    for (const mb of sys.measures) if (mb.index === playMeasure) px = layout.xAt(mb, playTick);
    renderer.drawSystem(c, sys, playMeasure, px, playMeasure < 0 ? markMeasure : -1);
  }
}

scroller.addEventListener('scroll', () => { requestAnimationFrame(draw); }, { passive: true });
scroller.addEventListener('touchmove', () => { lastUserScroll = Date.now(); }, { passive: true });
scroller.addEventListener('wheel', () => { lastUserScroll = Date.now(); }, { passive: true });
new ResizeObserver(() => { if (song) relayout(); }).observe(scroller);

$('zoom-in').onclick = () => setZoom(zoom * 1.15);
$('zoom-out').onclick = () => setZoom(zoom / 1.15);
function setZoom(z) {
  zoom = Math.max(0.5, Math.min(2.5, z));
  localStorage.setItem('zoom', String(zoom));
  relayout();
}

// Tap on a measure: play from there.
scroller.addEventListener('click', e => {
  if (!layout) return;
  const rect = scroller.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top + scroller.scrollTop;
  let m = -1;
  for (const sys of layout.systems) {
    if (y < sys.y || y > sys.y + sys.height) continue;
    for (const mb of sys.measures) if (x >= mb.x && x <= mb.x + mb.width) m = mb.index;
  }
  if (m < 0) return;
  const from = player.playing ? currentStep() : 0;
  let target = -1;
  for (let i = from; i < order.length && target < 0; i++) if (order[i][0] === m) target = i;
  for (let i = 0; i < order.length && target < 0; i++) if (order[i][0] === m) target = i;
  if (target < 0) return;
  startStep = target;
  if (player.playing) startPlayback(target);
  else {
    markMeasure = m;
    draw();
    setStatus(`${m + 1}마디부터 재생합니다 · ▶를 누르세요`);
  }
});

// ---- Playback -------------------------------------------------------------------------------

function mix() {
  const g = gain.map((v, i) => (focus >= 0 && quietOthers && i !== focus ? v * 0.35 : v));
  return { audible, gain: g };
}

function stepAt(tick) {
  const steps = perf.steps;
  let lo = 0, hi = steps.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].tick <= tick) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function currentStep() {
  const t = player.position();
  return t < 0 ? startStep : stepAt(t);
}

function startPlayback(step) {
  player.tempoFactor = $('tempo').value / 100;
  player.play(step, mix());
  markMeasure = -1;
  $('play').textContent = '❚❚';
  $('play').setAttribute('aria-label', '일시정지');
  setStatus(`재생 중 · 빠르기 ${$('tempo').value}%`);
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(follow);
}

function stopPlayback(keepPosition = false) {
  if (keepPosition && player.playing) startStep = currentStep();
  player.stop();
  cancelAnimationFrame(raf);
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', '재생');
  if (!keepPosition) { playMeasure = -1; draw(); }
  if (song) setStatus('정지 · 마디를 누르면 그 위치부터 재생');
}

player.onEnd = () => { startStep = 0; stopPlayback(); };

function follow() {
  if (!player.playing) return;
  const t = player.position();
  if (t >= 0) {
    const st = perf.steps[stepAt(t)];
    const changed = st.measure !== playMeasure;
    playMeasure = st.measure;
    playTick = st.from + (t - st.tick);
    if (changed && Date.now() - lastUserScroll > 2500) ensureVisible(st.measure);
    draw();
  }
  raf = requestAnimationFrame(follow);
}

function ensureVisible(m) {
  const si = layout.systemOf(m);
  if (si < 0) return;
  const sys = layout.systems[si];
  const top = scroller.scrollTop, h = scroller.clientHeight;
  if (sys.y < top || sys.y + sys.height > top + h) scroller.scrollTo({ top: Math.max(0, sys.y - h * 0.12), behavior: 'smooth' });
}

$('play').onclick = () => {
  if (!song) return;
  if (player.playing) stopPlayback(true);
  else startPlayback(startStep);
};
$('rewind').onclick = () => {
  stopPlayback();
  startStep = 0;
  markMeasure = -1;
  scroller.scrollTo({ top: 0 });
  draw();
};
$('tempo').addEventListener('input', () => { $('tempo-label').textContent = $('tempo').value + '%'; });
$('tempo').addEventListener('change', () => { if (player.playing) startPlayback(currentStep()); });

// Keyboard: space toggles playback (useful with a keyboard on iPad or PC).
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !$('viewer').hidden && !$('parts').open) { e.preventDefault(); $('play').click(); }
});

document.addEventListener('visibilitychange', () => { if (document.hidden && player.playing) stopPlayback(true); });

// ---- Parts dialog -------------------------------------------------------------------------

$('parts-btn').onclick = () => {
  if (!song) return;
  const sel = $('focus');
  sel.replaceChildren(new Option('선택 안 함', '-1'));
  song.staves.forEach((st, i) => sel.append(new Option(displayName(st) || `(이름 없음 ${i + 1})`, String(i))));
  sel.value = String(focus);
  $('quiet').checked = quietOthers;
  const rows = $('part-rows');
  rows.replaceChildren();
  const showBoxes = [], soundBoxes = [];
  const updateToggles = () => {
    $('toggle-show').textContent = shown.every(Boolean) ? '보기 전체 해제' : '보기 전체 선택';
    $('toggle-sound').textContent = audible.every(Boolean) ? '소리 전체 해제' : '소리 전체 선택';
  };
  $('toggle-show').onclick = () => {
    // Turning everything off keeps the first part so the page never goes blank.
    const on = !shown.every(Boolean);
    shown = shown.map((_, i) => on || i === 0);
    showBoxes.forEach((b, i) => { b.checked = shown[i]; });
    updateToggles();
    relayout();
  };
  $('toggle-sound').onclick = () => {
    const on = !audible.every(Boolean);
    audible = audible.map(() => on);
    soundBoxes.forEach((b, i) => { b.checked = audible[i]; });
    updateToggles();
    player.applyMix(mix());
  };
  song.staves.forEach((st, i) => {
    const div = document.createElement('div');
    div.className = 'part';
    div.innerHTML = `<div class="part-name"></div><div class="part-row">
      <label><input type="checkbox" data-k="show"> 보기</label>
      <label><input type="checkbox" data-k="sound"> 소리</label>
      <input type="range" min="0" max="100" step="5" aria-label="볼륨"></div>`;
    div.querySelector('.part-name').textContent = displayName(st) || `(이름 없음 ${i + 1})`;
    const [show, sound] = div.querySelectorAll('input[type=checkbox]');
    const vol = div.querySelector('input[type=range]');
    show.checked = shown[i];
    sound.checked = audible[i];
    showBoxes.push(show);
    soundBoxes.push(sound);
    vol.value = Math.round(gain[i] * 100);
    show.onchange = () => {
      if (!show.checked && shown.filter(Boolean).length === 1) { show.checked = true; return; }
      shown[i] = show.checked;
      updateToggles();
      relayout();
    };
    sound.onchange = () => { audible[i] = sound.checked; updateToggles(); player.applyMix(mix()); };
    vol.oninput = () => { gain[i] = vol.value / 100; player.applyMix(mix()); };
    rows.append(div);
  });
  updateToggles();
  $('parts').showModal();
};
$('focus').onchange = () => {
  focus = parseInt($('focus').value, 10);
  if (renderer) renderer.focusStaff = focus;
  player.applyMix(mix());
  draw();
};
$('quiet').onchange = () => { quietOthers = $('quiet').checked; player.applyMix(mix()); };

// ---- Print / PDF ----------------------------------------------------------------------------

let currentName = '';
$('print-btn').onclick = () => {
  if (!song) return;
  $('print-status').textContent = '';
  $('print-dialog').showModal();
};

async function makePages() {
  const buttons = ['do-print', 'do-pdf'].map($);
  buttons.forEach(b => { b.disabled = true; });
  try {
    await loadFont();
    return await renderPages(song, shown, $('print-size').value, (done, total) => {
      $('print-status').textContent = `페이지 만드는 중… ${done} / ${total}`;
    });
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

$('do-print').onclick = async () => {
  if (player.playing) stopPlayback(true);
  const pages = await makePages();
  $('print-status').textContent = `${pages.length}쪽 · 인쇄 창을 여는 중…`;
  $('print-dialog').close();
  await printPages(pages);
};

$('do-pdf').onclick = async () => {
  const pages = await makePages();
  $('print-status').textContent = `${pages.length}쪽 · PDF 만드는 중…`;
  const title = song.title || currentName.replace(/\.nwc(txt)?$/i, '') || '악보';
  const pdf = await buildPdf(pages, title);
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').trim() || '악보';
  const result = await savePdf(pdf, safe + '.pdf');
  $('print-status').textContent = result === 'cancelled' ? 'PDF 저장을 취소했습니다.'
    : result === 'shared' ? `PDF(${pages.length}쪽)를 공유했습니다.`
    : `PDF(${pages.length}쪽)를 저장했습니다: ${safe}.pdf`;
};

// ---- Offline support ------------------------------------------------------------------------

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
$('install-hint').hidden = standalone || !/iPad|iPhone|Macintosh/.test(navigator.userAgent);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const ready = () => { $('offline-status').textContent = '✓ 오프라인 사용 준비 완료 — 인터넷 없이도 열립니다.'; };
    if (reg.active) ready();
    navigator.serviceWorker.ready.then(ready);
  }).catch(() => { $('offline-status').textContent = '오프라인 저장을 사용할 수 없는 환경입니다.'; });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

refreshLibrary();
