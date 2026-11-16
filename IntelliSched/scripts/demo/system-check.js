// The team's one-command system check (Phase 8 Part 2, decision 5): `npm run system-check` starts the
// practice copy (`npm run demo:sem2:reset`, with the private faculty files when they exist, as that
// mode does), follows the Dean's path through the same routes as the pages (scripts/demo/deans-path.js,
// the code the rehearsal follows — one copy, never two):
//   1. ITEP 205 -> Morris Virtus Faculty, entered as an override with the reason "The Dean's
//      decision" (Phase 8 Part 8: the one account, the Dean's);
//   2. the Readiness Check;
//   3. Generate Mother Schedule (a new random seed, or --seed N);
//   4. "Check the whole schedule" (the validator on the saved version);
// then exports the complete next-semester set as DOCX and PDF (all sections, all professors, all rooms
// for the odd and the even weeks) into system-check/<date-time>/ at the repository root (gitignored),
// writes SYSTEM_CHECK_REPORT.html and .md there — every line ✔ or ✖ with its number, including an
// independent re-check of the saved schedule (system-check-core.js) — stops the practice copy cleanly
// and frees every port. It runs on the practice copy only: the defense database and the live
// intellisched_db are refused. Never a rating, on screen or in the folder.
// Usage (repo root): npm run system-check [-- --seed N] [-- --no-private] [-- --no-week-groups]
//   --seed N          the GA seed (default: a new random seed, as the Generate button picks one)
//   --no-private      seed the faculty from the tracked seed file (the demo's --faculty-seed), so the
//                     run uses no private file
//   --no-week-groups  Phase 8 Part 5 (decision 2e): the Dean's fallback — "When the rooms are short:
//                     Use TBA rooms only" (the odd/even weeks off), saved by the TEST Dean on the
//                     practice copy before the same check. The rooms export is then ONE "All weeks"
//                     file with the TBA rooms' pages, and the TBA rooms to request appear as expected
//                     information (a pass line with the count).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const procs = require('./processes');
const { apiOf, readiness, assignUnassignedMajors, assignmentsBySource, generateSeed, lastYearStats, DEFENSE_REASON } = require('./deans-path');
const core = require('./system-check-core');
const { pdfInfo } = require(path.join(REPO, 'server', 'src', 'exports', 'pdf'));
const { checkDocx } = require(path.join(REPO, 'server', 'src', 'exports', 'docxRules'));
// Phase 8 Part 5: last year's single-class days from the transcribed CSV (the same counting as the
// Generate result's line), shown beside the schedule's own counts.
const { lastYearSingleClassDays } = require(path.join(REPO, 'server', 'src', 'utils', 'lastYearSchedule'));

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const seedAsked = Number(argOf('--seed', NaN));
const SEED = Number.isInteger(seedAsked) && seedAsked >= 0 ? seedAsked : Math.floor(Math.random() * 1_000_000);
const NO_PRIVATE = args.includes('--no-private');
const NO_WEEK_GROUPS = args.includes('--no-week-groups');
const RUN_FILE = path.join(REPO, '.demo-data', 'run.json');
const TERM_FILE = path.join(REPO, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const CSV_FILE = path.join(REPO, 'docs', 'data', 'past_class_blocks.csv');
const log = (m) => console.log(`[system-check ${new Date().toISOString().slice(11, 19)}] ${m}`);
const round1 = (n) => Math.round(n * 10) / 10;
// The folder's name in the computer's LOCAL time (Phase 8 Part 3, decision 3): a check run at 03:44
// on 7 October in Manila is `2026-10-07_03-44-19`, never the UTC `2026-10-06_19-44-19`.
const stamp = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

// The complete next-semester set: the office's three files, every page, as Word and PDF. With the
// odd/even weeks on, one room file per week group; with --no-week-groups (the Dean's fallback) the
// version does not alternate, so the room schedule is ONE "All weeks" file with the TBA rooms' pages.
const EXPORT_SET = NO_WEEK_GROUPS ? [
  { view: 'class-schedule', per: 'section' },
  { view: 'teachers-program', per: 'professor' },
  { view: 'room-schedule', per: 'room' }
] : [
  { view: 'class-schedule', per: 'section' },
  { view: 'teachers-program', per: 'professor' },
  { view: 'room-schedule', per: 'room', weekGroup: 'odd' },
  { view: 'room-schedule', per: 'room', weekGroup: 'even' }
];

(async () => {
  const startedAt = new Date();
  const outDir = path.join(REPO, 'system-check', stamp());

  // ---------------------------------------------------------------- start the practice copy
  const demoScript = `npm run demo:sem2:reset${NO_PRIVATE ? ' -- --faculty-seed' : ''}`;
  log(`starting the practice copy: ${demoScript}`);
  const demo = spawn(demoScript, { cwd: REPO, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  demo.stdin.on('error', () => {});
  let output = '';
  let exitCode = null;
  const exited = new Promise(resolve => demo.on('exit', code => { exitCode = code; resolve(code); }));
  let shown = 0;
  for (const stream of [demo.stdout, demo.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk;
      const end = output.lastIndexOf('\n') + 1;
      if (end > shown) process.stdout.write(output.slice(shown, end - 1).split('\n').map(line => `  | ${line}\n`).join(''));
      shown = Math.max(shown, end);
    });
  }
  const stopDemo = async () => {
    if (exitCode !== null) return;
    log('stopping the practice copy (Ctrl+C)');
    demo.stdin.write('\u0003');
    const stopped = await Promise.race([exited.then(() => true), procs.sleep(90000).then(() => false)]);
    if (!stopped) {
      log('the demo did not stop in 90 s: ending its processes');
      procs.killTree(demo.pid);
    }
  };

  let report = null;
  try {
    await procs.waitUntil({ label: 'practice copy', check: async () => output.includes('Press Ctrl+C to stop'), timeoutMs: 8 * 60000, shouldStop: () => exitCode !== null });
    const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));

    // The practice copy only: never the defense database, never the live one (decision 5).
    const database = String(run.database || run.dbName || '');
    if (run.mode !== 'sem2') throw new Error(`The system check runs on the practice copy only (demo:sem2); this demo is "${run.mode}". Nothing was checked.`);
    if (database === 'intellisched_db' || !database.endsWith('_test')) throw new Error(`The system check refuses the database "${database}": it runs on a practice copy whose name ends in _test.`);
    if (database.includes('defense')) throw new Error('The system check never touches the defense database. It runs on the practice copy (demo:sem2).');
    log(`practice copy ready (database ${database}; faculty from ${run.facultySource})`);

    const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
    const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
    const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
    const { call, login } = apiOf(run);
    // Phase 8 Part 8: one account — the TEST Dean does the whole path, the seed included.
    const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
    const termFile = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));

    // Phase 8 Part 5 (decision 2e): the Dean's fallback on the practice copy — the plain policy
    // choice "Use TBA rooms only" (the odd/even weeks off); the headroom rule then gives the run a
    // TBA room of a nearly-full type, and the check carries on the same way.
    if (NO_WEEK_GROUPS) {
      const put = await call('PUT', '/policy', { token: dean, body: { weekGroups: { enabled: false } } });
      if (put.status !== 200) throw new Error(`The fallback (weekGroups off) was refused: ${put.status} ${JSON.stringify(put.data).slice(0, 200)}`);
      log('the TEST Dean chose "Use TBA rooms only" (odd and even weeks off, --no-week-groups)');
    }

    // ---------------------------------------------------------------- the Dean's path
    // 1. ITEP 205 to the Dean's planned choice, entered as an override with the reason "The Dean's
    //    decision" (Phase 8 Part 8: the Dean's one account does the work and approves);
    //    Phase 8 Part 7 (decision 4): the term file's other open classes on the practice copy only —
    //    BSIT 1D's to the top-ranked professor the Overload Guardian allows, the 4th-year WMAD B
    //    coordination to Faculty, with "Practice copy only: the Secretary assigns this class by hand".
    const assigned = await assignUnassignedMajors({ call, dean, TERM, term: termFile, log, reason: DEFENSE_REASON });

    // 2. The Readiness Check: generation runs only when it says ready.
    const ready = await readiness(call, dean, TERM);
    ready.lines.forEach(l => log(`  ${l.status === 'pass' ? '✔' : l.status === 'warn' ? '⚠' : '✖'} ${l.text}`));
    if (ready.verdict !== 'ready') throw new Error(`The Readiness Check says "${ready.verdict}", so nothing can be generated. Fix the lines above first.`);

    // 3. Generate Mother Schedule (the seed as on "Advanced").
    log(`generating with seed ${SEED}`);
    const runRow = await generateSeed({ call, dean, TERM, seed: SEED, log });
    if (runRow.status !== 'done' || !runRow.scheduleId) throw new Error(`The run ended "${runRow.status}": ${runRow.message}`);
    log(`saved as ${runRow.version}: ${runRow.checkedConflicts} conflicts, ${runRow.classes.total} classes`);

    // 4. The saved version, re-read for the checks (generateSeed already ran "Check the whole schedule").
    const outputs = (await call('GET', `/schedule/outputs?${termQuery}&scheduleId=${runRow.scheduleId}`, { token: dean })).data;
    const catalog = (await call('GET', '/catalog', { token: dean })).data;
    const locks = (await call('GET', `/schedule/locks?${termQuery}`, { token: dean })).data.locks || [];
    const partTime = (await call('GET', `/schedule/part-time-loads?${termQuery}`, { token: dean })).data;
    // Phase 8 Part 4: the faculty records, for the Extension-day re-check (employment type and the
    // per-professor override; the day itself is resolved inside the independent pass).
    const facultyRecords = ((await call('GET', '/faculty', { token: dean })).data || [])
      .filter(f => f.isActive !== false)
      .map(f => ({ id: String(f._id), name: f.name, employmentType: f.employmentType || null, extensionDay: f.extensionDay || null }));

    // ---------------------------------------------------------------- the exports
    fs.mkdirSync(outDir, { recursive: true });
    const printableProfessors = (outputs.faculty || []).filter(f => f.classCount > 0 || (f.selfPaced || []).length > 0 || (f.practicum?.blocks || []).length > 0);
    const roomsInGroup = (group) => {
      const inGroup = (c) => !c.weekGroup || c.weekGroup === group;
      const tbaWithClasses = new Set((outputs.classes || []).filter(c => c.extraRoomKey && inGroup(c)).map(c => c.roomKey));
      return (outputs.rooms || []).filter(r => (r.kind === 'TBA' ? tbaWithClasses.has(r.key) : true)).length;
    };
    const expectedPages = {
      'class-schedule': (outputs.sections || []).filter(s => s.classCount > 0).length,
      'teachers-program': printableProfessors.length,
      'room-schedule:odd': roomsInGroup('ODD'),
      'room-schedule:even': roomsInGroup('EVEN'),
      // The fallback's one "All weeks" file (no weekGroup on the target): every room with a class,
      // the TBA rooms' pages included (no class carries a week group, so any group argument counts
      // the same rooms).
      'room-schedule': roomsInGroup('ODD')
    };
    const files = [];
    for (const target of EXPORT_SET) {
      for (const format of ['docx', 'pdf']) {
        const q = new URLSearchParams({ ...TERM, view: target.view, format, scheduleId: runRow.scheduleId, ...(target.weekGroup ? { weekGroup: target.weekGroup } : {}) });
        const res = await fetch(`http://localhost:${run.ports.gateway}/api/schedule/exports?${q}`, { headers: { authorization: `Bearer ${dean}` } });
        const expected = expectedPages[target.weekGroup ? `${target.view}:${target.weekGroup}` : target.view];
        if (res.status !== 200) {
          const body = await res.json().catch(() => ({}));
          files.push({ name: `${target.view}${target.weekGroup ? ` (${target.weekGroup} weeks)` : ''}.${format}`, error: body.message || `the gateway answered ${res.status}`, expectedPages: expected, per: target.per });
          continue;
        }
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `${target.view}.${format}`;
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(path.join(outDir, name), buffer);
        // The PDF's pages are counted in the file itself; the DOCX carries the gateway's own count,
        // which the unit tests verified against Word.
        const info = format === 'pdf' ? pdfInfo(buffer) : null;
        const pages = info ? info.pages : Number(res.headers.get('x-export-pages'));
        // Phase 8 Part 9: the form of each file — a PDF's orientation and fonts, a DOCX's Word rules.
        files.push({
          name, pages, expectedPages: expected, per: target.per, bytes: buffer.length,
          expectedLandscape: target.view !== 'teachers-program',
          ...(info ? { landscape: info.mediaBox.w > info.mediaBox.h, fonts: info.fonts } : { wordProblems: checkDocx(buffer) })
        });
        log(`wrote ${name} (${pages} pages, ${Math.round(buffer.length / 1024)} KB)`);
      }
    }

    // ---------------------------------------------------------------- the report
    // The coordinations IN FORCE (Phase 8 Part 7: the term file's 4 and the one the practice copy
    // filled): the practicum locks of the term; its partTimeBalance.thisSemester is a plain
    // name -> hours table (the office's own schedule, docs/formats §4).
    const practicumIds = new Set(catalog.filter(c => c.isPracticum).map(c => String(c._id)));
    const coordinators = locks.filter(l => practicumIds.has(String(l.subjectId))).map(l => ({ name: l.facultyName }));
    const officeLoads = termFile.partTimeBalance?.thisSemester
      ? Object.entries(termFile.partTimeBalance.thisSemester).map(([name, hours]) => ({ name, hours: Number(hours) }))
      : null;
    const comparison = core.lastYearComparison({ termFile, locks });
    report = core.buildReport([
      {
        title: 'The run',
        lines: [
          { status: 'pass', text: `Saved as ${runRow.version} with seed ${SEED}${NO_PRIVATE ? ' (tracked seed faculty, --no-private)' : ''}.` },
          { status: runRow.timeToFirstFeasibleMs === null ? 'fail' : 'pass', text: runRow.timeToFirstFeasibleMs === null ? 'No conflict-free schedule was reached.' : `First conflict-free schedule after ${round1(runRow.timeToFirstFeasibleMs / 1000)} s.` },
          { status: 'pass', text: `Total run time ${round1((runRow.runtimeMs || 0) / 1000)} s (${runRow.generations ?? '-'} generations); ${round1(runRow.wallMs / 1000)} s from the button to the saved Draft.` },
          ...assigned.map(a => ({ status: a.chosen ? 'pass' : 'fail', text: `${a.subject} (${a.section}) assigned to ${a.chosen}${a.alreadyAssigned ? ' (already assigned before this check)'
            : a.coordination ? ' (the On-the-Job Training coordination, the practice copy only: the Secretary assigns it by hand)'
              : a.practiceOnly ? ` (the practice copy only: the top-ranked professor the Overload Guardian allows${a.rank ? `, rank ${a.rank}` : ''}; the Secretary assigns it by hand)`
                : a.rank === 1 ? ' (the ranking’s first choice)' : ' (the Dean’s decision, entered as an override)'}.` }))
        ]
      },
      {
        title: 'The validator',
        lines: [
          {
            status: runRow.checkedConflicts === 0 ? 'pass' : 'fail',
            text: runRow.checkedConflicts === 0
              ? '0 hard conflicts: the gateway’s validator re-checked the whole saved schedule and found nothing, under every rule.'
              : `${runRow.checkedConflicts} hard conflicts by rule: ${Object.entries(runRow.conflictsByRule || {}).map(([code, n]) => `${code} ${n}`).join(', ')}.`
          }
        ]
      },
      { title: 'The schedule, re-checked independently', lines: core.independentScheduleChecks({ classes: outputs.classes, policy: outputs.policy, catalog, professors: facultyRecords, lastYearSingleDays: lastYearSingleClassDays({ academicYear: TERM.academicYear, semester: TERM.semester }) }) },
      {
        title: 'Faculty',
        lines: core.facultyChecks({
          classes: outputs.classes,
          faculty: outputs.faculty,
          policy: outputs.policy,
          coordinators,
          assignmentsBySource: assignmentsBySource(termFile),
          partTimeLoads: { ...partTime, officeSemesterLabel: 'schedule this semester' },
          officeLoads
        })
      },
      { title: 'Last year as the reference', lines: comparison.lines },
      { title: 'Rooms', lines: core.roomChecks({ tbaRequest: outputs.tbaRequest, atOncePerGroup: runRow.atOncePerGroup, rooms: outputs.rooms, classes: outputs.classes, weekGroupsOn: Boolean(outputs.policy?.weekGroups?.enabled) }) },
      { title: 'The files', lines: core.fileChecks(files) }
    ]);

    const title = `System check — ${TERM.semester === 2 ? '2nd' : '1st'} Semester AY ${TERM.academicYear}`;
    const facts = [
      `Run on ${startedAt.toISOString().replace('T', ' ').slice(0, 19)} (${database}; faculty from ${run.facultySource}).`,
      ...(NO_WEEK_GROUPS ? ['The Dean’s fallback (--no-week-groups): "Use TBA rooms only" was chosen on the practice copy, so the schedule runs without the odd and even weeks and the rooms export is one "All weeks" file.'] : []),
      `Version ${runRow.version}, seed ${SEED}; the files are in this folder, next to this report.`,
      'Made by npm run system-check: the Dean’s path through the same routes as the pages, then every number re-checked.'
    ];
    fs.writeFileSync(path.join(outDir, 'SYSTEM_CHECK_REPORT.md'), core.renderMd(report, { title, facts }));
    fs.writeFileSync(path.join(outDir, 'SYSTEM_CHECK_REPORT.html'), core.renderHtml(report, { title, facts }));
    log(`report written (${report.verdict === 'pass' ? 'every check passed' : `${report.failures} checks FAILED`})`);
  } finally {
    await stopDemo();
    // Every port the practice copy used must be free again.
    try {
      const run = fs.existsSync(RUN_FILE) ? JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) : null;
      if (run?.ports) {
        const busy = [];
        for (const [label, port] of Object.entries(run.ports)) if (!(await procs.isPortFree(port))) busy.push(`${label} ${port}`);
        if (busy.length) log(`ports still in use: ${busy.join(', ')}`);
      }
    } catch { /* the run file is removed on a clean stop */ }
  }

  if (!report) throw new Error('The check did not finish.');
  console.log('');
  log(`${report.verdict === 'pass' ? '✔ every check passed' : `✖ ${report.failures} check${report.failures === 1 ? '' : 's'} failed`}`);
  log(`open the folder: ${path.relative(REPO, outDir)}`);
  log(`the report: ${path.relative(REPO, path.join(outDir, 'SYSTEM_CHECK_REPORT.html'))} (and .md)`);
  process.exit(report.verdict === 'pass' ? 0 : 1);
})().catch(async (err) => {
  console.error(`[system-check] ${err.stack || err.message}`);
  process.exit(1);
});
