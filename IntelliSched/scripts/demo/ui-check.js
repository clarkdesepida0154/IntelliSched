#!/usr/bin/env node
// Phase 13 (decision 4): the full UI check in one run. Crawls every page and the main dialogs as the
// Dean, the College Secretary and Faculty on the practice copy, at 1366x768 and 1920x1080 (plus
// 1280x720 for the main pages), in the light and the dark theme; saves a screenshot of each into
// docs/screenshots/ui-check/<before|after>/ and runs the same automatic layout checks on every one
// (a horizontal scrollbar, clipped or wrapping labels, overlapping controls, a modal taller than the
// window, icons out of line with their text). The findings go to .demo-data/logs/ui-check-<set>.json.
//
// Needs `npm run demo:sem2:reset -- --faculty-seed` running (never the defense database). The Faculty
// and College Secretary TEST accounts are made on that practice copy when missing (through Users &
// Roles' own route, as the TEST Dean); no password is printed.
// Usage: node scripts/demo/ui-check.js --set before|after [--only <page key,…>] [--no-shots] [--client <url>]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const RUN_FILE = path.join(REPO, '.demo-data', 'run.json');
const argOf = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const SET = argOf('--set', 'before');
const ONLY = (argOf('--only', '') || '').split(',').filter(Boolean);
const NO_SHOTS = process.argv.includes('--no-shots');
const OUT_DIR = path.join(REPO, 'docs', 'screenshots', 'ui-check', SET);
const LOG = path.join(REPO, '.demo-data', 'logs', `ui-check-${SET}.json`);
const ACCOUNTS_FILE = path.join(REPO, '.demo-data', 'ui-check-accounts.json');

// Every page of the registry (navigation/pages.js), the two Assign Faculty tabs apart.
const PAGES = [
  { id: 'checklist', hash: 'checklist', main: true },
  { id: 'subjects', hash: 'subjects' },
  { id: 'subjects-builder', hash: 'subjects?tab=builder' },
  { id: 'sections', hash: 'sections' },
  { id: 'rooms', hash: 'rooms' },
  { id: 'faculty', hash: 'faculty', main: true },
  { id: 'policy', hash: 'policy' },
  { id: 'assign-by-class', hash: 'assign-faculty?tab=by-class', main: true },
  { id: 'assign-recommendations', hash: 'assign-faculty?tab=recommendations' },
  { id: 'readiness', hash: 'readiness', main: true },
  { id: 'generate', hash: 'generate', main: true },
  { id: 'schedule-views', hash: 'schedule-views', main: true },
  { id: 'versions', hash: 'versions' },
  { id: 'approval', hash: 'approval' },
  { id: 'print-outputs', hash: 'print-outputs', main: true },
  { id: 'users-roles', hash: 'users-roles' },
  { id: 'output-settings', hash: 'output-settings' },
  { id: 'reference-lists', hash: 'reference-lists' },
  { id: 'audit-logs', hash: 'audit-logs' },
  { id: 'model-feedback', hash: 'model-feedback' },
  { id: 'api-health', hash: 'api-health' },
  { id: 'system', hash: 'system', main: true }
];

// The main dialogs: the page, the button that opens it, and what shows it is open.
const DIALOGS = [
  { id: 'faculty-form', hash: 'faculty', open: 'faculty-add' },
  { id: 'section-form', hash: 'sections', open: 'section-add' },
  { id: 'room-form', hash: 'rooms', open: 'room-add' },
  { id: 'catalog-form', hash: 'subjects', open: 'catalog-add' },
  { id: 'user-form', hash: 'users-roles', open: 'users-add' },
  { id: 'teaching-loads', hash: 'assign-faculty?tab=by-class', open: 'pt-loads-toggle' },
  { id: 'page-search', hash: 'checklist', open: 'page-search', type: 'Fac' },
  { id: 'notifications', hash: 'checklist', open: 'notif-toggle' },
  { id: 'term-picker', hash: 'checklist', open: 'term-year-button' }
];

