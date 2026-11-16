// Phase 12 (decision 8): the kit's data\practice.isbak, built from the practice copy.
//   node deploy/build-practice-data.js [--seed 1]
// 1. starts the practice copy (npm run demo:sem2:reset -- --faculty-seed: tracked data only);
// 2. as its TEST Dean: the open classes (none in the default term file), the Readiness Check, one
//    generation, then Send for review and Approve through the normal approval route;
// 3. copies that database into a THROWAWAY database (intellisched_practicekit_test), and there:
//    - removes every evaluation rating, set exactly as for a professor with no evaluation (average 0,
//      no history; decision rows' rating fields null; "Student evaluation: X of 5" -> "No CCS
//      evaluation yet"), so the ranking uses its missing-rating path;
//    - keeps two accounts: the practice Dean (the TEST Dean who approved, renamed) and a new practice
//      College Secretary, each with a NEW password;
// 4. writes the backup through the Phase 11.3 backup service, encrypted with "intellisched", to
//    .deploy-out/cache/practice/practice.isbak, re-opens it and scans every collection for a rating;
// 5. writes PRACTICE-SIGN-IN.txt beside it (the only place the practice passwords are written), drops
//    the throwaway database and stops the practice copy.
// Never the defense database, Atlas or intellisched_db. Prints counts only, never a rating.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const BACKEND = path.resolve(REPO, '..', 'intellisched_backend');
const OUT = path.join(REPO, '.deploy-out', 'cache', 'practice');
const RUN_FILE = path.join(REPO, '.demo-data', 'run.json');
const PRACTICE_DB = 'intellisched_practicekit_test';
const procs = require(path.join(REPO, 'scripts', 'demo', 'processes.js'));
const { apiOf, readiness, assignUnassignedMajors, generateSeed, DEFENSE_REASON } = require(path.join(REPO, 'scripts', 'demo', 'deans-path.js'));
const serverRequire = createRequire(path.join(SERVER, 'package.json'));

const argv = process.argv.slice(2);
const SEED = Number(argv[argv.indexOf('--seed') + 1]) || 1;
const log = (line) => console.log(`[practice-data] ${line}`);

const newPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < 14) { const b = crypto.randomBytes(1)[0]; if (b < 232) out += chars[b % chars.length]; }
  return `${out.slice(0, 7)}-${out.slice(7)}`;
};

