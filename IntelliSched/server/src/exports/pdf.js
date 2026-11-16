// The PDF renderer (Phase 8 Part 2, decision 3): the export's HTML printed to PDF offline by a
// headless browser already on the computer — Microsoft Edge on Windows (every Windows computer has
// it, and the tests already drive it), else Chrome, else Playwright's Chromium from client/ — never
// Word or LibreOffice, and no new dependency. Fonts: the browser draws the installed Arial, Arial
// Narrow and Old English Text MT and embeds them in the PDF; on a computer without them the HTML
// carries the bundled look-alikes (fonts.js).
//
// Phase 12.2 (decision 2): a failure is logged (the browser, the arguments, the exit, the last 20 lines
// of its stderr, the time, whether it timed out; never the document), the browser keeps one profile
// folder (PDF_PROFILE_DIR, the kit's run\browser-profile; else a folder under the system's temp), the
// first start of a browser in this process gets 60 s and later ones 30 s, a failure is retried once
// with a fresh profile, then the next browser found is tried. One PDF at a time (one profile each).
// warmUp() renders one tiny PDF in the background so the user's first export is not the cold start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const USER_MESSAGE = 'The PDF could not be made on this computer. Try again, or export the file as Word (DOCX).';
const NO_BROWSER_MESSAGE = 'No browser for the PDF was found on this computer. Install Microsoft Edge or Chrome, or export the file as Word (DOCX).';
const FIRST_START_MS = 60000;
const LATER_START_MS = 30000;
const MAX_BROWSERS = 2;
const STDERR_LINES = 20;

// The browsers the PDF may be printed with, in order. EXPORT_BROWSER (a developer's or a test's
// override) is the ONLY one when set, so a wrong path fails visibly instead of falling back.
const candidateBrowsers = () => {
  if (process.env.EXPORT_BROWSER) return [process.env.EXPORT_BROWSER];
  const found = [];
  if (process.platform === 'win32') {
    const programs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of programs) found.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const base of programs) found.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else {
    found.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  // Playwright's Chromium, when the client's tests installed it.
  const playwright = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null)
    || path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(playwright).filter(d => d.startsWith('chromium')).sort().reverse();
    for (const dir of dirs) {
      found.push(path.join(playwright, dir, 'chrome-win', 'chrome.exe'));
      found.push(path.join(playwright, dir, 'chrome-linux', 'chrome'));
    }
  } catch { /* no Playwright browsers */ }
  return found;
};

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// Every browser to try, in order (at most MAX_BROWSERS; Edge's 32- and 64-bit folders count once).
// With EXPORT_BROWSER the path is returned even when it does not exist: the failure is then logged.
const browsersToTry = () => {
  if (process.env.EXPORT_BROWSER) return [process.env.EXPORT_BROWSER];
  const out = [];
  const kinds = new Set();
  for (const p of candidateBrowsers()) {
    const kind = path.basename(p).toLowerCase();
    if (kinds.has(kind) || !exists(p)) continue;
    kinds.add(kind);
    out.push(p);
    if (out.length >= MAX_BROWSERS) break;
  }
  return out;
};

const findBrowser = () => browsersToTry().find(exists) || null;

