// Phase 8 Part 9 (decision 7): measure the forms in three viewers.
//   npm run forms:compare       the system's PDFs against the targets (±1 mm), Word's rendering of each DOCX
//                               against the system's PDF, and the side-by-side pictures
//   npm run forms:word-check    only the Word part (page counts and every measured line within 1 mm)
// It exports the three forms from a THROWAWAY copy of the defense data (scripts/forms/export-copy.js;
// restore a defense backup with `npm run defense:restore -- --from <folder> --into <name>_test` first),
// renders every PDF to PNG with Windows' own PDF engine (scripts/forms/pdf-to-png.ps1), and measures
// the PNGs the way the office's scans were measured (scripts/forms/measure.js).
//   Word: the script starts its own Word through COM (scripts/forms/word-to-pdf.ps1), read-only and
//   invisible, saves Word's rendering as PDF and quits only that Word. If WINWORD is already running
//   (it could be the team's open work) the Word check is SKIPPED and says so; it never saves over a file.
//   node scripts/forms/compare.js [--db <name>_test] [--dir <folder of exports>] [--out <folder>] [--word-only] [--no-word] [--no-pictures]
// Writes the numbers to .demo-data/logs/part9-compare.json and the pictures to docs/outputs-samples/compare/.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { openPage, hLines, textBands } = require('./measure');

const REPO = path.join(__dirname, '..', '..');
const { FORMS } = require(path.join(REPO, 'server', 'src', 'exports', 'layouts.js'));
const POWERSHELL = 'powershell';
const PS = (script, args) => spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valueOf = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const WORD_ONLY = flag('--word-only');
const DB = valueOf('--db') || 'intellisched_part9_forms_test';
const WORK = path.resolve(valueOf('--out') || path.join(REPO, '.demo-data', 'part9', 'compare'));
const EXPORT_DIR = path.resolve(valueOf('--dir') || path.join(WORK, 'export'));
const LOG = path.join(REPO, '.demo-data', 'logs', 'part9-compare.json');
const PICTURES = path.join(REPO, 'docs', 'outputs-samples', 'compare');
const say = (line) => console.log(`[forms:compare] ${line}`);
const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- the targets, read from layouts.js
const TP = FORMS['teachers-program'];
const CS = FORMS['class-schedule'];
const twipMm = 25.4 / 1440;

// A landmark: a labelled line, its x range and the target top of its capitals.
const lm = (name, x0, x1, y) => ({ name, x0, x1, y });
const sf029Landmarks = () => {
  const L = [];
  TP.titles.forEach(t => L.push(lm(t.key, 50, 160, t.capTop)));
  TP.info.left.capTops.forEach((y, i) => L.push(lm(`info left ${i + 1}`, 10.5, 110, y)));
  TP.info.right.capTops.forEach((y, i) => L.push(lm(`info right ${i + 1}`, 113.5, 200, y)));
  const s = TP.summary;
  L.push(lm('SUMMARY', 12.5, 58, s.title.capTop), lm('(Maximum…)', 12.5, 58, s.maximum.capTop), lm('AREA', 12.5, 40, s.area.capTop));
  s.areaLines.forEach((y, i) => L.push(lm(`area line ${i + 1}`, 12.5, 58, y)));
  L.push(lm('(Lab.)', 12.5, 58, s.lab.capTop), lm('TOTAL NO. OF HOURS', 12.5, 58, s.total.capTop), lm('Excess', 12.5, 58, s.excess.capTop));
  TP.signatories.blocks.forEach(b => {
    L.push(lm(`${b.key} label`, b.labelX - 0.5, b.labelX + 42, b.labelTop));
    L.push(lm(`${b.key} name`, b.centreX - 31, b.centreX + 31, b.nameTop));
    L.push(lm(`${b.key} position`, b.centreX - 31, b.centreX + 31, b.positionTop));
  });
  L.push(lm('footer', TP.footer.codeX - 0.5, 70, TP.footer.capTop));
  return L;
};
const landscapeLandmarks = (form, withTitles) => {
  const L = [];
  if (withTitles) {
    CS.titles.forEach(t => L.push(lm(t.key, 80, 220, t.capTop)));
    L.push(lm('program line', CS.programLine.x - 0.5, 120, CS.programLine.capTop));
  }
  const sg = CS.signatories;
  L.push(lm('signatory line 1', sg.nameX[0] - 0.5, sg.labelX[1] - 2, sg.line1CapTop));
  L.push(lm('signatory line 2', sg.nameX[0] - 0.5, sg.labelX[1] - 2, sg.line2CapTop));
  L.push({ ...lm('footer', CS.footer.codeX - 0.5, 80, CS.footer.capTop), optional: true });
  return L;
};

