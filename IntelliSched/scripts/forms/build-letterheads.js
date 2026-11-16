// Phase 8 Part 9 (decision 5): the forms' letterheads as ONE picture each — the seal and the three
// university lines, the university's name in blackletter — so the Word file and the PDF can't differ
// there, whatever fonts a computer or Google Docs has. Made with the PDF's own headless browser from
// HTML at 300 dpi or more, then measured back: each line's capitals must land within 0.2 mm of its
// target (layouts.js LETTERHEADS), or the script corrects the position and draws it again.
//   node scripts/forms/build-letterheads.js     -> server/src/exports/letterhead-sf029.png
//                                                  server/src/exports/letterhead-landscape.png
// The pictures are committed; run this only when a letterhead changes. It needs the office's fonts
// (Old English Text MT, Arial Narrow, Calibri: Windows with Office); without them it uses the bundled
// look-alikes and says so.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const EXPORTS = path.join(REPO_ROOT, 'server', 'src', 'exports');
const { LETTERHEADS } = require(path.join(EXPORTS, 'layouts.js'));
const { findBrowser } = require(path.join(EXPORTS, 'pdf.js'));
const { checkFonts } = require(path.join(EXPORTS, 'fonts.js'));
const { openPage, textBands, inkExtent } = require('./measure');

const SEAL = path.join(REPO_ROOT, 'docs', 'formats', 'lspu-logo.png');
const PX_PER_MM = 96 / 25.4;
const SCALE = 3.2;                // device pixels per CSS pixel: 307 dpi
const FAMILIES = {
  narrow: "'Arial Narrow', 'Archivo Narrow', sans-serif",
  blackletter: "'Old English Text MT', 'Pirata One', serif",
  calibri: "'Calibri', 'Carlito', 'Arial', sans-serif"
};

const fontFaces = () => {
  const check = checkFonts();
  const faces = [];
  if (!check.families.oldEnglish.installed) faces.push(['Pirata One', 'PirataOne-Regular.ttf']);
  if (!check.families.arialNarrow.installed) faces.push(['Archivo Narrow', 'ArchivoNarrow-wght.ttf']);
  if (faces.length) console.log(`Look-alikes used: ${faces.map(f => f[0]).join(', ')} (the office's fonts are not installed).`);
  return faces.map(([family, file]) => `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${fs.readFileSync(path.join(EXPORTS, 'fonts', file)).toString('base64')}) format('truetype');}`).join('\n');
};

// The picture's HTML: the seal and each line absolutely placed in mm inside the box; `shift` moves a
// line's box (mm) after the first measurement.
const pictureHtml = (spec, shifts) => {
  const seal = `data:image/png;base64,${fs.readFileSync(SEAL).toString('base64')}`;
  const centre = spec.centreX - spec.box.x;
  const lines = spec.lines.map((line, i) => {
    // The first guess: the line box's top at the target less ~0.2 em (corrected by measuring).
    const top = line.capTop - spec.box.y - 0.2 * line.pt * (25.4 / 72) + (shifts[i] || 0);
    return `<div style="position:absolute;left:0;width:${spec.box.w}mm;top:${top}mm;text-align:left;white-space:pre;font-family:${FAMILIES[line.font]};font-size:${line.pt}pt;line-height:1;font-kerning:none"><span style="position:relative;left:${centre}mm;display:inline-block;transform:translateX(-50%)">${line.text}</span></div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontFaces()}
html,body{margin:0;padding:0;background:#fff;color:#000;overflow:hidden}
.box{position:relative;width:${spec.box.w}mm;height:${spec.box.h}mm;overflow:hidden}</style></head><body><div class="box">
<img alt="" src="${seal}" style="position:absolute;left:${spec.seal.x}mm;top:${spec.seal.y}mm;width:${spec.seal.w}mm;height:${spec.seal.h}mm"/>${lines}</div></body></html>`;
};

const shoot = (html, spec, out) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forms-letterhead-'));
  const file = path.join(work, 'letterhead.html');
  fs.writeFileSync(file, html);
  const w = Math.round(spec.box.w * PX_PER_MM);
  const h = Math.round(spec.box.h * PX_PER_MM);
  spawnSync(findBrowser(), ['--headless', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${path.join(work, 'profile')}`,
    `--window-size=${w},${h}`, `--force-device-scale-factor=${SCALE}`, `--screenshot=${out}`, '--virtual-time-budget=5000',
    `file:///${file.replace(/\\/g, '/')}`], { windowsHide: true });
  fs.rmSync(work, { recursive: true, force: true });
  if (!fs.existsSync(out)) throw new Error('The browser made no picture.');
};

// Each line's capitals' top on the page, measured in the picture (within the line's x range, clear of
// the seal).
const measureLines = (spec, file) => {
  const page = openPage(file, spec.box.w);
  const sealRight = spec.seal.x + spec.seal.w + 0.5;
  return spec.lines.map(line => {
    // The band whose top is nearest the target (the line above may reach down with its descenders).
    const target = line.capTop - spec.box.y;
    const bands = textBands(page, sealRight, spec.box.w - 0.2, Math.max(0, target - 2.5), target + 3);
    const best = bands.sort((a, b) => Math.abs(a.top - target) - Math.abs(b.top - target))[0];
    return best ? Math.round((best.top + spec.box.y) * 100) / 100 : null;
  });
};

if (require.main === module) {
  if (!findBrowser()) { console.error('No headless browser (Edge or Chrome) on this computer.'); process.exit(1); }
  for (const [key, spec] of Object.entries(LETTERHEADS).filter(([, s]) => Array.isArray(s.lines))) {
    const out = path.join(EXPORTS, spec.file);
    let shifts = spec.lines.map(() => 0);
    let tops = [];
    for (let pass = 0; pass < 3; pass++) {
      shoot(pictureHtml(spec, shifts), spec, out);
      tops = measureLines(spec, out);
      const off = tops.map((t, i) => (t === null ? 0 : spec.lines[i].capTop - t));
      if (off.every(d => Math.abs(d) <= 0.1)) break;
      shifts = shifts.map((s, i) => s + off[i]);
    }
    const page = openPage(out, spec.box.w);
    const { width } = page;
    const spans = tops.map(t => inkExtent(page, spec.seal.x + spec.seal.w + 0.5, spec.box.w - 0.2, t - spec.box.y, t - spec.box.y + 1.5))
      .map(e => (e ? `${(e.left + spec.box.x).toFixed(1)}–${(e.right + spec.box.x).toFixed(1)}` : '?'));
    console.log(`  x extents on the page: ${spans.join(' / ')}`);
    console.log(`${spec.file}: ${width}×${page.height} px (${Math.round(width / (spec.box.w / 25.4))} dpi); cap tops ${tops.join(' / ')} (targets ${spec.lines.map(l => l.capTop).join(' / ')}) [${key}]`);
  }
}

module.exports = { pictureHtml };
