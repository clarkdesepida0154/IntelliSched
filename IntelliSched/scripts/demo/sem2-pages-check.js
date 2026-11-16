// Phase 4 Part 3, Step 4: the words and data on the pages for 2nd Semester AY 2026-2027, read from the
// real pages of a running `npm run demo:sem2` (headless Microsoft Edge, Playwright from client/node_modules):
//   as the TEST Dean: Faculty (the 18 names exactly as in the term file, Faculty full-time, the weekend
//   unavailable days, every evaluation shown as "0 – none yet" or a rating), Curriculum & Subjects
//   (PATHFIT 1-4; the curriculum's codes, not the forms' typos), Output Settings (the signatories);
//   and (Phase 8 Part 8: one account) Sections (the 19 sections; add, rename and disable a test section).
// Usage (repo root, a console): node scripts/demo/sem2-pages-check.js [--out <file.json>]
// It records counts and names only (never a rating). The test section it adds ("BSIT 9Z" -> "BSIT 9Y")
// is left disabled in the demo's own _test database.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const OUT = path.resolve(REPO, argOf('--out', path.join('.demo-data', 'sem2-pages-check.json')));
const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
const CLIENT = run.clientUrl || `http://localhost:${run.ports.client}`;
const API = `http://localhost:${run.ports.gateway}/api`;
const TERM = { academicYear: run.term?.academicYear || '2026-2027', semesterLabel: run.term?.semesterLabel || '2nd Semester' };
const term = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'data', 'term_2nd_sem_AY2026_27.json'), 'utf8'));
const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
const log = (m) => console.log(`[pages ${new Date().toISOString().slice(11, 19)}] ${m}`);
const checks = [];
const record = (name, pass, detail) => { checks.push({ name, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const signIn = async (browser, email, password) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(([year, semester]) => {
    try { window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: year, activeSemester: semester })); } catch { /* none */ }
  }, [TERM.academicYear, TERM.semesterLabel]);
  await page.goto(CLIENT);
  await page.getByTestId('login-username').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
  return page;
};
const open = async (page, hash, heading) => {
  await page.goto(`${CLIENT}/#/${hash}`);
  await page.waitForFunction((name) => document.querySelector('[data-testid="topbar-page-name"]')?.textContent.trim() === name, heading, { timeout: 30000 });
  await page.waitForTimeout(800);
};
const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll('table tbody tr')].map(tr => ({
  text: tr.innerText.replace(/\s+/g, ' ').trim(),
  cells: [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim()),
  noScore: Boolean(tr.querySelector('[data-testid="faculty-no-score"]'))
})));
const currentTerm = (page) => page.evaluate(() => document.querySelector('[data-testid="current-term"]')?.innerText.replace(/\s+/g, ' ').trim() || '');