// Grid rules in the first column (x range), target tops in mm.
const gridTargets = (kind) => {
  if (kind === 'teachers-program') {
    const g = TP.grid;
    const ys = [g.y, g.y + g.headerMm];
    for (let r = 1; r <= 20; r++) ys.push(g.y + g.headerMm + r * g.rowMm);
    ys.push(g.y + g.headerMm + 20 * g.rowMm + g.totalMm);
    return { x0: g.x + 2, x1: g.x + g.periodMm - 2, ys };
  }
  const g = CS.grid;
  const rowH = g.rowTwips * twipMm;
  return { x0: g.xTwips * twipMm + 2, x1: g.xTwips * twipMm + 28, ys: Array.from({ length: 22 }, (_, i) => g.y + i * rowH) };
};

// ---------------------------------------------------------------- the Room Schedule (Phase 11.2)
// The target is the office's own file, docs/formats/Room-Schedule_2nd-Sem-AY2025-26.docx, as Word
// renders it (committed beside it as .word.pdf; Word 16, 13 Nov 2026), page 1: the three title lines,
// the table frame, the column edges and the 22 row lines, each measured the same way on both pages.
const OFFICE_ROOM_PDF = path.join(REPO, 'docs', 'formats', 'Room-Schedule_2nd-Sem-AY2025-26.word.pdf');
const ROOM_TOLERANCE_MM = 0.6;
const roomProfile = (file) => {
  const page = openPage(file);
  const rows = hLines(page, 10, 32, { frac: 0.8, y0mm: 45, y1mm: 240 }).map(l => round(l.top + l.thick / 2));
  const out = [];
  if (!rows.length) return { rows, cols: [], titles: [], out: ['no grid'] };
  const y = Math.round((rows[0] + 2) * page.pxPerMm);
  const cols = [];
  let open = null;
  for (let x = 0; x <= page.width; x++) {
    const dark = x < page.width && page.grey[y * page.width + x] < 140;
    if (dark && open === null) open = x;
    if (!dark && open !== null) { cols.push(round(((open + x - 1) / 2) / page.pxPerMm)); open = null; }
  }
  const titles = textBands(page, 70, 140, 28.5, rows[0] - 0.5, { gapMm: 0.4 }).map(b => round(b.top)).slice(0, 3);
  return { rows, cols, titles };
};
const roomLandmarks = (p) => [
  ...['college', 'heading', 'term'].map((name, i) => ({ name: `title ${name}`, v: p.titles[i] })),
  ...p.cols.map((v, i) => ({ name: i === 0 ? 'frame left' : i === p.cols.length - 1 ? 'frame right' : `column edge ${i}`, v })),
  ...p.rows.map((v, i) => ({ name: i === 0 ? 'frame top' : i === p.rows.length - 1 ? 'frame bottom' : `row line ${i}`, v }))
];
let officeRoom = null;
const officeRoomProfile = () => {
  if (!officeRoom) officeRoom = roomProfile(render(OFFICE_ROOM_PDF, path.join(WORK, 'office-room-2025-26'))[0]);
  return officeRoom;
};
const measureRoomAgainstOffice = (file) => {
  const want = roomLandmarks(officeRoomProfile());
  const got = new Map(roomLandmarks(roomProfile(file)).map(l => [l.name, l.v]));
  const out = { diffs: [], missing: [] };
  for (const l of want) {
    const v = got.get(l.name);
    if (v === undefined || l.v === undefined) out.missing.push(l.name);
    else out.diffs.push({ name: l.name, target: l.v, got: v, diff: round(v - l.v) });
  }
  return out;
};
// Page 1 and the AVR page (the prompt's two), by the page names the export recorded.
const roomPagesToMeasure = (form) => {
  const avr = (form.pageNames || []).findIndex(n => n === 'AVR' || / AVR$/.test(n));
  return [...new Set([0, avr >= 0 ? avr : 0])];
};

// ---------------------------------------------------------------- measuring
const measureLandmark = (page, l) => {
  const bands = textBands(page, l.x0, l.x1, l.y - 2.2, l.y + 4.5);
  const best = bands.sort((a, b) => Math.abs(a.top - l.y) - Math.abs(b.top - l.y))[0];
  if (!best || Math.abs(best.top - l.y) > 2.2) return null;
  return best.top;
};

