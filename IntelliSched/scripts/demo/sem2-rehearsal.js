// Phase 4 Part 3, Step 3: the dress rehearsal of 2nd Semester AY 2026-2027 along the Dean's path, on a
// fresh `npm run demo:sem2:reset`, headless, through the gateway as the TEST Dean (the GA seed too, as
// on the Generate Schedule page's "Advanced"; Phase 8 Part 8: one account; the defense database is the
// team's and is never changed by a script, so the rehearsal runs on demo:sem2):
//   1. the Readiness Check before assigning (every line recorded);
//   2. Assign Faculty: for each ITEP 205 class, the Dean's planned choice (Phase 8: Morris Virtus
//      Faculty, as the term file's notes say she will assign live at the defense); since Phase 8
//      Part 7 also the term file's other open classes, the practice copy only (BSIT 1D's to the
//      top-ranked professor the Overload Guardian allows, the 4th-year WMAD B coordination to
//      Faculty, with "Practice copy only: the Secretary assigns this class by hand")
//      (the ranking's order, through POST /schedule/lock exactly as the Recommendations page sends it:
//      rank 1 is an 'accept', a lower rank an 'override' with the Guardian's refusal as the reason);
//      with no candidates from the ranking service, the professor with the most free teaching hours
//      and a matching specialization;
//   3. the Readiness Check again (it must say "Ready to generate");
//   4. Generate with each seed (1, 2, 3): conflicts, classes (all and taught by CCS faculty), TBA rooms
//      to request, classes in TBA rooms, Saturday blocks, starts before 08:00, lunch-rule failures,
//      room double-bookings, the most CCS classes and labs at once, and the time;
//   5. the outputs of the first seed, printed to PDF in the real print view (the Mother Schedule of
//      BSIT 1A, the Teachers' Program of one full-timer and one part-timer, the Room Program of one lab);
//   6. last year's manual 2nd semester from docs/data/past_class_blocks.csv, for the comparison.
// The Dean's-path steps themselves live in scripts/demo/deans-path.js (Phase 8 Part 2), shared with
// `npm run system-check` — one copy, never two.
// Usage (repo root): npm run demo:sem2:reset, then in a second terminal
//   node scripts/demo/sem2-rehearsal.js [--seeds 1,2,3] [--out <folder>] [--no-pdf] [--pdf-professors "Name,Name"]
// It reads .demo-data/run.json (the ports, the mode's secrets file) and writes <out>/sem2-rehearsal.json
// and <out>/pdf/*.pdf; the default <out> is .demo-data/sem2-rehearsal/ (gitignored). The record holds
// counts, professors' names, ranks and times only: never a rating, a score, a specialization or a note.
// The PDFs need the installed Microsoft Edge (Playwright from client/node_modules); on this computer a
// headless browser starts from a console, not from a sandboxed shell.
const fs = require('fs');
const path = require('path');
const { apiOf, readiness, assignUnassignedMajors, assignmentsBySource, generateSeed, lastYearStats } = require('./deans-path');
const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const SEEDS = String(argOf('--seeds', '1,2,3')).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 0);
const OUT = path.resolve(REPO, argOf('--out', path.join('.demo-data', 'sem2-rehearsal')));
const WITH_PDF = !args.includes('--no-pdf');
const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
const CLIENT = run.clientUrl || `http://localhost:${run.ports.client}`;
const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
const TERM_LABEL = `${TERM.semester === 2 ? '2nd' : '1st'} Semester AY ${TERM.academicYear}`;
const TERM_FILE = path.join(REPO, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const CSV_FILE = path.join(REPO, 'docs', 'data', 'past_class_blocks.csv');
const LAST_YEAR = '2nd Sem AY 2025-26';
const log = (m) => console.log(`[rehearsal ${new Date().toISOString().slice(11, 19)}] ${m}`);
const { call, login } = apiOf(run);
const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;

(async () => {
  if (run.mode === 'defense') throw new Error('The defense database is kept for the team and never changed by a script. Run the rehearsal on npm run demo:sem2:reset. Nothing was changed.');
  if (run.state !== 'ready' || run.mode !== 'sem2') throw new Error(`The demo is not a ready 2nd-semester demo (mode ${run.mode}, state ${run.state}). Start npm run demo:sem2:reset first.`);
  fs.mkdirSync(path.join(OUT, 'pdf'), { recursive: true });
  const record = { startedAt: new Date().toISOString(), mode: run.mode, term: TERM, facultySource: run.facultySource, seeds: SEEDS };
  const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
  log(`signed in as the Dean (${run.mode}, ${TERM_LABEL})`);

  // 1. Readiness before assigning.
  record.readinessBefore = await readiness(call, dean, TERM);
  log(`Readiness before: ${record.readinessBefore.verdict}`);
  record.readinessBefore.lines.forEach(l => log(`  ${l.status === 'pass' ? '✔' : l.status === 'warn' ? '⚠' : '✖'} ${l.text}`));

  // 2. Assign Faculty: the ITEP 205 classes from the Recommendations, and (Part 7) the other open
  // classes the practice copy's way (deans-path.js, shared with the system check). Phase 8: the term
  // file's assignment counts by source, for the backtest.
  const term = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));
  record.assignmentsBySource = assignmentsBySource(term);
  record.assignments = await assignUnassignedMajors({ call, dean, TERM, term, log });

  // 3. Readiness again.
  record.readinessAfter = await readiness(call, dean, TERM);
  log(`Readiness after: ${record.readinessAfter.verdict}`);
  record.readinessAfter.lines.forEach(l => log(`  ${l.status === 'pass' ? '✔' : l.status === 'warn' ? '⚠' : '✖'} ${l.text}`));

  // 4. Generate with each seed (deans-path.js generateSeed: the run, the whole-version check and the
  // saved version's own numbers).
  record.runs = [];
  if (record.readinessAfter.verdict !== 'ready') {
    log('not ready: no generation (see the lines above)');
  } else {
    for (const seed of SEEDS) {
      const row = await generateSeed({ call, dean, TERM, seed, log });
      record.runs.push(row);
      log(`seed ${seed}: ${row.status}, ${row.message}; conflicts ${row.conflicts}, TBA rooms to request ${row.tbaRequest ? `${row.tbaRequest.lab} lab / ${row.tbaRequest.lec} lecture` : '-'}, classes in TBA rooms ${row.classesInTbaRooms}, Saturday ${row.saturdayBlocks}, before 08:00 ${row.startsBefore8 ?? '-'}, lunch failures ${row.lunchFailures ?? '-'}, ${row.runtimeMs ? `${Math.round(row.runtimeMs / 100) / 10} s` : '-'}`);
    }
  }

  // 5. The outputs of the first seed, printed to PDF.
  const first = record.runs.find(r => r.status === 'done' && r.scheduleId);
  record.pdfs = [];
  if (first && WITH_PDF) {
    try {
      const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
      const out = (await call('GET', `/schedule/outputs?${termQuery}&scheduleId=${first.scheduleId}`, { token: dean })).data;
      const section = (out.sections || []).find(s => s.code === 'BSIT 1A' || s.label === 'BSIT 1A');
      const profs = out.faculty || [];
      const withClasses = (type) => profs.filter(p => p.employmentType === type && (out.classes || []).some(c => String(c.facultyRef) === String(p.id)));
      const fullTimer = withClasses('FULL_TIME')[0];
      const partTimer = withClasses('PART_TIME')[0];
      const lab = (out.rooms || []).find(r => r.kind === 'CCS' && r.type === 'LAB');
      // Phase 4 Part 4: --pdf-professors "Name,Name" also prints those professors' Teachers' Programs (exact
      // names as on the Faculty page), e.g. a coordinator's SF-029 with its On-The-Job Training boxes.
      const named = String(argOf('--pdf-professors', '')).split(',').map(s => s.trim()).filter(Boolean)
        .map(name => ({ name, prof: profs.find(p => p.name === name) }));
      for (const { name, prof } of named.filter(n => !n.prof)) log(`PDF: no professor named "${name}" in this version`);
      const slug = (name) => String(name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const targets = [
        section && { output: 'mother-schedule', id: section.id, file: 'mother-schedule-BSIT-1A.pdf', who: 'BSIT 1A' },
        fullTimer && { output: 'teachers-program', id: fullTimer.id, file: 'teachers-program-full-time.pdf', who: fullTimer.name },
        partTimer && { output: 'teachers-program', id: partTimer.id, file: 'teachers-program-part-time.pdf', who: partTimer.name },
        lab && { output: 'room-program', id: lab.key, file: `room-program-${String(lab.name).replace(/\s+/g, '-')}.pdf`, who: lab.name },
        ...named.filter(n => n.prof).map(({ prof }) => ({ output: 'teachers-program', id: prof.id, file: `teachers-program-${slug(prof.name)}.pdf`, who: prof.name }))
      ].filter(Boolean);
      const browser = await chromium.launch({ channel: 'msedge', headless: true });
      try {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
        await page.addInitScript(([year, semester]) => {
          try { window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: year, activeSemester: semester })); } catch { /* none */ }
        }, [TERM.academicYear, TERM.semester === 2 ? '2nd Semester' : '1st Semester']);
        await page.goto(CLIENT);
        await page.getByTestId('login-username').fill(secrets.deanEmail);
        await page.getByTestId('login-password').fill(secrets.deanPassword);
        await page.getByTestId('login-submit').click();
        await page.getByTestId('nav-group-check').waitFor({ timeout: 30000 });
        for (const t of targets) {
          const q = new URLSearchParams({ output: t.output, id: String(t.id), scheduleId: String(first.scheduleId), academicYear: TERM.academicYear, semester: String(TERM.semester) });
          await page.goto('about:blank');
          await page.goto(`${CLIENT}/#/print?${q.toString()}`);
          await page.locator('[data-testid=print-page], [data-testid=print-error], [data-testid=print-empty]').first().waitFor({ timeout: 60000 });
          const problem = await page.evaluate(() => document.querySelector('[data-testid=print-error], [data-testid=print-empty]')?.innerText || '');
          if (problem) { record.pdfs.push({ ...t, error: problem }); log(`PDF ${t.file}: ${problem}`); continue; }
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => (img.complete ? null : new Promise((done) => { img.onload = done; img.onerror = done; })))); });
          await page.waitForTimeout(500);
          const pages = await page.locator('[data-testid=print-page]').count();
          await page.pdf({ path: path.join(OUT, 'pdf', t.file), format: 'A4', printBackground: true, preferCSSPageSize: true });
          record.pdfs.push({ output: t.output, who: t.who, file: `pdf/${t.file}`, pages });
          log(`PDF ${t.file} (${t.who}, ${pages} page${pages === 1 ? '' : 's'})`);
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      record.pdfError = err.message;
      log(`PDFs not printed: ${err.message.split('\n')[0]}`);
    }
  }

  // 6. Last year's manual schedule, for the comparison.
  record.lastYear = lastYearStats(CSV_FILE, LAST_YEAR);
  log(`last year (${LAST_YEAR}): ${record.lastYear.meetings} meetings, ${record.lastYear.hours} h, ${record.lastYear.labs} labs, at most ${record.lastYear.atOnce.classes} classes / ${record.lastYear.atOnce.labs} labs at once, Saturday ${record.lastYear.saturdayBlocks}, before 08:00 ${record.lastYear.startsBefore8}`);

  record.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'sem2-rehearsal.json'), `${JSON.stringify(record, null, 2)}\n`);
  log(`record written to ${path.relative(REPO, path.join(OUT, 'sem2-rehearsal.json'))}`);
})().catch((err) => {
  console.error(`[rehearsal] ${err.stack || err.message}`);
  process.exit(1);
});
