// The Phase 5 record: the ranking's Top 3 for each of the 4 ITEP 205 classes on the 2nd Semester AY
// 2026-2027 demo (the classes the term file leaves to the Dean), with the reasons, from the two routes the
// pages use: POST /api/schedule/recommendations (one subject) and /api/schedule/recommendations/batch (the
// Recommendations tab). Usage, from the repo root, with nothing else of the demo running:
//
//   node scripts/demo/itep205-top3.js [--script demo:sem2:reset] [--keep]
//
// It starts the demo (default: npm run demo:sem2:reset), waits until it is ready, signs in as the TEST
// Dean, records, then stops the demo (Ctrl+C) unless --keep. The record goes to
// .demo-data/itep205-top3.json (gitignored) and to the console. The console and the record show the
// reason texts as the pages show them; the progress file quotes them with the evaluation masked.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REPO_ROOT, RUN_FILE } = require('./paths');
const procs = require('./processes');
// Phase 8 Part 7: the term file's open list also holds BSIT 1D's classes; this record stays the Dean's
// ITEP 205 classes (the ones nobody on the faculty taught).
const { isDeansClass } = require('./deans-path');

const args = process.argv.slice(2);
const script = (/--script\s+(\S+)/.exec(args.join(' ')) || [])[1] || 'demo:sem2:reset';
const keep = args.includes('--keep');
const OUT = path.join(REPO_ROOT, '.demo-data', 'itep205-top3.json');
const TERM_FILE = path.join(REPO_ROOT, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');

const log = (line) => console.log(`[itep205] ${line}`);

const run = async () => {
  const started = Date.now();
  const demo = spawn(`npm run ${script}`, { cwd: REPO_ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  demo.stdin.on('error', () => {});
  let exitCode = null;
  const exited = new Promise(resolve => demo.on('exit', code => { exitCode = code; resolve(code); }));
  for (const stream of [demo.stdout, demo.stderr]) stream.on('data', (chunk) => { output += chunk; });
  await procs.waitUntil({ label: 'demo', check: async () => output.includes('Press Ctrl+C to stop'), timeoutMs: 8 * 60000, shouldStop: () => exitCode !== null });
  log(`demo ready after ${Math.round((Date.now() - started) / 1000)} s (${script})`);
  const facultyFrom = (/Faculty from:\s+(.+)/.exec(output) || [])[1] || '';
  log(`Faculty from: ${facultyFrom.trim()}`);

  const runInfo = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  const apiBase = `http://localhost:${runInfo.ports.gateway}/api`;
  const email = (/TEST Dean email:\s+(\S+)/.exec(output) || [])[1];
  const password = (/TEST Dean password:\s+(\S+)/.exec(output) || [])[1];
  const loginRes = await fetch(`${apiBase}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: email, password }) });
  const session = await loginRes.json();
  if (!session.token) throw new Error(`The TEST Dean could not sign in: ${loginRes.status} ${session.message || ''}`);
  const api = async (method, route, body) => {
    const res = await fetch(`${apiBase}${route}`, { method, headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const term = { academicYear: String(runInfo.term?.academicYear || '2026-2027'), semester: Number(runInfo.term?.semester) || 2 };
  const termFile = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));
  const classes = (termFile.unassignedMajors || []).filter(isDeansClass);
  const catalog = (await api('GET', '/catalog')).data;
  const record = { recordedAt: new Date().toISOString(), script, term, facultyFrom: facultyFrom.trim(), classes: [] };

  // One subject, the route the change-professor panel and the rehearsal use, with the term.
  const bySubject = new Map();
  for (const cls of classes) {
    const subject = catalog.find(c => c.subjectCode === cls.subjectCode && c.descriptiveTitle === cls.descriptiveTitle);
    if (!subject) throw new Error(`${cls.subjectCode} (${cls.sectionCode}): no catalog subject`);
    if (!bySubject.has(String(subject._id))) {
      const rec = await api('POST', '/schedule/recommendations', { ...term, subjectId: subject._id, subjectCode: subject.subjectCode });
      if (rec.status !== 200) throw new Error(`POST /schedule/recommendations -> ${rec.status} ${rec.data.message || ''}`);
      bySubject.set(String(subject._id), rec.data.candidates || []);
    }
    const top3 = bySubject.get(String(subject._id)).slice(0, 3).map(c => ({ rank: c.rank, name: c.name, score: c.score, reason: c.reason, features: c.features }));
    record.classes.push({ section: cls.sectionCode, subject: subject.subjectCode, title: subject.descriptiveTitle, top3 });
    log(`${subject.subjectCode} (${cls.sectionCode}):`);
    top3.forEach(c => log(`   #${c.rank} ${c.name} (${c.score}): ${c.reason}`));
  }

  // The Recommendations tab's route: the same subject's candidates must agree.
  const batch = await api('POST', '/schedule/recommendations/batch', term);
  if (batch.status !== 200) throw new Error(`POST /schedule/recommendations/batch -> ${batch.status} ${batch.data.message || ''}`);
  const itep205 = (batch.data.predictions || []).filter(p => p.subjectCode === 'ITEP 205');
  record.batch = itep205.map(p => ({ subjectCode: p.subjectCode, subjectId: p.subjectId, candidates: (p.candidates || []).map(c => ({ rank: c.rank, name: c.name, score: c.score, reason: c.reason, currentLoad: c.currentLoad, maxWeeklyHours: c.maxWeeklyHours })) }));
  const same = itep205.length === 1 && JSON.stringify(itep205[0].candidates.map(c => c.name)) === JSON.stringify(record.classes[0].top3.map(c => c.name));
  record.batchAgrees = same;
  log(`Recommendations tab (batch route): ${itep205.length} ITEP 205 ranking, Top 3 ${same ? 'the same as above' : 'DIFFERENT: ' + JSON.stringify(itep205.map(p => p.candidates.map(c => c.name)))}`);
  record.plainWords = record.classes.every(cls => cls.top3.every(c => /^(Taught this subject to \d+ sections? in \d+ earlier semesters?|Has not taught this subject before)/.test(c.reason) && !/%/.test(c.reason)));
  log(`Reason texts in the Dean's words: ${record.plainWords}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
  log(`record written to ${path.relative(REPO_ROOT, OUT)}`);

  if (keep) {
    log('--keep: the demo stays up (Ctrl+C in its own terminal stops it).');
    return;
  }
  demo.stdin.write('\u0003');
  const stopped = await Promise.race([exited.then(() => true), procs.sleep(90000).then(() => false)]);
  if (!stopped) procs.killTree(demo.pid);
  log(`demo stopped (${stopped ? `exit code ${exitCode}` : 'killed'})`);
  process.exit(0);
};

run().catch((err) => {
  console.error(`[itep205] ${err.stack || err.message}`);
  process.exit(1);
});
