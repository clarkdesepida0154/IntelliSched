// Phase 8 Part 9 (decision 1): the character widths the forms' line breaks are decided with, measured
// once from the bundled Arimo (server/src/exports/fonts/Arimo-wght.ttf, metric-compatible with Arial:
// the same advance widths) in the same headless browser that prints the PDF, kerning off. The table is
// committed; this script only remakes it.
//   node scripts/forms/build-widths.js        -> server/src/exports/arialWidths.json
// Widths are in 1/1000 em, for the regular and the bold weight (Arial's italic has the regular's widths).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FONT = path.join(REPO_ROOT, 'server', 'src', 'exports', 'fonts', 'Arimo-wght.ttf');
const OUT = path.join(REPO_ROOT, 'server', 'src', 'exports', 'arialWidths.json');
const { findBrowser } = require(path.join(REPO_ROOT, 'server', 'src', 'exports', 'pdf.js'));

// Printable ASCII, Latin-1, and the punctuation the forms print (dashes, quotes, the bullet, the
// ellipsis, the multiplication sign is in Latin-1).
const CODES = [
  ...Array.from({ length: 95 }, (_, i) => 32 + i),
  ...Array.from({ length: 96 }, (_, i) => 160 + i),
  0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026
];

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'ArimoW';src:url(data:font/ttf;base64,${fs.readFileSync(FONT).toString('base64')}) format('truetype');font-weight:100 900;}
body{font-family:'ArimoW'}</style></head><body><pre id="out">waiting</pre><script>
const codes = ${JSON.stringify(CODES)};
Promise.all([document.fonts.load('400 100px ArimoW'), document.fonts.load('700 100px ArimoW')]).then(() => {
  const ctx = document.createElement('canvas').getContext('2d');
  const table = {};
  for (const weight of [400, 700]) {
    ctx.font = weight + ' 1000px ArimoW';
    if ('fontKerning' in ctx) ctx.fontKerning = 'none';
    table[weight === 400 ? 'regular' : 'bold'] = Object.fromEntries(codes.map(c => [c, Math.round(ctx.measureText(String.fromCharCode(c)).width * 100) / 100]));
  }
  document.getElementById('out').textContent = 'WIDTHS' + JSON.stringify(table) + 'END';
});
</script></body></html>`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forms-widths-'));
const file = path.join(work, 'widths.html');
fs.writeFileSync(file, html);
const browser = findBrowser();
if (!browser) { console.error('No headless browser (Edge or Chrome) on this computer.'); process.exit(1); }
const res = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(work, 'profile')}`,
  '--virtual-time-budget=10000', '--dump-dom', `file:///${file.replace(/\\/g, '/')}`], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
fs.rmSync(work, { recursive: true, force: true });
const m = /WIDTHS(.*)END/.exec(res.stdout || '');
if (!m) { console.error('The browser did not return the widths.', (res.stderr || '').slice(0, 400)); process.exit(1); }
const table = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
const out = {
  about: 'Advance widths in 1/1000 em of the bundled Arimo (metric-compatible with Arial), kerning off; made by scripts/forms/build-widths.js (Phase 8 Part 9). Italic uses the regular widths.',
  font: 'Arimo-wght.ttf',
  ...table
};
fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`Wrote ${path.relative(REPO_ROOT, OUT)}: ${Object.keys(table.regular).length} characters; "A" ${table.regular[65]} / bold ${table.bold[65]}`);
