// The forms' page model (Phase 8 Part 9, decision 1): every page is a stack of BANDS, each of fixed
// height and measured from the top edge of the paper; a band is a row of CELLS of fixed width with
// their own borders; a cell holds its LINES already broken, each with its runs (text, bold, italic,
// superscript), its size and its alignment. The PDF (HTML) writer and the DOCX writer draw only from
// this: neither measures, wraps or moves anything by itself.
//
// The line breaks are decided ONCE, here, with the advance widths of the bundled Arimo (Arial's metric
// twin; arialWidths.json, made by scripts/forms/build-widths.js), kerning off. The fit rule: a cell's
// lines must fit its box with room to spare (0.5 mm of height, 3 % of width); if they don't, the size
// goes down in 0.5-pt steps to 6 pt; if they still don't, the title is shortened with "…" (the caller
// reports every shortened title). A band never grows.
const WIDTHS = require('./arialWidths.json');
const { MM_PER_PT, LINE_EM, CAP_TOP_EM, CELL_PAD_MM, FIT } = require('./layouts');

const round = (n, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

// ---------------------------------------------------------------- measuring
const FALLBACK = WIDTHS.regular[110];   // an unknown character measures as an "n"
const charWidth = (code, bold) => (bold ? WIDTHS.bold : WIDTHS.regular)[code] ?? FALLBACK;
const SUPER_SCALE = 0.65;               // a superscript run, in the HTML and as Word draws it (≈ 2/3)

// The width in mm of one run of text at a size in points.
const textWidthMm = (text, pt, { bold = false } = {}) => {
  let units = 0;
  for (const ch of String(text ?? '')) units += charWidth(ch.codePointAt(0), bold);
  return (units / 1000) * pt * MM_PER_PT;
};
const runsWidthMm = (runs, pt) => runs.reduce((sum, r) => sum + textWidthMm(r.text, r.super ? pt * SUPER_SCALE : pt, r), 0);

const lineHeightMm = (pt) => pt * LINE_EM * MM_PER_PT;
const capOffsetMm = (pt) => pt * CAP_TOP_EM * MM_PER_PT;

// ---------------------------------------------------------------- line breaks
// Breaks one text into lines no wider than maxMm, at spaces only, never inside a word. A word wider
// than the line stays whole on its own line (the fit rule then sees it overflow).
const breakText = (text, maxMm, pt, { bold = false } = {}) => {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (textWidthMm(candidate, pt, { bold }) <= maxMm) current = candidate;
    else { lines.push(current); current = word; }
  }
  lines.push(current);
  return lines;
};

// ---------------------------------------------------------------- the fit rule
// items: [{ text, bold?, italic?, align?, wrap? (default true), shorten? (the title: may end in "…"),
//           runs? (one fixed line of runs, never wrapped) }]
// box: { w, h } in mm (the cell's outer size; the padding comes off here). pt: the starting size.
// Returns { pt, lines: [{ runs, pt, align }], fits, shortened: null | { from, to } }.
const layoutAt = (items, pt, maxW) => {
  const lines = [];
  for (const item of items) {
    const align = item.align || 'center';
    if (item.runs) { lines.push({ runs: item.runs, pt, align }); continue; }
    const parts = item.wrap === false ? [String(item.text ?? '')] : breakText(item.text, maxW, pt, item);
    for (const text of parts) lines.push({ runs: [{ text, bold: Boolean(item.bold), italic: Boolean(item.italic) }], pt, align });
  }
  return lines;
};

const fitsBox = (lines, pt, maxW, maxH) => lines.length * lineHeightMm(pt) <= maxH + 1e-9
  && lines.every(l => runsWidthMm(l.runs, pt) <= maxW + 1e-9);

const fitLines = (items, box, pt, { minPt = FIT.minPt, pad = CELL_PAD_MM } = {}) => {
  const maxW = (box.w - 2 * pad) * (1 - FIT.spareWidthFrac);
  const maxH = box.h - 2 * pad - FIT.spareHeightMm;
  for (let size = pt; size >= minPt - 1e-9; size = round(size - FIT.stepPt, 2)) {
    const lines = layoutAt(items, size, maxW);
    if (fitsBox(lines, size, maxW, maxH)) return { pt: size, lines, fits: true, shortened: null };
  }
  // The last resort: shorten the title, word by word, ending in "…", at the smallest size.
  const at = items.findIndex(i => i.shorten);
  if (at >= 0) {
    const words = String(items[at].text ?? '').split(/\s+/).filter(Boolean);
    for (let keep = words.length - 1; keep >= 0; keep -= 1) {
      const text = keep > 0 ? `${words.slice(0, keep).join(' ')}…` : '…';
      const tried = items.map((item, i) => (i === at ? { ...item, text } : item));
      const lines = layoutAt(tried, minPt, maxW);
      if (fitsBox(lines, minPt, maxW, maxH)) return { pt: minPt, lines, fits: true, shortened: { from: items[at].text, to: text } };
    }
  }
  return { pt: minPt, lines: layoutAt(items, minPt, maxW), fits: false, shortened: null };
};

// ---------------------------------------------------------------- bands and cells
const NO_BORDERS = { top: false, right: false, bottom: false, left: false };
const ALL_BORDERS = { top: true, right: true, bottom: true, left: true };

// A cell. h (default: the band's height) lets a grid cell span the rows of the bands below it.
const cell = ({ x, w, h = null, lines = [], borders = NO_BORDERS, valign = 'top', image = null }) => ({
  x: round(x), w: round(w), h: h === null ? null : round(h), lines, borders, valign, image
});

const band = (y, h, cells) => ({ y: round(y), h: round(h), cells });

