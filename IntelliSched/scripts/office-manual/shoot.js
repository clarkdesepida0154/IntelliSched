#!/usr/bin/env node
// Phase 15: every screenshot of the IntelliSched Office Manual, taken fresh from the practice copy while each
// step is really done (sign in, add an account, generate, move a class, approve, export, back up, restore …).
//
//   npm run demo:sem2:reset -- --faculty-seed          (repo root, PowerShell; the practice copy)
//   node scripts/office-manual/shoot.js [--only a,b] [--from id] [--list]
//
// Writes docs/office-manual/images/*.jpg (1366x768 at device scale 2, light theme, cropped to the step) and
// .demo-data/logs/office-manual-shots.json (each shot, its markers and the number of blurred items).
// Refuses anything but the practice copy (lib.readRun). Practice-only side files go to
// .deploy-out/manual-shots/ (the "USB stick" folder), removed by --cleanup. Never prints a password.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = (argOf('--only') || '').split(',').filter(Boolean);
const FROM = argOf('--from');
const DEBUG_DIR = path.join(L.REPO, '.demo-data', 'office-manual-debug');
const SHOTS_ROOT = path.join(L.REPO, '.deploy-out', 'manual-shots');

const ctx = L.readRun();
const state = L.readState();
const log = (() => { try { return JSON.parse(fs.readFileSync(L.LOG_FILE, 'utf8')); } catch { return { shots: {} }; } })();
const saveLog = () => { fs.mkdirSync(path.dirname(L.LOG_FILE), { recursive: true }); fs.writeFileSync(L.LOG_FILE, JSON.stringify(log, null, 2)); };
const newPassword = () => `Pr-${crypto.randomBytes(9).toString('base64url')}7a`;
let NAMES = [];

const { chromium } = require(path.join(L.REPO, 'client', 'node_modules', '@playwright', 'test'));
let browser;

