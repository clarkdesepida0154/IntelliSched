// Phase 8 Part 11 (decision 6): Engine 4 end to end on the practice copy. It starts
// `npm run demo:sem2:reset` (the 2nd Semester AY 2026-2027 practice copy; the defense database is never
// touched), signs in as the TEST Dean and:
//   1. re-enters by hand, on Assign Faculty's own route (POST /schedule/lock), every Major class the term
//      loader assigned — the same professor, as the Dean did on 9 Oct — so each becomes a hand assignment
//      by a person (the loader's own locks are the System's and never count);
//   2. reads Model Feedback's counts (GET /schedule/decisions);
//   3. ranks ITEC 103 (Intermediate Programming) on the Recommendations route;
//   4. retrains (POST /schedule/retrain) and records the answer;
//   5. checks the demo's own model copy (.demo-data/models/<db>/): replaced or not, the .bak, the
//      .meta.json's engine4 block, the Python service's reload line, and ranks ITEC 103 again.
// Usage, from the repo root, with no demo running:
//   node scripts/demo/engine4-run.js [--script demo:sem2:reset] [--keep] [--limit N]
// The record goes to .demo-data/logs/part11-engine4-run.json (names, scores and counts; the reason texts
// are left out because they carry the evaluation). The model file committed in ../intellisched_backend
// never changes: the demo's Python service runs on its own copy (ML_MODEL_PATH, scripts/demo/demo.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { REPO_ROOT, RUN_FILE, LOG_DIR } = require('./paths');
const procs = require('./processes');

const args = process.argv.slice(2);
const script = (/--script\s+(\S+)/.exec(args.join(' ')) || [])[1] || 'demo:sem2:reset';
const keep = args.includes('--keep');
const limit = Number((/--limit\s+(\d+)/.exec(args.join(' ')) || [])[1]) || Infinity;
const OUT = path.join(LOG_DIR, 'part11-engine4-run.json');
const BACKEND_MODEL = path.join(REPO_ROOT, '..', 'intellisched_backend', 'intellisched_gbdt_engine.joblib');
const REASON = 'Entered by hand on Assign Faculty (Phase 8 Part 11 end-to-end test)';
const FOCUS = 'ITEC 103';

const log = (line) => console.log(`[engine4-run] ${line}`);
const hashOf = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16) : null);