// [role, viewport, theme, which pages]
const PASSES = [
  ['dean', { width: 1366, height: 768 }, 'light', 'all'],
  ['dean', { width: 1366, height: 768 }, 'dark', 'all'],
  ['dean', { width: 1920, height: 1080 }, 'light', 'all'],
  ['dean', { width: 1920, height: 1080 }, 'dark', 'all'],
  ['dean', { width: 1280, height: 720 }, 'light', 'main'],
  ['dean', { width: 1280, height: 720 }, 'dark', 'main'],
  ['secretary', { width: 1366, height: 768 }, 'light', 'all'],
  ['secretary', { width: 1920, height: 1080 }, 'dark', 'all'],
  ['faculty', { width: 1366, height: 768 }, 'light', 'all'],
  ['faculty', { width: 1920, height: 1080 }, 'dark', 'all'],
  // Phase 13 (decision 2): a future term with no data shows the normal empty states, never an error.
  ['dean', { width: 1366, height: 768 }, 'light', 'main', { academicYear: '2030-2031', semester: 1 }]
];

// The checks, run in the page. Each returns a list of { kind, where, detail }.
const CHECKS = () => {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && !el.closest('.sr-only, [aria-hidden="true"], [inert]'); };
  // Really on screen: the element (or a child) is what the browser hits at its own centre, so a control
  // clipped away inside a closed menu group or scrolled out of its box does not count.
  const hit = (el) => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false; const t = document.elementFromPoint(x, y); return Boolean(t && (el.contains(t) || t.contains(el))); };
  // The most lines any one run of text in the element takes (a run broken over two lines = a wrap;
  // an icon or a badge beside the text is not a line).
  const lineCount = (el) => {
    let most = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      const tops = [];
      for (const b of range.getClientRects()) if (b.width > 1 && b.height > 4 && !tops.some(t => Math.abs(t - b.top) < 4)) tops.push(b.top);
      most = Math.max(most, tops.length);
    }
    return most;
  };
  const where = (el) => {
    const id = el.closest('[data-testid]')?.getAttribute('data-testid');
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''} "${text}"`;
  };
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push({ kind: 'page-hscroll', where: 'document', detail: `${doc.scrollWidth} > ${doc.clientWidth}` });
  const main = document.querySelector('main');
  if (main && main.scrollWidth > main.clientWidth + 1) out.push({ kind: 'page-hscroll', where: 'main', detail: `${main.scrollWidth} > ${main.clientWidth}` });
  // Short labels that wrap onto a second line, or are clipped without an ellipsis.
  const labels = [...document.querySelectorAll('button, a, [role="tab"], th, [role="option"], label, h1, h2, h3, span[class*="rounded"], div[class*="rounded"]:not(:has(*))')].filter(vis);
  for (const el of labels) {
    const text = (el.innerText || '').trim();
    if (!text || text.length < 2 || text.length > 40 || text.includes('\n') || !hit(el)) continue;
    const s = getComputedStyle(el);
    const lines = lineCount(el);
    if (el.tagName !== 'TH' && lines > 1 && text.split(/\s+/).length <= 4) out.push({ kind: 'label-wraps', where: where(el), detail: `${lines} lines` });
    if (el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== 'ellipsis' && ['hidden', 'clip'].includes(s.overflowX)) out.push({ kind: 'label-clipped', where: where(el), detail: `${el.scrollWidth} > ${el.clientWidth}` });
  }
  // Table headers that break a single word.
  for (const th of [...document.querySelectorAll('th')].filter(el => vis(el) && hit(el))) {
    const words = (th.innerText || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const range = document.createRange(); range.selectNodeContents(th);
    const rects = [...range.getClientRects()].filter(r => r.width > 1);
    const lines = new Set(rects.map(r => Math.round(r.top))).size;
    if (lines > words.length) out.push({ kind: 'header-breaks-word', where: where(th), detail: `${lines} lines for ${words.length} words` });
  }
  // Interactive controls that overlap one another (neither inside the other).
  const ctl = [...document.querySelectorAll('button, input, select, textarea, a[href]')].filter(el => vis(el) && hit(el)).slice(0, 400);
  const boxes = ctl.map(el => ({ el, r: el.getBoundingClientRect() }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 4 && h > 4) {
        // Hidden behind a scroll container's edge or an overlay is not an overlap of the page itself.
        const cx = Math.max(a.r.left, b.r.left) + w / 2; const cy = Math.max(a.r.top, b.r.top) + h / 2;
        const top = document.elementFromPoint(cx, cy);
        if (top && (a.el.contains(top) || b.el.contains(top))) out.push({ kind: 'overlap', where: `${where(a.el)} / ${where(b.el)}`, detail: `${Math.round(w)}x${Math.round(h)}px` });
      }
    }
  }
  // A modal taller than the window that cannot scroll inside.
  for (const d of [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(vis)) {
    const r = d.getBoundingClientRect();
    if (r.height > window.innerHeight + 1 || r.bottom > window.innerHeight + 1) {
      const scrolls = [d, ...d.querySelectorAll('*')].some(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight);
      if (!scrolls) out.push({ kind: 'modal-too-tall', where: where(d), detail: `${Math.round(r.height)}px in ${window.innerHeight}px` });
    }
  }
  // An icon beside its text, off its centre line by more than 3 px.
  for (const el of [...document.querySelectorAll('button, a, [role="tab"]')].filter(el => vis(el) && hit(el))) {
    const svg = el.querySelector(':scope > svg');
    const text = (el.innerText || '').trim();
    if (!svg || !text || text.includes('\n')) continue;
    const range = document.createRange(); range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 4);
    const textRect = rects.find(r => r.left >= svg.getBoundingClientRect().right - 1) || rects[rects.length - 1];
    if (!textRect) continue;
    const ic = svg.getBoundingClientRect();
    const off = Math.abs((ic.top + ic.bottom) / 2 - (textRect.top + textRect.bottom) / 2);
    if (off > 3) out.push({ kind: 'icon-off-line', where: where(el), detail: `${off.toFixed(1)}px` });
  }
  // An error shown in the page area (role="alert"): on a future term with no data there must be none.
  for (const el of [...document.querySelectorAll('main [role="alert"]')].filter(vis)) {
    const text = (el.innerText || '').trim();
    if (text) out.push({ kind: 'alert-shown', where: where(el), detail: text.slice(0, 120) });
  }
  return out;
};

const randomPassword = () => `Ui-${crypto.randomBytes(9).toString('base64url')}9a`;

(async () => {
  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (run.state !== 'ready' || run.mode !== 'sem2') throw new Error('Needs a ready `npm run demo:sem2:reset -- --faculty-seed` (never the defense database).');
  if (/defense|^intellisched_db$/.test(run.database || '') || !/_test$/.test(run.database || '')) throw new Error(`Refusing database ${run.database}.`);
  if (run.facultySource && run.facultySource !== 'seed') throw new Error('The screenshots are committed evidence: start the practice copy with -- --faculty-seed.');
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  // --client <url>: another client on the same gateway (the baseline's, for the before findings).
  const CLIENT = argOf('--client', null) || run.clientUrl || `http://localhost:${run.ports.client}`;
  const API = `${run.gatewayUrl || `http://localhost:${run.ports.gateway}`}/api`;
  const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };

  // The three accounts: the TEST Dean from the demo, and a TEST College Secretary and a TEST Faculty
  // account made here when missing (kept in .demo-data, gitignored).
  const login = async (email, password) => {
    const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: email, password }) });
    const body = await res.json().catch(() => ({}));
    return res.ok ? body.token : null;
  };
  const deanToken = await login(secrets.deanEmail, secrets.deanPassword);
  if (!deanToken) throw new Error('The TEST Dean could not sign in.');
  let accounts = {};
  try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { /* none yet */ }
  const ensure = async (key, role, name) => {
    const want = accounts[`${run.database}:${key}`];
    if (want && await login(want.email, want.password)) return want;
    const made = { email: `${key}.uicheck@example.test`, password: randomPassword() };
    const res = await fetch(`${API}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deanToken}` }, body: JSON.stringify({ name, email: made.email, password: made.password, role }) });
    if (!res.ok) {
      // Already there from an earlier run with a lost password: give it a new one.
      const list = await (await fetch(`${API}/users`, { headers: { Authorization: `Bearer ${deanToken}` } })).json();
      const user = (list.users || list.data || []).find(u => u.email === made.email);
      if (!user) throw new Error(`Could not make the ${role} account (${res.status}).`);
      const put = await fetch(`${API}/users/${user._id || user.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deanToken}` }, body: JSON.stringify({ name, email: made.email, role, status: 'Active', password: made.password }) });
      if (!put.ok) throw new Error(`Could not reset the ${role} account (${put.status}).`);
    }
    accounts[`${run.database}:${key}`] = made;
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    return made;
  };
  const creds = {
    dean: { email: secrets.deanEmail, password: secrets.deanPassword },
    secretary: await ensure('secretary', 'College Secretary', 'TEST College Secretary (UI check)'),
    faculty: await ensure('faculty', 'Faculty', 'TEST Faculty (UI check)')
  };

  const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  if (!NO_SHOTS) fs.mkdirSync(OUT_DIR, { recursive: true });
  const result = { at: new Date().toISOString(), set: SET, database: run.database, shots: [], findings: [] };
  const pagesOf = (which) => PAGES.filter(p => (which === 'all' || p.main) && (!ONLY.length || ONLY.includes(p.id)));
  try {
    for (const [role, viewport, theme, which, termOverride] of PASSES) {
      const passTerm = termOverride || TERM;
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.addInitScript(([year, semester, mode]) => {
        try {
          window.localStorage.setItem('intellisched-theme', mode);
          window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: year, activeSemester: semester }));
        } catch { /* none */ }
      }, [passTerm.academicYear, passTerm.semester === 2 ? '2nd Semester' : '1st Semester', theme]);
      await page.goto(CLIENT);
      await page.getByTestId('login-submit').waitFor({ timeout: 30000 });
      await page.getByTestId('login-username').fill(creds[role].email);
      await page.getByTestId('login-password').fill(creds[role].password);
      await page.getByTestId('login-submit').click();
      await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
      const tag = `${role}-${viewport.width}x${viewport.height}-${theme}${termOverride ? `-AY${termOverride.academicYear}` : ''}`;
      const shoot = async (name) => {
        const file = `${name}__${tag}.jpg`;
        if (!NO_SHOTS) await page.screenshot({ path: path.join(OUT_DIR, file), type: 'jpeg', quality: 72 });
        const found = await page.evaluate(CHECKS);
        for (const f of found) result.findings.push({ page: name, role, viewport: `${viewport.width}x${viewport.height}`, theme, ...f, shot: file });
        result.shots.push(file);
        return found.length;
      };
      for (const p of pagesOf(which)) {
        await page.evaluate((h) => { window.location.hash = `#/${h}`; }, p.hash);
        await page.waitForTimeout(2200);
        await page.waitForSelector('[data-testid="nav-switching"]', { state: 'detached', timeout: 15000 }).catch(() => {});
        const n = await shoot(p.id);
        process.stdout.write(`${tag} ${p.id} ${n}\n`);
      }
      // The dialogs, as the Dean only (the other roles may not open the forms), in both widths' light and dark.
      if (role === 'dean' && which === 'all') {
        for (const d of DIALOGS.filter(x => !ONLY.length || ONLY.includes(x.id))) {
          await page.evaluate((h) => { window.location.hash = `#/${h}`; }, d.hash);
          await page.waitForTimeout(1800);
          try {
            await page.getByTestId(d.open).filter({ visible: true }).first().click({ timeout: 12000 });
            if (d.type) await page.getByTestId(d.open).first().fill(d.type);
            await page.waitForTimeout(700);
            const n = await shoot(`dialog-${d.id}`);
            process.stdout.write(`${tag} dialog-${d.id} ${n}\n`);
          } catch (e) { result.findings.push({ page: `dialog-${d.id}`, role, viewport: `${viewport.width}x${viewport.height}`, theme, kind: 'not-opened', where: d.open, detail: e.message.split('\n')[0] }); }
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(300);
        }
      }
      await context.close();
    }
  } finally { await browser.close(); }
  // A summary by kind and page.
  const byKind = {};
  for (const f of result.findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  result.summary = { shots: result.shots.length, findings: result.findings.length, byKind };
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify(result, null, 2));
  console.log(`${result.shots.length} screenshots, ${result.findings.length} findings ${JSON.stringify(byKind)} -> ${path.relative(REPO, LOG)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