// ---------------------------------------------------------------------------------------- helpers
const newPage = async (theme = 'light') => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript((mode) => {
    try {
      window.localStorage.setItem('intellisched-theme', mode);
      window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: '2026-2027', activeSemester: '2nd Semester' }));
    } catch { /* none */ }
  }, theme);
  return page;
};
const signIn = async (page, email, password, { expectHome = true } = {}) => {
  await page.goto(ctx.client);
  await page.getByTestId('login-submit').waitFor({ timeout: 30000 });
  await page.getByTestId('login-username').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  if (expectHome) await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
};
const go = async (page, hash, title) => {
  await page.evaluate((h) => { window.location.hash = `#/${h}`; }, hash);
  if (title) await page.getByTestId('page-title').filter({ hasText: title }).waitFor({ timeout: 30000 });
  await page.waitForSelector('[data-testid="nav-switching"]', { state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
};
const tid = (page, id) => page.getByTestId(id).filter({ visible: true }).first();
const choose = async (page, testId, value) => {
  await tid(page, `${testId}-button`).click();
  await page.locator(`[data-testid="${testId}-list"] [role="option"][data-value="${value}"]`).click();
};
const dump = async (page, name) => {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`) }).catch(() => {});
  const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid], [role="dialog"], [role="menu"], [role="menuitem"], button')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(el => `${el.getAttribute('data-testid') || ''} <${el.tagName.toLowerCase()} role=${el.getAttribute('role') || ''}> ${(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')).catch(() => '');
  fs.writeFileSync(path.join(DEBUG_DIR, `${name}.txt`), ids);
};

// A locator, a test id ('t:…' or a bare id), or a box.
const toLoc = (page, x) => (typeof x === 'string' ? tid(page, x.replace(/^t:/, '')) : x);
const boxOf = async (page, x) => {
  if (x && typeof x === 'object' && 'width' in x && 'x' in x && !('click' in x)) return x;
  const loc = toLoc(page, x);
  const b = await loc.boundingBox({ timeout: 15000 });
  if (!b) throw new Error(`No box for ${x}`);
  return b;
};
const union = (boxes) => {
  const x1 = Math.min(...boxes.map(b => b.x)); const y1 = Math.min(...boxes.map(b => b.y));
  const x2 = Math.max(...boxes.map(b => b.x + b.width)); const y2 = Math.max(...boxes.map(b => b.y + b.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};

// shot(page, name, { marks: [{ t, n, at, arrow, highlight }], clip: 'full' | target | [targets], pad, scrollTo })
const shot = async (page, name, opts = {}) => {
  const { marks = [], pad = 28, scrollTo } = opts;
  if (opts.alignTop) await toLoc(page, opts.alignTop).evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  else if (scrollTo) await toLoc(page, scrollTo).scrollIntoViewIfNeeded().catch(() => {});
  else if (marks[0]) await toLoc(page, marks[0].t).scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(opts.wait ?? 400);
  const resolved = [];
  for (const m of marks) {
    if (m.optional && !(await toLoc(page, m.t).count())) continue;
    resolved.push({ ...m, t: undefined, box: await boxOf(page, m.t) });
  }
  const vw = 1366; const vh = 768;
  let clip;
  if (opts.clip === 'full') clip = { x: 0, y: 0, width: vw, height: vh };
  else {
    const targets = opts.clip ? (Array.isArray(opts.clip) ? opts.clip : [opts.clip]) : marks.filter(m => !m.optional).map(m => m.t);
    const boxes = [];
    for (const t of targets) boxes.push(await boxOf(page, t));
    const u = union(boxes);
    const px = opts.padX ?? pad; const py = opts.padY ?? pad;
    clip = { x: u.x - px, y: u.y - py, width: u.width + 2 * px, height: u.height + 2 * py };
    if (opts.minWidth && clip.width < opts.minWidth) { const d = opts.minWidth - clip.width; clip.x -= d / 2; clip.width = opts.minWidth; }
  }
  clip.x = Math.max(0, Math.round(clip.x)); clip.y = Math.max(0, Math.round(clip.y));
  clip.width = Math.round(Math.min(vw - clip.x, clip.width)); clip.height = Math.round(Math.min(vh - clip.y, clip.height));
  let blurred; let leaks;
  for (let attempt = 0; attempt < 4; attempt++) {
    // A list that is still fading in can change what is on top: draw and check again until they agree.
    blurred = await page.evaluate(L.drawOverlay, { names: NAMES, marks: resolved, color: L.BLUE, clip });
    leaks = await page.evaluate(L.verifyCovered, { names: NAMES, clip });
    if (!leaks.length) break;
    await page.waitForTimeout(500);
  }
  if (leaks.length) { await dump(page, `leak-${name}`); throw new Error(`${name}: ${leaks.length} name(s) not covered by a blur patch: ${leaks.join(" | ")}`); }
  fs.mkdirSync(L.OUT_DIR, { recursive: true });
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(L.OUT_DIR, file), type: 'jpeg', quality: 84, clip, caret: 'hide' });
  await page.evaluate(() => document.getElementById('om-overlay')?.remove());
  log.shots[name] = { file, at: new Date().toISOString(), marks: marks.map(m => m.n).filter(n => n != null), blurred: blurred.length, blurredKinds: blurred.reduce((a, b) => ({ ...a, [b.kind]: (a[b.kind] || 0) + 1 }), {}), clip };
  saveLog();
  console.log(`  shot ${name} (${clip.width}x${clip.height}, ${blurred.length} blurred)`);
};

// ---------------------------------------------------------------------------------------- scenes
const S = {};
const deanCreds = () => ({ email: ctx.secrets.deanEmail, password: ctx.secrets.deanPassword });
let dean; // the Dean's page, signed in

const SCENES = [];
const scene = (id, fn) => SCENES.push({ id, fn });

scene('signin', async () => {
  const page = await newPage();
  await page.goto(ctx.client);
  await page.getByTestId('login-submit').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await shot(page, 'c2-signin', { clip: 'full', marks: [{ t: 'login-username', n: 1 }, { t: 'login-password', n: 2 }, { t: 'login-submit', n: 3 }] });
  await page.getByTestId('login-username').fill(deanCreds().email);
  await page.getByTestId('login-password').fill(deanCreds().password);
  await shot(page, 'c2-signin-filled', { clip: ['login-username', 'login-submit'], pad: 40, marks: [{ t: 'login-submit', n: 3, arrow: 'left' }] });
  await page.getByTestId('login-submit').click();
  await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
  await page.context().close();
});

module.exports = { SCENES, scene, shot, go, tid, choose, dump, newPage, signIn, ctx, state, L, newPassword, S, deanCreds, SHOTS_ROOT };
require('./scenes');

(async () => {
  if (process.argv.includes('--list')) { for (const s of SCENES) console.log(s.id); return; }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const token = await L.login(ctx, deanCreds().email, deanCreds().password);
    if (!token) throw new Error('The TEST Dean could not sign in to the practice copy.');
    NAMES = await L.loadNames(ctx, token);
    console.log(`Practice copy ${ctx.run.database}: ${NAMES.length} name strings to blur.`);
    let started = !FROM;
    for (const s of SCENES) {
      if (FROM && s.id === FROM) started = true;
      if (!started || (ONLY.length && !ONLY.includes(s.id))) continue;
      console.log(`scene ${s.id}`);
      try { await s.fn(); } catch (e) { console.error(`scene ${s.id} FAILED: ${e.message.split('\n')[0]}`); if (S.dean) await dump(S.dean, `fail-${s.id}`); throw e; }
      // Names added during a scene (a new account) are blurred from the next scene on.
      if (S.refreshNames) { NAMES = await L.loadNames(ctx, token); S.refreshNames = false; }
    }
  } finally { await browser.close(); }
  const all = Object.values(log.shots);
  console.log(`${all.length} shots in the log, ${all.reduce((a, s) => a + s.blurred, 0)} blurred items.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
