// Phase 8 Part 7, Step 4: the classes the term file leaves for the College Secretary, as the practice
// copy shows them — READ ONLY (it assigns nothing). For each open class: its hours, the
// Recommendations' top 3 with the hours each professor would reach and the Overload Guardian's verdict
// (the Guardian's own rule: the professor's teaching hours now + what the class adds for them, against
// their cap); for an open On-the-Job Training coordination, which the ranking does not rank, last
// year's OJT coordinators instead (the coordination counts its policy hours, 6).
//
//   node scripts/demo/open-classes.js [--start demo:sem2] [--out <file under .demo-data>]
//
// Without --start it reads a demo that is already running (.demo-data/run.json; demo:sem2 or the
// defense, read only). With --start <npm script> it starts that script itself (stdin as a pipe, as
// check.js does), reads, then stops it with a Ctrl+C byte. Writes .demo-data/logs/part7-open-classes.json
// and prints the list: names, ranks and hours only — never a rating, never a ranking's reason text.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REPO_ROOT, RUN_FILE, LOG_DIR } = require('./paths');
const procs = require('./processes');
const { apiOf } = require('./deans-path');

const TERM_FILE = path.join(REPO_ROOT, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const LAST_YEAR_FILE = path.join(REPO_ROOT, 'server', 'tests', 'fixtures', 'term_2nd_sem_AY2025_26.json');
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.join(LOG_DIR, 'part7-open-classes.json');
const startScript = args.includes('--start') ? args[args.indexOf('--start') + 1] : null;
const log = (line) => console.log(`[open-classes] ${line}`);
const round2 = (n) => Math.round(n * 100) / 100;

const read = async () => {
  const runInfo = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (!['sem2', 'defense'].includes(runInfo.mode)) throw new Error(`The running demo is "${runInfo.mode}"; this list reads the 2nd semester term (npm run demo:sem2).`);
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, runInfo.secretsFile || '.demo-data/demo-secrets.json'), 'utf8'));
  const TERM = { academicYear: runInfo.term?.academicYear || '2026-2027', semester: Number(runInfo.term?.semester) || 2 };
  const query = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
  const { call, login } = apiOf(runInfo);
  const token = await login('Dean', secrets.deanEmail, secrets.deanPassword);
  const termFile = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));
  const lastYear = JSON.parse(fs.readFileSync(LAST_YEAR_FILE, 'utf8'));
  const catalog = (await call('GET', '/catalog', { token })).data;
  const locks = (await call('GET', `/schedule/locks?${query}`, { token })).data.locks || [];
  const policy = (await call('GET', '/policy', { token })).data || {};
  const coordinatorHours = Number(policy.load?.ojtCoordinatorHours) || 6;
  const batch = await call('POST', '/schedule/recommendations/batch', { token, body: TERM });
  if (batch.status !== 200) throw new Error(`The Recommendations answered ${batch.status}: ${batch.data?.message || ''}`);
  const loads = batch.data.facultyLoads || [];
  const subjectOf = (u) => catalog.find(c => c.subjectCode === u.subjectCode && c.descriptiveTitle === u.descriptiveTitle);
  const heldBy = (u) => locks.find(l => l.sectionCode === u.sectionCode && String(l.subjectId) === String(subjectOf(u)?._id))?.facultyName || null;
  const verdict = (reach, cap) => (Number.isFinite(cap) && reach > cap ? `refused: ${reach} of ${cap} h, over the cap` : `allowed: ${reach} of ${cap} h`);

  const classes = [];
  for (const u of termFile.unassignedMajors || []) {
    const subject = subjectOf(u);
    const prediction = (batch.data.predictions || []).find(p => String(p.subjectId) === String(subject._id));
    const top3 = (prediction?.candidates || []).filter(c => c.id && !['TBA', 'FAC-TBA'].includes(c.id)).slice(0, 3).map((c, i) => {
      const reach = round2((Number(c.currentLoad) || 0) + (Number(c.addHours) || 0));
      return { rank: i + 1, name: c.name, hoursNow: c.currentLoad, adds: c.addHours, wouldReach: reach, cap: c.maxWeeklyHours, guardian: verdict(reach, c.maxWeeklyHours) };
    });
    classes.push({
      kind: 'Major', sectionCode: u.sectionCode, subjectCode: u.subjectCode, descriptiveTitle: u.descriptiveTitle, reasonKind: u.reasonKind,
      hours: { lecture: subject.lecHours, lab: subject.labHours, partTime: round2(subject.lecHours + subject.labHours * 0.75), fullTime: subject.lecHours + subject.labHours },
      heldNow: heldBy(u), top3
    });
  }
  for (const u of termFile.unassignedCoordinations || []) {
    const names = [...new Set((lastYear.practicumCoordinators || []).map(c => c.faculty))];
    const candidates = names.map((name) => {
      const row = loads.find(l => l.name === name);
      const reach = round2((Number(row?.teaching) || 0) + coordinatorHours);
      const lastYearSections = (lastYear.practicumCoordinators || []).filter(c => c.faculty === name).map(c => (lastYear.sections || []).find(s => s.sectionCode === c.sectionCode)?.sameAsLastYear || c.sectionCode);
      return { name, lastYear: lastYearSections, hoursNow: row?.teaching ?? null, adds: coordinatorHours, wouldReach: reach, cap: row?.cap ?? null, guardian: verdict(reach, row?.cap) };
    });
    classes.push({ kind: 'coordination', sectionCode: u.sectionCode, subjectCode: u.subjectCode, descriptiveTitle: u.descriptiveTitle, reasonKind: u.reasonKind, hours: { coordination: coordinatorHours }, heldNow: heldBy(u), lastYearCoordinators: candidates });
  }

  // The Term Checklist's and the Readiness Check's numbers as the pages show them (the Readiness
  // Check saves nothing): for the defense script's "what you will see".
  const pre = await call('POST', '/schedule/preflight', { token, body: TERM });
  const report = pre.data?.report || {};
  const pages = {
    dataLine: report.dataLine || null,
    assignment: report.numbers?.assignment || null,
    readiness: { verdict: report.readiness?.verdict || null, lines: (report.readiness?.lines || []).map(l => ({ status: l.status, text: l.text, ...(l.howWeKnow ? { howWeKnow: l.howWeKnow } : {}), ...(l.items ? { items: l.items } : {}) })) }
  };
  const record = { recordedAt: new Date().toISOString(), database: runInfo.database, facultySource: runInfo.facultySource || null, term: TERM, pages, classes };
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  if (pages.assignment) log(`Term Checklist: Major classes assigned ${pages.assignment.majorAssigned} of ${pages.assignment.majorPairs}; Minor classes with a CCS professor ${pages.assignment.minorAssigned} of ${pages.assignment.minorPairs}; practicum coordinators ${pages.assignment.practicumWithCoordinator} of ${pages.assignment.practicumPairs}.`);
  log(`Readiness Check: ${pages.readiness.verdict}`);
  pages.readiness.lines.forEach(l => log(`   ${l.status === 'pass' ? '✔' : l.status === 'warn' ? '⚠' : '✖'} ${l.text}`));
  for (const c of classes) {
    const hours = c.kind === 'coordination' ? `${c.hours.coordination} h of coordination` : `${c.hours.lecture} h lecture + ${c.hours.lab} h lab (${c.hours.partTime} h for a part-timer, ${c.hours.fullTime} h for a full-timer)`;
    log(`${c.subjectCode} (${c.sectionCode}), ${hours}${c.heldNow ? ` — now held by ${c.heldNow}` : ''}:`);
    for (const t of c.top3 || []) log(`   #${t.rank} ${t.name}: ${t.hoursNow} h now + ${t.adds} h = ${t.wouldReach} h — ${t.guardian}`);
    for (const t of c.lastYearCoordinators || []) log(`   ${t.name} (last year: ${t.lastYear.join(', ')}): ${t.hoursNow} h now + ${t.adds} h = ${t.wouldReach} h — ${t.guardian}`);
  }
  log(`written to ${path.relative(REPO_ROOT, OUT)}`);
};

const main = async () => {
  if (!startScript) return read();
  const demo = spawn(`npm run ${startScript}`, { cwd: REPO_ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let exitCode = null;
  demo.stdin.on('error', () => {});
  const exited = new Promise(resolve => demo.on('exit', code => { exitCode = code; resolve(code); }));
  for (const stream of [demo.stdout, demo.stderr]) stream.on('data', chunk => { output += chunk; });
  try {
    await procs.waitUntil({ label: 'demo', check: async () => output.includes('Press Ctrl+C to stop'), timeoutMs: 10 * 60000, shouldStop: () => exitCode !== null });
    log(/\[demo\] Keeping /.test(output) ? 'the kept practice copy started' : 'the practice copy started');
    await read();
  } finally {
    demo.stdin.write('\u0003');
    const stopped = await Promise.race([exited.then(() => true), procs.sleep(90000).then(() => false)]);
    if (!stopped) procs.killTree(demo.pid);
    log(`demo stopped (${stopped ? 'cleanly' : 'killed'}).`);
  }
};

main().catch((err) => { console.error(`[open-classes] ${err.message}`); process.exit(1); });
