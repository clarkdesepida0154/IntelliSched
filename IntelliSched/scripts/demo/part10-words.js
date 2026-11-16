#!/usr/bin/env node
// Phase 8 Part 10: counts the words a Dean sees on first load of each page at 1366x768 (read only).
// Needs `npm run demo:sem2:reset -- --faculty-seed` running. Counts the page area (the menu and the top bar left out) and,
// separately, the whole screen. Usage: node scripts/demo/part10-words.js --out .demo-data/logs/part10-words-before.json
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const RUN_FILE = path.join(REPO, '.demo-data', 'run.json');
const argOf = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };

const PAGES = [
  { id: 'login', label: 'Login page', signedOut: true },
  { id: 'checklist', label: 'Term Checklist', hash: 'checklist' },
  { id: 'assign-by-class', label: 'Assign Faculty: By class', hash: 'assign-faculty?tab=by-class' },
  { id: 'assign-recommendations', label: 'Assign Faculty: Recommendations', hash: 'assign-faculty?tab=recommendations' },
  { id: 'teaching-loads', label: 'Teaching loads (panel opened)', hash: 'assign-faculty?tab=by-class', open: 'pt-loads-toggle' },
  { id: 'readiness', label: 'Readiness Check', hash: 'readiness' },
  { id: 'generate', label: 'Generate Schedule', hash: 'generate' },
  { id: 'schedule-views', label: 'Schedule Views & Editor', hash: 'schedule-views' },
  { id: 'print-outputs', label: 'Print Outputs and Export', hash: 'print-outputs' },
  { id: 'faculty', label: 'Faculty', hash: 'faculty' },
  { id: 'sections', label: 'Sections', hash: 'sections' },
  { id: 'rooms', label: 'Rooms', hash: 'rooms' },
  { id: 'subjects', label: 'Curriculum & Subjects', hash: 'subjects' },
  { id: 'policy', label: 'Scheduling Policy', hash: 'policy' },
  { id: 'output-settings', label: 'Output Settings', hash: 'output-settings' },
  { id: 'audit-logs', label: 'Audit Trail', hash: 'audit-logs' }
];

const countWords = (text) => (String(text || '').match(/[^\s]+/g) || []).filter(w => /[A-Za-z0-9]/.test(w)).length;

(async () => {
  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (run.state !== 'ready' || run.mode !== 'sem2') throw new Error('Needs a ready `npm run demo:sem2:reset -- --faculty-seed` (never the defense database).');
  if (/defense|^intellisched_db$/.test(run.database || '') || !/_test$/.test(run.database || '')) throw new Error(`Refusing database ${run.database}.`);
  const out = path.resolve(argOf('--out', path.join(REPO, '.demo-data', 'logs', 'part10-words.json')));
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  const CLIENT = run.clientUrl || `http://localhost:${run.ports.client}`;
  const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
  const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.addInitScript(([year, semester]) => {
    try {
      window.localStorage.setItem('intellisched-theme', 'light');
      window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: year, activeSemester: semester }));
    } catch { /* none */ }
  }, [TERM.academicYear, TERM.semester === 2 ? '2nd Semester' : '1st Semester']);
  const result = { at: new Date().toISOString(), viewport: '1366x768', pages: {} };
  try {
    await page.goto(CLIENT);
    await page.getByTestId('login-submit').waitFor({ timeout: 30000 });
    result.pages.login = { label: 'Login page', words: countWords(await page.locator('body').innerText()), pageWords: null };
    await page.getByTestId('login-username').fill(secrets.deanEmail);
    await page.getByTestId('login-password').fill(secrets.deanPassword);
    await page.getByTestId('login-submit').click();
    await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
    for (const p of PAGES.filter(x => !x.signedOut)) {
      await page.evaluate((h) => { window.location.hash = `#/${h}`; }, p.hash);
      await page.waitForTimeout(2500);
      if (p.open) { try { await page.getByTestId(p.open).click({ timeout: 5000 }); await page.waitForTimeout(1500); } catch { /* none */ } }
      const area = await page.locator('main').innerText();
      if (process.argv.includes('--blocks')) { result.blocks = result.blocks || {}; result.blocks[p.id] = await page.evaluate(() => { const out = []; for (const el of document.querySelectorAll('main *')) { if (el.querySelector('p, div, li, table')) continue; const t = (el.innerText || '').trim().split(/\s+/).join(' '); const n = t ? t.split(' ').length : 0; if (n >= 12 && !out.some(o => o.t === t)) out.push({ id: el.closest('[data-testid]')?.getAttribute('data-testid') || '', n, t }); } return out; }); }
      const body = await page.locator('body').innerText();
      result.pages[p.id] = { label: p.label, pageWords: countWords(area), words: countWords(body) };
    }
  } finally { await browser.close(); }
  result.total = Object.values(result.pages).reduce((n, p) => n + (p.pageWords ?? p.words), 0);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  for (const [k, v] of Object.entries(result.pages)) console.log(`${k.padEnd(24)} ${String(v.pageWords ?? v.words).padStart(5)}`);
  console.log(`total ${result.total}  -> ${path.relative(REPO, out)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
