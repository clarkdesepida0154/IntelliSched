// Phase 7, Step 3: a screenshot of every page, for the manuscript and the user documentation.
// On `npm run demo:sem2:reset -- --faculty-seed` (tracked data only, so no rating can appear), through the
// real pages: Playwright, headless Microsoft Edge, a 1366 × 768 window, the light theme, PNG, the whole
// page when it scrolls (a part of a page, such as the unavailable-times grid inside the Faculty form, is
// the window scrolled to that part). Names: NN-group-page-state.png, NN in the order of the side menu and
// the Dean's path; docs/screenshots/README.md is the index (file, page, role, what it shows, data state).
//   node scripts/demo/doc-screenshots.js [--out <a folder git ignores>]
// Safety (final-evidence.js's rules): every image is made in .demo-data/doc-screenshots/ first and the
// committed folder is replaced only when every shot passed; only the 2nd-semester demo (mode sem2), never
// the defense database; the committed folder only from a demo whose faculty came from the seed file
// (--out for a private set, into a folder git ignores); the Phase 6 evidence folders are never written;
// a page that shows an evaluation rating stops it before anything is copied.
// What it changes in the demo, as the Dean's path does: one generation as the TEST Dean, one allowed move saved,
// the review and the Dean's approval of that Draft (Phase 8 Part 10: the term file already holds every class, so
// nothing is assigned). Every form, panel and confirmation it only shows is closed without saving; the error
// scenes plant a problem on the practice copy and undo it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const RUN_FILE = path.join(REPO, '.demo-data', 'run.json');
const WORK = path.join(REPO, '.demo-data', 'doc-screenshots');
const COMMITTED = path.join(REPO, 'docs', 'screenshots');
const TERM_FILE = path.join(REPO, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const VIEWPORT = { width: 1366, height: 768 };
const Faculty = 'FacultyMember';
const RATING_TEXT = /Student evaluation: [0-9]|\b[1-5]\.\d\d \/ 5\.0\b/;
const MIN_BYTES = 15000;
const log = (m) => console.log(`[shots ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const isInside = (dir, root) => { const rel = path.relative(root, dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const gitIgnores = (file) => {
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd: REPO, stdio: 'ignore' }); return true; } catch (err) { if (err.status === 1) return false; throw err; }
};

// A move the validator must refuse (final-evidence.js): one class of a section on the day and start of
// another class of the same section; weekday classes only.
const clashingMove = (out) => {
  const { policy } = out;
  const movable = (c) => !c.isFixed && (policy.weekdays || []).includes(c.day);
  const moves = [];
  for (const section of out.sections) {
    const classes = out.classes.filter(c => c.sectionId === section.id && movable(c));
    for (const cls of classes) {
      for (const other of classes) {
        if (other.itemId === cls.itemId) continue;
        const start = Math.min(toMin(other.startTime), toMin(policy.dayEnd) - cls.durationSlots * policy.slotMinutes);
        if (start < toMin(policy.dayStart) || (other.day === cls.day && start === toMin(cls.startTime))) continue;
        moves.push({ section, cls, other, day: other.day, start: fromMin(start), rank: (cls.subjectId === other.subjectId ? 2 : 0) + (cls.day === other.day ? 1 : 0) });
      }
    }
  }
  return moves.sort((a, b) => a.rank - b.rank)[0] || null;
};
// Times to try for an allowed move of `cls`: weekday starts where its section has no class, after the
// lunch window first (15:00 on), then the early morning, then the rest.
const freeStarts = (out, cls) => {
  const { policy } = out;
  const length = cls.durationSlots * policy.slotMinutes;
  const mine = out.classes.filter(c => c.sectionId === cls.sectionId && c.itemId !== cls.itemId);
  const starts = [];
  for (const day of policy.weekdays || []) {
    for (let s = Math.max(toMin(policy.dayStart), toMin('08:00')); s + length <= toMin(policy.dayEnd); s += policy.slotMinutes) {
      if (day === cls.day && s === toMin(cls.startTime)) continue;
      if (mine.some(c => c.day === day && toMin(c.startTime) < s + length && s < toMin(c.endTime))) continue;
      starts.push({ day, start: fromMin(s), rank: s >= toMin('15:00') ? 0 : s + length <= toMin('10:00') ? 1 : 2 });
    }
  }
  return starts.sort((a, b) => a.rank - b.rank);
};

(async () => {
  if (!fs.existsSync(RUN_FILE)) throw new Error('No demo is running: start `npm run demo:sem2:reset -- --faculty-seed` first.');
  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (run.state !== 'ready' || run.mode !== 'sem2') throw new Error(`Needs a ready 2nd-semester demo (npm run demo:sem2:reset -- --faculty-seed), not mode ${run.mode} / state ${run.state}; never the defense database.`);
  const asked = String(argOf('--out', '')).trim();
  const target = asked ? path.resolve(asked) : COMMITTED;
  if (asked && isInside(target, REPO) && !gitIgnores(path.join(target, '01-sample.png'))) throw new Error(`--out names ${path.relative(REPO, target) || 'the repo root'}, a folder git would commit. Choose a folder git ignores (e.g. .demo-data/private-shots) or one outside the repo; leave --out out to remake docs/screenshots/.`);
  if (!asked && run.facultySource !== 'seed') throw new Error(`Refusing to write docs/screenshots/: it is made from tracked data only, and this demo's faculty came from ${run.facultySource === 'faculty_data' ? 'docs/data/faculty_data.json, which is gitignored' : 'a source it did not record'}. Restart it with \`npm run demo:sem2:reset -- --faculty-seed\`, or give --out a folder git ignores.`);
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  for (const field of ['deanEmail', 'deanPassword']) if (!secrets[field]) throw new Error(`The demo's secrets file has no ${field}: start the demo once to make it.`);
  const CLIENT = run.clientUrl || `http://localhost:${run.ports.client}`;
  const API = `http://localhost:${run.ports.gateway}/api`;
  const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
  const SEMESTER_LABEL = TERM.semester === 2 ? '2nd Semester' : '1st Semester';
  const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const record = { startedAt: new Date().toISOString(), database: run.database, facultySource: run.facultySource, shots: [], facts: {} };

  const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const newPage = async () => {
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
    const page = await context.newPage();
    await page.addInitScript(([year, semester]) => {
      try {
        window.localStorage.setItem('intellisched-theme', 'light');
        window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: year, activeSemester: semester }));
      } catch { /* none */ }
    }, [TERM.academicYear, SEMESTER_LABEL]);
    return page;
  };
  const signIn = async (email, password) => {
    const page = await newPage();
    await page.goto(CLIENT);
    await page.getByTestId('login-username').fill(email);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();
    await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
    return page;
  };
  // The page's own session, for the few reads the script needs (one sign-in per role: the login route is rate-limited).
  const apiOf = (page) => async (method, route, body) => {
    const token = await page.evaluate(() => window.localStorage.getItem('intellisched_token'));
    const res = await fetch(`${API}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const settle = async (page, ms = 700) => {
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };
  const open = async (page, hash, heading) => {
    await page.goto(`${CLIENT}/#/${hash}`);
    if (heading) await page.waitForFunction((name) => document.querySelector('[data-testid="topbar-page-name"]')?.textContent.trim() === name, heading, { timeout: 30000 });
  };
  const gone = (page, id, timeout = 60000) => page.waitForFunction((tid) => !document.querySelector(`[data-testid="${tid}"]`), id, { timeout });
  const shown = (page, id, timeout = 60000) => page.getByTestId(id).first().waitFor({ state: 'visible', timeout });

  // One screenshot. mode 'page': the whole page (the window grows to the scrolled content's height);
  // 'window': the 1366 × 768 window as it is (a part of a page scrolled into view, or a dialog).
  const shoot = async (page, { group, name, title, role, shows, state }, { mode = 'page', wait = 700 } = {}) => {
    await settle(page, wait);
    const text = await page.evaluate(() => document.body.innerText);
    if (RATING_TEXT.test(text)) throw new Error(`The page for "${name}" shows an evaluation rating; nothing is written.`);
    const file = `${String(record.shots.length + 1).padStart(2, '0')}-${group}-${slug(name)}.png`;
    if (mode === 'page') {
      const height = await page.evaluate(() => {
        const scroller = document.querySelector('main > div.overflow-y-auto');
        return Math.max(768, (scroller ? scroller.scrollHeight : document.documentElement.scrollHeight) + 90);
      });
      await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(height, 12000) });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(WORK, file), fullPage: true });
      await page.setViewportSize(VIEWPORT);
    } else {
      await page.screenshot({ path: path.join(WORK, file) });
    }
    const bytes = fs.statSync(path.join(WORK, file)).size;
    if (bytes < MIN_BYTES) throw new Error(`${file} is only ${bytes} bytes: the page did not draw.`);
    record.shots.push({ file, page: title, role, shows, state, bytes, mode });
    log(`${file} (${Math.round(bytes / 1024)} KB): ${shows}`);
  };
  // Phase 8 Part 10: a picture that is not a page of the app (an export PDF page drawn by Windows' own PDF engine).
  const addImage = (src, { group, name, title, role, shows, state }) => {
    const file = `${String(record.shots.length + 1).padStart(2, '0')}-${group}-${slug(name)}.png`;
    fs.copyFileSync(src, path.join(WORK, file));
    const bytes = fs.statSync(path.join(WORK, file)).size;
    if (bytes < MIN_BYTES) throw new Error(`${file} is only ${bytes} bytes: the PDF did not draw.`);
    record.shots.push({ file, page: title, role, shows, state, bytes, mode: 'pdf' });
    log(`${file} (${Math.round(bytes / 1024)} KB): ${shows}`);
  };
  // The practice copy's own database, only to plant and undo a state the pages cannot make (never another database).
  const withDb = async (fn) => {
    if (!/_test$/.test(run.database)) throw new Error(`Refusing to open ${run.database}: only a _test database.`);
    const { MongoClient } = require(path.join(REPO, 'server', 'node_modules', 'mongodb'));
    const client = new MongoClient(`mongodb://127.0.0.1:${run.ports.mongo}/?directConnection=true`);
    await client.connect();
    try { return await fn(client.db(run.database)); } finally { await client.close(); }
  };
  const BEFORE = "Before generation: the term as loaded from the Dean's own session of 9 Oct (19 sections enabled, 18 professors, every class assigned, tracked data only).";
  const BEFORE_ASSIGNED = BEFORE;
  let AFTER = '';

  try {
    // ------------------------------------------------------------ sign-in
    const loginPage = await newPage();
    await loginPage.goto(CLIENT);
    await shown(loginPage, 'login-submit', 30000);
    await shoot(loginPage, { group: 'sign-in', name: 'login', title: 'Sign-in', role: 'Signed out', shows: 'The sign-in page: the email and the password with their labels, show/hide password, "Secure Sign In".', state: 'Signed out.' });
    await loginPage.getByTestId('login-username').fill(secrets.deanEmail);
    await loginPage.getByTestId('login-password').fill('not-the-password');
    await loginPage.getByTestId('login-submit').click();
    await loginPage.getByRole('alert').first().waitFor({ timeout: 20000 });
    record.facts.refused = (await loginPage.getByRole('alert').first().innerText()).trim();
    await shoot(loginPage, { group: 'err', name: 'sign-in-wrong-password', title: 'Sign-in', role: 'Signed out', shows: `A refused sign-in (a wrong password): "${record.facts.refused}"; the email stays typed.`, state: 'Signed out.' });
    await loginPage.context().close();

    // ------------------------------------------------------------ the Dean, before generation
    const dean = await signIn(secrets.deanEmail, secrets.deanPassword);
    const api = apiOf(dean);
    await open(dean, 'checklist', 'Term Checklist');
    await dean.waitForFunction(() => /steps? done/.test(document.querySelector('[data-testid="checklist-summary"]')?.innerText || ''), null, { timeout: 120000 });
    record.facts.checklistBefore = (await dean.getByTestId('checklist-summary').innerText()).replace(/\s+/g, ' ').trim();
    await shoot(dean, { group: 'main', name: 'term-checklist-before-generation', title: 'Term Checklist', role: 'Dean', shows: `The Main page right after signing in: the six steps with their status from real data and the next action; "${record.facts.checklistBefore}".`, state: BEFORE });

    await open(dean, 'subjects', 'Curriculum & Subjects');
    await shown(dean, 'catalog-search');
    await shoot(dean, { group: 'setup', name: 'curriculum-master-catalog', title: 'Curriculum & Subjects → Master Catalog', role: 'Dean', shows: 'The Master Catalog: every subject with its code, title, type and hours; search, filters, sorting and pages of 25 (a subject\'s form holds "Needs a CCS room" and, for a Major, the Lecture mode).', state: BEFORE });
    await dean.getByRole('tab', { name: /Curriculum Builder/ }).click();
    await shown(dean, 'builder-context', 30000);
    await shoot(dean, { group: 'setup', name: 'curriculum-builder', title: 'Curriculum & Subjects → Curriculum Builder', role: 'Dean', shows: 'The Curriculum Builder: a program, year, semester and track block with its subjects and the sentence saying which sections it reaches.', state: BEFORE });

    await open(dean, 'sections', 'Sections');
    await shown(dean, 'section-search');
    await shoot(dean, { group: 'setup', name: 'sections-table', title: 'Sections', role: 'Dean', shows: 'The sections: the 19 enabled this term and the Dean\'s full set\'s disabled ones (the College Secretary enables sections per term), with program, year level, track, search and sorting.', state: BEFORE });
    await dean.getByTestId('section-search').fill('no such section');
    await dean.waitForTimeout(600);
    await shoot(dean, { group: 'setup', name: 'sections-search-no-match', title: 'Sections', role: 'Dean', shows: 'An empty table: a search that matches no section shows the empty state with its next action.', state: BEFORE });
    await dean.getByTestId('section-search').fill('');
    await dean.waitForTimeout(400);
    await dean.locator('tbody tr', { hasText: 'BSIT 1A' }).first().locator('button[aria-label^="Edit"]').click();
    await shown(dean, 'section-code', 15000);
    await shoot(dean, { group: 'setup', name: 'sections-edit-form', title: 'Sections', role: 'Dean', shows: 'The edit form of BSIT 1A: labelled fields, the required ones marked, Save and Cancel.', state: BEFORE }, { mode: 'window' });
    const writesBefore = [];
    const watchWrites = (req) => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method()) && req.url().includes('/api/sections')) writesBefore.push(req.url()); };
    dean.on('request', watchWrites);
    await dean.getByTestId('section-code').fill('');
    await dean.getByTestId('section-submit').click();
    await dean.locator('[role=dialog] [role=alert], [role=dialog] [id$="-error"]').first().waitFor({ timeout: 15000 });
    await shoot(dean, { group: 'err', name: 'required-field-empty', title: 'Sections', role: 'Dean', shows: 'A field\'s validation message: the section code left empty, the message next to the field in plain words; nothing is saved and what was typed stays.', state: BEFORE }, { mode: 'window' });
    await dean.keyboard.press('Escape');
    await dean.waitForTimeout(400);
    dean.off('request', watchWrites);
    record.facts.sectionWritesWhileShowing = writesBefore.length;

    await open(dean, 'rooms', 'Rooms');
    await shown(dean, 'room-search');
    await shoot(dean, { group: 'setup', name: 'rooms-table', title: 'Rooms', role: 'Dean', shows: 'The 6 CCS rooms (3 LEC, 3 LAB) with their type and availability.', state: BEFORE });
    await dean.locator('tbody tr', { hasText: 'LAB 1' }).first().locator('button[aria-label^="Edit"]').click();
    await shown(dean, 'room-name', 15000);
    await shoot(dean, { group: 'setup', name: 'rooms-edit-form', title: 'Rooms', role: 'Dean', shows: 'The edit form of LAB 1: name, type, the optional capacity and building, and the availability windows of a borrowed room.', state: BEFORE }, { mode: 'window' });
    // An invalid value: an availability window that ends before it starts. Nothing is saved.
    await dean.getByTestId('room-availability-add').click();
    await dean.getByTestId('room-availability-start-0').selectOption({ index: 12 });
    await dean.getByTestId('room-availability-end-0').selectOption({ index: 3 });
    await dean.getByTestId('room-submit').click();
    await dean.locator('[role=dialog] [role=alert], [role=dialog] [id$="-error"]').first().waitFor({ timeout: 15000 });
    record.facts.invalidWindow = (await dean.locator('[role=dialog] [role=alert], [role=dialog] [id$="-error"]').first().innerText()).trim();
    await shoot(dean, { group: 'err', name: 'invalid-value-window-ends-before-start', title: 'Rooms', role: 'Dean', shows: `An invalid value: an availability window that ends before it starts; "${record.facts.invalidWindow}" next to the field; nothing is saved and what was typed stays.`, state: BEFORE }, { mode: 'window' });
    await dean.keyboard.press('Escape');
    await dean.waitForTimeout(400);

    await open(dean, 'faculty', 'Faculty');
    await shown(dean, 'faculty-search');
    await shoot(dean, { group: 'setup', name: 'faculty-table', title: 'Faculty', role: 'Dean', shows: 'The 18 professors: employment type, teaching hours this term against the cap, ancillary hours by type, unavailable times, the evaluation ("0 – none yet": tracked data only) and the status.', state: BEFORE });
    // The professor with the most unavailable times, so the grid shows marked cells.
    const busiest = (await api('GET', '/faculty')).data.filter(p => p.isActive)
      .sort((a, b) => (b.unavailableBlocks?.length || 0) - (a.unavailableBlocks?.length || 0) || a.name.localeCompare(b.name))[0];
    record.facts.gridProfessor = { name: busiest.name, rows: busiest.unavailableBlocks?.length || 0 };
    await dean.locator('tbody tr', { hasText: busiest.name }).first().locator('button[aria-label^="Edit"]').click();
    await shown(dean, 'faculty-name', 15000);
    await shoot(dean, { group: 'setup', name: 'faculty-edit-form', title: 'Faculty', role: 'Dean', shows: `The edit form of ${busiest.name}: employment type, position, the evaluation field, the teaching cap, the specializations and the ancillary hours by type.`, state: BEFORE }, { mode: 'window' });
    await dean.getByTestId('faculty-grid').scrollIntoViewIfNeeded();
    await dean.getByTestId('faculty-grid').evaluate(el => el.scrollIntoView({ block: 'center' }));
    await shoot(dean, { group: 'setup', name: 'faculty-unavailable-times-grid', title: 'Faculty', role: 'Dean', shows: `The "Unavailable times" grid in the same form: the weekdays and Saturday in 30-minute cells, ${busiest.name}'s ${record.facts.gridProfessor.rows === 1 ? '1 unavailable time' : `${record.facts.gridProfessor.rows} unavailable times`} marked (click or drag to mark), with the list of the same rows under it.`, state: BEFORE }, { mode: 'window' });
    await dean.keyboard.press('Escape');
    await dean.waitForTimeout(400);

    // Archive a professor who still has classes: refused with the classes named (nothing changes).
    await dean.locator('tbody tr', { hasText: Faculty }).first().locator('button[aria-label^="Archive"]').click();
    await shown(dean, 'archive-confirm-confirm', 15000);
    await dean.getByTestId('archive-confirm-confirm').click();
    await shown(dean, 'archive-classes', 30000);
    record.facts.archiveRefused = (await dean.getByTestId('archive-classes').locator('p').first().innerText()).replace(/\s+/g, ' ').trim();
    await shoot(dean, { group: 'err', name: 'archive-professor-with-classes', title: 'Faculty', role: 'Dean', shows: `Archiving a professor who still has classes is refused: "${record.facts.archiveRefused}" with the classes listed and "Open Assign Faculty"; nothing changes.`, state: BEFORE }, { mode: 'window' });
    await dean.keyboard.press('Escape');
    await dean.waitForTimeout(400);
    // Archive and Restore on a professor with no class this term.
    const lockedNow = (await api('GET', `/schedule/locks?${termQuery}`)).data.locks || [];
    const idle = (await api('GET', '/faculty')).data.filter(p => !p.archived)
      .find(p => !lockedNow.some(l => l.facultyName === p.name || String(l.facultyRef) === String(p._id)));
    if (!idle) throw new Error('No professor without a class for the Archive and Restore pictures.');
    await dean.locator('tbody tr', { hasText: idle.name }).first().locator('button[aria-label^="Archive"]').click();
    await shown(dean, 'archive-confirm-confirm', 15000);
    await shoot(dean, { group: 'setup', name: 'faculty-archive-confirmation', title: 'Faculty', role: 'Dean', shows: `The Archive confirmation for ${idle.name} (no class this term): what archiving does and that the profile can be restored from the "Archived" filter.`, state: BEFORE }, { mode: 'window' });
    await dean.getByTestId('archive-confirm-confirm').click();
    await gone(dean, 'archive-confirm', 30000);
    await dean.getByRole('button', { name: /^Filters/ }).click();
    await dean.locator('select:has(option:text-is("Archived"))').selectOption('archived');
    await dean.keyboard.press('Escape');
    await dean.waitForTimeout(600);
    await shoot(dean, { group: 'setup', name: 'faculty-archived-filter-restore', title: 'Faculty → Archived', role: 'Dean', shows: `The "Archived" filter: ${idle.name} with the Archived badge and Restore.`, state: BEFORE });
    await dean.locator('tbody tr', { hasText: idle.name }).first().getByRole('button', { name: /Restore/ }).click();
    await dean.waitForTimeout(1200);
    await dean.locator('select:has(option:text-is("Archived"))').selectOption('').catch(() => {});
    { const back = (await api('GET', '/faculty')).data.find(p => p.name === idle.name); record.facts.archiveRestored = Boolean(back) && !back.archived && Boolean(back.isActive) === Boolean(idle.isActive); }
    if (!record.facts.archiveRestored) throw new Error(`${idle.name} was not restored.`);

    await open(dean, 'policy', 'Scheduling Policy');
    await shown(dean, 'policy-page');
    await gone(dean, 'policy-loading');
    await shoot(dean, { group: 'setup', name: 'scheduling-policy-deans-settings', title: 'Scheduling Policy', role: 'Dean', shows: 'The Dean\'s plain settings (the 08:00\u201317:00 day, the lunch rule, Saturday off), "When the rooms are short" with "Alternate odd and even weeks" and the editable group table, the TBA rooms choice, the read-only Rules, and "Advanced (system team)" closed to the Dean with the reason.', state: BEFORE });
    await dean.locator('[data-testid="policy-weekGroups-on"]').first().evaluate(el => el.scrollIntoView({ block: 'center' }));
    await shoot(dean, { group: 'setup', name: 'scheduling-policy-rooms-choice', title: 'Scheduling Policy', role: 'Dean', shows: 'The rooms choices: "When the rooms are short" ("Alternate odd and even weeks", recommended, with the program-and-year table, or "Use TBA rooms only") and "When the CCS rooms are full" (TBA rooms or only the CCS rooms), each with what it means.', state: BEFORE }, { mode: 'window' });
    await open(dean, 'policy?section=rules', 'Scheduling Policy');
    await gone(dean, 'policy-loading');
    await dean.waitForTimeout(1200);
    await shoot(dean, { group: 'setup', name: 'scheduling-policy-rules', title: 'Scheduling Policy', role: 'Dean', shows: 'The Rules, read only: the hard rules every schedule keeps, in plain words.', state: BEFORE }, { mode: 'window' });

    await open(dean, 'assign-faculty?tab=by-class', 'Assign Faculty');
    await shown(dean, 'matrix-toolbar', 120000);
    await shoot(dean, { group: 'assign', name: 'faculty-by-class', title: 'Assign Faculty → By class', role: 'Dean', shows: 'By class: one row per subject and section with its professor or "No professor yet", the counts, filters by section and professor, and every professor\'s teaching hours against the cap.', state: BEFORE });
    // Phase 8 Step 4: the part-time loads panel under the tabs (opened for the picture; nothing applied).
    await dean.getByTestId('pt-loads-toggle').evaluate(el => el.scrollIntoView({ block: 'center' }));
    await dean.getByTestId('pt-loads-toggle').click();
    await dean.getByTestId('pt-loads-table').waitFor({ timeout: 60000 });
    await dean.waitForTimeout(400);
    await shoot(dean, { group: 'assign', name: 'faculty-part-time-loads', title: 'Assign Faculty → Part-time teaching loads', role: 'Dean', shows: "The part-time loads panel: each part-timer's teaching hours against their cap, the average and the spread, and the Dean's equal-loads rule — the balanced term shows no further move, or a suggested balance with Apply behind a confirmation.", state: BEFORE }, { mode: 'window' });
    await dean.getByTestId('pt-loads-toggle').click();
    await open(dean, 'assign-faculty?tab=recommendations', 'Assign Faculty');
    await dean.waitForSelector('tbody [data-testid=ranking-likelihood]', { timeout: 240000 });
    await dean.getByTestId('ranking-search').fill('ITEP 205');
    await dean.waitForTimeout(900);
    record.facts.itep205 = await dean.evaluate(() => [...document.querySelectorAll('tbody tr')].filter(tr => tr.querySelectorAll('[data-testid=ranking-likelihood]').length)[0]?.innerText.replace(/\s+/g, ' ').slice(0, 160));
    await shoot(dean, { group: 'assign', name: 'faculty-recommendations-itep205', title: 'Assign Faculty → Recommendations', role: 'Dean', shows: 'Recommendations searched for ITEP 205: the 3 classes nobody on the current faculty has taught, each with the weak-ranking line above its three ranks, the Likelihood with its level, and each professor\'s hours against the cap.', state: BEFORE });
    await dean.getByTestId('ranking-search').fill('CMSC 101');
    await dean.waitForTimeout(900);
    await shoot(dean, { group: 'assign', name: 'faculty-recommendations-cmsc-101', title: 'Assign Faculty → Recommendations', role: 'Dean', shows: 'A class with history (CMSC 101): no weak-ranking line; the professor who taught it last 2nd semester ranks first with a High likelihood and is already assigned.', state: BEFORE });

    // The review dialog of an ITEP 205 class (its professor, Mr. Faculty, is the Dean's own decision of 9 Oct): shown, not changed.
    await dean.getByTestId('ranking-search').fill('ITEP 205');
    await dean.waitForTimeout(900);
    const weakRow = dean.locator('tr', { has: dean.locator('[data-testid^="ranking-weak-"]') }).first();
    await weakRow.getByRole('button', { name: /Review/ }).click();
    await dean.locator('[role=dialog]').first().waitFor({ timeout: 15000 });
    await shown(dean, 'review-weak-ranking', 15000);
    await dean.waitForTimeout(500);
    await shoot(dean, { group: 'assign', name: 'faculty-review-dialog-itep205', title: 'Assign Faculty → Recommendations', role: 'Dean', shows: "The review dialog of an ITEP 205 class: the weak-ranking line above the three ranks with their Likelihood, the professor to assign (the Dean's own choice stays marked \"Currently assigned\"), each professor's hours against the cap, \"Why another professor?\" for the reason, and Confirm Assignment (closed until the reason is written).", state: BEFORE }, { mode: 'window' });
    await dean.keyboard.press('Escape');
    await dean.waitForTimeout(400);

    // The Readiness Check with a ✖ line: a professor with no free weekday time (planted on the copy, undone below).
    const termLocks = (await api('GET', `/schedule/locks?${termQuery}`)).data.locks || [];
    const busyName = (() => {
      const counts = new Map();
      for (const l of termLocks) if (l.facultyName && !/^TBA$/i.test(l.facultyName)) counts.set(l.facultyName, (counts.get(l.facultyName) || 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    })();
    const busyProf = (await api('GET', '/faculty')).data.find(p => p.name === busyName);
    if (!busyProf) throw new Error('No professor with classes for the Readiness Check picture.');
    const wholeWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(day => ({ day, start: '08:00', end: '17:00' }));
    const savedBlocks = await withDb(async (db) => {
      const { ObjectId } = require(path.join(REPO, 'server', 'node_modules', 'mongodb'));
      const doc = await db.collection('faculty').findOne({ _id: new ObjectId(String(busyProf._id)) });
      await db.collection('faculty').updateOne({ _id: doc._id }, { $set: { unavailableBlocks: wholeWeek } });
      return { _id: doc._id, unavailableBlocks: doc.unavailableBlocks || [] };
    });
    try {
      await open(dean, 'readiness', 'Readiness Check');
      await dean.getByTestId('readiness-verdict').waitFor({ timeout: 90000 });
      await dean.waitForFunction(() => document.querySelector('[data-testid="readiness-verdict"]')?.dataset.verdict === 'not-ready', null, { timeout: 90000 });
      await dean.getByTestId('readiness-fix-8').first().waitFor({ timeout: 30000 }).catch(() => {});
      await shoot(dean, { group: 'err', name: 'readiness-not-ready-fix-this', title: 'Readiness Check', role: 'Dean', shows: `"Not ready yet": a ✖ line (${busyName} teaches classes but is marked unavailable on every weekday) with "Fix this" to the Faculty page; the other lines ✔ or ⚠.`, state: `${BEFORE} ${busyName}'s unavailable times planted on the copy for this picture and undone afterwards.` });
    } finally {
      await withDb(db => db.collection('faculty').updateOne({ _id: savedBlocks._id }, { $set: { unavailableBlocks: savedBlocks.unavailableBlocks } }));
    }

    // The Overload Guardian on "By class": a class whose top pick would pass the professor's teaching cap shows
    // "Over the cap" in red, Accept is closed (its hint reads "Capacity Exceeded: …") and the professor's option
    // in the list is closed ("over teaching cap"). Nothing is saved.
    await open(dean, 'assign-faculty?tab=by-class', 'Assign Faculty');
    await shown(dean, 'matrix-toolbar', 120000);
    const sectionValues = await dean.getByTestId('matrix-filter-section').evaluate(el => [...el.options].map(o => o.value).filter(Boolean));
    let guard = null;
    for (const value of sectionValues) {
      await dean.getByTestId('matrix-filter-section').selectOption(value);
      await dean.waitForTimeout(900);
      guard = await dean.evaluate(() => {
        const rows = [...document.querySelectorAll('tbody tr[data-testid^="matrix-class-"]')];
        const hit = rows.find(tr => /Over the cap/.test(tr.innerText));
        return hit ? { testid: hit.dataset.testid, text: hit.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) } : null;
      });
      if (guard) { guard.section = value; break; }
    }
    if (!guard) throw new Error('No class has a top pick over the cap, for the Overload Guardian picture.');
    record.facts.guardian = guard;
    await dean.getByTestId(guard.testid).evaluate(el => el.scrollIntoView({ block: 'center' }));
    await shoot(dean, { group: 'err', name: 'overload-guardian-over-the-cap', title: 'Assign Faculty → By class', role: 'Dean', shows: `The Overload Guardian: in ${guard.section}, a class whose top pick would pass the professor's teaching cap shows "Over the cap" in red and Accept is closed (its hint reads "Capacity Exceeded: assigning … would put the professor at … / … teaching hrs."); an over-cap professor is also closed in the list ("over teaching cap"). Nothing is saved.`, state: BEFORE }, { mode: 'window' });

    // Outside teachers, and live updates with two tabs: a GenEd class given to a teacher from another
    // college in the first tab shows in the second tab without a reload; both are undone afterwards.
    await open(dean, 'assign-faculty?tab=by-class', 'Assign Faculty');
    await shown(dean, 'matrix-toolbar', 120000);
    await dean.getByTestId('matrix-filter-section').selectOption('BSIT 1A');
    await dean.waitForTimeout(800);
    const geBase = await dean.evaluate(() => {
      for (const el of document.querySelectorAll('[data-testid$="-outside-name"]')) {
        const base = el.dataset.testid.replace(/-outside-name$/, '');
        const sel = document.querySelector(`[data-testid="${base}"]`);
        if (sel && !sel.disabled && /^(|tba|fac-tba)$/i.test(sel.value)) return base;
      }
      return null;
    });
    if (!geBase) throw new Error('No GenEd class without a professor in BSIT 1A for the outside teacher pictures.');
    const tab2 = await dean.context().newPage();
    await tab2.goto(`${CLIENT}/#/assign-faculty?tab=by-class`);
    await shown(tab2, 'outside-teachers', 120000);
    const OUTSIDE = 'Ramon Santos';
    await dean.getByTestId(`${geBase}-outside-name`).fill(OUTSIDE);
    await shoot(dean, { group: 'assign', name: 'outside-teacher-typed', title: 'Assign Faculty → By class', role: 'Dean', shows: `A GenEd class (${geBase.replace(/^matrix-assign-/, '').replace(/-/g, ' ')}) with the name of a teacher from another college typed in its own box (${OUTSIDE}); outside teachers have no Teachers' Program, load or cap, and do not use a CCS room.`, state: BEFORE }, { mode: 'window' });
    await dean.getByTestId(`${geBase}-outside-assign`).click();
    await dean.waitForFunction((n) => (document.querySelector('[data-testid=outside-teachers]')?.innerText || '').includes(n), OUTSIDE, { timeout: 30000 });
    await shoot(dean, { group: 'assign', name: 'outside-teachers-list', title: 'Assign Faculty → By class', role: 'Dean', shows: `The list of outside teachers under the table: ${OUTSIDE} with the class this term, Rename, and Remove (open only while the teacher has no class).`, state: BEFORE });
    await tab2.waitForFunction((n) => (document.querySelector('[data-testid=outside-teachers]')?.innerText || '').includes(n), OUTSIDE, { timeout: 30000 });
    record.facts.liveUpdate = 'the second tab showed the new outside teacher without a reload';
    await shoot(tab2, { group: 'assign', name: 'live-updates-second-tab', title: 'Assign Faculty → By class (second tab)', role: 'Dean', shows: `Live updates: a second tab left open on the same page shows ${OUTSIDE} a few seconds after the first tab saved it, without a reload.`, state: BEFORE });
    await tab2.close();
    // Undo: release the class, then remove the outside teacher.
    await dean.getByTestId(geBase).selectOption('');
    await dean.getByTestId(`${geBase}-assign`).click();
    await dean.waitForFunction(() => /No class this term/.test(document.querySelector('[data-testid=outside-teachers]')?.innerText || ''), null, { timeout: 30000 });
    const outsideId = await dean.evaluate(() => [...document.querySelectorAll('[data-testid^="outside-teacher-remove-"]')].map(b => b.dataset.testid.replace('outside-teacher-remove-', ''))[0]);
    await dean.getByTestId(`outside-teacher-remove-${outsideId}`).click();
    await dean.getByTestId('outside-teacher-remove-dialog-confirm').click();
    await shown(dean, 'outside-teachers-empty', 30000);

    await open(dean, 'readiness', 'Readiness Check');
    await dean.waitForFunction(() => document.querySelector('[data-testid="readiness-verdict"]')?.dataset.verdict === 'ready', null, { timeout: 90000 });
    record.facts.howWeKnow = await dean.evaluate(() => [...document.querySelectorAll('[data-testid$="-how"]')].map(p => p.innerText.replace(/\s+/g, ' ').trim()));
    if (!record.facts.howWeKnow.length) throw new Error('The rooms line has no "How we know".');
    await shoot(dean, { group: 'check', name: 'readiness-ready-how-we-know', title: 'Readiness Check', role: 'Dean', shows: '"Ready to generate": every line ✔ or ⚠; the rooms line with "How we know" — with the odd and even weeks each room is counted once per group, so the CCS rooms (LAB 4 included) hold every class.', state: BEFORE_ASSIGNED });

    // Generate Schedule as the Dean: before, running, the result.
    await open(dean, 'generate', 'Generate Schedule');
    await dean.waitForFunction(() => document.querySelector('[data-testid="readiness-verdict"]')?.dataset.verdict === 'ready', null, { timeout: 90000 });
    await shoot(dean, { group: 'check', name: 'generate-schedule-before', title: 'Generate Schedule', role: 'Dean', shows: 'Before the run: the readiness verdict only ("Ready to generate", "8 of 9 checks passed", the one ⚠ line, "See all checks"; Phase 8 Part 12), "Generate Mother Schedule" open, and "Advanced (system team)" collapsed.', state: BEFORE_ASSIGNED });
    let result = null;
    for (let attempt = 1; attempt <= 3 && (!result || result.status !== 'done'); attempt += 1) {
      await dean.getByTestId(attempt === 1 ? 'generate-button' : 'generate-try-again').click();
      const confirm = dean.getByTestId('generate-confirm');
      if (await confirm.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) await dean.getByTestId('generate-confirm-confirm').click();
      await shown(dean, 'generate-progress', 60000);
      await dean.waitForTimeout(3500);
      const status = await dean.evaluate(() => document.querySelector('[data-testid="generate-result"]')?.dataset.status || null);
      if (attempt === 1 && (!status || ['running', 'saving'].includes(status))) {
        await shoot(dean, { group: 'check', name: 'generate-schedule-running', title: 'Generate Schedule', role: 'Dean', shows: 'The run going: the plain progress line with the elapsed time and Cancel; the Dean can leave the page and come back.', state: 'Generating the Mother Schedule.' }, { wait: 0 });
      }
      const t0 = Date.now();
      for (;;) {
        const s = await dean.evaluate(() => document.querySelector('[data-testid="generate-result"]')?.dataset.status || null);
        if (s && !['running', 'saving'].includes(s)) break;
        if (Date.now() - t0 > 12 * 60000) throw new Error('The run did not end within 12 minutes.');
        await sleep(1000);
      }
      result = { status: await dean.getByTestId('generate-result').getAttribute('data-status'), title: (await dean.getByTestId('generate-result-title').innerText()).trim(), attempt };
      log(`run ${attempt}: ${result.status} - ${result.title}`);
    }
    if (result.status !== 'done') throw new Error(`The runs ended "${result.status}": ${result.title}`);
    record.facts.generate = result;
    await shoot(dean, { group: 'check', name: 'generate-schedule-result', title: 'Generate Schedule', role: 'Dean', shows: `The result: "${result.title}", with the TBA rooms to request, the Saturday classes, the time taken and the links to the outputs.`, state: 'Draft v1 just saved by the run.' });

    const out = (await api('GET', `/schedule/outputs?${termQuery}&prefer=draft`)).data;
    const scheduleId = out.schedule.id || out.schedule._id;
    record.facts.version = { version: out.schedule.version, classes: out.classes.length, tba: out.tbaRequest ? `${out.tbaRequest.classCount} classes, ${out.tbaRequest.labRooms} lab + ${out.tbaRequest.lecRooms} lecture rooms` : 'none' };
    AFTER = `After generation: ${out.schedule.version} (a Draft) with ${out.classes.length} classes, 0 conflicts.`;
    const sectionOf = (label) => out.sections.find(s => s.label === label || s.code === label);
    const bsit1a = sectionOf('BSIT 1A');
    const bscs1a = sectionOf('BSCS 1A');
    const Faculty = out.faculty.find(f => f.name === Faculty);
    const lab1 = out.rooms.find(r => r.kind === 'CCS' && r.name === 'LAB 1');
    // Phase 8: with the odd/even weeks and LAB 4 the run may have NO TBA room; the TBA pictures are
    // then left out (the Room Program shows every class in a CCS room instead).
    const firstTba = out.rooms.filter(r => r.kind === 'TBA' && r.classCount > 0)[0] || null;
    for (const [what, item] of [['BSIT 1A', bsit1a], ['BSCS 1A', bscs1a], [Faculty, Faculty], ['LAB 1', lab1]]) if (!item) throw new Error(`The version has no ${what}.`);

    await open(dean, 'checklist', 'Term Checklist');
    await dean.waitForFunction(() => /steps? done/.test(document.querySelector('[data-testid="checklist-summary"]')?.innerText || ''), null, { timeout: 120000 });
    await dean.waitForFunction(() => !document.querySelector('[data-testid^="checklist-step-"][data-status="loading"]'), null, { timeout: 120000 });
    await shoot(dean, { group: 'main', name: 'term-checklist-after-generation', title: 'Term Checklist', role: 'Dean', shows: `The Term Checklist after generation: step 4 done (${out.schedule.version}), the next step Review.`, state: AFTER });

    // ------------------------------------------------------------ Review & fix
    const views = async (view, entityKey, extra = '') => {
      await open(dean, `schedule-views?scheduleId=${scheduleId}&view=${view}&entityKey=${encodeURIComponent(entityKey)}${extra}`, 'Schedule Views & Editor');
      await shown(dean, 'views-entity-name', 60000);
      await settle(dean);
    };
    await views('section', bsit1a.id);
    await shoot(dean, { group: 'review', name: 'mother-schedule-bsit-1a', title: 'Schedule Views & Editor → Mother Schedule', role: 'Dean', shows: "The Mother Schedule of BSIT 1A on the class-schedule table (08:00 AM to 05:00 PM under the Phase 8 policy), with the section's weeks note (face-to-face in the odd weeks); PATHFIT and NSTP with no room, the GenEd classes TBA.", state: AFTER });
    await views('professor', Faculty.id);
    await shoot(dean, { group: 'review', name: 'teachers-program-Faculty', title: 'Schedule Views & Editor → Teachers\' Program', role: 'Dean', shows: `The Teachers' Program of ${Faculty}: her classes, the On-The-Job Training boxes, the duty blocks, the day totals and the load summary.`, state: AFTER });
    await views('room', lab1.key);
    await shoot(dean, { group: 'review', name: 'room-program-lab-1', title: 'Schedule Views & Editor → Room Program', role: 'Dean', shows: "The Room Program of LAB 1: the week filter (All / Odd / Even weeks), each class box with its section's week group, and the hours used and available.", state: AFTER });
    // Phase 8: the odd weeks alone, like the office's own per-group room files.
    if (await dean.getByTestId('views-week-filter-odd').count()) {
      await dean.getByTestId('views-week-filter-odd').click();
      await dean.waitForTimeout(600);
      await shoot(dean, { group: 'review', name: 'room-program-lab-1-odd-weeks', title: 'Schedule Views & Editor → Room Program', role: 'Dean', shows: "The same room filtered to the odd weeks: only the odd-week classes (and any class that meets every week), as in the office's odd-week room file.", state: AFTER });
      await dean.getByTestId('views-week-filter-both').click();
      await dean.waitForTimeout(400);
    }
    if (firstTba) {
      await views('room', firstTba.key);
      await shown(dean, 'views-tba-request', 30000);
      record.facts.tbaHeader = (await dean.getByTestId('views-tba-header').innerText()).replace(/\s+/g, ' ').trim();
      await shoot(dean, { group: 'review', name: 'tba-rooms-to-request', title: 'Schedule Views & Editor → Room Program', role: 'Dean', shows: `"TBA rooms to request" ("${record.facts.tbaHeader}") and the Room Program of the first TBA room: the classes the CCS rooms can't hold.`, state: AFTER });
    } else {
      record.facts.tbaHeader = 'no TBA room: the CCS rooms hold every class';
    }
    await views('section', bsit1a.id);
    await dean.getByTestId('views-mode-list').click();
    await shown(dean, 'views-list-region', 30000);
    await shoot(dean, { group: 'review', name: 'list-view', title: 'Schedule Views & Editor → List view', role: 'Dean', shows: 'The List view of BSIT 1A: every class in a table with search, filters by section, professor, day and room, and a Move button per class.', state: AFTER });
    await dean.getByTestId('views-mode-table').click();

    // A refused move, then an allowed move (saved: its success message).
    const move = clashingMove(out);
    if (!move) throw new Error('No section has two weekday classes to move onto each other.');
    await views('section', move.section.id);
    await dean.getByTestId(`views-block-${move.cls.itemId}`).click();
    await shown(dean, 'move-panel', 30000);
    await dean.getByTestId('move-day').selectOption(move.day);
    await dean.getByTestId('move-start').selectOption(move.start);
    await dean.waitForFunction(() => document.querySelector('[data-testid="move-check"]')?.dataset.tone === 'error', null, { timeout: 30000 });
    await shoot(dean, { group: 'err', name: 'move-refused-clash', title: 'Schedule Views & Editor → Move', role: 'Dean', shows: `A refused move: ${move.cls.subjectCode} of ${move.section.label} to ${move.day} ${move.start}; "This move is not allowed:" names the clash and "Save the move" stays closed.`, state: AFTER });
    await dean.getByTestId('move-cancel').click();

    const movable = out.classes.filter(c => c.sectionId === bsit1a.id && !c.isFixed && !c.isOnline && c.classType === 'LEC' && (out.policy.weekdays || []).includes(c.day)).sort((a, b) => a.durationSlots - b.durationSlots || a.subjectCode.localeCompare(b.subjectCode));
    let allowed = null;
    for (const cls of movable) {
      await views('section', bsit1a.id);
      await dean.getByTestId(`views-block-${cls.itemId}`).click();
      await shown(dean, 'move-panel', 30000);
      for (const option of freeStarts(out, cls).slice(0, 12)) {
        await dean.getByTestId('move-day').selectOption(option.day);
        const startOk = await dean.getByTestId('move-start').selectOption(option.start).then(() => true).catch(() => false);
        if (!startOk) continue;
        await dean.waitForFunction(() => ['ok', 'error', 'invalid'].includes(document.querySelector('[data-testid="move-check"]')?.dataset.tone), null, { timeout: 30000 });
        if (await dean.getByTestId('move-check').getAttribute('data-tone') === 'ok') { allowed = { cls, ...option }; break; }
      }
      if (allowed) break;
      await dean.getByTestId('move-cancel').click();
    }
    if (!allowed) throw new Error('No allowed move found for a BSIT 1A lecture.');
    record.facts.allowedMove = `${allowed.cls.subjectCode} of BSIT 1A from ${allowed.cls.day} ${allowed.cls.startTime} to ${allowed.day} ${allowed.start}`;
    await shoot(dean, { group: 'review', name: 'move-allowed', title: 'Schedule Views & Editor → Move', role: 'Dean', shows: `An allowed move: ${record.facts.allowedMove}; "This move is allowed." and "Save the move" open.`, state: AFTER });
    await dean.getByTestId('move-submit').click();
    await shown(dean, 'views-toast', 30000);
    await shoot(dean, { group: 'review', name: 'move-saved', title: 'Schedule Views & Editor → Move', role: 'Dean', shows: `A success message: the move saved (${record.facts.allowedMove}) and the class in its new place.`, state: `${AFTER.replace(', 0 conflicts.', '')}, one class moved by hand.` }, { mode: 'window', wait: 300 });
    AFTER = `After generation: ${out.schedule.version} (a Draft), one class moved by hand, 0 conflicts.`;

    // Change professor on a class with history, Swap, Fill TBA rooms (nothing saved).
    const cmsc = out.classes.find(c => c.sectionId === bscs1a.id && c.subjectCode === 'CMSC 101' && c.classType === 'LEC') || out.classes.find(c => c.sectionId === bscs1a.id && c.subjectCode === 'CMSC 101');
    if (!cmsc) throw new Error('BSCS 1A has no CMSC 101 class.');
    await views('section', bscs1a.id);
    await dean.getByTestId(`views-block-${cmsc.itemId}`).click();
    await shown(dean, 'move-panel', 30000);
    await dean.getByTestId('move-action-professor').click();
    await shown(dean, 'professor-options', 120000);
    await dean.waitForTimeout(1000);
    await shoot(dean, { group: 'review', name: 'change-professor-cmsc-101', title: 'Schedule Views & Editor → Change professor', role: 'Dean', shows: 'Change professor on CMSC 101 (BSCS 1A), a class with history: every active professor with a live verdict, the recommended ones first with their Likelihood and reason; nothing saved.', state: AFTER });
    await dean.getByTestId('professor-close').click();

    await views('section', bsit1a.id);
    const swapFrom = out.classes.filter(c => c.sectionId === bsit1a.id && !c.isFixed && !c.isOnline && c.classType === 'LEC')[0];
    await dean.getByTestId(`views-block-${swapFrom.itemId}`).click();
    await shown(dean, 'move-panel', 30000);
    await dean.getByTestId('move-action-swap').click();
    await shown(dean, 'swap-panel', 30000);
    // The first class in the list whose swap the check allows (else the last one tried, with its refusal).
    const partners = await dean.getByTestId('swap-with').evaluate(el => [...el.querySelectorAll('option')].map(o => o.value).filter(Boolean));
    if (!partners.length) throw new Error('The swap list has no class.');
    let swapTone = null;
    for (const partner of partners.slice(0, 12)) {
      await dean.getByTestId('swap-with').selectOption(partner);
      await shown(dean, 'swap-check', 30000);
      await dean.waitForFunction(() => ['ok', 'error', 'invalid'].includes(document.querySelector('[data-testid="swap-check"]')?.dataset.tone), null, { timeout: 30000 }).catch(() => {});
      swapTone = await dean.getByTestId('swap-check').getAttribute('data-tone');
      if (swapTone === 'ok') break;
    }
    record.facts.swap = { tone: swapTone, message: (await dean.getByTestId('swap-check-message').innerText()).replace(/\s+/g, ' ').trim() };
    await shoot(dean, { group: 'review', name: 'swap-preview', title: 'Schedule Views & Editor → Swap with another class', role: 'Dean', shows: `Swap with another class: the two classes, both new places previewed on the table, and the live verdict ("${record.facts.swap.message}"); nothing saved.`, state: AFTER });
    if (await dean.getByTestId('swap-close').count()) await dean.getByTestId('swap-close').click(); else await dean.getByTestId('swap-cancel').click();

    if (firstTba) {
      await views('room', lab1.key, '&fill=1');
      await shown(dean, 'views-fill-panel', 30000);
      await shoot(dean, { group: 'review', name: 'fill-tba-rooms-panel', title: 'Schedule Views & Editor → Fill TBA rooms', role: 'Dean', shows: 'Fill TBA rooms: the rooms with their free hours (all ticked), "Add a borrowed room", Preview; "Times and professors stay the same. Only the room changes."', state: AFTER });
      await dean.getByTestId('views-fill-preview').click();
      await dean.locator('[data-testid=views-fill-summary], [data-testid=views-fill-none], [data-testid=views-fill-error]').first().waitFor({ timeout: 60000 });
      record.facts.fill = await dean.evaluate(() => (document.querySelector('[data-testid=views-fill-summary]') || document.querySelector('[data-testid=views-fill-none]') || document.querySelector('[data-testid=views-fill-error]'))?.innerText.replace(/\s+/g, ' ').trim());
    } else {
      record.facts.fill = 'not shown: the run has no class in a TBA room (the odd/even weeks and LAB 4 hold every class)';
    }
    if (firstTba) {
      await shoot(dean, { group: 'review', name: 'fill-tba-rooms-preview', title: 'Schedule Views & Editor → Fill TBA rooms', role: 'Dean', shows: `The preview (nothing saved): "${record.facts.fill}".`, state: AFTER });
      // The panel only exists when it was opened above.
      const closeFill = dean.getByTestId('views-fill-close');
      if (await closeFill.count()) await closeFill.click(); else await dean.getByTestId('views-fill-cancel').click();
    }

    await views('section', bsit1a.id);
    await dean.getByTestId('views-check-all').click();
    await dean.waitForFunction(() => /Checked at/.test(document.querySelector('[data-testid="views-check-result"]')?.innerText || ''), null, { timeout: 120000 });
    record.facts.check = (await dean.getByTestId('views-check-result').innerText()).replace(/\s+/g, ' ').trim();
    await shoot(dean, { group: 'review', name: 'check-the-whole-schedule', title: 'Schedule Views & Editor', role: 'Dean', shows: `"Check the whole schedule": "${record.facts.check}".`, state: AFTER });

    // ------------------------------------------------------------ the three exports, opened as PDF
    // The gateway's PDFs (the same pages as the Word files), page 1 of each drawn by Windows' own PDF engine.
    const pdfDir = path.join(WORK, '_pdf');
    fs.mkdirSync(pdfDir, { recursive: true });
    const token = await dean.evaluate(() => window.localStorage.getItem('intellisched_token'));
    for (const [view, id, name, title, shows] of [
      ['class-schedule', bsit1a.id, 'export-class-schedule-pdf', 'Export → Class Schedule (PDF)', 'The Class Schedule (LSPU-ACAD-SF-003) of BSIT 1A, exported as PDF and opened: the page the Word file has.'],
      ['teachers-program', Faculty.id, 'export-teachers-program-pdf', "Export → Teachers' Program (PDF)", `The Teachers' Program (LSPU-ACAD-SF-029) of ${Faculty}, exported as PDF and opened.`],
      ['room-schedule', lab1.key, 'export-room-schedule-pdf', 'Export → Room schedule (PDF)', 'The room schedule of LAB 1 for the odd weeks, exported as PDF and opened.']
    ]) {
      const qs = new URLSearchParams({ ...TERM, scheduleId: String(scheduleId), view, format: 'pdf', id: String(id), ...(view === 'room-schedule' ? { weekGroup: 'odd' } : {}) });
      const res = await fetch(`${API}/schedule/exports?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 200) throw new Error(`The ${view} export answered ${res.status}.`);
      const pdf = path.join(pdfDir, `${view}.pdf`);
      fs.writeFileSync(pdf, Buffer.from(await res.arrayBuffer()));
      const png = path.join(pdfDir, view);
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts', 'forms', 'pdf-to-png.ps1'), '-Pdf', pdf, '-OutDir', png, '-Dpi', '110'], { stdio: 'ignore' });
      addImage(path.join(png, 'page-01.png'), { group: 'review', name, title, role: 'Dean', shows, state: AFTER });
    }
    fs.rmSync(pdfDir, { recursive: true, force: true });

    // ------------------------------------------------------------ the error and refusal set that needs a Draft
    // A move that leaves a part-timer alone on a day: refused, naming the professor and the day.
    {
      const partTimers = new Set(out.classes.filter(c => c.employmentType === 'PART_TIME' && c.facultyRef).map(c => c.facultyRef));
      const candidates = [];
      for (const cls of out.classes) {
        if (!partTimers.has(cls.facultyRef) || cls.isFixed || cls.isOnline || cls.classType !== 'LEC' || !(out.policy.weekdays || []).includes(cls.day)) continue;
        const busyDays = new Set(out.classes.filter(c => c.facultyRef === cls.facultyRef).map(c => c.day));
        for (const option of freeStarts(out, cls)) if (!busyDays.has(option.day)) candidates.push({ cls, ...option });
      }
      candidates.sort((a, b) => a.rank - b.rank);
      let found = null;
      for (const cand of candidates.slice(0, 60)) {
        await views('section', cand.cls.sectionId);
        await dean.getByTestId(`views-block-${cand.cls.itemId}`).click();
        await shown(dean, 'move-panel', 30000);
        await dean.getByTestId('move-day').selectOption(cand.day);
        const ok = await dean.getByTestId('move-start').selectOption(cand.start).then(() => true).catch(() => false);
        if (ok) {
          await dean.waitForFunction(() => ['ok', 'error', 'invalid'].includes(document.querySelector('[data-testid="move-check"]')?.dataset.tone), null, { timeout: 30000 });
          const text = (await dean.getByTestId('move-check').innerText()).replace(/\s+/g, ' ');
          if (/only one class/i.test(text) && !/double-booked|clash|unavailable|lunch|cap/i.test(text.replace(/part-time/gi, ''))) { found = { cand, text }; break; }
        }
        await dean.getByTestId('move-cancel').click();
      }
      if (!found) throw new Error('No move leaves a part-timer alone on a day (the refused-move picture).');
      record.facts.partTimerRefusal = found.text.trim();
      await shoot(dean, { group: 'err', name: 'move-refused-part-timer-one-class', title: 'Schedule Views & Editor → Move', role: 'Dean', shows: `A refused move: ${found.cand.cls.subjectCode} to ${found.cand.day} ${found.cand.start} would leave a part-time professor with one class on that day; "${record.facts.partTimerRefusal}" and "Save the move" stays closed.`, state: AFTER });
      await dean.getByTestId('move-cancel').click();
    }

    // Approve refused while conflicts exist: plant one clash in the Draft (the copy's database), show the
    // Approval page, then put the class back and check the whole schedule again.
    {
      const fresh = (await api('GET', `/schedule/outputs?${termQuery}&scheduleId=${scheduleId}`)).data;
      const clash = clashingMove(fresh);
      if (!clash) throw new Error('No clash to plant for the Approval picture.');
      const target = clash.cls, other = clash.other;
      const original = await withDb(async (db) => {
        const sched = await db.collection('mother_schedules').findOne({ 'scheduleData._id': { $exists: true }, version: out.schedule.version, academicYear: TERM.academicYear });
        if (!sched) throw new Error('The Draft was not found in the copy.');
        const item = sched.scheduleData.find(i => String(i._id) === String(target.itemId));
        const otherItem = sched.scheduleData.find(i => String(i._id) === String(other.itemId));
        if (!item || !otherItem) throw new Error('The class was not found in the Draft.');
        const keep = { _id: sched._id, itemId: item._id, day: item.day, startTime: item.startTime, endTime: item.endTime, startSlot: item.startSlot };
        await db.collection('mother_schedules').updateOne({ _id: sched._id }, { $set: { 'scheduleData.$[e].day': otherItem.day, 'scheduleData.$[e].startTime': otherItem.startTime, 'scheduleData.$[e].endTime': fromMin(toMin(otherItem.startTime) + target.durationSlots * out.policy.slotMinutes), 'scheduleData.$[e].startSlot': otherItem.startSlot } }, { arrayFilters: [{ 'e._id': item._id }] });
        return keep;
      });
      try {
        await open(dean, 'approval', 'Approval');
        await shown(dean, 'approval-stage-1', 60000);
        await gone(dean, 'approval-loading');
        await dean.getByTestId('approval-check-now').click().catch(() => {});
        await dean.waitForFunction(() => Number(document.querySelector('[data-testid="approval-check-result"]')?.dataset.conflicts) > 0, null, { timeout: 120000 });
        await shown(dean, 'approval-signoff-reason', 30000);
        record.facts.approveRefused = (await dean.getByTestId('approval-check-result').innerText()).replace(/\s+/g, ' ').trim();
        await shoot(dean, { group: 'err', name: 'approve-refused-conflicts', title: 'Approval', role: 'Dean', shows: `Approve refused while the version has conflicts: "${record.facts.approveRefused}", the conflicts listed with the way to fix them, and the sign-off button closed with its reason.`, state: `${AFTER.replace(', 0 conflicts.', '')}, one clash planted on the copy for this picture and undone afterwards.` });
      } finally {
        await withDb(db => db.collection('mother_schedules').updateOne({ _id: original._id }, { $set: { 'scheduleData.$[e].day': original.day, 'scheduleData.$[e].startTime': original.startTime, 'scheduleData.$[e].endTime': original.endTime, 'scheduleData.$[e].startSlot': original.startSlot } }, { arrayFilters: [{ 'e._id': original.itemId }] }));
      }
      await views('section', bsit1a.id);
      await dean.getByTestId('views-check-all').click();
      await dean.waitForFunction(() => /Checked at/.test(document.querySelector('[data-testid="views-check-result"]')?.innerText || '') && /no conflicts/i.test(document.querySelector('[data-testid="views-check-result"]')?.innerText || ''), null, { timeout: 120000 });
    }

    // A generation that ends without a schedule: one professor's unavailable times leave no 3-hour window
    // for their long class (the Readiness Check counts hours, not windows, so it still says ready).
    {
      const hoursOf = new Map();
      for (const c of out.classes) if (c.facultyRef && !c.isOnline) hoursOf.set(c.facultyRef, (hoursOf.get(c.facultyRef) || 0) + c.durationSlots * out.policy.slotMinutes / 60);
      const longOnes = out.classes.filter(c => c.facultyRef && c.durationSlots >= 6 && !c.isFixed && c.type !== 'OJT');
      const pick = longOnes.map(c => ({ c, hours: hoursOf.get(c.facultyRef) })).filter(x => x.hours <= 12).sort((a, b) => (a.c.employmentType === 'PART_TIME' ? 0 : 1) - (b.c.employmentType === 'PART_TIME' ? 0 : 1) || a.hours - b.hours)[0];
      if (!pick) throw new Error('No professor with a three-hour class and few hours for the failed-generation picture.');
      const prof = out.faculty.find(f => f.id === pick.c.facultyRef);
      const wall = (out.policy.weekdays || []).flatMap(day => [{ day, start: '10:00', end: '12:00' }, { day, start: '14:00', end: '17:00' }]);
      const before = await withDb(async (db) => {
        const { ObjectId } = require(path.join(REPO, 'server', 'node_modules', 'mongodb'));
        const doc = await db.collection('faculty').findOne({ _id: new ObjectId(String(pick.c.facultyRef)) });
        if (!doc) throw new Error('The professor was not found in the copy.');
        await db.collection('faculty').updateOne({ _id: doc._id }, { $set: { unavailableBlocks: wall } });
        return { _id: doc._id, unavailableBlocks: doc.unavailableBlocks || [] };
      });
      try {
        await open(dean, 'generate', 'Generate Schedule');
        await dean.waitForFunction(() => document.querySelector('[data-testid="readiness-verdict"]')?.dataset.verdict === 'ready', null, { timeout: 120000 });
        await dean.getByTestId('generate-advanced-toggle').click();
        await shown(dean, 'ga-settings-form', 60000);
        await dean.getByRole('spinbutton', { name: /Time budget/ }).fill('1');
        await dean.getByTestId('generate-button').click();
        const confirm = dean.getByTestId('generate-confirm');
        if (await confirm.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) await dean.getByTestId('generate-confirm-confirm').click();
        await shown(dean, 'generate-progress', 60000);
        await dean.waitForFunction(() => { const s = document.querySelector('[data-testid="generate-result"]')?.dataset.status; return s && !['running', 'saving'].includes(s); }, null, { timeout: 12 * 60000 });
        const status = await dean.getByTestId('generate-result').getAttribute('data-status');
        if (status !== 'failed') throw new Error(`The run ended "${status}", not "failed": the failed-generation picture needs a run without a schedule.`);
        record.facts.failedRun = (await dean.getByTestId('generate-result-title').innerText()).trim();
        await dean.getByTestId('generate-advanced-toggle').click().catch(() => {});
        await shoot(dean, { group: 'err', name: 'generation-without-schedule', title: 'Generate Schedule', role: 'Dean', shows: `A generation that ends without a schedule (${prof?.name || 'one professor'} marked unavailable for every window of three hours): "${record.facts.failedRun}", the cause and the ways out, "Nothing was saved" and Try again.`, state: `${AFTER.replace(', 0 conflicts.', '')}, one professor's unavailable times changed on the copy for this picture and undone afterwards.` });
      } finally {
        await withDb(db => db.collection('faculty').updateOne({ _id: before._id }, { $set: { unavailableBlocks: before.unavailableBlocks } }));
      }
    }

    // An action refused by the permission map: the view-only Faculty role (a TEST account made on the copy and locked afterwards).
    {
      const faculty = { name: 'TEST Faculty', email: 'faculty.demo@example.test', password: 'Demo-Faculty-2026', role: 'Faculty', status: 'Active' };
      await api('POST', '/users', faculty);
      const viewer = await signIn(faculty.email, faculty.password);
      await open(viewer, 'generate', 'Generate Schedule');
      await viewer.getByTestId('readiness-verdict').waitFor({ timeout: 120000 });
      await shoot(viewer, { group: 'err', name: 'permission-refused-faculty-role', title: 'Generate Schedule', role: 'Faculty (view only)', shows: 'An action refused by the permission map: the view-only Faculty role sees "Generate Mother Schedule" closed with the reason next to it; every page can be viewed and printed.', state: AFTER });
      await viewer.context().close();
      const users = (await api('GET', '/users')).data;
      const mine = (Array.isArray(users) ? users : users.users || []).find(u => u.email === faculty.email);
      if (mine && mine.status !== 'Locked') await api('PATCH', `/users/${mine._id}/toggle`);
    }

    await open(dean, 'versions', 'Versions');
    await gone(dean, 'versions-loading');
    await shown(dean, 'versions-table', 30000);
    await shoot(dean, { group: 'review', name: 'versions', title: 'Versions', role: 'Dean', shows: 'Versions: the term\'s saved versions with their status and last check; Restore makes a new Draft after a confirmation.', state: AFTER });

    // ------------------------------------------------------------ Approve & print
    const printHash = (params) => `print?${new URLSearchParams({ ...params, scheduleId: String(scheduleId), academicYear: TERM.academicYear, semester: String(TERM.semester) }).toString()}`;
    const openPrint = async (params) => {
      await dean.goto('about:blank');
      await dean.goto(`${CLIENT}/#/${printHash(params)}`);
      await dean.locator('.sheet, [data-testid=print-page], [data-testid=print-sheets-error], [data-testid=print-error], [data-testid=print-empty]').first().waitFor({ timeout: 60000 });
      const problem = await dean.evaluate(() => document.querySelector('[data-testid=print-sheets-error], [data-testid=print-error], [data-testid=print-empty]')?.innerText || '');
      if (problem) throw new Error(`The print view of ${JSON.stringify(params)}: ${problem}`);
      await dean.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => (img.complete ? null : new Promise((done) => { img.onload = done; img.onerror = done; })))); });
    };
    await openPrint({ output: 'mother-schedule', id: bsit1a.id });
    const watermark = await dean.getByTestId('print-draft-note').first().innerText().catch(() => '');
    if (!/DRAFT – NOT APPROVED/.test(watermark)) throw new Error('The Draft\'s print view has no "DRAFT – NOT APPROVED".');
    await shoot(dean, { group: 'approve', name: 'print-draft-not-approved', title: 'Print view', role: 'Dean', shows: 'A Draft printed for checking: the Mother Schedule of BSIT 1A with "DRAFT – NOT APPROVED" on the page.', state: AFTER });

    await open(dean, 'approval', 'Approval');
    await shown(dean, 'approval-stage-1', 60000);
    await gone(dean, 'approval-loading');
    await shoot(dean, { group: 'approve', name: 'approval-stages', title: 'Approval', role: 'Dean', shows: 'Approval: the version\'s stored check first, the four stages with who signs each, remarks and the next sign-off.', state: AFTER });
    await dean.getByTestId('approval-signoff').click();
    await shown(dean, 'approval-confirm', 15000);
    record.facts.confirmTitle = (await dean.getByTestId('approval-confirm-title').innerText()).trim();
    await shoot(dean, { group: 'approve', name: 'approval-signoff-confirmation', title: 'Approval', role: 'Dean', shows: `A confirmation dialog: "${record.facts.confirmTitle}", saying what the sign-off does, with Cancel focused.`, state: AFTER }, { mode: 'window' });
    await dean.getByTestId('approval-confirm-confirm').click();
    await gone(dean, 'approval-confirm', 30000);
    await settle(dean, 1500);
    await dean.getByTestId('approval-signoff').click();
    await shown(dean, 'approval-confirm', 15000);
    await dean.getByTestId('approval-confirm-confirm').click();
    await gone(dean, 'approval-confirm', 30000);
    await settle(dean, 1500);
    record.facts.stages = await dean.evaluate(() => [1, 2, 3].map(n => document.querySelector(`[data-testid="approval-stage-${n}-status"]`)?.innerText.trim()));
    const APPROVED = `After approval: ${out.schedule.version} reviewed and approved by the Dean (final: Phase 8 Part 6 removed Publish).`;
    await shoot(dean, { group: 'approve', name: 'approval-approved', title: 'Approval', role: 'Dean', shows: `After the review and the Dean's sign-off: the stages read ${record.facts.stages.filter(Boolean).join(' / ')}; the version is Approved, final.`, state: APPROVED });

    await open(dean, 'print-outputs', 'Print Outputs');
    await gone(dean, 'po-loading');
    await shown(dean, 'po-version', 30000);
    await shoot(dean, { group: 'approve', name: 'print-outputs', title: 'Print Outputs', role: 'Dean', shows: 'Print Outputs: the approved version, the Mother Schedule per section, the Teachers\' Program per professor (SF-029 or the class schedule table), the Room Program per room, the TBA rooms to request and the CSV.', state: APPROVED });
    for (const [params, name, shows] of [
      [{ output: 'teachers-program', id: Faculty.id, layout: 'sf029' }, 'print-sf029-Faculty', `The SF-029 (LSPU-ACAD-SF-029) of ${Faculty}: the header facts, the period grid with classes, On-The-Job Training and duty blocks, the day totals and the summary box.`],
      [{ output: 'teachers-program', id: Faculty.id, layout: 'table' }, 'print-class-schedule-table-Faculty', `The same Teachers' Program in the "Class schedule table" layout, with the load summary under the table.`],
      [{ output: 'mother-schedule', id: bsit1a.id }, 'print-mother-schedule-bsit-1a', 'The Mother Schedule of BSIT 1A, approved: one A4 page, no DRAFT mark.'],
      [{ output: 'room-program', id: lab1.key }, 'print-room-program-lab-1', 'The Room Program of LAB 1 with its hours used and available, each class with its week group.'],
      ...(firstTba ? [[{ output: 'room-program', id: firstTba.key }, 'print-tba-room', `The Room Program of ${firstTba.name || 'the first TBA room'}, a TBA room to request from another department.`]] : [])
    ]) {
      await openPrint(params);
      await shoot(dean, { group: 'approve', name, title: 'Print view', role: 'Dean', shows, state: APPROVED });
    }

    // ------------------------------------------------------------ Administration (the Dean)
    for (const [key, heading, waitFor, shows] of [
      ['users-roles', 'Users & Roles', () => shown(dean, 'users-add'), 'Users & Roles as the Dean: the accounts with their roles and status; the Dean adds accounts.'],
      ['output-settings', 'Output Settings', () => gone(dean, 'os-loading'), 'Output Settings: the campus code and college name, "On screen" with "Show evaluation ratings on screen" (presentation mode), and each output\'s title, form code and signatory lines.'],
      ['reference-lists', 'Reference Lists', () => gone(dean, 'rl-loading'), 'Reference Lists: the specialization domains and the position titles, each entry editable, removals confirmed.'],
      ['audit-logs', 'Audit Trail', () => shown(dean, 'audit-table'), 'The Audit Trail: who did what and when (the assignments, the run, the move, the sign-offs), with filters and pages of 25.']
    ]) {
      await open(dean, key, heading);
      await waitFor();
      await shoot(dean, { group: 'admin', name: key === 'audit-logs' ? 'audit-trail' : key, title: heading, role: 'Dean', shows, state: APPROVED });
    }
    await dean.context().close();

    // ------------------------------------------------------ the technical pages (Phase 8 Part 8: the Dean's one account)
    const admin = await signIn(secrets.deanEmail, secrets.deanPassword);
    await open(admin, 'generate', 'Generate Schedule');
    await admin.getByTestId('readiness-verdict').waitFor({ timeout: 90000 });
    await admin.getByTestId('generate-advanced-toggle').click();
    await shown(admin, 'ga-settings-form', 60000);
    await shoot(admin, { group: 'check', name: 'generate-schedule-advanced', title: 'Generate Schedule → Advanced (system team)', role: 'Dean', shows: '"Advanced (system team)" open: the generation settings and the seed, the TBA room mode and counts, the penalty weights, the runs\' technical results; the Dean and the College Secretary open it.', state: APPROVED });
    await open(admin, 'policy', 'Scheduling Policy');
    await gone(admin, 'policy-loading');
    await admin.getByTestId('policy-advanced-toggle').click();
    await admin.waitForTimeout(800);
    await shoot(admin, { group: 'setup', name: 'scheduling-policy-advanced', title: 'Scheduling Policy → Advanced (system team)', role: 'Dean', shows: 'The Scheduling Policy with "Advanced (system team)" open: the TBA room mode and counts, the penalty weights and the preferred earliest start.', state: APPROVED });
    await open(admin, 'model-feedback', 'Model Feedback');
    await gone(admin, 'feedback-loading');
    await shoot(admin, { group: 'admin', name: 'model-feedback', title: 'Model Feedback', role: 'Dean', shows: 'Model Feedback: the Dean\'s accept and override decisions the ranking learns from, and Retrain.', state: APPROVED });
    await open(admin, 'api-health', 'Service Health');
    await shown(admin, 'health-check-again', 60000);
    await shoot(admin, { group: 'admin', name: 'service-health', title: 'Service Health', role: 'Dean', shows: 'Service Health: the gateway, the database and the scheduling service in plain words, with "Last checked at".', state: APPROVED });
    await open(admin, 'users-roles', 'Users & Roles');
    await shown(admin, 'users-add');
    await admin.getByTestId('users-add').click();
    await shown(admin, 'user-name', 15000);
    await shoot(admin, { group: 'admin', name: 'users-roles-add-user', title: 'Users & Roles', role: 'Dean', shows: 'The add-user form: the full name, the institutional email, the first password (8 characters or more, with show/hide), the role with what it may do, and the account status; nothing saved.', state: APPROVED }, { mode: 'window' });
    await admin.keyboard.press('Escape');
    const dark = await admin.context().newPage();
    await dark.addInitScript(([year, semester]) => {
      try {
        window.localStorage.setItem('intellisched-theme', 'dark');
        window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: year, activeSemester: semester }));
      } catch { /* none */ }
    }, [TERM.academicYear, SEMESTER_LABEL]);
    await dark.setViewportSize(VIEWPORT);
    await open(dark, 'checklist', 'Term Checklist');
    await dark.waitForFunction(() => /steps? (are )?done/.test(document.querySelector('[data-testid="checklist-summary"]')?.innerText || ''), null, { timeout: 120000 });
    await dark.waitForFunction(() => !document.querySelector('[data-testid^="checklist-step-"][data-status="loading"]'), null, { timeout: 120000 });
    await shoot(dark, { group: 'dark', name: 'term-checklist-dark', title: 'Term Checklist (dark)', role: 'Dean', shows: 'The Term Checklist in the dark theme.', state: APPROVED });
    await open(dark, 'assign-faculty?tab=by-class', 'Assign Faculty');
    await shown(dark, 'matrix-toolbar', 120000);
    await shoot(dark, { group: 'dark', name: 'assign-faculty-dark', title: 'Assign Faculty (dark)', role: 'Dean', shows: 'Assign Faculty, By class, in the dark theme.', state: APPROVED });
    await open(dark, `schedule-views?scheduleId=${scheduleId}&view=section&entityKey=${encodeURIComponent(bsit1a.id)}`, 'Schedule Views & Editor');
    await shown(dark, 'views-entity-name', 60000);
    await shoot(dark, { group: 'dark', name: 'schedule-views-dark', title: 'Schedule Views & Editor (dark)', role: 'Dean', shows: 'The Mother Schedule of BSIT 1A in the dark theme.', state: APPROVED });
    await admin.context().close();

    // Phase 8 Part 6 removed the restricted Secretary's "read only, with the reason" pictures; since
    // Part 8 the office has one account, the Dean's, so the technical pages above are the Dean's too.
  } finally {
    await browser.close();
  }

  // ------------------------------------------------------------ the index, then the copy
  const f = record.facts;
  const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lines = [
    '# Screenshots of every page',
    '',
    `For the manuscript, the user documentation and the ISO/IEC 25010 evidence: ${record.shots.length} screenshots of IntelliSched, ${record.shots.filter(x => /-err-/.test(x.file)).length} of them the error and refusal set (\`err\` in the name: what the user sees when something is refused or goes wrong) and ${record.shots.filter(x => /-dark-/.test(x.file)).length} in the dark theme; the rest are the pages in the order of the side menu and the Dean's path (sign-in, the Dean before generation, the generation, review and approval, the technical pages). Each is a PNG of a 1366 × 768 window in the light theme, the whole page when it scrolls ("page"), the window as it is for a dialog or a part of a page ("window"), or page 1 of an exported PDF ("pdf"). Names: \`NN-group-page-state.png\`, the group being the side menu's (main, setup, assign, check, review, approve, admin), sign-in, err or dark.`,
    '',
    `Taken by \`scripts/demo/doc-screenshots.js\` on ${new Date().toLocaleString('sv-SE').slice(0, 16)}, on \`npm run demo:sem2:reset -- --faculty-seed\` (database \`${record.database}\`): the real 2nd Semester AY 2026-2027 loaded by the term loader, with the seed file's faculty (tracked data only), so every evaluation reads "0 – none yet" and no screenshot shows a rating. The ranking with tracked data can differ from the defense's, which uses the private faculty files (\`docs/DEFENSE_DEMO.md\` step 3). The logins are the demo's TEST accounts.`,
    '',
    `What the path did: nothing was assigned (the term file already holds every class, from the Dean's own session of 9 Oct); the archive of ${f.archiveRefused ? 'a professor with classes was refused' : ''}, an idle professor archived and restored, an outside teacher typed and removed; one generation as the TEST Dean (${f.generate.title}; ${f.version.version}, ${f.version.classes} classes, TBA: ${f.version.tba}); one move saved (${f.allowedMove}); the whole-schedule check ("${f.check}"); the review and the Dean's approval. The error scenes plant their problem on the copy (a class moved onto another, a professor's unavailable times) and undo it. Every other form, panel and dialog was closed without saving.`,
    '',
    '| File | Page | Role | What it shows | Data state |',
    '|---|---|---|---|---|',
    ...record.shots.map(s => `| [\`${s.file}\`](${s.file}) | ${cell(s.page)}${s.mode === 'window' ? ' (window)' : ''} | ${cell(s.role)} | ${cell(s.shows)} | ${cell(s.state)} |`),
    '',
    '## Make them again',
    '1. `npm run demo:sem2:reset -- --faculty-seed` (repo root), and wait for "Press Ctrl+C to stop".',
    '2. In a second terminal: `node scripts/demo/doc-screenshots.js` (about 12 minutes). `--out <a folder git ignores>` makes a private set instead.',
    '3. The wordmark pictures (`wordmark/`: the sign-in page and the sidebar, the Part 10 baseline and the header since Phase 8 Part 11, light and dark) come from `node scripts/demo/part10-wordmark-shots.js` (its header says how to make the baseline copy); run it AFTER this script, which remakes this folder; it writes its own section of this README.',
    '4. Stop the demo with Ctrl+C.',
    '',
    'Every image is made in `.demo-data/doc-screenshots/` first; this folder is replaced only when every shot passed (each page found, each image over 15 KB, no evaluation rating on any page). The script refuses the defense database, and refuses this folder from a demo whose faculty came from `docs/data/faculty_data.json`.',
    ''
  ];
  fs.writeFileSync(path.join(WORK, 'README.md'), lines.join('\n'));
  fs.writeFileSync(path.join(REPO, '.demo-data', 'doc-screenshots.json'), `${JSON.stringify(record, null, 2)}\n`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(WORK)) fs.copyFileSync(path.join(WORK, file), path.join(target, file));
  log(`${record.shots.length} screenshots and README.md written to ${path.relative(REPO, target) || target}.`);
})().catch((err) => {
  console.error(`[shots] Nothing was written to the screenshots folder: ${err.stack || err.message}`);
  process.exit(1);
});
