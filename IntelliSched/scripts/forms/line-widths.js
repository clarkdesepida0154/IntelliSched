// Phase 11.1: the thickness of every grid line on a rendered form page. Every line of the timetable
// grids is one rule of the same width. Phase 11.4 (decision 3) made the check strict: the system's PDF
// must show every grid line of a page at the SAME pixel width (max - min = 0 px) at 600 dpi and at
// 150 dpi (the samples' PNG size); Word's own rendering of the DOCX within 1 px at 600 dpi.
//   node scripts/forms/line-widths.js <file.pdf|file.docx> [...] [--dpi 600|150,600] [--page 1] [--out <json>]
// Without --dpi a PDF is measured at 600 and 150 dpi, a DOCX (through Word) at 600.
// A DOCX goes through Word's own PDF export (word-to-pdf.ps1) first; every PDF is rendered with
// Windows' own PDF engine (pdf-to-png.ps1). Prints one line per page: min and max in px, ✔ or ✖.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { openPage } = require('./measure');

const DARK = 140;
const H_MIN_MM = 8;     // a horizontal rule is a dark run of 8 mm or more (longer than any "___" of text)
const V_MIN_MM = 3.5;   // a vertical rule: 3.5 mm or more (taller than any capital of the forms)
const TOLERANCE_PX = { PDF: 0, Word: 1 };

// Runs of dark pixels along one row (or column) at least `min` long: [[from, to], ...] (to exclusive).
const runsOf = (len, isDark, min) => {
  const out = [];
  let start = -1;
  for (let i = 0; i <= len; i++) {
    const dark = i < len && isDark(i);
    if (dark && start < 0) start = i;
    if (!dark && start >= 0) { if (i - start >= min) out.push([start, i]); start = -1; }
  }
  return out;
};

// Groups the runs of consecutive rows (columns) that overlap into lines; a line's thickness is the
// number of rows (columns) it spans. Returns [{ at, thickness, from, to }] in px.
const groupRuns = (perIndex) => {
  const lines = [];
  let open = [];
  perIndex.forEach((runs, i) => {
    const next = [];
    for (const [a, b] of runs) {
      const hit = open.find(l => l.last === i - 1 && a < l.to && l.from < b);
      if (hit) { hit.last = i; hit.from = Math.min(hit.from, a); hit.to = Math.max(hit.to, b); next.push(hit); open = open.filter(l => l !== hit); } else {
        const line = { first: i, last: i, from: a, to: b };
        lines.push(line);
        next.push(line);
      }
    }
    open = next;
  });
  return lines.map(l => ({ at: l.first, thickness: l.last - l.first + 1, from: l.from, to: l.to }));
};