const run = async () => {
  const started = Date.now();
  const backendBefore = hashOf(BACKEND_MODEL);
  const demo = spawn(`npm run ${script}`, { cwd: REPO_ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  demo.stdin.on('error', () => {});
  let exitCode = null;
  const exited = new Promise(resolve => demo.on('exit', code => { exitCode = code; resolve(code); }));
  for (const stream of [demo.stdout, demo.stderr]) stream.on('data', (chunk) => { output += chunk; });
  const stopDemo = async () => {
    if (exitCode !== null) return;
    demo.stdin.write('\u0003');
    const stopped = await Promise.race([exited.then(() => true), procs.sleep(90000).then(() => false)]);
    if (!stopped) procs.killTree(demo.pid);
    log(`demo stopped (${stopped ? `exit code ${exitCode}` : 'killed'})`);
  };
  try {
    await procs.waitUntil({ label: 'demo', check: async () => output.includes('Press Ctrl+C to stop'), timeoutMs: 8 * 60000, shouldStop: () => exitCode !== null });
    log(`demo ready after ${Math.round((Date.now() - started) / 1000)} s (${script})`);
    const runInfo = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
    const dbName = runInfo.dbName || runInfo.database || 'intellisched_demo_sem2_test';
    const modelCopy = path.join(REPO_ROOT, '.demo-data', 'models', dbName, 'intellisched_gbdt_engine.joblib');
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
    const TERM = { academicYear: String(runInfo.term?.academicYear || '2026-2027'), semester: Number(runInfo.term?.semester) || 2 };
    const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
    const record = { recordedAt: new Date().toISOString(), script, dbName, term: TERM, modelCopy: path.relative(REPO_ROOT, modelCopy) };

    // The ranking of ITEC 103 (names and scores only; the reasons carry the evaluation).
    const focusRanking = async () => {
      const res = await api('POST', '/schedule/recommendations/batch', TERM);
      const preds = (res.data?.predictions || []).filter(p => p.subjectCode === FOCUS);
      return preds.map(p => (p.candidates || []).map(c => ({ rank: c.rank, name: c.name, score: c.score })));
    };

    const decisionsBefore = (await api('GET', `/schedule/decisions?${termQuery}`)).data;
    record.decisionsBefore = { allTerms: decisionsBefore.allTerms, counts: decisionsBefore.counts };
    log(`Model Feedback before: ${decisionsBefore.allTerms} decisions in every term; ${JSON.stringify(decisionsBefore.counts)}`);

    // 1. The term's Major classes, re-entered by hand with the same professor.
    const catalog = (await api('GET', '/catalog')).data;
    const catalogRows = Array.isArray(catalog) ? catalog : catalog?.subjects || catalog?.data || [];
    const byId = new Map(catalogRows.map(s => [String(s._id), s]));
    const locks = (await api('GET', `/schedule/locks?${termQuery}`)).data?.locks || [];
    const majors = locks.filter(l => ['matrix', 'ranking', undefined, null].includes(l.source) && l.facultyRef && l.facultyId !== 'FAC-TBA').slice(0, limit);
    let saved = 0;
    const refused = [];
    for (const l of majors) {
      const subject = byId.get(String(l.subjectId)) || {};
      const res = await api('POST', '/schedule/lock', {
        ...TERM, subjectId: l.subjectId, subjectCode: l.subjectCode, sectionCode: l.sectionCode, sectionId: l.sectionId,
        facultyId: l.facultyId, facultyName: l.facultyName, classType: l.classType || 'ALL', units: subject.units || l.units || 3, reason: REASON
      });
      if (res.status === 200) saved += 1; else refused.push({ class: `${l.subjectCode} (${l.sectionCode})`, status: res.status, code: res.data?.code || null, message: res.data?.message || '' });
    }
    record.handAssignments = { majorLocks: majors.length, saved, refused };
    log(`re-entered by hand: ${saved} of ${majors.length} Major classes${refused.length ? `; refused: ${refused.map(r => `${r.class} ${r.code || r.status}`).join(', ')}` : ''}`);

    // 2. Model Feedback after.
    const decisionsAfter = (await api('GET', `/schedule/decisions?${termQuery}`)).data;
    record.decisionsAfter = { allTerms: decisionsAfter.allTerms, counts: decisionsAfter.counts };
    log(`Model Feedback after: ${decisionsAfter.allTerms} decisions in every term; ${JSON.stringify(decisionsAfter.counts)}`);

    // 3-4. Rank, retrain.
    record.rankingBefore = await focusRanking();
    const hashBefore = hashOf(modelCopy);
    const t0 = Date.now();
    const retrain = await api('POST', '/schedule/retrain', {});
    record.retrain = { httpStatus: retrain.status, seconds: Math.round((Date.now() - t0) / 100) / 10, ...retrain.data };
    log(`retrain: HTTP ${retrain.status}, ${retrain.data?.status}: ${retrain.data?.message || ''} (${record.retrain.seconds} s)`);
    if (retrain.data?.before) log(`  before ${JSON.stringify(retrain.data.before)}  after ${JSON.stringify(retrain.data.after)}`);

    // 5. The file, the reload, the next ranking.
    const hashAfter = hashOf(modelCopy);
    const metaPath = modelCopy.replace(/\.joblib$/, '.meta.json');
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    const pythonLog = fs.existsSync(path.join(LOG_DIR, 'python.log')) ? fs.readFileSync(path.join(LOG_DIR, 'python.log'), 'utf8') : '';
    record.modelFile = {
      replaced: Boolean(hashBefore && hashAfter && hashBefore !== hashAfter),
      backupKept: fs.existsSync(modelCopy.replace(/\.joblib$/, '.joblib.bak')),
      metaEngine4: meta.engine4 || null,
      reloadLine: /Hot-reloading model weights/.test(pythonLog) && /Engine 2 \(GBDT\) initialized/.test(pythonLog.split('Hot-reloading model weights').pop() || ''),
      committedModelUnchanged: hashOf(BACKEND_MODEL) === backendBefore
    };
    record.rankingAfter = await focusRanking();
    record.rankingChanged = JSON.stringify(record.rankingBefore) !== JSON.stringify(record.rankingAfter);
    log(`model copy replaced: ${record.modelFile.replaced}; .bak kept: ${record.modelFile.backupKept}; reload line: ${record.modelFile.reloadLine}; committed model unchanged: ${record.modelFile.committedModelUnchanged}`);
    log(`${FOCUS} top 3 before: ${(record.rankingBefore[0] || []).map(c => `${c.name} ${c.score}`).join(', ')}`);
    log(`${FOCUS} top 3 after:  ${(record.rankingAfter[0] || []).map(c => `${c.name} ${c.score}`).join(', ')}`);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
    log(`record written to ${path.relative(REPO_ROOT, OUT)}`);
    if (keep) { log('--keep: the demo stays up (Ctrl+C in its own terminal stops it).'); return; }
  } finally {
    if (!keep) await stopDemo();
  }
  process.exit(0);
};

run().catch((err) => {
  console.error(`[engine4-run] ${err.stack || err.message}`);
  process.exit(1);
});
