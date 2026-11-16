#!/usr/bin/env node
// Phase 8 Part 10, Step 3 check: the print view prints the SAME pages as the exported PDF.
// With a practice copy running (`npm run demo:sem2:reset -- --faculty-seed`), it signs in as the TEST Dean,
// generates a Draft (seed 1) when the term has none, then for one Teachers' Program, one Class Schedule
// and one room page: prints the print view to PDF from the browser (headless Edge, the page's own
// @page size), downloads the export's PDF of the same page, renders both with Windows' own PDF engine
// and compares every horizontal rule and every text line's top (±1 mm).
//   node scripts/forms/print-view-check.js [--out .demo-data/logs/part10-print-compare.json]
// Reads and generates on the practice copy only; refuses any other database.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { openPage, hLines, textBands } = require('./measure');
const { apiOf, generateSeed } = require('../demo/deans-path');

const REPO = path.resolve(__dirname, '..', '..');
const WORK = path.join(REPO, '.demo-data', 'print-view-check');
const argOf = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const round = (v) => Math.round(v * 100) / 100;

const render = (pdf, outDir) => {
  fs.rmSync(outDir, { recursive: true, force: true });
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'pdf-to-png.ps1'), '-Pdf', pdf, '-OutDir', outDir, '-Dpi', '200'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`The PDF could not be rendered: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
  return fs.readdirSync(outDir).filter(n => n.endsWith('.png')).sort().map(n => path.join(outDir, n));
};

// Rules and text-line tops of one rendered page, in mm.
const landmarks = (file) => {
  const page = openPage(file);
  const wMm = page.width / page.pxPerMm; const hMm = page.height / page.pxPerMm;
  const rules = hLines(page, 5, wMm - 5, { frac: 0.35 }).map(l => l.top);
  const bands = textBands(page, 5, wMm - 5, 0.5, hMm - 0.5).map(b => b.top);
  return { widthMm: round(wMm), heightMm: round(hMm), rules, bands };
};
const match = (a, b, tol = 3) => {
  const used = new Set(); let max = 0; let unmatched = 0;
  for (const v of a) {
    let bi = -1; let bd = Infinity;
    b.forEach((w, i) => { if (!used.has(i) && Math.abs(w - v) < bd) { bd = Math.abs(w - v); bi = i; } });
    if (bi < 0 || bd > tol) { unmatched += 1; continue; }
    used.add(bi); max = Math.max(max, bd);
  }
  return { max: round(max), unmatched: unmatched + (b.length - used.size) };
};

(async () => {
  const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
  if (run.state !== 'ready' || run.mode !== 'sem2' || !/_test$/.test(run.database || '') || /defense/.test(run.database)) throw new Error('Needs a ready `npm run demo:sem2:reset -- --faculty-seed` (never the defense database).');
  const out = path.resolve(argOf('--out', path.join(REPO, '.demo-data', 'logs', 'part10-print-compare.json')));
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  const CLIENT = run.clientUrl || `http://localhost:${run.ports.client}`;
  const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
  const q = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
  const { API, call, login } = apiOf(run);
  const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);

  let outputs = await call('GET', `/schedule/outputs?${q}&prefer=draft`, { token: dean });
  if (outputs.status !== 200 || !outputs.data.classes?.length) {
    console.log('No Draft yet: generating one (seed 1) ...');
    const row = await generateSeed({ call, dean, TERM, seed: 1, log: console.log });
    if (row.status !== 'done') throw new Error(`The generation ended ${row.status}: ${row.message}`);
    outputs = await call('GET', `/schedule/outputs?${q}&scheduleId=${row.scheduleId}`, { token: dean });
  }
  const o = outputs.data;
  const scheduleId = o.schedule.id;
  const section = o.sections.find(s => s.classCount > 0);
  const room = o.rooms.find(r => r.kind === 'CCS' && r.type === 'LAB' && r.classCount > 0) || o.rooms.find(r => r.kind === 'CCS' && r.classCount > 0);
  const prof = o.faculty.find(f => o.classes.some(c => c.facultyRef && String(c.facultyRef) === String(f.id)));
  const alternating = Boolean(o.policy?.weekGroups?.enabled);
  const cases = [
    { name: 'class-schedule', output: 'mother-schedule', view: 'class-schedule', id: String(section.id), label: section.code || section.name },
    { name: 'teachers-program', output: 'teachers-program', view: 'teachers-program', id: String(prof.id), label: prof.name },
    { name: 'room-schedule', output: 'room-program', view: 'room-schedule', id: String(room.key), label: room.name, weekGroup: alternating ? 'odd' : null }
  ];

  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const result = { at: new Date().toISOString(), database: run.database, scheduleId, version: o.schedule.version, status: o.schedule.status, cases: {} };
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'light' });
    const page = await context.newPage();
    await page.addInitScript(([y, s]) => { try { window.localStorage.setItem('intellisched-theme', 'light'); window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: y, activeSemester: s })); } catch { /* none */ } }, [TERM.academicYear, TERM.semester === 2 ? '2nd Semester' : '1st Semester']);
    await page.goto(CLIENT);
    await page.getByTestId('login-username').fill(secrets.deanEmail);
    await page.getByTestId('login-password').fill(secrets.deanPassword);
    await page.getByTestId('login-submit').click();
    await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });

    for (const c of cases) {
      // The export's PDF of that one page.
      const url = `${API}/schedule/exports?${q}&scheduleId=${scheduleId}&view=${c.view}&format=pdf&id=${encodeURIComponent(c.id)}${c.weekGroup ? `&weekGroup=${c.weekGroup}` : ''}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${dean}` } });
      if (res.status !== 200) throw new Error(`${c.name}: the export answered ${res.status}`);
      const exported = path.join(WORK, `${c.name}-export.pdf`);
      fs.writeFileSync(exported, Buffer.from(await res.arrayBuffer()));
      // The print view's page, printed by the browser (a room schedule of an alternating version: the odd weeks' page).
      const params = new URLSearchParams({ output: c.output, scheduleId, id: c.id, academicYear: TERM.academicYear, semester: String(TERM.semester) });
      await page.evaluate((h) => { window.location.hash = h; }, `#/print?${params.toString()}`);
      await page.waitForSelector('.print-shared .sheet', { timeout: 60000 });
      await page.waitForTimeout(500);
      const sheets = await page.locator('.print-shared .sheet').count();
      const printed = path.join(WORK, `${c.name}-print.pdf`);
      await page.pdf({ path: printed, preferCSSPageSize: true, printBackground: true });
      const a = render(exported, path.join(WORK, `${c.name}-export`));
      const b = render(printed, path.join(WORK, `${c.name}-print`));
      const la = landmarks(a[0]); const lb = landmarks(b[0]);
      const rules = match(la.rules, lb.rules); const bands = match(la.bands, lb.bands);
      const entry = {
        label: c.label, sheetsOnScreen: sheets, exportPages: a.length, printPages: b.length,
        exportSizeMm: [la.widthMm, la.heightMm], printSizeMm: [lb.widthMm, lb.heightMm],
        rules: { count: la.rules.length, ...rules }, textLines: { count: la.bands.length, ...bands }
      };
      // A room of a version that alternates weeks prints both groups' pages (odd, then even); the first is compared with the odd-weeks export.
      entry.pass = b.length === (c.weekGroup ? 2 : a.length) && Math.abs(la.widthMm - lb.widthMm) <= 1 && Math.abs(la.heightMm - lb.heightMm) <= 1
        && rules.max <= 1 && rules.unmatched === 0 && bands.max <= 1 && bands.unmatched === 0;
      result.cases[c.name] = entry;
      console.log(`${c.name.padEnd(17)} ${entry.pass ? 'PASS' : 'FAIL'}  rules ${la.rules.length} (max ${rules.max} mm, ${rules.unmatched} unmatched), text lines ${la.bands.length} (max ${bands.max} mm, ${bands.unmatched} unmatched), pages ${a.length}/${b.length}`);
    }
  } finally { await browser.close(); }
  result.pass = Object.values(result.cases).every(e => e.pass);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(result.pass ? 'All three pages match within 1 mm.' : 'A page differs: see the log.');
  process.exit(result.pass ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