// The folder that holds each browser's profile and the jobs' working files: the kit's gateway gets
// run\browser-profile from its supervisor; anything else (the tests, the scripts) one folder per
// process under the system's temp, removed when the process ends, so two processes never share a
// profile (a second browser on one profile hands over to the first and writes nothing).
let ownRoot = null;
const profileRoot = () => {
  if (process.env.PDF_PROFILE_DIR) return process.env.PDF_PROFILE_DIR;
  if (!ownRoot) {
    ownRoot = path.join(os.tmpdir(), `intellisched-pdf-${process.pid}`);
    process.once('exit', () => { try { fs.rmSync(ownRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return ownRoot;
};
const profileDirOf = (browser) => path.join(profileRoot(), path.basename(browser, path.extname(browser)).toLowerCase());

// Browsers that already made a PDF in this process (their next start is a warm one: 30 s).
const warmBrowsers = new Set();

const lastLines = (text, n) => text.split(/\r?\n/).filter(l => l.trim()).slice(-n);

// An elevated process gets no PDF from Edge or Chrome: the browser relaunches itself de-elevated and
// the process it started ends at once (Phase 12.2's finding on the office laptop).
const elevationWords = () => {
  try {
    const id = require('../utils/elevation').processIdentity();
    if (id.elevated === true) return `ELEVATED (administrator, integrity ${id.integrity}): the browser relaunches itself de-elevated and writes no PDF here; start IntelliSched as the daily user`;
    if (id.elevated === false) return `not elevated (integrity ${id.integrity || 'normal'})`;
  } catch { /* unknown */ }
  return 'elevation unknown';
};

// One failure, one block in the server log. Paths and flags only: never the document.
const logFailure = (f) => {
  const lines = [
    `[PDF] ${new Date().toISOString()} the PDF could not be made (attempt ${f.attempt}${f.final ? ', the last one' : ''})`,
    `  browser: ${f.browser}`,
    `  arguments: ${f.args.join(' ')}`,
    `  exit: ${f.spawnError ? `not started (${f.spawnError})` : `code ${f.code === null ? 'none' : f.code}, signal ${f.signal || 'none'}`}`,
    `  timeout: ${f.timedOut ? `yes (after ${f.timeoutMs} ms)` : 'no'}`,
    `  elapsed: ${f.elapsedMs} ms`,
    `  result: ${f.reason}`,
    `  this process: ${elevationWords()}`,
    `  stderr (last ${STDERR_LINES} lines):${f.stderr.length ? '' : ' (empty)'}`,
    ...f.stderr.map(l => `    ${l}`)
  ];
  console.error(lines.join('\n'));
};

// One start of one browser: resolves { ok: true, pdf } or { ok: false, ...facts for the log }.
const renderOnce = (browser, html, { timeoutMs, freshProfile }) => new Promise((resolve) => {
  const started = Date.now();
  let profile = profileDirOf(browser);
  const jobs = path.join(profileRoot(), 'jobs');
  let work;
  try {
    if (freshProfile) {
      // A browser that was just killed may still hold its profile's files: then a new folder.
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { profile = `${profile}-fresh-${Date.now()}`; }
    }
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(jobs, { recursive: true });
    work = fs.mkdtempSync(path.join(jobs, 'job-'));
  } catch (err) {
    resolve({ ok: false, browser, args: [`--user-data-dir=${profile}`], code: null, signal: null, spawnError: null, timedOut: false, timeoutMs, elapsedMs: Date.now() - started, stderr: [], reason: `the profile folder could not be prepared (${err.code || err.message})` });
    return;
  }
  const htmlPath = path.join(work, 'export.html');
  const pdfPath = path.join(work, 'export.pdf');
  fs.writeFileSync(htmlPath, html);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`
  ];
  const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };
  let stderr = '';
  let timedOut = false;
  let settled = false;
  let child;
  const finish = (facts) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    let pdf = null;
    try {
      const buf = fs.readFileSync(pdfPath);
      if (buf.subarray(0, 5).toString('latin1') === '%PDF-') pdf = buf;
    } catch { /* no file */ }
    cleanup();
    const base = { browser, args, timeoutMs, elapsedMs: Date.now() - started, timedOut, stderr: lastLines(stderr, STDERR_LINES), code: null, signal: null, spawnError: null, ...facts };
    if (pdf && !timedOut) resolve({ ok: true, pdf, ...base });
    else resolve({ ok: false, ...base, reason: timedOut ? 'the browser did not finish in time' : facts.spawnError ? 'the browser could not be started' : 'the browser ended without writing the PDF' });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    // The browser's whole tree (its GPU and crash-handler processes too), not only the first process.
    try {
      if (process.platform === 'win32' && child.pid) {
        // Synchronously, so the tree is gone before a retry reuses or removes the profile.
        require('child_process').spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
      } else child.kill('SIGKILL');
    } catch { /* already gone */ }
    // A browser that ignores the kill: give up on it after 5 more seconds.
    setTimeout(() => finish({}), 5000).unref?.();
  }, timeoutMs);
  try {
    child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (err) {
    finish({ spawnError: err.code || err.message });
    return;
  }
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-8000); });
  child.on('error', (err) => finish({ spawnError: err.code || err.message }));
  child.on('exit', (code, signal) => finish({ code, signal }));
});

// HTML -> PDF bytes: each browser found (at most two), each tried once and once more with a fresh
// profile. The caller's timeoutMs, when given, replaces the 60 s / 30 s rule.
const renderWithFallback = async (html, { timeoutMs } = {}) => {
  const browsers = browsersToTry();
  if (!browsers.length) throw new Error(NO_BROWSER_MESSAGE);
  // Decision 3: the browser never runs elevated. From an elevated process (an installer, an updater's
  // backup) it would relaunch itself de-elevated and write nothing, so it is not started at all.
  let elevated = false;
  try { elevated = require('../utils/elevation').isElevated(); } catch { /* unknown: try */ }
  if (elevated) {
    console.error(`[PDF] ${new Date().toISOString()} no PDF: this process runs as administrator (pid ${process.pid}), and the browser is never started elevated. IntelliSched's own gateway, which runs as the daily user, makes the PDFs.`);
    throw new Error(USER_MESSAGE);
  }
  const plan = browsers.flatMap(b => [{ browser: b, freshProfile: false }, { browser: b, freshProfile: true }]);
  for (let i = 0; i < plan.length; i += 1) {
    const { browser, freshProfile } = plan[i];
    // The start's limit, plus 10 s per started MB of HTML: a whole Teachers' Program set (its
    // letterheads inline) takes longer to print than the browser takes to start.
    const limit = timeoutMs || (warmBrowsers.has(browser) ? LATER_START_MS : FIRST_START_MS) + Math.ceil(html.length / 1e6) * 10000;
    const r = await renderOnce(browser, html, { timeoutMs: limit, freshProfile });
    if (r.ok) {
      warmBrowsers.add(browser);
      if (i > 0) console.log(`[PDF] made with ${browser} on attempt ${i + 1} (${r.elapsedMs} ms)`);
      return r.pdf;
    }
    warmBrowsers.delete(browser);
    logFailure({ ...r, attempt: `${i + 1} of ${plan.length}`, final: i === plan.length - 1 });
  }
  throw new Error(USER_MESSAGE);
};

// One PDF at a time: the browsers keep one profile folder each, which two at once would share.
let queue = Promise.resolve();
const htmlToPdf = (html, opts = {}) => {
  const job = queue.then(() => renderWithFallback(html, opts));
  queue = job.catch(() => {});
  return job;
};

// The warm-up (decision 2): one tiny blank PDF, in the background; its failure is only logged.
// state: 'off' | 'pending' | 'ok' | 'failed'; warmUpDone resolves when it ended (or at once when off).
const warm = { state: 'off', ms: null, done: Promise.resolve() };
const warmUp = () => {
  if (warm.state === 'pending' || warm.state === 'ok') return warm.done;
  warm.state = 'pending';
  const started = Date.now();
  warm.done = htmlToPdf('<!doctype html><html><body></body></html>')
    .then(() => { warm.state = 'ok'; warm.ms = Date.now() - started; console.log(`[PDF] warm-up done in ${warm.ms} ms`); })
    .catch((err) => { warm.state = 'failed'; warm.ms = Date.now() - started; console.error(`[PDF] warm-up failed after ${warm.ms} ms: ${err.message}`); });
  return warm.done;
};
const warmUpState = () => ({ state: warm.state, ms: warm.ms });
const warmUpDone = () => warm.done;

// Plain facts about a PDF, for the tests and the system check: the page count, the first page's size
// in points, and the embedded font names (a browser PDF subsets fonts as "ABCDEF+Arial-Bold").
const pdfInfo = (buffer) => {
  const text = buffer.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  const mediaBox = box ? { w: Number(box[3]) - Number(box[1]), h: Number(box[4]) - Number(box[2]) } : null;
  const fonts = [...new Set([...text.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_.]+)/g)].map(m => m[1].replace(/^[A-Z]{6}\+/, '')))];
  const embedded = /\/FontFile2|\/FontFile3|\/FontFile[^\d]/.test(text);
  return { pages, mediaBox, fonts, embedded };
};

module.exports = { findBrowser, browsersToTry, htmlToPdf, pdfInfo, warmUp, warmUpState, warmUpDone, profileRoot, USER_MESSAGE, FIRST_START_MS, LATER_START_MS };
