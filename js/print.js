// Printing and PDF export: lays the score out on A4 pages, renders each page to an image and
// either prints it through the browser or packs the pages into a PDF written here (no library,
// so it also works offline).
import { ScoreLayout } from './layout.js';
import { ScoreRenderer } from './render.js';

// A4 in CSS px (96 dpi) and in PDF points.
const PAGE_W = 794, PAGE_H = 1123, PT_W = 595.28, PT_H = 841.89;
const MARGIN = 45;           // ~12 mm
const RENDER_SCALE = 2.5;    // ~240 dpi page images
const FONT = '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

export const SIZES = { small: 6.2, normal: 7.4, large: 8.8 };

/** Splits the score into pages: [{systems, offsetY}] where offsetY maps layout y to page y. */
function paginate(layout) {
  const pages = [];
  const usable = PAGE_H - 2 * MARGIN - 18; // room for the page number
  let page = { systems: [], title: true, offset: 0 };
  for (const sys of layout.systems) {
    if (page.systems.length && sys.y + sys.height - page.offset > usable) {
      pages.push(page);
      page = { systems: [], title: false, offset: sys.y - 1.5 * layout.sp };
    }
    page.systems.push(sys);
  }
  pages.push(page);
  return pages;
}

/** Renders all pages to canvases. onProgress(done, total) is called after each page. */
export async function renderPages(song, shown, size, onProgress) {
  const sp = SIZES[size] || SIZES.normal;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${1.6 * sp}px ${FONT}`;
  const layout = new ScoreLayout(song, shown, sp, PAGE_W - 2 * MARGIN, t => measure.measureText(t).width);
  const renderer = new ScoreRenderer(layout);
  const pages = paginate(layout);
  const canvases = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const cv = document.createElement('canvas');
    cv.width = Math.round(PAGE_W * RENDER_SCALE);
    cv.height = Math.round(PAGE_H * RENDER_SCALE);
    const c = cv.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, MARGIN * RENDER_SCALE, (MARGIN - p.offset) * RENDER_SCALE);
    c.textBaseline = 'alphabetic';
    if (p.title) renderer.drawTitle(c);
    for (const sys of p.systems) renderer.drawSystem(c, sys, -1, -1, -1);
    if (pages.length > 1) {
      c.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
      c.fillStyle = '#555';
      c.font = `11px ${FONT}`;
      c.textAlign = 'center';
      c.fillText(`${i + 1} / ${pages.length}`, PAGE_W / 2, PAGE_H - MARGIN / 2);
    }
    canvases.push(cv);
    if (onProgress) onProgress(i + 1, pages.length);
    await new Promise(r => setTimeout(r, 0)); // keep the UI responsive
  }
  return canvases;
}

// ---- PDF ----------------------------------------------------------------------------------

const enc = new TextEncoder();

async function jpegBytes(canvas) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Builds a PDF with one full-page JPEG image per page. */
export async function buildPdf(canvases, title) {
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = data => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    length += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    for (const part of body) push(part);
    push('\nendobj\n');
  };
  // Title as a UTF-16BE hex string so Korean titles survive.
  const hexTitle = '<FEFF' + [...title].map(ch => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>';

  push('%PDF-1.4\n%âãÏÓ\n');
  const n = canvases.length;
  // Objects: 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${4 + i * 3} 0 R`);
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`]);
  obj(3, [`<< /Title ${hexTitle} /Producer (NWC Score Web) >>`]);
  for (let i = 0; i < n; i++) {
    const pageN = 4 + i * 3, contentN = pageN + 1, imageN = pageN + 2;
    const jpg = await jpegBytes(canvases[i]);
    const content = `q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im0 Do Q`;
    obj(pageN, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>`]);
    obj(contentN, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(imageN, [
      `<< /Type /XObject /Subtype /Image /Width ${canvases[i].width} /Height ${canvases[i].height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`,
      jpg,
      '\nendstream',
    ]);
  }
  const xref = length;
  const count = 4 + n * 3;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/** Shares the PDF (iPad/iPhone share sheet: Save to Files, KakaoTalk ...) or downloads it. */
export async function savePdf(blob, fileName) {
  const file = new File([blob], fileName, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

/** Prints the pages through the browser's print dialog. */
export async function printPages(canvases) {
  const area = document.getElementById('print-area');
  area.replaceChildren();
  for (const cv of canvases) {
    const img = new Image();
    img.src = cv.toDataURL('image/jpeg', 0.9);
    img.alt = '';
    area.append(img);
  }
  await Promise.all([...area.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
  window.print();
}