// One page against its targets: the grid's rules and every landmark.
const measureAgainstTargets = (file, kind) => {
  if (kind === 'room-schedule') return measureRoomAgainstOffice(file);
  const page = openPage(file);
  const out = { diffs: [], missing: [] };
  const gt = gridTargets(kind);
  const lines = hLines(page, gt.x0, gt.x1, { frac: 0.8, y0mm: gt.ys[0] - 3, y1mm: gt.ys[gt.ys.length - 1] + 3 });
  const tops = lines.map(l => l.top + l.thick / 2);
  gt.ys.forEach((y, i) => {
    const near = tops.sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0];
    if (near === undefined || Math.abs(near - y) > 2) out.missing.push(`grid rule ${i + 1}`);
    else out.diffs.push({ name: `grid rule ${i + 1}`, target: round(y), got: round(near), diff: round(near - y) });
  });
  const landmarks = kind === 'teachers-program' ? sf029Landmarks() : landscapeLandmarks(CS, kind === 'class-schedule');
  for (const l of landmarks) {
    const top = measureLandmark(page, l);
    if (top === null) { if (!l.optional) out.missing.push(l.name); else out.absent = [...(out.absent || []), l.name]; continue; }
    out.diffs.push({ name: l.name, target: round(l.y), got: round(top), diff: round(top - l.y) });
  }
  return out;
};

// The profile of a page for the Word comparison: the grid's rules and the tops of the text bands in
// three vertical strips.
const profile = (file, landscape) => {
  const page = openPage(file);
  const W = landscape ? 297 : 210;
  const strips = landscape ? [[16, 100], [100, 190], [190, 282]] : [[9, 70], [70, 140], [140, 202]];
  const first = strips[0];
  const rules = hLines(page, first[0] + 3, first[0] + 25, { frac: 0.8 }).map(l => l.top + l.thick / 2);
  const bands = strips.flatMap(([a, b]) => textBands(page, a, b, 0.5, (landscape ? 210 : 297) - 0.5).map(x => x.top));
  return { rules, bands: bands.sort((p, q) => p - q), widthMm: W };
};
const matchLists = (a, b, tolerance = 3) => {
  let max = 0; let unmatched = 0; let worst = null;
  const used = new Set();
  for (const v of a) {
    let bestI = -1; let bestD = Infinity;
    b.forEach((w, i) => { if (!used.has(i) && Math.abs(w - v) < bestD) { bestD = Math.abs(w - v); bestI = i; } });
    if (bestI < 0 || bestD > tolerance) { unmatched += 1; continue; }
    used.add(bestI);
    if (bestD > max) { max = bestD; worst = { system: round(v), word: round(b[bestI]) }; }
  }
  unmatched += b.length - used.size;
  return { max: round(max), unmatched, worst };
};

// ---------------------------------------------------------------- rendering
const render = (pdf, outDir, dpi = 200) => {
  fs.rmSync(outDir, { recursive: true, force: true });
  const r = PS('pdf-to-png.ps1', ['-Pdf', pdf, '-OutDir', outDir, '-Dpi', String(dpi)]);
  if (r.status !== 0) throw new Error(`The PDF could not be rendered (${path.basename(pdf)}): ${(r.stderr || r.stdout || '').slice(0, 300)}`);
  return fs.readdirSync(outDir).filter(n => n.endsWith('.png')).sort().map(n => path.join(outDir, n));
};
const wordPdf = (docx, pdf) => {
  fs.rmSync(pdf, { force: true });
  const r = PS('word-to-pdf.ps1', ['-Docx', docx, '-Pdf', pdf]);
  const out = (r.stdout || '').trim();
  if (r.status === 3) return { skipped: out.replace(/^SKIPPED\s*/, '') };
  if (r.status === 5) return { skipped: 'Microsoft Word is not installed on this computer.' };
  if (r.status !== 0) throw new Error(`Word could not open ${path.basename(docx)}: ${out || r.stderr}`);
  return { pages: Number(/PAGES (\d+)/.exec(out)?.[1]) };
};

const sample = (n) => [...new Set([0, Math.floor(n / 2), n - 1])];

