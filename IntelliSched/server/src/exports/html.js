// The HTML writer (Phase 8 Part 2; since Part 9, decision 1): the export model's sheets (sheets.js)
// drawn as one self-contained HTML document, which pdf.js prints to PDF with a headless browser, and
// whose sheets Print Outputs can show. Every sheet is one fixed page; nothing here measures or wraps.
const fs = require('fs');
const { checkFonts, fontFaceCss } = require('./fonts');
const { placeCells, pageEdges, lineHeightMm, capOffsetMm } = require('./bands');

const esc = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- Phase 8 Part 9: the sheets
// A page with bands (sheets.js) is drawn exactly as its model says: every cell, line, border and
// picture absolutely placed in mm on a fixed sheet; the lines arrive already broken (white-space: pre,
// nothing wraps), Arial only, kerning off (Word does not kern by default). The same markup is the
// print view's page, so the screen, the PDF and the Word file agree.
const mmText = (n) => `${Math.round(n * 1000) / 1000}mm`;
const imageCache = new Map();
const imageSrc = (file) => {
  if (!imageCache.has(file)) {
    try { imageCache.set(file, `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`); } catch { imageCache.set(file, null); }
  }
  return imageCache.get(file);
};
const ARIAL = "'Arial', 'Arimo', sans-serif";

const runHtml = (r) => {
  const style = [r.bold ? 'font-weight:bold' : '', r.italic ? 'font-style:italic' : ''].filter(Boolean).join(';');
  if (r.super) return `<span class="sup"${style ? ` style="${style}"` : ''}>${esc(r.text)}</span>`;
  return style ? `<span style="${style}">${esc(r.text)}</span>` : esc(r.text);
};

const lineHtml = (runs, { left, width, top, pt, align, extra = '', cls = 'ln' }) => {
  const lh = lineHeightMm(pt);
  return `<div class="${cls}" style="left:${mmText(left)};width:${mmText(width)};top:${mmText(top)};height:${mmText(lh)};line-height:${mmText(lh)};font-size:${pt}pt;text-align:${align}${extra}">${runs.map(runHtml).join('')}</div>`;
};

// Phase 11.1: the page's borders as merged edges (bands.js pageEdges), each drawn once, centred on its
// line and running half a line past each end so corners close. They are one SVG in mm, not boxes: the
// browser snaps a box to whole screen pixels (a 0.5-pt rule printed as 0.75 pt, 1 px or 2 px wide by
// where it fell), and draws an SVG's shapes at their exact size.
// Phase 11.4 (decision 3): every rule is snapped to the 1/150-inch grid and is exactly one cell of it
// thick (0.169 mm, 0.48 pt: 1 px at 150 dpi, 2 at 300, 4 at 600). A 0.5-pt rule centred where the
// layout puts it fell, for the SF-029's 6.1-mm rows, on a pixel boundary at the "4:30 – 5:00" and the
// Total rows (the pitch drifts 0.024 px a row at 150 dpi): the renderer then greyed two pixels and the
// line printed twice as thick as its neighbours. On the grid, every line covers whole pixels at 150,
// 300, 600 and 1200 dpi; no line moves more than 0.085 mm.
const GRID_MM = 25.4 / 150;
const onGrid = (v) => Math.round(v / GRID_MM) * GRID_MM;
const n4 = (v) => Math.round(v * 10000) / 10000;
const edgesHtml = (placed, page) => {
  const half = GRID_MM / 2;
  const rects = pageEdges(placed).map(e => {
    const at = onGrid(e.at - half);
    const from = onGrid(e.from - half);
    const len = Math.max(GRID_MM, onGrid(e.to + half) - from);
    return e.dir === 'h'
      ? `<rect x="${n4(from)}" y="${n4(at)}" width="${n4(len)}" height="${n4(GRID_MM)}"/>`
      : `<rect x="${n4(at)}" y="${n4(from)}" width="${n4(GRID_MM)}" height="${n4(len)}"/>`;
  });
  if (!rects.length) return '';
  const w = page?.w ?? 210;
  const h = page?.h ?? 297;
  return `<svg class="bd" xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" aria-hidden="true">${rects.join('')}</svg>`;
};

// One sheet's markup (no <section> wrapper): exported for the print view's route.
const sheetInnerHtml = (sheet) => {
  const parts = [];
  const placed = placeCells(sheet);
  for (const c of placed) {
    if (!c.image) continue;
    const src = imageSrc(c.image.file);
    if (src) parts.push(`<img class="pic" alt="" src="${src}" style="left:${mmText(c.x)};top:${mmText(c.y)};width:${mmText(c.image.w)};height:${mmText(c.image.h)}"/>`);
  }
  parts.push(edgesHtml(placed, sheet.page));
  for (const c of placed) {
    for (const l of c.lines) parts.push(lineHtml(l.runs, { left: c.x, width: c.w, top: l.top, pt: l.pt, align: l.align }));
  }
  if (sheet.draft) {
    const d = sheet.draft;
    parts.push(lineHtml([{ text: d.text, bold: true }], { left: 0, width: sheet.page.w, top: d.capTop - capOffsetMm(d.pt), pt: d.pt, align: 'center', extra: ';color:#990000', cls: 'ln draft' }));
  }
  if (sheet.footer) {
    const f = sheet.footer;
    const top = f.capTop - capOffsetMm(f.pt);
    const W = 120;
    for (const item of f.items) {
      if (!item.text) continue;
      const left = item.align === 'left' ? item.x : item.align === 'center' ? item.x - W / 2 : item.x - W;
      parts.push(lineHtml([{ text: item.text }], { left, width: W, top, pt: f.pt, align: item.align, cls: 'ln foot' }));
    }
  }
  return parts.join('');
};

const SHEET_CSS = `
.sheet { position: relative; overflow: hidden; page-break-after: always; background: #fff; color: #000;
  font-family: ${ARIAL}; font-kerning: none; font-variant-ligatures: none; }
.sheet:last-child { page-break-after: auto; }
.sheet .ln { position: absolute; white-space: pre; overflow: visible; }
.sheet .sup { font-size: 0.65em; position: relative; top: -0.42em; line-height: 0; }
.sheet .bd { position: absolute; left: 0; top: 0; fill: #000; shape-rendering: geometricPrecision; pointer-events: none; }
.sheet .pic { position: absolute; }`;

const writeHtml = (model, { fonts = checkFonts() } = {}) => {
  const { page } = model.pages[0].sheet;
  const sheets = model.pages.map(p => `<section class="sheet" data-page-key="${esc(p.key)}" data-page-name="${esc(p.name)}" style="width:${page.w}mm;height:${page.h}mm">${sheetInnerHtml(p.sheet)}</section>`).join('\n');
  const title = `${model.view} — ${model.schedule.semesterLabel} AY ${model.schedule.academicYear}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
${fontFaceCss(fonts)}
@page { size: ${page.w}mm ${page.h}mm; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #fff; }
${SHEET_CSS}
</style></head>
<body>
${sheets}
</body></html>`;
};

module.exports = { writeHtml, sheetInnerHtml, SHEET_CSS };
