// Phase 8 Part 6, Step 3 evidence: the Balance all plan on the real term. Starts
// `npm run demo:sem2:reset` itself (stdin as a pipe, as check.js does), waits until it is ready,
// signs in as the TEST Dean (Phase 8 Part 8: one account), reads GET /api/schedule/part-time-loads (the plan and
// every professor's load before and after), writes `.demo-data/logs/part6-balance-all.json`
// (counts, names and hours only — never a rating), prints the plan, then stops the demo with a
// Ctrl+C byte and waits for it to exit. READ ONLY: it applies nothing.
// Usage (repo root): node scripts/demo/balance-all-run.js
//
// --defense-path [--seeds 1,2,3] (Phase 8 Part 6, Step 8: the defense script's order, checked end to
// end on the demo): as the TEST Dean, first the ITEP 205 classes to Mr. Faculty with
// the reason "The Dean's decision" and (Phase 8 Part 7) the term file's other open classes the
// practice copy's way (the shared deans-path module), then the plan, then EVERY move
// applied the way the panel's Apply does (POST /schedule/lock as an override with the move's
// reason; the Overload Guardian re-checks each), the loads and the Readiness Check again, and one
// Generate run per seed (the saved version re-checked). Writes
// `.demo-data/logs/part6-balance-all-defense-path.json`; it changes only the demo's database.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REPO_ROOT, RUN_FILE, LOG_DIR } = require('./paths');
const procs = require('./processes');
const { apiOf, readiness, assignUnassignedMajors, generateSeed, DEFENSE_REASON } = require('./deans-path');

const args = process.argv.slice(2);
const DEFENSE_PATH = args.includes('--defense-path');
const seedsArg = args.indexOf('--seeds') >= 0 ? args[args.indexOf('--seeds') + 1] : '1,2,3';
const SEEDS = String(seedsArg).split(',').map(s => Number(s.trim())).filter(Number.isInteger);
const OUT = path.join(LOG_DIR, DEFENSE_PATH ? 'part6-balance-all-defense-path.json' : 'part6-balance-all.json');
const TERM_FILE = path.join(REPO_ROOT, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');

// The saved reason of one applied move, as the panel words it (PartTimeLoadsPanel.jsx reasonOfMove).
const reasonOfMove = (m) => (m.phase === 'new-subject'
  ? `A new subject for the Secretary's minimum load: ${m.subjectCode} (${m.sectionCode}) moved from ${m.from.name} to ${m.to.name}.`
  : `Teaching loads balance (${m.why || "the Dean's equal part-time loads"}): moved from ${m.from.name}. The Dean can undo it by assigning the class back.`);

const loadsOf = (data) => (data.professors || []).map(p => ({ name: p.name, employmentType: p.employmentType, hours: p.hours, min: p.min, cap: p.cap, underMin: p.underMin }));
const planOf = (data) => (data.suggestion ? {
  moves: data.suggestion.moves.map(m => ({
    subjectCode: m.subjectCode, sectionCode: m.sectionCode, phase: m.phase, taughtBefore: m.taughtBefore,
    from: m.from.name, fromBefore: m.fromBefore, fromAfter: m.fromAfter,
    to: m.to.name, toBefore: m.toBefore, toAfter: m.toAfter, why: m.why
  })),
  loadsBefore: data.suggestion.loadsBefore,
  loadsAfter: data.suggestion.loadsAfter,
  spreadAfter: data.suggestion.spreadAfter
} : null);
const cannotReachOf = (data) => (data.cannotReach || []).map(c => ({ name: c.name, hours: c.hours, min: c.min, underMin: c.underMin, reason: c.reason, offers: (c.offers || []).length }));
const printPlan = (plan, cannotReach) => {
  for (const m of plan?.moves || []) {
    console.log(`[balance-all]   ${m.phase}${m.taughtBefore === false ? ' (not taught before)' : ''}: ${m.subjectCode} (${m.sectionCode}) ${m.from} ${m.fromBefore}->${m.fromAfter} h => ${m.to} ${m.toBefore}->${m.toAfter} h`);
  }
  for (const c of cannotReach) console.log(`[balance-all]   cannot reach: ${c.name} ${c.hours} of ${c.min} h (${c.underMin} under): ${c.reason} (${c.offers} offers)`);
};

const defensePath = async ({ runInfo, secrets, term }) => {
  const { call, login } = apiOf(runInfo);
  const secretary = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword); // Part 8: one account
  const termFile = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));
  const query = `academicYear=${term.academicYear}&semester=${term.semester}`;
  const log = (line) => console.log(`[balance-all] ${line}`);
  const record = { recordedAt: new Date().toISOString(), database: runInfo.database, term, path: 'defense' };

  record.assignments = (await assignUnassignedMajors({ call, dean: secretary, TERM: term, term: termFile, log, reason: DEFENSE_REASON }))
    .map(a => ({ section: a.section, subject: a.subject, chosen: a.chosen, decision: a.decision || null, practiceOnly: Boolean(a.practiceOnly) }));
  const before = await call('GET', `/schedule/part-time-loads?${query}`, { token: secretary });
  if (before.status !== 200) throw new Error(`part-time-loads answered ${before.status}`);
  record.professorsBefore = loadsOf(before.data);
  record.plan = planOf(before.data);
  record.cannotReachBefore = cannotReachOf(before.data);
  log(`plan after the open classes' assignments: ${record.plan ? record.plan.moves.length : 0} move(s)`);
  printPlan(record.plan, record.cannotReachBefore);

  // Apply every move as the panel's Apply does (all ticked), one at a time.
  record.applied = [];
  for (const m of before.data.suggestion?.moves || []) {
    const res = await call('POST', '/schedule/lock', {
      token: secretary,
      body: {
        ...term, subjectId: m.subjectId, subjectCode: m.subjectCode, sectionCode: m.sectionCode,
        facultyId: m.to.facultyId, facultyName: m.to.name, classType: 'ALL', decision: 'override',
        originalFacultyId: m.from.facultyId, reason: reasonOfMove(m)
      }
    });
    record.applied.push({ subjectCode: m.subjectCode, sectionCode: m.sectionCode, to: m.to.name, status: res.status, message: res.status === 200 ? '' : (res.data?.message || '') });
    log(`applied ${m.subjectCode} (${m.sectionCode}) -> ${m.to.name}: ${res.status}${res.status === 200 ? '' : ` ${res.data?.message || ''}`}`);
  }
  const after = await call('GET', `/schedule/part-time-loads?${query}`, { token: secretary });
  record.professorsAfter = loadsOf(after.data);
  record.planAfter = planOf(after.data);
  record.cannotReachAfter = cannotReachOf(after.data);
  log(`after Apply: ${record.planAfter ? record.planAfter.moves.length : 0} move(s) left; out of range: ${record.professorsAfter.filter(p => p.underMin > 0 || p.hours > p.cap).map(p => `${p.name} ${p.hours} of ${p.min}-${p.cap} h`).join('; ') || 'nobody'}`);
  const ready = await readiness(call, secretary, term);
  record.readiness = { verdict: ready.verdict, toFix: ready.toFix, lines: ready.lines.filter(l => l.status !== 'pass').map(l => ({ status: l.status, text: l.text })) };
  log(`Readiness: ${ready.verdict}; ${record.readiness.lines.map(l => `${l.status}: ${l.text}`).join(' | ') || 'every line passes'}`);

  record.runs = [];
  for (const seed of SEEDS) {
    const row = await generateSeed({ call, dean: secretary, TERM: term, seed, log: () => {} });
    const s = row.singleClassDays || {};
    record.runs.push({
      seed, status: row.status, version: row.version, conflicts: row.conflicts, checkedConflicts: row.checkedConflicts ?? null,
      pageWaitS: Math.round(row.wallMs / 100) / 10, firstConflictFreeS: row.timeToFirstFeasibleMs === null ? null : Math.round(row.timeToFirstFeasibleMs / 100) / 10,
      generations: row.generations, partTimers: s.partTimers ?? null, fullTimers: s.fullTimers ?? null, sections: s.sections ?? null,
      tbaRooms: row.tbaRequest || null, saturdayBlocks: row.saturdayBlocks ?? null, startsBefore8: row.startsBefore8 ?? null
    });
    const r = record.runs[record.runs.length - 1];
    log(`seed ${seed}: ${r.status}, ${r.conflicts} conflicts (validator ${r.checkedConflicts}), page wait ${r.pageWaitS} s, ${r.generations} generations, single-class days: part-timers ${r.partTimers}, full-timers ${r.fullTimers}, sections ${r.sections}`);
  }
  return record;
};