(async () => {
  if (run.state !== 'ready' || !['sem2', 'defense'].includes(run.mode)) throw new Error(`The demo is not a ready 2nd-semester demo (mode ${run.mode}, state ${run.state}).`);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const out = { startedAt: new Date().toISOString(), mode: run.mode, checks };
  try {
    // ------------------------------------------------------------------ as the Dean
    const dean = await signIn(browser, secrets.deanEmail, secrets.deanPassword);

    // Faculty
    await open(dean, 'faculty', 'Faculty');
    record('Faculty: the page shows the current term', /2nd Semester/.test(await currentTerm(dean)) && /2026/.test(await currentTerm(dean)), await currentTerm(dean));
    const facultyRows = await rowsOf(dean);
    const names = term.faculty.map(f => f.name);
    const missing = names.filter(n => !facultyRows.some(r => r.text.includes(n)));
    record('Faculty: the 18 names exactly as in the term file', facultyRows.length === 18 && missing.length === 0, `${facultyRows.length} rows${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
    // Only the facts are recorded, never a row's text (the rows carry the specializations).
    const Faculty = facultyRows.find(r => r.text.includes('Alejandro V. Faculty Jr.'));
    record('Faculty: Faculty is full-time', Boolean(Faculty) && /Full-time/.test(Faculty.text) && !/Part-time/.test(Faculty.text), Faculty ? (/Full-time/.test(Faculty.text) ? 'Full-time shown' : 'Full-time NOT shown') : 'no row');
    // The Unavailable column prints each block as "Sat 7:00 AM–5:00 PM" (the day's first three letters).
    const weekend = [['FacultyMember', 'Sat'], ['FacultyMember', 'Sat'], ['FacultyMember', 'Sat'], ['FacultyMember', 'Sun']];
    const dayShown = (text, day) => new RegExp(`\\b${day}\\b`).test(text);
    const weekendShown = weekend.map(([n, day]) => { const r = facultyRows.find(x => x.text.includes(n)); return { n, day, ok: Boolean(r) && dayShown(r.text, day) }; });
    record('Faculty: the weekend unavailable days (Saturday ×3, Sunday ×1)', weekendShown.every(w => w.ok), weekendShown.map(w => `${w.n.split(' ').at(-1)} ${w.day} ${w.ok ? 'shown' : 'NOT shown'}`).join(', '));
    const others = facultyRows.filter(r => !weekend.some(([n]) => r.text.includes(n)));
    record('Faculty: the other professors show no unavailable weekend day', others.every(r => !dayShown(r.text, 'Sat') && !dayShown(r.text, 'Sun')), `${others.length} rows`);
    const noneYet = facultyRows.filter(r => r.noScore && r.text.includes('0 – none yet')).length;
    const rated = facultyRows.filter(r => !r.noScore && /\b[1-5]\.\d\d \/ 5\.0\b/.test(r.text)).length;
    record('Faculty: every evaluation reads as the stored value or "0 – none yet"', noneYet + rated === facultyRows.length, `${rated} with a rating shown, ${noneYet} "0 – none yet" (values not recorded)`);

    // Curriculum & Subjects
    await open(dean, 'subjects', 'Curriculum & Subjects');
    const search = dean.getByTestId('catalog-search');
    await search.fill('PATHFIT');
    await dean.waitForTimeout(500);
    const pathfit = await rowsOf(dean);
    const wanted = term.catalogChanges.map(c => c.to);
    const pathfitOk = wanted.every(w => pathfit.some(r => r.text.includes(w.subjectCode) && r.text.includes(w.descriptiveTitle)));
    record('Curriculum & Subjects: PATHFIT 1-4 with their titles, no PE', pathfit.length === 4 && pathfitOk, pathfit.map(r => r.cells[0]).join(', '));
    await search.fill('PE ');
    await dean.waitForTimeout(500);
    const pe = (await rowsOf(dean)).filter(r => /^PE \d/.test(r.cells[0] || ''));
    record('Curriculum & Subjects: no "PE n" subject left', pe.length === 0, `${pe.length} rows`);
    // The curriculum's codes for the subjects the forms misprint (SECOND_SEM_2025_26_NOTES.md).
    const codes = [['ITEP 101', 'Human Computer Interaction 1'], ['ITEC 103', 'Intermediate Programming'], ['ITEL 203', 'Web Systems and Technologies'], ['ITEP 207', 'Networking 1'], ['ITEL 305', 'System Integration and Architecture 2'], ['ITEC 306', 'Applications Development and Emerging Technologies'], ['CMSC 313', 'Human Computer Interaction (HCI)'], ['CMSC 315', 'Social Issues and Professional Practices']];
    const codeResults = [];
    for (const [code, title] of codes) {
      await search.fill(code);
      await dean.waitForTimeout(400);
      const rows = await rowsOf(dean);
      codeResults.push({ code, ok: rows.some(r => r.cells[0] === code && r.text.includes(title)) });
    }
    record("Curriculum & Subjects: the curriculum's codes (not the forms' typos)", codeResults.every(c => c.ok), codeResults.map(c => `${c.code} ${c.ok ? 'ok' : 'MISSING'}`).join(', '));
    await search.fill('');

    // Output Settings
    await open(dean, 'output-settings', 'Output Settings');
    const sig = await dean.evaluate(() => [0, 1, 2, 3].map(i => ({
      label: document.querySelector(`[data-testid="os-teachersProgram-sig-label-${i}"]`)?.value ?? null,
      name: document.querySelector(`[data-testid="os-teachersProgram-sig-name-${i}"]`)?.value ?? null,
      title: document.querySelector(`[data-testid="os-teachersProgram-sig-title-${i}"]`)?.value ?? null
    })));
    const campus = await dean.evaluate(() => document.querySelector('[data-testid="os-all-campusCode"]')?.value ?? null);
    const expected = term.outputSettings.teachersProgramSignatories;
    const byLabel = (label) => sig.find(s => s.label === label);
    const sigOk = byLabel('Prepared by:')?.name === expected.preparedBy.name && byLabel('Recommending Approval:')?.name === expected.recommendingApproval.name && byLabel('Approved:')?.name === expected.approvedBy.name;
    record("Output Settings: the Teachers' Program signatories filled in from the term file", sigOk, sig.map(s => `${s.label || '?'} ${s.name || '(empty)'}${s.title ? `, ${s.title}` : ''}`).join(' | '));
    record('Output Settings: the campus code', campus === term.outputSettings.campusCode, String(campus));
    out.dean = { facultyRows: facultyRows.length, rated, noneYet, signatories: sig, campusCode: campus };
    await dean.context().close();

    // ---------------------------------------------- Sections (as the TEST Dean: Phase 8 Part 8, one account)
    const sec = await signIn(browser, secrets.deanEmail, secrets.deanPassword);
    await open(sec, 'sections', 'Sections');
    const before = await rowsOf(sec);
    const codesShown = before.map(r => r.cells[0]);
    const termCodes = term.sections.map(s => s.sectionCode);
    const missingSections = termCodes.filter(c => !codesShown.includes(c));
    record('Sections (Dean): the 19 sections of the term file', missingSections.length === 0, `${before.length} rows${missingSections.length ? `; missing ${missingSections.join(', ')}` : ''}`);
    // The test section's codes, unused so far (an earlier run leaves its own disabled).
    const free = 'ZYXWVUTSRQP'.split('').map(l => `BSIT 9${l}`).filter(c => !codesShown.includes(c));
    const [codeA, codeB] = free;
    if (!codeB) throw new Error('No free test section code left (BSIT 9Z … 9P are all used).');
    // Add
    await sec.getByTestId('section-add').click();
    await sec.getByTestId('section-code').fill(codeA);
    await sec.getByTestId('section-program').selectOption('BSIT');
    await sec.getByTestId('section-year').selectOption('1');
    await sec.getByTestId('section-submit').click();
    await sec.waitForTimeout(1200);
    const toastAdd = await sec.evaluate(() => document.querySelector('[data-testid="section-toast-message"]')?.innerText || '');
    const afterAdd = await rowsOf(sec);
    record('Sections (Dean): add a section', afterAdd.some(r => r.cells[0] === codeA), toastAdd || `${afterAdd.length} rows`);
    const token = (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: secrets.deanEmail, password: secrets.deanPassword }) })).json()).token;
    const sections = await (await fetch(`${API}/sections`, { headers: { authorization: `Bearer ${token}` } })).json();
    const added = sections.find(s => s.sectionCode === codeA);
    // Rename: the row's Edit control when it has an accessible name, else the same route the form uses.
    let renamedHow = `the row's Edit button (${codeA} -> ${codeB})`;
    const row = sec.locator('table tbody tr', { hasText: codeA }).first();
    const editButton = row.getByRole('button', { name: /edit/i });
    if (await editButton.count()) {
      await editButton.first().click();
      await sec.getByTestId('section-code').fill(codeB);
      await sec.getByTestId('section-submit').click();
      await sec.waitForTimeout(1200);
    } else {
      renamedHow = `PUT /sections/:id as the TEST Dean (the row has no named Edit button; ${codeA} -> ${codeB})`;
      const res = await fetch(`${API}/sections/${added._id}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ sectionCode: codeB }) });
      if (res.status !== 200) throw new Error(`rename: ${res.status}`);
      await open(sec, 'sections', 'Sections');
    }
    const afterRename = await rowsOf(sec);
    record('Sections (Dean): rename a section', afterRename.some(r => r.cells[0] === codeB) && !afterRename.some(r => r.cells[0] === codeA), renamedHow);
    // Disable: the row's Disable control (it asks first), else the toggle route.
    let disabledHow = 'the row\'s Disable button';
    const row2 = sec.locator('table tbody tr', { hasText: codeB }).first();
    const disableButton = row2.getByRole('button', { name: /disable/i });
    if (await disableButton.count()) {
      await disableButton.first().click();
      const confirm = sec.getByRole('button', { name: /^disable/i }).last();
      if (await confirm.count()) await confirm.click();
      await sec.waitForTimeout(1200);
    } else {
      disabledHow = 'PATCH /sections/:id/toggle as the TEST Dean (the row has no named Disable button)';
      const res = await fetch(`${API}/sections/${added._id}/toggle`, { method: 'PATCH', headers: { authorization: `Bearer ${token}` } });
      if (res.status !== 200) throw new Error(`disable: ${res.status}`);
    }
    const now = await (await fetch(`${API}/sections`, { headers: { authorization: `Bearer ${token}` } })).json();
    const testSection = now.find(s => s._id === added._id);
    record('Sections (Dean): disable a section', testSection && testSection.isActive === false && testSection.sectionCode === codeB, `${disabledHow}; active sections now ${now.filter(s => s.isActive).length}`);
    out.secretary = { sectionsBefore: before.length, testSection: testSection ? { code: testSection.sectionCode, isActive: testSection.isActive } : null };
    await sec.context().close();
  } finally {
    await browser.close();
  }
  out.endedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  const failed = checks.filter(c => !c.pass).length;
  log(`${checks.length - failed} passed, ${failed} failed; record written to ${path.relative(REPO, OUT)}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(`[pages] ${err.stack || err.message}`);
  process.exit(1);
});