// One line of text whose CAPITALS' top sits at capTop: the band's top is the line box's top less the
// padding. x is where the text starts (align left), its centre (center) or where it ends (right).
const textBand = ({ capTop, pt, x, align = 'left', runs, width = null }) => {
  const lh = lineHeightMm(pt);
  const w = width ?? runsWidthMm(runs, pt) / (1 - FIT.spareWidthFrac) + 2 * CELL_PAD_MM + 0.2;
  const left = align === 'left' ? x - CELL_PAD_MM : align === 'center' ? x - w / 2 : x + CELL_PAD_MM - w;
  return band(capTop - capOffsetMm(pt) - CELL_PAD_MM, lh + 2 * CELL_PAD_MM,
    [cell({ x: left, w, lines: [{ runs, pt, align }] })]);
};

// Two boxes of one page may never overlap (the DOCX is one table per page). The office's lines can sit
// closer than Arial's line box (the SF-029's area lines are 3.2 mm apart at 8 pt, a 3.24-mm box), so a
// box that reaches into the one below it ends where that one starts: only the empty foot of the line
// box (or the descenders of a name in capitals) goes. Returns the bands with those cells' heights set.
const settleBands = (bands) => {
  const boxes = bands.flatMap(b => b.cells.map(c => ({ c, x: c.x, y: b.y, w: c.w, h: c.h ?? b.h })));
  for (const a of boxes) {
    for (const b of boxes) {
      // 0.01 mm of slack: the grid's columns and rows are sums of rounded numbers.
      if (a === b || b.y <= a.y + 0.01) continue;
      const xOverlap = a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01;
      if (xOverlap && b.y < a.y + a.h - 0.01) a.h = round(b.y - a.y);
    }
    if (a.h !== (a.c.h ?? null)) a.c.h = a.h;
  }
  return bands;
};

// Every cell of a page with its absolute box (x, y, w, h) and each line's box top, the way both writers
// place them: valign top starts under the padding; center splits what is left equally.
const placeCells = (page) => page.bands.flatMap(b => b.cells.map(c => {
  const h = c.h ?? b.h;
  const heights = c.lines.map(l => lineHeightMm(l.pt));
  const used = heights.reduce((a, v) => a + v, 0);
  let top = c.valign === 'center' ? b.y + (h - used) / 2 : b.y + CELL_PAD_MM;
  const lines = c.lines.map((l, i) => {
    const placed = { ...l, top: round(top), capTop: round(top + capOffsetMm(l.pt)) };
    top += heights[i];
    return placed;
  });
  return { x: c.x, y: b.y, w: c.w, h: round(h), borders: c.borders, image: c.image, valign: c.valign, lines };
}));

// Phase 11.1: every grid line drawn ONCE. Two neighbouring cells both carry the edge they share; drawn
// by both, an edge doubles (and a hair's offset between the two makes it look thicker). The edges are
// snapped to 0.01 mm and merged into straight lines here (the HTML writer); the DOCX writer gives each
// grid stretch to one table cell (docxWriter.js).
const SNAP_MM = 0.01;
const snap = (v) => Math.round(v / SNAP_MM) * SNAP_MM;
const sidesOf = (c) => ({
  top: { dir: 'h', at: snap(c.y), from: snap(c.x), to: snap(c.x + c.w) },
  bottom: { dir: 'h', at: snap(c.y + c.h), from: snap(c.x), to: snap(c.x + c.w) },
  left: { dir: 'v', at: snap(c.x), from: snap(c.y), to: snap(c.y + c.h) },
  right: { dir: 'v', at: snap(c.x + c.w), from: snap(c.y), to: snap(c.y + c.h) }
});
const segKey = (s) => `${s.dir}:${s.at.toFixed(2)}`;
// Every border of a page as one merged segment per straight stretch: the lines the HTML writer draws,
// each exactly once and never interrupted where an empty cell meets a merged box.
const pageEdges = (placed) => {
  const byKey = new Map();
  for (const c of placed) {
    const sides = sidesOf(c);
    for (const side of ['top', 'left', 'bottom', 'right']) {
      if (!c.borders?.[side]) continue;
      const s = sides[side];
      if (s.to - s.from < SNAP_MM / 2) continue;
      const key = segKey(s);
      if (!byKey.has(key)) byKey.set(key, { dir: s.dir, at: s.at, spans: [] });
      byKey.get(key).spans.push([s.from, s.to]);
    }
  }
  const edges = [];
  for (const { dir, at, spans } of byKey.values()) {
    spans.sort((p, q) => p[0] - q[0]);
    let [a, b] = spans[0];
    for (const [p, q] of spans.slice(1)) {
      if (p <= b + SNAP_MM / 2) { b = Math.max(b, q); continue; }
      edges.push({ dir, at: round(at, 2), from: round(a, 2), to: round(b, 2) });
      [a, b] = [p, q];
    }
    edges.push({ dir, at: round(at, 2), from: round(a, 2), to: round(b, 2) });
  }
  return edges;
};

// The text of every line of a page with its cap top and box, for the tests and the measurements.
const linesOf = (page) => placeCells(page).flatMap(c => c.lines.map(l => ({
  text: l.runs.map(r => r.text).join(''),
  capTop: l.capTop,
  align: l.align,
  left: round(c.x + CELL_PAD_MM),
  right: round(c.x + c.w - CELL_PAD_MM),
  centre: round(c.x + c.w / 2),
  pt: l.pt,
  bold: l.runs.some(r => r.bold)
})));

module.exports = {
  textWidthMm,
  runsWidthMm,
  lineHeightMm,
  capOffsetMm,
  breakText,
  fitLines,
  cell,
  band,
  textBand,
  settleBands,
  placeCells,
  pageEdges,
  linesOf,
  NO_BORDERS,
  ALL_BORDERS,
  SUPER_SCALE
};