const run = async () => {
  const demo = spawn('npm run demo:sem2:reset', { cwd: REPO_ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  demo.stdin.on('error', () => {});
  let exitCode = null;
  const exited = new Promise(resolve => demo.on('exit', code => { exitCode = code; resolve(code); }));
  for (const stream of [demo.stdout, demo.stderr]) stream.on('data', chunk => { output += chunk; });

  try {
    await procs.waitUntil({ label: 'demo', check: async () => output.includes('Press Ctrl+C to stop'), timeoutMs: 10 * 60000, shouldStop: () => exitCode !== null });
    const runInfo = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
    const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, runInfo.secretsFile || '.demo-data/demo-secrets.json'), 'utf8'));
    const term = runInfo.term ? { academicYear: runInfo.term.academicYear, semester: Number(runInfo.term.semester) } : { academicYear: '2026-2027', semester: 2 };
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (DEFENSE_PATH) {
      const record = await defensePath({ runInfo, secrets, term });
      fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`[balance-all] written to ${path.relative(REPO_ROOT, OUT)}`);
      return;
    }
    const apiBase = `http://localhost:${runInfo.ports.gateway}/api`;
    const login = await fetch(`${apiBase}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: secrets.deanEmail, password: secrets.deanPassword })
    });
    const session = await login.json();
    if (!login.ok || !session.token) throw new Error(`The TEST Dean could not sign in (${login.status}).`);
    const res = await fetch(`${apiBase}/schedule/part-time-loads?academicYear=${term.academicYear}&semester=${term.semester}`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`part-time-loads answered ${res.status}: ${data.message || ''}`);

    const record = {
      recordedAt: new Date().toISOString(),
      database: runInfo.database,
      term,
      professors: loadsOf(data),
      average: data.average,
      spread: data.spread,
      plan: planOf(data),
      cannotReach: cannotReachOf(data)
    };
    fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`[balance-all] plan: ${record.plan ? record.plan.moves.length : 0} move(s); cannotReach: ${record.cannotReach.length}; written to ${path.relative(REPO_ROOT, OUT)}`);
    printPlan(record.plan, record.cannotReach);
  } finally {
    demo.stdin.write('\u0003');
    const stopped = await Promise.race([exited.then(() => true), procs.sleep(90000).then(() => false)]);
    if (!stopped) procs.killTree(demo.pid);
    console.log(`[balance-all] demo stopped (${stopped ? 'cleanly' : 'killed'}).`);
  }
};

run().catch((err) => { console.error(`[balance-all] ${err.message}`); process.exit(1); });