// ------------------------------------------------------------------ the rating scrub
const EVAL_TEXT = /Student evaluation: (?:\d+(?:\.\d+)?|on record) of 5|Student evaluation: on record/g;
const isEvalKey = (k) => /^(selectedEvalScore|rejectedEvalScore|eval_rating|evalAverage|evalRating|rating)$/i.test(k);
// Returns the number of values changed; walks every field of a document.
const scrub = (node) => {
  let n = 0;
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i += 1) { if (typeof node[i] === 'string') { const s = node[i].replace(EVAL_TEXT, 'No CCS evaluation yet'); if (s !== node[i]) { node[i] = s; n += 1; } } else n += scrub(node[i]); } return n; }
  if (!node || typeof node !== 'object' || node._bsontype) return 0;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === 'evalScore' && v && typeof v === 'object') {
      if (v.average !== 0 || (v.history || []).length) n += 1;
      node[k] = { ...v, average: 0, history: [] };
    } else if (isEvalKey(k) && v !== null && v !== undefined && typeof v !== 'object') {
      node[k] = null; n += 1;
    } else if (typeof v === 'string') {
      const s = v.replace(EVAL_TEXT, 'No CCS evaluation yet');
      if (s !== v) { node[k] = s; n += 1; }
    } else n += scrub(v);
  }
  return n;
};
// The verification: any rating left (a non-zero evalScore, a history entry, a rating field with a
// value, a "Student evaluation: N of 5" text). Returns the places found.
const findRatings = (node, where, out) => {
  if (Array.isArray(node)) { node.forEach((x, i) => findRatings(x, `${where}[${i}]`, out)); return out; }
  if (typeof node === 'string') { if (/Student evaluation: \d/.test(node)) out.push(`${where}: text`); return out; }
  if (!node || typeof node !== 'object' || node._bsontype) return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'evalScore' && v && typeof v === 'object' && (Number(v.average) !== 0 || (v.history || []).length)) out.push(`${where}.${k}`);
    else if (isEvalKey(k) && v !== null && v !== undefined && typeof v !== 'object') out.push(`${where}.${k}`);
    else findRatings(v, `${where}.${k}`, out);
  }
  return out;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // ---------------------------------------------------------------- 1. the practice copy
  log('starting the practice copy: npm run demo:sem2:reset -- --faculty-seed');
  const demo = spawn('npm run demo:sem2:reset -- --faculty-seed', { cwd: REPO, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  demo.stdin.on('error', () => {});
  let output = '';
  let exitCode = null;
  const exited = new Promise(resolve => demo.on('exit', code => { exitCode = code; resolve(code); }));
  for (const s of [demo.stdout, demo.stderr]) s.on('data', c => { output += c; });
  const stopDemo = async () => {
    if (exitCode !== null) return;
    log('stopping the practice copy');
    demo.stdin.write('\u0003');
    const stopped = await Promise.race([exited.then(() => true), procs.sleep(90000).then(() => false)]);
    if (!stopped) procs.killTree(demo.pid);
  };
  let mongoose = null;
  let client = null;
  try {
    await procs.waitUntil({ label: 'practice copy', check: async () => output.includes('Press Ctrl+C to stop'), timeoutMs: 8 * 60000, shouldStop: () => exitCode !== null });
    const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
    const database = String(run.database || '');
    if (run.mode !== 'sem2' || !database.endsWith('_test') || database.includes('defense')) throw new Error(`Refused: this is not the practice copy (${run.mode}, ${database}).`);
    if (run.facultySource !== 'seed') throw new Error('Refused: the practice copy must be seeded with --faculty-seed (tracked data only).');
    log(`practice copy ready: ${database}, faculty from the seed file`);
    const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile), 'utf8'));
    const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };

    // ------------------------------------------------------------ 2. generate and approve
    const { call, login } = apiOf(run);
    const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
    const termFile = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'data', 'term_2nd_sem_AY2026_27.json'), 'utf8'));
    await assignUnassignedMajors({ call, dean, TERM, term: termFile, log, reason: DEFENSE_REASON });
    const ready = await readiness(call, dean, TERM);
    log(`Readiness Check: ${ready.verdict}`);
    if (ready.verdict !== 'ready') throw new Error('The practice copy is not ready to generate.');
    const runRow = await generateSeed({ call, dean, TERM, seed: SEED, log });
    if (runRow.status !== 'done' || !runRow.scheduleId) throw new Error(`The generation did not finish: ${runRow.status} ${runRow.message || ''}`);
    log(`generated ${runRow.version} (seed ${SEED})`);
    for (const stepNumber of [2, 3]) {
      const res = await call('POST', '/schedule/approve-stage', { token: dean, body: { scheduleId: runRow.scheduleId, ...TERM, stepNumber, notes: stepNumber === 2 ? 'Practice data for the deployment kit' : 'Approved for the practice kit' } });
      if (res.status !== 200) throw new Error(`approval stage ${stepNumber}: ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    log(`${runRow.version} sent for review and approved by the TEST Dean`);

    // ------------------------------------------------------------ 3. the throwaway copy
    const { MongoClient } = serverRequire('mongodb');
    const host = `127.0.0.1:${run.ports.mongo}`;
    client = await MongoClient.connect(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 15000 });
    const src = client.db(database);
    const dst = client.db(PRACTICE_DB);
    await dst.dropDatabase();
    let scrubbed = 0;
    const ratingValuesBefore = await src.collection('faculty').countDocuments({ $or: [{ 'evalScore.average': { $gt: 0 } }, { 'evalScore.history.0': { $exists: true } }] });
    for (const { name } of await src.listCollections({}, { nameOnly: true }).toArray()) {
      // demo_meta marks a demo database; the practice kit is not a demo.
      if (name.startsWith('system.') || name === 'demo_meta') continue;
      const docs = await src.collection(name).find({}).toArray();
      for (const d of docs) scrubbed += scrub(d);
      if (docs.length) await dst.collection(name).insertMany(docs);
    }
    log(`copied into ${PRACTICE_DB}; ${ratingValuesBefore} professors had a rating, ${scrubbed} rating values removed`);

    // Two accounts: the TEST Dean who approved (renamed) and a new College Secretary.
    const bcrypt = serverRequire('bcryptjs');
    const deanPw = newPassword();
    const secPw = newPassword();
    const users = dst.collection('users');
    const deanDoc = await users.findOne({ email: secrets.deanEmail });
    if (!deanDoc) throw new Error('The TEST Dean account is missing in the copy.');
    const removed = await users.deleteMany({ _id: { $ne: deanDoc._id } });
    await users.updateOne({ _id: deanDoc._id }, { $set: { name: 'PRACTICE Dean', email: 'practice.dean@example.test', role: 'Dean', status: 'Active', password: await bcrypt.hash(deanPw, await bcrypt.genSalt(10)), updatedAt: new Date() } });
    await users.insertOne({ name: 'PRACTICE College Secretary', email: 'practice.secretary@example.test', role: 'College Secretary', status: 'Active', password: await bcrypt.hash(secPw, await bcrypt.genSalt(10)), lastLogin: null, createdAt: new Date(), updatedAt: new Date(), __v: 0 });
    // A fresh office starts without this computer's system settings and with ratings shown or not as stored.
    await dst.collection('system_settings').drop().catch(() => {});
    log(`accounts: PRACTICE Dean and PRACTICE College Secretary (${removed.deletedCount} other account(s) removed)`);

    // ------------------------------------------------------------ 4. the backup, through the service
    process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
    process.env.INTELLISCHED_MODEL_PATH = path.join(BACKEND, 'intellisched_gbdt_engine.joblib');
    mongoose = serverRequire('mongoose');
    await mongoose.connect(`mongodb://${host}/${PRACTICE_DB}?directConnection=true`, { autoIndex: false, autoCreate: false });
    const svc = serverRequire(path.join(SERVER, 'src', 'backup', 'service.js'));
    const { entries, manifest } = await svc.buildFullPayload({ passwordSetOn: null, kind: 'full' });
    const sealed = svc.sealBackup(svc.zipSync(entries), 'intellisched', {
      passwordSetOn: null, createdAt: manifest.createdAt, appVersion: manifest.appVersion,
      schemaVersion: manifest.schemaVersion, dbName: manifest.dbName, kind: manifest.kind
    });
    const file = path.join(OUT, 'practice.isbak');
    fs.writeFileSync(file, sealed);

    // The check: re-open with the password and scan every collection for a rating.
    const opened = svc.openFullBackup(fs.readFileSync(file), 'intellisched');
    const { EJSON } = mongoose.mongo.BSON;
    const found = [];
    for (const [name, data] of opened.files) {
      if (!name.startsWith('collections/')) continue;
      const docs = EJSON.parse(data.toString('utf8'), { relaxed: false });
      docs.forEach((d, i) => findRatings(d, `${name}#${i}`, found));
      if (/Student evaluation: \d/.test(data.toString('utf8'))) found.push(`${name}: text`);
    }
    const faculty = EJSON.parse(opened.files.get('collections/faculty.json').toString('utf8'), { relaxed: false });
    const unrated = faculty.filter(f => Number(f.evalScore?.average || 0) === 0 && !(f.evalScore?.history || []).length).length;
    const sha256 = crypto.createHash('sha256').update(sealed).digest('hex');
    const versions = EJSON.parse(opened.files.get('collections/mother_schedules.json').toString('utf8'), { relaxed: false });
    const approved = versions.filter(v => v.status === 'Approved').length;
    const verify = {
      builtAt: new Date().toISOString(), seed: SEED, version: runRow.version, sha256, bytes: sealed.length,
      counts: opened.manifest.counts, model: opened.manifest.model,
      ratingsFound: found.length, professors: faculty.length, professorsWithoutRating: unrated, approvedVersions: approved
    };
    fs.writeFileSync(path.join(OUT, 'practice-verify.json'), `${JSON.stringify(verify, null, 2)}\n`);
    if (found.length) throw new Error(`A rating is still in the practice backup (${found.length} place(s), first: ${found[0]}).`);
    if (unrated !== faculty.length) throw new Error('A professor still has a rating.');
    if (!approved) throw new Error('The practice backup has no approved version.');
    log(`practice.isbak: ${Math.round(sealed.length / 1024)} KB, SHA-256 ${sha256}; ${faculty.length} professors, none with a rating; ${approved} approved version`);

    fs.writeFileSync(path.join(OUT, 'PRACTICE-SIGN-IN.txt'), [
      'IntelliSched practice sign-in (PRACTICE MODE ONLY - practice data, no real ratings)',
      '',
      'Open IntelliSched from the desktop icon, then sign in with one of these:',
      '',
      'Dean:              practice.dean@example.test',
      `  password:        ${deanPw}`,
      'College Secretary: practice.secretary@example.test',
      `  password:        ${secPw}`,
      '',
      'Backup password of data\\practice.isbak: intellisched',
      ''
    ].join('\r\n'));
    log('PRACTICE-SIGN-IN.txt written');
  } finally {
    if (mongoose) await mongoose.disconnect().catch(() => {});
    if (client) { await client.db(PRACTICE_DB).dropDatabase().catch(() => {}); await client.close().catch(() => {}); log(`dropped ${PRACTICE_DB}`); }
    await stopDemo();
  }
})().then(() => process.exit(0)).catch((err) => { console.error(`[practice-data] FAIL: ${err.message}`); process.exit(1); });
