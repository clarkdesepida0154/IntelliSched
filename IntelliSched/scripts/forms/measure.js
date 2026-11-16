// Measures a rendered form page the way the scans were measured (Phase 8 Part 9, decision 7): the
// grid's horizontal lines, and the top of each text line found within an x range. Positions in mm
// from the page's top-left corner; the page's size in mm comes from the caller (A4: 210 × 297).
//   node scripts/forms/measure.js <page.png> <pageWidthMm> [x0 x1]   -> a dump of lines and text bands
const { readPng } = require('./png');

const DARK = 140;

const fs = require('fs');
const path = require('path');

// A page rendered by pdf-to-png.ps1: its width in mm from the folder's pages.json (the PNG's pixels
// follow the display scaling, so only the page's own size says how many pixels make a mm), or given.
const openPage = (file, pageWidthMm = null) => {
  const img = readPng(file);
  let widthMm = pageWidthMm;
  if (!widthMm) {
    const sizes = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'pages.json'), 'utf8'));
    widthMm = sizes.find(s => s.file === path.basename(file)).widthMm;
  }
  return { ...img, pxPerMm: img.width / widthMm };
};

const px = (page, mm) => Math.round(mm * page.pxPerMm);
const mm = (page, p) => Math.round((p / page.pxPerMm) * 100) / 100;

const darkInRow = (page, y, x0, x1) => {
  let n = 0;
  const row = y * page.width;
  for (let x = Math.max(0, x0); x < Math.min(page.width, x1); x++) if (page.grey[row + x] < DARK) n += 1;
  return n;
};

// Horizontal rules within [x0, x1] mm: rows with at least `frac` of the range dark, consecutive rows
// grouped; each line's top in mm.
const hLines = (page, x0mm, x1mm, { frac = 0.6, y0mm = 0, y1mm = Infinity } = {}) => {
  const x0 = px(page, x0mm); const x1 = px(page, x1mm);
  const need = (x1 - x0) * frac;
  const lines = [];
  let open = null;
  const yEnd = Math.min(page.height, px(page, y1mm));
  for (let y = Math.max(0, px(page, y0mm)); y < yEnd; y++) {
    if (darkInRow(page, y, x0, x1) >= need) {
      if (open && y === open.last + 1) open.last = y;
      else { open = { first: y, last: y }; lines.push(open); }
    }
  }
  return lines.map(l => ({ top: mm(page, l.first), thick: mm(page, l.last - l.first + 1) }));
};

// Text bands within [x0, x1] mm between y0 and y1: runs of rows with ink (gaps up to `gapMm` join),
// each band's top and bottom in mm. Rows that are mostly a rule are skipped.
const textBands = (page, x0mm, x1mm, y0mm, y1mm, { gapMm = 0.25, ruleFrac = 0.6 } = {}) => {
  const x0 = px(page, x0mm); const x1 = px(page, x1mm);
  const gap = Math.max(1, px(page, gapMm));
  const bands = [];
  let open = null;
  for (let y = Math.max(0, px(page, y0mm)); y < Math.min(page.height, px(page, y1mm)); y++) {
    const n = darkInRow(page, y, x0, x1);
    const ink = n >= 2 && n < (x1 - x0) * ruleFrac;
    if (!ink) continue;
    if (open && y - open.last <= gap) open.last = y;
    else { open = { first: y, last: y }; bands.push(open); }
  }
  return bands.map(b => ({ top: mm(page, b.first), bottom: mm(page, b.last + 1) }));
};

// The first ink row at or after y0 within [x0, x1]: the top of the line that starts there.
const textTop = (page, x0mm, x1mm, y0mm, y1mm) => {
  const band = textBands(page, x0mm, x1mm, y0mm, y1mm)[0];
  return band ? band.top : null;
};

// The leftmost and rightmost ink columns within a y band: a line's x extent.
const inkExtent = (page, x0mm, x1mm, y0mm, y1mm) => {
  let left = null; let right = null;
  const y0 = px(page, y0mm); const y1 = px(page, y1mm);
  for (let x = px(page, x0mm); x < px(page, x1mm); x++) {
    let n = 0;
    for (let y = y0; y < y1; y++) if (page.grey[y * page.width + x] < DARK) n += 1;
    if (n > 0 && n < (y1 - y0) * 0.9) { if (left === null) left = x; right = x; }
  }
  return left === null ? null : { left: mm(page, left), right: mm(page, right + 1) };
};

module.exports = { openPage, hLines, textBands, textTop, inkExtent };

if (require.main === module) {
  const [file, widthMm, x0 = '10', x1 = '200'] = process.argv.slice(2);
  const page = openPage(file, Number(widthMm));
  console.log(JSON.stringify({ size: [page.width, page.height], pxPerMm: page.pxPerMm }));
  console.log('lines', JSON.stringify(hLines(page, Number(x0), Number(x1), { frac: 0.5 })));
  console.log('bands', JSON.stringify(textBands(page, Number(x0), Number(x1), 0, 400)));
}
