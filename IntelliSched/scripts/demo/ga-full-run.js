// The Dean's path on the full college in the browser (Phase 2 Step 4; since Phase 3 Step 4 on the
// Generate Schedule page): the menu's "Check & generate" -> Generate Schedule -> the Readiness panel
// says "Ready to generate" (TBA rooms are automatic: when the CCS rooms can't hold every class, the
// rest become TBA rooms to request) -> "Generate Mother Schedule" -> the plain progress line -> the
// plain result ("No conflicts – saved as Draft N", the TBA and Saturday counts, the time taken).
// The Phase 2 steps "Needs extra rooms" -> "Use these numbers" -> Save are gone for the Dean.
//
// Usage (repo root): start a fresh demo with `npm run demo:full:reset`, then in a second terminal
//   node scripts/demo/ga-full-run.js [--seed N] [--out <folder>]
// It reads the demo's ports from .demo-data/run.json and the TEST logins from
// .demo-data/demo-secrets.json, and writes ga-full-1-ready.png, ga-full-2-during.png,
// ga-full-3-after.png and ga-full-run.json into docs/benchmarks/phase3/ (or --out, relative to the
// repo). The Phase 2 evidence in docs/benchmarks/phase2/ is left as it was.
// Without --seed every run gets a new one. `--seed N` sets the seed under "Advanced (system team)"
// (Phase 8 Part 8: one account, so the TEST Dean does both).
// Runs headless in the installed Microsoft Edge (Playwright from client/node_modules). It writes no
// data itself: the run it starts saves a Draft in the demo's own _test database.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const seed = argOf('--seed');
const OUT = path.resolve(REPO, argOf('--out') || path.join('docs', 'benchmarks', 'phase3'));
const secrets = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'demo-secrets.json'), 'utf8'));
const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
const CLIENT = `http://localhost:${run.ports?.client || 5174}`;
const log = (m) => console.log(`[ga-full-run ${new Date().toISOString().slice(11, 19)}] ${m}`);

const shoot = async (page, name) => {
  await page.waitForTimeout(600);
  const height = await page.evaluate(() => {
    const scroller = document.querySelector('main > div.overflow-y-auto');
    return Math.max(900, (scroller ? scroller.scrollHeight : document.body.scrollHeight) + 90);
  });
  await page.setViewportSize({ width: 1440, height: Math.min(height, 9000) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  log(`screenshot ${name}.png`);
};
const text = (page, id) => page.evaluate((i) => document.querySelector(`[data-testid="${i}"]`)?.innerText ?? null, id);

(async () => {
  if (seed !== null && !/^\d+$/.test(seed)) {
    console.error('--seed needs a whole number, e.g. --seed 1.');
    process.exit(1);
  }
  const account = { who: 'TEST Dean', email: secrets.deanEmail, password: secrets.deanPassword };
  if (!account.email || !account.password) {
    console.error(`No ${account.who} login: .demo-data/demo-secrets.json has no deanEmail / deanPassword. Start the demo once to create it.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const summary = { client: CLIENT, signedInAs: account.who, seed: seed === null ? 'new random seed (the Dean sets none)' : Number(seed) };
  try {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('intellisched.activeTerm', JSON.stringify({ activeAcademicYear: '2025-2026', activeSemester: '1st Semester' })); } catch { /* none */ }
    });
    await page.goto(CLIENT);
    await page.getByTestId('login-username').fill(account.email);
    await page.getByTestId('login-password').fill(account.password);
    await page.getByTestId('login-submit').click();

    // The menu: "Check & generate" -> Generate Schedule.
    const group = page.getByTestId('nav-group-check');
    await group.waitFor({ timeout: 30000 });
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
    await page.getByTestId('nav-generate').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="topbar-page-name"]')?.textContent.trim() === 'Generate Schedule', null, { timeout: 30000 });

    // The Readiness panel at the top of the page.
    const verdict = page.getByTestId('readiness-verdict');
    await verdict.waitFor({ timeout: 90000 });
    summary.term = await text(page, 'current-term');
    summary.verdict = await verdict.getAttribute('data-verdict');
    summary.verdictText = await text(page, 'readiness-verdict');
    summary.readinessLines = await page.evaluate(() => [...document.querySelectorAll('li[data-testid^="readiness-line-"]')]
      .map(li => ({ line: li.dataset.line, status: li.dataset.status, text: li.innerText.replace(/\s+/g, ' ').trim() })));
    log(`readiness: ${summary.verdict} (${summary.verdictText?.replace(/\s+/g, ' ')})`);
    await shoot(page, 'ga-full-1-ready');
    if (summary.verdict !== 'ready') throw new Error(`expected "Ready to generate", got ${summary.verdict}: ${summary.verdictText}`);

    if (seed !== null) {
      // The seed is set under "Advanced (system team)" (the Dean's technical view since Phase 8 Part 8).
      await page.getByTestId('generate-advanced-toggle').click();
      await page.getByTestId('ga-seed').fill(String(seed));
      log(`seed ${seed} set under Advanced`);
    }

    await page.getByTestId('generate-button').click();
    // A term that already has a Draft asks first: the new run becomes the newest Draft.
    const confirm = page.getByTestId('generate-confirm');
    if (await confirm.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
      summary.confirmation = await text(page, 'generate-confirm');
      await page.getByTestId('generate-confirm-confirm').click();
      log('confirmed "Generate a new Draft"');
    }
    await page.getByTestId('generate-progress').waitFor({ timeout: 30000 });
    const started = Date.now();
    const readings = [];
    let shotDuring = false;
    while (Date.now() - started < 12 * 60 * 1000) {
      const s = await page.evaluate(() => {
        const q = (id) => document.querySelector(`[data-testid="${id}"]`);
        return { line: q('generate-progress-line')?.innerText.trim(), elapsed: q('generate-elapsed')?.innerText.trim(), result: q('generate-result')?.dataset.status || null };
      });
      if (s.result && !['running', 'saving'].includes(s.result)) break;
      if (s.line && (!readings.length || readings.at(-1).line !== s.line)) readings.push({ at: Math.round((Date.now() - started) / 1000), line: s.line, elapsed: s.elapsed });
      if (!shotDuring && Date.now() - started > 20000) { await shoot(page, 'ga-full-2-during'); shotDuring = true; }
      await page.waitForTimeout(1000);
    }
    summary.progressReadings = readings;
    const result = page.getByTestId('generate-result');
    await result.waitFor({ timeout: 60000 });
    summary.resultStatus = await result.getAttribute('data-status');
    summary.resultTitle = await text(page, 'generate-result-title');
    summary.resultMessage = await text(page, 'generate-result-message');
    summary.facts = {
      tba: await text(page, 'generate-result-tba'),
      noRoom: await text(page, 'generate-result-noroom'),
      saturday: await text(page, 'generate-result-saturday'),
      time: await text(page, 'generate-result-time')
    };
    log(`result: ${summary.resultStatus} - ${summary.resultTitle}`);
    await shoot(page, 'ga-full-3-after');
    if (!shotDuring) log('the run ended before 20 s: no "during" screenshot');
  } catch (err) {
    summary.error = err.message;
    log(`FAILED: ${err.message}`);
    try { await shoot(page, 'ga-full-error'); } catch { /* none */ }
  } finally {
    fs.writeFileSync(path.join(OUT, 'ga-full-run.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await browser.close();
  }
  process.exit(summary.error ? 1 : 0);
})();