// ---------------------------------------------------------------- the run
const main = () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (!valueOf('--dir')) {
    say(`Exporting the three forms from the throwaway copy ${DB} ...`);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'export-copy.js'), '--db', DB, '--out', EXPORT_DIR], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error(`The export failed: ${(r.stdout + r.stderr).slice(-400)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'exports.json'), 'utf8'));
  const forms = manifest.files.filter(f => f.format === 'pdf').map(f => ({
    ...f,
    key: `${f.view}${f.weekGroup && f.weekGroup !== 'ALL' ? `-${f.weekGroup.toLowerCase()}` : ''}`,
    docx: path.join(EXPORT_DIR, f.file.replace(/\.pdf$/, '.docx')),
    pdf: path.join(EXPORT_DIR, f.file),
    landscape: f.view === 'class-schedule'
  }));
  const result = { when: new Date().toISOString(), db: DB, version: manifest.version, status: manifest.status, shortened: manifest.shortened || [], forms: {}, word: { skipped: null } };

  for (const form of forms) {
    say(`${form.key}: system PDF (${form.pages} pages) ...`);
    const sysDir = path.join(WORK, `${form.key}-system`);
    const sysPages = render(form.pdf, sysDir);
    const entry = { file: form.file, pages: form.pages, systemPages: sysPages.length };
    if (!WORD_ONLY) {
      const pagesToMeasure = form.view === 'room-schedule' ? roomPagesToMeasure(form) : sample(sysPages.length);
      const perPage = pagesToMeasure.map(i => ({ page: i + 1, ...measureAgainstTargets(sysPages[i], form.view) }));
      const diffs = perPage.flatMap(p => p.diffs);
      const worst = diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0] || null;
      entry.targets = {
        pagesMeasured: perPage.map(p => p.page),
        lines: diffs.length,
        maxAbsDiffMm: worst ? Math.abs(worst.diff) : null,
        worst,
        missing: [...new Set(perPage.flatMap(p => p.missing))],
        absent: [...new Set(perPage.flatMap(p => p.absent || []))],
        tolerance: form.view === 'room-schedule' ? ROOM_TOLERANCE_MM : 1,
        target: form.view === 'room-schedule' ? path.relative(REPO, OFFICE_ROOM_PDF).split(path.sep).join('/') : 'layouts.js',
        pass: Boolean(diffs.length) && !perPage.some(p => p.missing.length) && Math.abs(worst.diff) <= (form.view === 'room-schedule' ? ROOM_TOLERANCE_MM : 1)
      };
    }
    result.forms[form.key] = entry;
  }

  if (!flag('--no-word')) {
    for (const form of forms) {
      const entry = result.forms[form.key];
      const wpdf = path.join(WORK, `${form.key}-word.pdf`);
      say(`${form.key}: Word's own rendering ...`);
      const w = wordPdf(form.docx, wpdf);
      if (w.skipped) { result.word.skipped = w.skipped; entry.word = { skipped: w.skipped }; break; }
      const wordPages = render(wpdf, path.join(WORK, `${form.key}-wordpng`));
      const sysPages = fs.readdirSync(path.join(WORK, `${form.key}-system`)).filter(n => n.endsWith('.png')).sort().map(n => path.join(WORK, `${form.key}-system`, n));
      const comparable = Math.min(sysPages.length, wordPages.length);
      // The measured lines (the grid's rules and every labelled line) on the same page of both PDFs.
      const pages = form.view === 'room-schedule' ? roomPagesToMeasure(form).filter(i => i < comparable) : sample(comparable);
      const perPage = pages.map(i => {
        const sys = measureAgainstTargets(sysPages[i], form.view);
        const word = measureAgainstTargets(wordPages[i], form.view);
        const byName = new Map(sys.diffs.map(d => [d.name, d]));
        const lines = word.diffs.filter(d => byName.has(d.name)).map(d => ({ name: d.name, system: byName.get(d.name).got, word: d.got, diff: round(d.got - byName.get(d.name).got) }));
        return { page: i + 1, lines, missingInWord: word.missing, missingInSystem: sys.missing, band: matchLists(profile(sysPages[i], form.landscape).bands, profile(wordPages[i], form.landscape).bands, 1.5) };
      });
      const all = perPage.flatMap(p => p.lines);
      const worst = all.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))[0] || null;
      const missing = [...new Set(perPage.flatMap(p => p.missingInWord))];
      entry.word = {
        pages: w.pages,
        samePageCount: w.pages === form.pages && wordPages.length === form.pages,
        pagesMeasured: pages.map(i => i + 1),
        lines: all.length,
        maxDiffMm: worst ? Math.abs(worst.diff) : null,
        worst,
        missingInWord: missing,
        // Information only: the tops of all text bands in three strips, matched within 1.5 mm.
        textBandsMaxDiffMm: Math.max(...perPage.map(p => p.band.max)),
        textBandsUnmatched: perPage.reduce((n, p) => n + p.band.unmatched, 0),
        tolerance: form.view === 'room-schedule' ? ROOM_TOLERANCE_MM : 1,
        pass: w.pages === form.pages && !missing.length && Boolean(all.length) && Math.abs(worst.diff) <= (form.view === 'room-schedule' ? ROOM_TOLERANCE_MM : 1)
      };
    }
  }

  fs.writeFileSync(LOG, `${JSON.stringify(result, null, 2)}\n`);
  say(`Numbers written to ${path.relative(REPO, LOG)}`);

  if (!WORD_ONLY && !flag('--no-pictures')) pictures(result, forms);

  const rows = Object.entries(result.forms).map(([k, e]) => `${k}: pages ${e.pages}${e.targets ? `, targets max ${e.targets.maxAbsDiffMm} mm (${e.targets.pass ? 'pass' : 'OUT'})` : ''}${e.word ? (e.word.skipped ? ', Word skipped' : `, Word ${e.word.pages} pages, max ${e.word.maxDiffMm} mm over ${e.word.lines} lines (${e.word.pass ? 'pass' : 'OUT'})`) : ''}`);
  rows.forEach(r => say(r));
  if (result.word.skipped) say(`WORD SKIPPED: ${result.word.skipped}`);
};