// page: { width, height, grey, pxPerMm } (measure.js openPage, or made up by a test).
// box (mm, optional): only the lines inside it count. Only the grid counts: the lines between the
// page's first and last long rule (frameMm, 100 mm or more: the grid's frame), so the letterhead (a
// picture) and the "____" of a blank signatory (text) are left out. Returns the lines and the verdict.
const FRAME_MM = 100;
const measureLineWidths = (page, { box = null, frameMm = FRAME_MM, tolerancePx = TOLERANCE_PX.PDF } = {}) => {
  const { width, height, grey, pxPerMm } = page;
  const dark = (x, y) => grey[y * width + x] < DARK;
  const [x0, y0, x1, y1] = box ? box.map(v => Math.round(v * pxPerMm)) : [0, 0, width, height];
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(y < y0 || y >= y1 ? [] : runsOf(x1 - x0, i => dark(x0 + i, y), Math.round(H_MIN_MM * pxPerMm)).map(([a, b]) => [a + x0, b + x0]));
  }
  const cols = [];
  for (let x = 0; x < width; x++) {
    cols.push(x < x0 || x >= x1 ? [] : runsOf(y1 - y0, i => dark(x, y0 + i), Math.round(V_MIN_MM * pxPerMm)).map(([a, b]) => [a + y0, b + y0]));
  }
  const mm = (p) => Math.round((p / pxPerMm) * 100) / 100;
  const horizontal = groupRuns(rows).map(l => ({ dir: 'h', atMm: mm(l.at), fromMm: mm(l.from), toMm: mm(l.to), px: l.thickness }));
  const vertical = groupRuns(cols).map(l => ({ dir: 'v', atMm: mm(l.at), fromMm: mm(l.from), toMm: mm(l.to), px: l.thickness }));
  const frames = horizontal.filter(l => l.toMm - l.fromMm >= frameMm).map(l => l.atMm);
  const top = frames.length ? Math.min(...frames) - 0.5 : -Infinity;
  const bottom = frames.length ? Math.max(...frames) + 1 : Infinity;
  const all = [...horizontal.filter(l => l.atMm >= top && l.atMm <= bottom), ...vertical.filter(l => l.fromMm >= top - 0.5 && l.toMm <= bottom + 0.5)];
  const widths = all.map(l => l.px);
  const min = widths.length ? Math.min(...widths) : null;
  const max = widths.length ? Math.max(...widths) : null;
  return {
    lines: all,
    horizontal: all.filter(l => l.dir === 'h').length,
    vertical: all.filter(l => l.dir === 'v').length,
    minPx: min,
    maxPx: max,
    tolerancePx,
    ok: widths.length > 0 && max - min <= tolerancePx,
    thickest: all.filter(l => l.px === max).slice(0, 5),
    thinnest: all.filter(l => l.px === min).slice(0, 5)
  };
};

// ---------------------------------------------------------------- the command
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS = (script, args) => spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });

const measureFile = (file, { dpi = 600, pageNo = 1, work = fs.mkdtempSync(path.join(os.tmpdir(), 'line-widths-')) } = {}) => {
  let pdf = file;
  if (/\.docx$/i.test(file)) {
    pdf = path.join(work, `${path.basename(file, '.docx')}.word.pdf`);
    const r = PS('word-to-pdf.ps1', ['-Docx', path.resolve(file), '-Pdf', pdf]);
    if (r.status !== 0) throw new Error(`Word could not export ${file}: ${(r.stdout || '') + (r.stderr || '')}`.trim());
  }
  const out = path.join(work, `${path.basename(pdf, '.pdf')}-png`);
  const r = PS('pdf-to-png.ps1', ['-Pdf', path.resolve(pdf), '-OutDir', out, '-Dpi', String(dpi)]);
  if (r.status !== 0) throw new Error(`The PDF could not be rendered: ${r.stderr}`);
  const png = path.join(out, `page-${String(pageNo).padStart(2, '0')}.png`);
  const page = openPage(png);
  // The page's own pixels per inch (the render follows the display scaling): 1 px is reported at it.
  const renderedFrom = /\.docx$/i.test(file) ? 'Word' : 'PDF';
  const result = measureLineWidths(page, { tolerancePx: TOLERANCE_PX[renderedFrom] });
  return { file, renderedFrom, dpi, page: pageNo, pxPerInch: Math.round(page.pxPerMm * 25.4), ...result };
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v; };
  const dpiArg = opt('--dpi', null);
  const pageNo = Number(opt('--page', 1));
  const outFile = opt('--out', null);
  const results = [];
  let failed = false;
  for (const file of args) {
    const dpis = dpiArg ? dpiArg.split(',').map(Number) : (/\.docx$/i.test(file) ? [600] : [600, 150]);
    for (const dpi of dpis) {
      const r = measureFile(file, { dpi, pageNo });
      failed = failed || !r.ok;
      console.log(`${r.ok ? '✔' : '✖'} ${path.basename(file)} (${r.renderedFrom}, page ${r.page}, ${r.pxPerInch} px/in): ${r.horizontal} horizontal + ${r.vertical} vertical lines, ${r.minPx}–${r.maxPx} px (allowed spread ${r.tolerancePx})`);
      results.push({ ...r, lines: undefined });
    }
  }
  if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`); }
  process.exit(failed ? 1 : 0);
}

module.exports = { measureLineWidths, measureFile, groupRuns, TOLERANCE_PX };
