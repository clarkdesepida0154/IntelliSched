#!/usr/bin/env node
// Phase 8 Part 10: before and after pictures of the sign-in page and the sidebar (the wordmark), light and dark.
// Phase 8 Part 11: "after" is the old header with "INTELLI" bold (the team rejected Part 10's look); the script
// also writes its section of docs/screenshots/README.md, which doc-screenshots.js rewrites without it.
// "Before" is the Part 10 baseline commit (fb188e5) served by Vite from a git worktree in .demo-data/baseline-wt
// (git ignores it) on port 5190, talking to the practice copy's gateway; "after" is the practice copy's own client.
// Needs `npm run demo:sem2:reset -- --faculty-seed` running and the worktree:
//   git worktree add --detach .demo-data/baseline-wt fb188e5   (then a junction from its client/node_modules to client/node_modules)
//   node scripts/demo/part10-wordmark-shots.js [--out docs/screenshots/wordmark]
// Writes sign-in-before/after and sidebar-before/after, in light and dark, 1366 x 768. No rating can appear: the sign-in
// and the sidebar show none. Changes nothing in the demo's data.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const OUT = path.resolve(REPO, argOf('--out', path.join('docs', 'screenshots', 'wordmark')));
const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
if (run.mode !== 'sem2' || !/_test$/.test(run.database)) throw new Error('Needs the practice copy (demo:sem2).');
const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || '.demo-data/demo-secrets.json'), 'utf8'));
const WT = path.join(REPO, '.demo-data', 'baseline-wt', 'client');
const BEFORE_PORT = 5190;
const API = `http://localhost:${run.ports.gateway}/api`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The README's wordmark section, replaced or put before "## Make them again" (only for the committed folder).
const writeReadmeSection = () => {
  const readme = path.join(OUT, '..', 'README.md');
  if (path.resolve(OUT) !== path.join(REPO, 'docs', 'screenshots', 'wordmark') || !fs.existsSync(readme)) return;
  const rows = ['sign-in', 'sidebar'].flatMap(what => ['light', 'dark'].flatMap(theme => ['before', 'after'].map(which =>
    `| [\`wordmark/${what}-${which}-${theme}.png\`](wordmark/${what}-${which}-${theme}.png) | ${what === 'sign-in' ? 'Sign-in' : 'Sidebar'}, ${which}, ${theme} |`)));
  const section = ['## The wordmark, before and after (`wordmark/`)', '',
    '1366 × 768, the sign-in page and the sidebar\'s top-left column. "Before" is the Part 10 baseline commit `fb188e5` served from a git worktree; "after" is this code: the same header with "INTELLI" as bold as "SCHED" (Phase 8 Part 11), nothing else changed.', '',
    '| File | What it shows |', '|---|---|', ...rows, '', ''].join('\n');
  let text = fs.readFileSync(readme, 'utf8').replace(/## The wordmark, before and after[\s\S]*?(?=## |$)/, '');
  text = text.includes('## Make them again') ? text.replace('## Make them again', `${section}## Make them again`) : `${text.trimEnd()}\n\n${section}`;
  fs.writeFileSync(readme, text);
};

(async () => {
  if (!fs.existsSync(path.join(WT, 'src'))) throw new Error('The baseline worktree is missing (see the header).');
  fs.mkdirSync(OUT, { recursive: true });
  const vite = spawn(process.execPath, [path.join(REPO, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(BEFORE_PORT), '--strictPort'], { cwd: WT, env: { ...process.env, VITE_API_BASE_URL: API }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i += 1) {
      if (await fetch(`http://localhost:${BEFORE_PORT}`).then(r => r.ok).catch(() => false)) break;
      await sleep(1000);
    }
    const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const term = JSON.stringify({ activeAcademicYear: run.term?.academicYear || '2026-2027', activeSemester: '2nd Semester' });
    for (const [which, base] of [['before', `http://localhost:${BEFORE_PORT}`], ['after', run.clientUrl]]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: theme });
        const page = await context.newPage();
        // The baseline client calls the gateway from another origin: answer for it with the headers it needs.
        if (which === 'before') {
          await page.route(`${API}/**`, async (route) => {
            const cors = { 'access-control-allow-origin': base, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-credentials': 'true' };
            if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
            const res = await route.fetch();
            return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
          });
        }
        await page.addInitScript(([t, mode, termValue]) => {
          try { window.localStorage.setItem('intellisched-theme', mode); window.localStorage.setItem('intellisched.activeTerm', termValue); } catch { /* none */ }
        }, [theme, theme, term]);
        await page.goto(base);
        await page.getByTestId('login-submit').waitFor({ timeout: 30000 });
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(OUT, `sign-in-${which}-${theme}.png`) });
        await page.getByTestId('login-username').fill(secrets.deanEmail);
        await page.getByTestId('login-password').fill(secrets.deanPassword);
        await page.getByTestId('login-submit').click();
        await page.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
        await page.waitForTimeout(900);
        // The sidebar: the top-left 300 px column, a crop of the page.
        await page.screenshot({ path: path.join(OUT, `sidebar-${which}-${theme}.png`), clip: { x: 0, y: 0, width: 300, height: 768 } });
        await context.close();
        console.log(`${which} ${theme}: done`);
      }
    }
    await browser.close();
    writeReadmeSection();
  } finally {
    vite.kill();
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