// ---------------------------------------------------------------- the side-by-side pictures
const pictures = (result, forms) => {
  const office = {
    tp: render(path.join(REPO, 'docs', 'formats', 'LSPU-ACAD-SF-029_Teachers-Program_sample-pages.pdf'), path.join(WORK, 'office-tp')),
    cs: render(path.join(REPO, 'docs', 'formats', 'LSPU-ACAD-SF-003_Class-Schedule_1st-Sem-AY2026-27.word.pdf'), path.join(WORK, 'office-cs')),
    rs: render(OFFICE_ROOM_PDF, path.join(WORK, 'office-rs'))
  };
  const pngs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.png')).sort().map(n => path.join(dir, n)) : []);
  const manifest = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'exports.json'), 'utf8'));
  const names = (key) => manifest.files.find(f => f.format === 'pdf' && `${f.view}${f.weekGroup && f.weekGroup !== 'ALL' ? `-${f.weekGroup.toLowerCase()}` : ''}` === key)?.pageNames || [];
  const jobs = [];
  const tpNames = names('teachers-program');
  [['Faculty', 0], ['Faculty', 1], ['Faculty', 2]].forEach(([who, officeIndex]) => {
    const at = tpNames.findIndex(n => n.toLowerCase().includes(who.toLowerCase()));
    if (at >= 0) jobs.push({ file: `teachers-program-${who.toLowerCase()}.png`, key: 'teachers-program', at, office: office.tp[officeIndex], label: `Teachers' Program, ${who}`, officeLabel: `Last year's form (page ${officeIndex + 1} of the sample)` });
  });
  [0, 11].forEach(i => jobs.push({ file: `class-schedule-page-${i + 1}.png`, key: 'class-schedule', at: i, office: office.cs[Math.min(i, office.cs.length - 1)], label: `Class Schedule, page ${i + 1}`, officeLabel: `The office's Word file (page ${i + 1})` }));
  // Phase 11.2: page 1 (LAB 1, odd weeks) and the AVR page (page 7 of the office's file).
  const avrAt = names('room-schedule').findIndex(n => n === 'AVR' || / AVR$/.test(n));
  [[0, 0], [avrAt, 6]].filter(([at]) => at >= 0).forEach(([at, officeIndex]) => jobs.push({ file: `room-schedule-page-${at + 1}.png`, key: 'room-schedule', at, office: office.rs[Math.min(officeIndex, office.rs.length - 1)], label: `Room Schedule, page ${at + 1}`, officeLabel: `The office's Room Schedule.docx (page ${officeIndex + 1})` }));
  fs.mkdirSync(PICTURES, { recursive: true });
  for (const job of jobs) {
    const sys = pngs(path.join(WORK, `${job.key}-system`))[job.at];
    const word = pngs(path.join(WORK, `${job.key}-wordpng`))[job.at];
    const images = [job.office, sys, ...(word ? [word] : [])];
    const captions = [job.officeLabel, `System PDF — ${job.label}`, ...(word ? [`Word's own PDF of the DOCX`] : [])];
    const r = PS('side-by-side.ps1', ['-Out', path.join(PICTURES, job.file), '-Images', images.join('|'), '-Captions', captions.join('|'), '-Height', '900']);
    if (r.status !== 0) say(`Picture ${job.file} failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
    else say(`Picture ${path.relative(REPO, path.join(PICTURES, job.file))}`);
  }
};

try { main(); } catch (err) { console.error(`[forms:compare] ${err.message}`); process.exit(1); }
