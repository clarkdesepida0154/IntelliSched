// Checks the demo end to end (Phase 2 Step 0, "Demo checked"). It starts `npm run <script>` with stdin
// as a pipe, waits until the demo is ready, then checks:
//   (a) the client address answers 200 with HTML (the login page);
//   (b) the one login (Phase 8 Part 8: the TEST Dean; the defense's "Dean") signs in through the API
//       with the printed email and password, as the Dean; the Audit Trail reads, and approving a
//       version is the Dean's (a made-up version is refused with 404 after the permission check, so
//       nothing is read or written); no ACTIVE College Secretary account (the role is retired); the
//       accounts (Users & Roles' list): a fresh seed holds exactly the printed login, a kept database
//       at least that — and the defense exactly one active account (an account the Part 8 migration
//       locked, such as the retired College Secretary's, stays locked for its audit rows);
//   (c) GET /api/health reports mode "e2e", the mode's database, and a Python service on that database;
//   (d) the mode's active sections, a professor lock on every Major pair of the term, no GA version;
//   (e) a Ctrl+C byte on stdin stops the demo; afterwards every port it used is free, every process
//       it started (listed in .demo-data/run.json, children of children included) is gone, and the
//       MongoDB data folder is still there.
// Usage (repo root): node scripts/demo/check.js [demo|demo:reset] [--expect-seed | --expect-keep]
// Exits 1 when a check fails.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REPO_ROOT, MONGO_DIR, RUN_FILE } = require('./paths');
const { MODES, majorPairs } = require('./modes');
const procs = require('./processes');

const args = process.argv.slice(2);
const script = args.find(a => !a.startsWith('--')) || 'demo';
const expectSeed = args.includes('--expect-seed') ? true : (args.includes('--expect-keep') ? false : null);
const command = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts[script];
if (!command) throw new Error(`package.json has no script "${script}".`);
const modeName = (/--mode\s+(\S+)/.exec(command) || [])[1] || 'normal';
const mode = MODES[modeName];

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`[check] ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

// The logins the mode prints (Phase 8 Part 8: one account — the defense prints "Dean", every other
// mode the TEST Dean).
const LOGINS = mode?.logins || {
  dean: { label: 'TEST Dean', role: 'Dean' },
  extra: []
};

const run = async () => {
  const started = Date.now();
  // A reset of a mode that asks "Type RESET" (the defense) is answered with --yes: no console here.
  const extraArgs = command.includes('--reset') && mode?.resetPrompt ? ' -- --yes' : '';
  const demo = spawn(`npm run ${script}${extraArgs}`, { cwd: REPO_ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  demo.stdin.on('error', () => {}); // the demo may already have exited
  const exited = new Promise(resolve => demo.on('exit', code => resolve(code)));
  let exitCode = null;
  exited.then((code) => { exitCode = code; });
  // The demo's output is shown as it comes, whole lines only, indented.
  let shown = 0;
  for (const stream of [demo.stdout, demo.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk;
      const end = output.lastIndexOf('\n') + 1;
      if (end > shown) process.stdout.write(output.slice(shown, end - 1).split('\n').map(line => `  | ${line}\n`).join(''));
      shown = Math.max(shown, end);
    });
  }

  let ready = false;
  try {
    await procs.waitUntil({ label: 'demo', check: async () => output.includes('Press Ctrl+C to stop'), timeoutMs: 8 * 60000, shouldStop: () => exitCode !== null });
    ready = true;
  } catch (err) {
    record('the demo starts', false, err.stopRequested ? `it exited with code ${exitCode}` : err.message);
  }

  let run = null;
  if (ready) {
    record('the demo starts', true, `ready after ${Math.round((Date.now() - started) / 1000)} s`);
    if (expectSeed !== null) record(expectSeed ? 'it seeded the demo database' : 'it kept the demo database (no reseed)', expectSeed ? /\[demo\] Seeding /.test(output) : /\[demo\] Keeping /.test(output));
    run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
    const clientUrl = (/Open this address:\s+(\S+)/.exec(output) || [])[1];
    const email = (new RegExp(`${LOGINS.dean.label} email:\\s+(\\S+)`).exec(output) || [])[1];
    const password = (new RegExp(`${LOGINS.dean.label} password:\\s+(\\S+)`).exec(output) || [])[1];
    const apiBase = `http://localhost:${run.ports.gateway}/api`;

    // (a)
    const page = await procs.httpGet(clientUrl, 10000).catch(err => ({ status: err.message }));
    record('(a) the client address answers with the app page', page.status === 200 && page.contentType.includes('html') && String(page.body).includes('id="root"'), `${clientUrl} -> ${page.status} ${page.contentType || ''}`);

    // (b)
    const signIn = async (username, secret) => {
      const res = await fetch(`${apiBase}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: secret }) });
      return { res, body: await res.json().catch(() => ({})) };
    };
    const { res: login, body: session } = await signIn(email, password);
    record(`(b) the ${LOGINS.dean.label} signs in through the API, as the Dean`, login.ok && Boolean(session.token) && session.user?.role === 'Dean', `${email} -> ${login.status} ${session.user?.role || session.message || ''}`);
    // The other logins, printed as "<label> email:" / "<label> password:"; the sessions by role.
    const sessions = {};
    for (const { label, role } of LOGINS.extra) {
      const loginEmail = (new RegExp(`${label} email:\\s+(\\S+)`).exec(output) || [])[1];
      const loginPassword = (new RegExp(`${label} password:\\s+(\\S+)`).exec(output) || [])[1];
      if (!loginEmail || !loginPassword) {
        record(`(b) the demo prints the ${label} login`, false, `no "${label} email:" / "${label} password:" lines`);
        continue;
      }
      const { res, body } = await signIn(loginEmail, loginPassword);
      const signedIn = res.ok && Boolean(body.token) && body.user?.role === role;
      record(`(b) the ${label} signs in through the API, as the ${role}`, signedIn, `${loginEmail} -> ${res.status} ${body.user?.role || body.message || ''}`);
      if (signedIn) sessions[role] = body.token;
    }
    const api = async (method, route, { token = session.token, body } = {}) => {
      const headers = { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
      const res = await fetch(`${apiBase}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    // The accounts, as Users & Roles lists them (every role may read the list). Phase 8 Part 8: ONE
    // account. A fresh seed makes exactly the printed login; a kept database keeps the accounts it has
    // until its reset — except the defense, which must have exactly one ACTIVE account (an account the
    // Part 8 migration locked, such as the retired College Secretary's, stays for its audit rows and
    // cannot sign in).
    const printed = [LOGINS.dean, ...LOGINS.extra].map(l => (new RegExp(`${l.label} email:\\s+(\\S+)`).exec(output) || [])[1]).filter(Boolean).map(e => e.toLowerCase()).sort();
    const users = (await api('GET', '/users')).data?.users || [];
    const emails = users.map(u => String(u.email).toLowerCase()).sort();
    const activeEmails = users.filter(u => (u.status || 'Active') === 'Active').map(u => String(u.email).toLowerCase()).sort();
    const accountWords = `${users.length} ${users.length === 1 ? 'account' : 'accounts'}: ${users.map(u => `${u.email} (${u.role}${u.status && u.status !== 'Active' ? `, ${u.status}` : ''})`).join(', ')}`;
    if (/\[demo\] Seeding /.test(output)) {
      record('(b) exactly the printed login is the account (freshly seeded)', JSON.stringify(emails) === JSON.stringify(printed), accountWords);
    } else if (mode?.resetPrompt) {
      record('(b) the defense has exactly one active account, the printed login', JSON.stringify(activeEmails) === JSON.stringify(printed), accountWords);
    } else {
      record('(b) the printed login is an account (kept database: its other accounts stay until its reset)', printed.length > 0 && printed.every(e => emails.includes(e)), accountWords);
    }
    if (/\[demo\] Seeding /.test(output) || mode?.resetPrompt) {
      const activeSecretaries = users.filter(u => u.role === 'College Secretary' && (u.status || 'Active') === 'Active');
      record('(b) no active College Secretary account (the role is retired since Phase 8 Part 8)', activeSecretaries.length === 0, activeSecretaries.map(u => u.email).join(', ') || 'none');
    }
    const audit = await api('GET', '/audit/logs');
    record(`(b) the ${LOGINS.dean.label} reads the Audit Trail`, audit.status === 200, `GET /api/audit/logs -> ${audit.status} ${audit.data?.message || ''}`);
    // Approving is the Dean's: the permission is checked before the version is looked up, so a made-up
    // version id passes the check and is then not found (404) — nothing is read or written.
    const signOff = await api('POST', '/schedule/approve-stage', {
      body: { academicYear: mode.term.academicYear, semester: mode.term.semester, scheduleId: '0'.repeat(24), stepNumber: 3 }
    });
    record(`(b) the ${LOGINS.dean.label} may approve a version (a made-up version: 404 after the permission check, not 403)`, signOff.status === 404,
      `POST /api/schedule/approve-stage (stage 3) -> ${signOff.status} ${signOff.data?.code || ''}: ${signOff.data?.message || ''}`);

    // (c)
    const health = (await procs.httpGet(`${apiBase}/health`, 10000)).body || {};
    const pyDb = health.services?.python?.database;
    record('(c) /api/health reports the demo database', health.mode === 'e2e' && health.database === mode.dbName && pyDb === mode.dbName && health.services?.python?.status === 'Online',
      `mode ${health.mode}, database ${health.database}, python ${health.services?.python?.status} on ${pyDb}`);

    // (d)
    const termQuery = `academicYear=${mode.term.academicYear}&semester=${mode.term.semester}`;
    const active = (await api('GET', '/sections')).data.filter(s => s.isActive).map(s => s.sectionCode).sort();
    if (mode.sections) record('(d) the active sections', JSON.stringify(active) === JSON.stringify([...mode.sections].sort()), active.join(', '));
    const locks = (await api('GET', `/schedule/locks?${termQuery}`)).data.locks || [];
    const pairs = await majorPairs(api, mode.term);
    const missing = pairs.filter(({ section, subject }) => !locks.some(l => l.sectionCode === section.sectionCode && String(l.subjectId) === String(subject._id)))
      .map(p => `${p.section.sectionCode} ${p.subject.subjectCode}`).sort();
    // A term mode leaves named Major classes for the Secretary (the term file's unassignedMajors; Phase 8
    // Part 7: the 4 ITEP 205 classes and BSIT 1D's 3): exactly those.
    const expectedMissing = [...(mode.unassignedMajors || [])].sort();
    record(`(d) a professor lock on every Major class of ${mode.term.semesterLabel} AY ${mode.term.academicYear}${expectedMissing.length ? ` but the ${expectedMissing.length} left for the Secretary` : ''}`,
      pairs.length > 0 && JSON.stringify(missing) === JSON.stringify(expectedMissing),
      `${locks.length} locks, ${pairs.length} Major classes${missing.length ? `, without a professor: ${missing.join(', ')}` : ''}`);
    if (mode.expect) {
      const faculty = (await api('GET', '/faculty')).data.filter(f => f.isActive).length;
      record(`(d) the term file loaded: ${mode.expect.faculty} active professors and ${mode.expect.locks} assignments`, faculty === mode.expect.faculty && locks.length === mode.expect.locks, `${faculty} professors, ${locks.length} assignments`);
    }
    // Phase 7: the defense loads the term with the ratings hidden on screen (presentation mode); a kept
    // database keeps whatever the Dean set since.
    if (mode.presentationMode) {
      const shown = (await api('GET', '/output-settings')).data?.showEvaluationRatings;
      if (/\[demo\] Seeding /.test(output)) record('(d) presentation mode: "Show evaluation ratings on screen" is off after loading the term', shown === false, `showEvaluationRatings ${shown}`);
      else console.log(`[check] INFO (d) kept data: evaluation ratings on screen ${shown === false ? 'hidden (presentation mode)' : 'shown'}`);
    }
    const versions = (await api('GET', `/schedule/versions?${termQuery}`)).data.versions || [];
    const withGa = versions.filter(v => v.gaStats).length;
    // A freshly seeded demo has no GA schedule; a kept one may have the runs made on it since (Step 4).
    if (/\[demo\] Seeding /.test(output)) {
      record('(d) no GA schedule yet (freshly seeded)', withGa === 0, `${versions.length} schedule versions, ${withGa} with GA results`);
    } else {
      console.log(`[check] INFO (d) kept data: ${versions.length} schedule versions, ${withGa} with GA results from earlier use of this demo`);
    }
  }

  // (e)
  demo.stdin.write('\u0003');
  const stopped = await Promise.race([exited.then(() => true), procs.sleep(90000).then(() => false)]);
  record('(e) Ctrl+C stops the demo', stopped, stopped ? `npm exited with code ${exitCode}` : 'still running after 90 s');
  if (!stopped) procs.killTree(demo.pid);
  if (run) {
    const busy = [];
    for (const [label, port] of Object.entries(run.ports)) if (!(await procs.isPortFree(port))) busy.push(`${label} ${port}`);
    record('(e) every port the demo used is free', busy.length === 0, busy.length ? `still in use: ${busy.join(', ')}` : Object.entries(run.ports).map(([k, v]) => `${k} ${v}`).join(', '));
    const alive = run.processes.filter(p => procs.isAlive(p.pid, p.name));
    record('(e) every process the demo started is gone', alive.length === 0,
      `${run.processes.map(p => `${p.service}: ${p.name} ${p.pid}`).join('; ')}${alive.length ? ` | STILL RUNNING: ${alive.map(p => p.pid).join(', ')}` : ''}`);
    record('(e) the MongoDB data folder is kept', fs.existsSync(MONGO_DIR) && fs.readdirSync(MONGO_DIR).some(f => f.startsWith('WiredTiger')), path.relative(REPO_ROOT, MONGO_DIR));
    record('(e) the run file is removed', !fs.existsSync(RUN_FILE));
  }
  const failed = results.filter(r => !r.pass).length;
  console.log(`[check] ${results.length - failed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
};

run().catch((err) => {
  console.error(`[check] ${err.stack || err.message}`);
  process.exit(1);
});
