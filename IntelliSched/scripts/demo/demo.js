// One-command demo (Phase 2 Step 0): the app in a browser on test data, for the team.
//   npm run demo          start; seeds the demo database only when it is empty
//   npm run demo:reset    wipe the demo database, seed it again, start
// (The npm scripts pass --reset and --mode <name>; see modes.js for the modes.)
// The defense database is never wiped without a backup (Phase 8 Part 7, defense-backup.js): every
// collection is saved to .demo-data/backups/defense-<local date-time>/ first, and a failed backup
// wipes nothing; npm run defense:restore -- --from <folder> puts one back.
//
// It starts, on ports no test uses: its own MongoDB (a one-node replica set; data kept in
// .demo-data/mongo, so changes survive a restart), the Python service, the gateway in E2E mode and
// Vite. Ctrl+C stops everything it started, including child processes of those processes.
//
// Safety:
// - The database name must end in "_test" (allow-list), and it is on 127.0.0.1 only.
// - Every service gets its variables from here, for its own process only. Database and service
//   addresses, keys and secrets from the calling shell are not passed on (SCRUBBED).
// - The gateway runs in E2E mode (it refuses a database not ending in "_test" and a FastAPI service
//   that is not local) from an empty folder, so dotenv never reads server/.env. dotenv 16 never
//   overrides a variable that is already set anyway (lib/main.js populate(): override is false).
// - The Python service reads ../intellisched_backend/.env (config.py), but python-dotenv's load_dotenv
//   has override=False (it skips any key already in os.environ), and all five variables of that file
//   (MONGO_URI, HOST, PORT, ADMIN_API_KEY, ALLOWED_ORIGINS) are set here.
// - Vite reads client/.env, but variables already in the environment win (vite loadEnv: process.env
//   VITE_* keys are applied last).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { REPO_ROOT, SERVER_DIR, CLIENT_DIR, BACKEND_DIR, MONGO_DIR, LOG_DIR, GATEWAY_CWD, SECRETS_FILE, RUN_FILE } = require('./paths');
const { MODES, resetScriptOf } = require('./modes');
const { startMongo, withDatabase } = require('./mongo');
const procs = require('./processes');
const { checkTarget, seed, ensureUsers } = require(path.join(SERVER_DIR, 'scripts', 'seed-test-db.js'));
const { facultySourceOf, facultySourceWords, keptDatabaseFaculty } = require('./facultySource');
const { seedFileHash, seedFileNotice } = require('./seedFile');
const { isTestDatabaseName } = require(path.join(SERVER_DIR, 'src', 'config', 'db.js'));

const PREFERRED_PORTS = { mongo: 27037, python: 8012, gateway: 5100, client: 5174 };
const DEAN_EMAIL = 'dean.demo@example.test';
// More TEST logins, in the order they are printed after the TEST Dean's, each with its fields in the
// secrets file (<key>Email, <key>Password). Phase 8 Part 8: the office works with ONE account, so the
// demos make the TEST Dean only (it does the technical work too, "Advanced (system team)" included).
// A kept database keeps its TEST College Secretary account until its reset; the role is retired, so it
// can view but change nothing.
const EXTRA_LOGINS = [];
const TEST_LOGINS = { dean: { key: 'dean', label: 'TEST Dean', email: DEAN_EMAIL, name: 'TEST Dean (demo only)', role: 'Dean' }, extra: EXTRA_LOGINS };
const META_COLLECTION = 'demo_meta'; // one document: when this demo seeded and prepared the database
const IS_WINDOWS = process.platform === 'win32';
const PYTHON_EXE = IS_WINDOWS
  ? path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe')
  : path.join(BACKEND_DIR, '.venv', 'bin', 'python');
const VITE_BIN = path.join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

// Never passed on to a service: addresses, keys and secrets the calling shell may hold.
const SCRUBBED = /^(MONGODB_URI|MONGO_URI|TEST_MONGODB_URI|MIGRATION_MONGODB_URI|FASTAPI_URL|PYTHON_ML_SERVICE_URL|E2E_MODE|E2E_FASTAPI_URL|PYTHON_ML_API_KEY|ML_SERVICE_API_KEY|FASTAPI_API_KEY|ADMIN_API_KEY|ALLOW_LIVE_DB|JWT_SECRET|JWT_EXPIRES_IN|DOTENV_KEY|HOST|PORT|CLIENT_URL|ALLOWED_ORIGINS|NODE_ENV|VITE_.*)$/i;
// The ranking's model for one demo database (Phase 8 Part 11): .demo-data/models/<db>/, a copy of the
// committed model and its .meta.json, made when missing and on every reset (a retraining's .bak goes
// with it). Returns the model file's path for the Python service's ML_MODEL_PATH.
const MODEL_FILE = 'intellisched_gbdt_engine.joblib';
const MODEL_META = 'intellisched_gbdt_engine.meta.json';
const demoModelCopy = (dbName, fresh) => {
  const dir = path.join(REPO_ROOT, '.demo-data', 'models', dbName);
  const target = path.join(dir, MODEL_FILE);
  if (fresh || !fs.existsSync(target)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const name of [MODEL_FILE, MODEL_META]) {
      if (fs.existsSync(path.join(BACKEND_DIR, name))) fs.copyFileSync(path.join(BACKEND_DIR, name), path.join(dir, name));
    }
  }
  return target;
};
const envFor = (vars) => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!SCRUBBED.test(key)) env[key] = value;
  return { ...env, ...vars };
};

const say = (message) => console.log(`[demo] ${message}`);
const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
const logFileOf = (name) => path.join(LOG_DIR, `${name}.log`);

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const modeName = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'normal';
// --faculty-seed: seed the faculty from the seed file's faculty_draft even when
// docs/data/faculty_data.json exists (for sample PDFs and screenshots that are committed). It applies
// when the demo seeds; on a database kept from an earlier start whose faculty came from elsewhere, the
// demo stops and says to add --reset (it never reseeds by itself). Where the faculty came from is kept
// in demo_meta and in .demo-data/run.json (facultySource: 'seed' | 'faculty_data'; facultySource.js).
const facultySeedOnly = args.includes('--faculty-seed');
// The mode (checked in main), its logins and its secrets file: the TEST ones, or the mode's own (Phase 4
// Part 3; since Phase 7 the defense has one, "Dean", in .demo-data/defense-secrets.json).
const mode = MODES[modeName] || null;
const LOGINS = mode?.logins || TEST_LOGINS;
const SECRETS = mode?.secretsFile || SECRETS_FILE;

// What this run started, so everything can be stopped.
const state = { services: [], processes: [], mongo: null, ready: false, stopRequested: false, exiting: null, cleaned: false };
const stopError = () => Object.assign(new Error('Stopped by the user.'), { stopRequested: true });
const checkStop = () => { if (state.stopRequested) throw stopError(); };

// The JWT secret, the gateway-Python key and the TEST logins (the Dean's and EXTRA_LOGINS), made once
// with crypto and kept in .demo-data (gitignored), so sessions and the logins survive restarts.
const newPassword = () => crypto.randomBytes(9).toString('base64url');
const writeSecrets = (secrets) => fs.writeFileSync(SECRETS, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
const MIN_PASSWORD = 6;
// The fields a secrets file lacks for the extra logins, and the labels of those logins.
const missingLoginFields = (saved) => {
  const missing = {};
  const labels = [];
  for (const login of LOGINS.extra) {
    const emailField = `${login.key}Email`;
    const passwordField = `${login.key}Password`;
    const fields = {
      ...(saved[emailField] ? {} : { [emailField]: login.email }),
      ...(String(saved[passwordField] || '').length >= MIN_PASSWORD ? {} : { [passwordField]: newPassword() })
    };
    if (Object.keys(fields).length) {
      Object.assign(missing, fields);
      labels.push(login.label);
    }
  }
  return { missing, labels };
};
// The fields of logins this mode does not make (<key>Email / <key>Password), left by an older version
// of the mode: the defense's System Admin and College Secretary before Phase 7.
const LOGIN_FIELD = /^(.+)(Email|Password)$/;
const staleLoginFields = (saved) => {
  const keys = new Set([LOGINS.dean.key, ...LOGINS.extra.map(login => login.key)]);
  return Object.keys(saved).filter((field) => {
    const match = LOGIN_FIELD.exec(field);
    return Boolean(match) && !keys.has(match[1]);
  });
};
const staleEmails = (saved, fields) => fields.filter(field => field.endsWith('Email')).map(field => saved[field]).filter(Boolean);
const loginsWords = () => (LOGINS.extra.length ? 'its own logins' : `the ${LOGINS.dean.label}'s login`);
const loadSecrets = () => {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { /* first run */ }
  if (saved?.id && saved.jwtSecret && saved.apiKey && saved.deanEmail && String(saved.deanPassword || '').length >= MIN_PASSWORD) {
    // A file made before a TEST login existed (the System Admin's in Phase 3 Step 4, the College
    // Secretary's in Step 6): the missing logins are added and everything else is kept, the id above
    // all (a new id would reseed the demo database and wipe what the team changed in it).
    const { missing, labels } = missingLoginFields(saved);
    // A reset (after RESET in the defense) wipes the database, so the file keeps the mode's logins only
    // (Phase 7: the defense's Dean); a start without reset keeps the file as it is, with the accounts.
    const stale = reset ? staleLoginFields(saved) : [];
    if (!labels.length && !stale.length) return saved;
    const completed = { ...Object.fromEntries(Object.entries(saved).filter(([field]) => !stale.includes(field))), ...missing };
    writeSecrets(completed);
    if (labels.length) say(`Added the ${labels.join(' and ')} ${labels.length === 1 ? 'login' : 'logins'} to ${rel(SECRETS)}; the rest of it is unchanged.`);
    if (stale.length) say(`Removed ${staleEmails(saved, stale).join(' and ')} from ${rel(SECRETS)}: this mode makes ${loginsWords()} only. The ${LOGINS.dean.label}'s password is unchanged.`);
    return completed;
  }
  const secrets = {
    _note: `Made by npm run ${mode?.resetPrompt ? 'defense' : 'demo'} for this computer only. Never commit it (.demo-data is gitignored).`,
    id: crypto.randomUUID(),
    jwtSecret: crypto.randomBytes(48).toString('hex'),
    apiKey: crypto.randomBytes(32).toString('hex'),
    deanEmail: LOGINS.dean.email,
    deanPassword: newPassword(),
    ...missingLoginFields({}).missing
  };
  writeSecrets(secrets);
  return secrets;
};
// The extra logins as seed() and ensureUsers() take them, and the Dean's (ensured on every start).
const extraLoginsOf = (secrets) => LOGINS.extra.map(login => ({
  name: login.name, email: secrets[`${login.key}Email`], password: secrets[`${login.key}Password`], role: login.role
}));
const deanLoginOf = (secrets) => ({ name: LOGINS.dean.name, email: secrets.deanEmail, password: secrets.deanPassword, role: LOGINS.dean.role });

const writeRunFile = (fields) => {
  fs.writeFileSync(RUN_FILE, `${JSON.stringify({ demoPid: process.pid, mode: modeName, startedAt: state.startedAt, ...fields }, null, 2)}\n`);
};

// Refuses to start while another demo runs from this folder (they would share .demo-data/mongo).
const guardSingleRun = () => {
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch { return; }
  if (previous.demoPid && previous.demoPid !== process.pid && procs.isAlive(previous.demoPid, 'node.exe')) {
    throw new Error(`Another demo is already running (PID ${previous.demoPid}, started ${previous.startedAt}). Stop it with Ctrl+C in its window first. If no demo is running, delete ${rel(RUN_FILE)}.`);
  }
  const left = (previous.processes || []).filter(p => procs.isAlive(p.pid, p.name));
  if (left.length) {
    say(`An earlier demo did not stop cleanly and left these running: ${left.map(p => `${p.name} (PID ${p.pid})`).join(', ')}.`);
    say('Stop them with "taskkill /PID <pid> /T /F" if the demo cannot start.');
  }
};

// Why the database must be (re)seeded (reason, or null to keep it), and its demo_meta document.
const reasonToSeed = async (uri, secrets) => {
  if (reset) return { reason: 'npm run demo:reset starts from a fresh seed', meta: null };
  const { meta, collections } = await withDatabase(uri, async db => ({
    meta: await db.collection(META_COLLECTION).findOne({ _id: 'seed' }),
    collections: (await db.listCollections({}, { nameOnly: true }).toArray()).length
  }));
  const reason = !collections ? 'the demo database is empty'
    : !meta ? 'the demo database was not made by this demo'
      : !meta.preparedAt ? 'the last start did not finish preparing it'
        : meta.secretsId !== secrets.id ? `the ${LOGINS.dean.label} login was made again (${rel(SECRETS)} is new)`
          : null;
  return { reason, meta };
};

// npm run defense:reset (a mode with resetPrompt): the database is wiped only after RESET is typed in the
// console, or with --yes (for a script with no console). Anything else keeps it and stops.
const confirmReset = async () => {
  if (args.includes('--yes')) return;
  if (!process.stdin.isTTY) {
    throw new Error(`${mode.dbName} is wiped only after RESET is typed in a console. From a script, add --yes: npm run ${resetScriptOf(modeName)} -- --yes. Nothing was changed.`);
  }
  process.stdin.setRawMode(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(`Type RESET to wipe the defense database (${mode.dbName}) and load the term file again (a backup is saved first to .demo-data/backups/), or anything else to keep it: `, resolve));
  rl.close();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  if (answer.trim() !== 'RESET') {
    say(`${mode.dbName} is kept; nothing was changed. (npm run defense starts it as it is.)`);
    throw stopError();
  }
};
const writeMeta = (uri, fields) => withDatabase(uri, db => db.collection(META_COLLECTION).updateOne({ _id: 'seed' }, { $set: fields }, { upsert: true }));

// Starts a service and waits until ready(); on failure the error carries its log file.
const startAndWait = async ({ name, label, timeoutMs, ready, ...spawnOptions }) => {
  const logFile = logFileOf(name);
  const child = procs.startService({ name, logFile, ...spawnOptions });
  const service = { name, label, child, logFile };
  state.services.push(service);
  child.on('error', (err) => { service.spawnError = err; });
  child.on('exit', (code, signal) => {
    if (!state.ready || state.exiting) return;
    say(`The ${label} stopped unexpectedly (exit code ${code ?? signal}). Last lines of ${rel(logFile)}:`);
    console.log(procs.tailLog(logFile));
    shutdown(1);
  });
  try {
    return await procs.waitUntil({ label, child, check: ready, timeoutMs, shouldStop: () => state.stopRequested });
  } catch (err) {
    if (service.spawnError) err.message = `The ${label} could not be started: ${service.spawnError.message}`;
    err.logFile = logFile;
    throw err;
  }
};

const main = async () => {
  state.startedAt = new Date().toISOString();
  if (!mode) throw new Error(`Unknown demo mode "${modeName}". Known modes: ${Object.keys(MODES).join(', ')}.`);
  if (!isTestDatabaseName(mode.dbName)) throw new Error(`Refusing the database "${mode.dbName}": the demo only uses a database whose name ends in "_test".`);
  for (const [what, file] of [['the Python service', PYTHON_EXE], ['Vite', VITE_BIN], ['the gateway packages', path.join(SERVER_DIR, 'node_modules')]]) {
    if (!fs.existsSync(file)) throw new Error(`Cannot find ${what} at ${file}. See TESTING.md, "First-time setup".`);
  }
  [LOG_DIR, GATEWAY_CWD, MONGO_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  guardSingleRun();
  if (reset && mode.resetPrompt) await confirmReset();
  writeRunFile({ state: 'starting' });
  ['mongod', 'python', 'gateway', 'vite'].forEach(name => fs.writeFileSync(logFileOf(name), ''));
  const secrets = loadSecrets();

  const reserved = new Set();
  const ports = {
    mongo: await procs.pickPort('MongoDB', PREFERRED_PORTS.mongo, reserved),
    python: await procs.pickPort('Python service', PREFERRED_PORTS.python, reserved),
    gateway: await procs.pickPort('gateway', PREFERRED_PORTS.gateway, reserved),
    client: await procs.pickPort('client', PREFERRED_PORTS.client, reserved)
  };
  const clientUrl = `http://localhost:${ports.client}`;
  checkStop();

  say(`Starting MongoDB on 127.0.0.1:${ports.mongo} (data kept in ${rel(MONGO_DIR)}) ...`);
  try {
    state.mongo = await startMongo({ dbPath: MONGO_DIR, port: ports.mongo, logFile: logFileOf('mongod') });
  } catch (err) {
    err.logFile = logFileOf('mongod');
    throw err;
  }
  checkStop();
  const uri = state.mongo.uriFor(mode.dbName);
  const target = checkTarget(uri);
  if (!target.ok || !target.local) throw new Error(target.reason || `The demo database must be on this computer, not ${uri}.`);

  const { reason: seedReason, meta } = await reasonToSeed(uri, secrets);
  let facultySource;
  // The seed file this start would seed from: recorded when seeding, compared on a database kept.
  const seedHash = seedFileHash();
  if (seedReason) {
    const seedNow = () => {
      say(`Seeding ${mode.dbName} (${seedReason}) ...`);
      return seed({
        uri, local: true, deanEmail: secrets.deanEmail, deanPassword: secrets.deanPassword, deanName: LOGINS.dean.name,
        users: extraLoginsOf(secrets), ...mode.seedOptions, ...(facultySeedOnly ? { facultySource: 'seed' } : {})
      });
    };
    // Phase 8 Part 7 (decision 5): the defense database is never wiped without a backup. Its seed (a
    // wipe: npm run defense:reset after RESET, or a kept database the demo must seed again) runs only
    // after every collection is saved to .demo-data/backups/defense-<local date-time>/; a failed
    // backup stops here with nothing wiped. npm run defense:restore -- --from <folder> puts it back.
    let counts;
    if (mode.resetPrompt) {
      const { backupThenWipe, backupFolderFor } = require('./defense-backup');
      counts = (await backupThenWipe({ uri, dir: backupFolderFor(), wipe: seedNow, log: say, dbLabel: `the defense database (${mode.dbName})` })).result;
    } else {
      counts = await seedNow();
    }
    if (mode.load) {
      // Phase 4 Part 3: the term modes seed the logins only, then the term loader puts the term file's
      // real data in (its summary is printed as it comes; it prints counts and names, never a rating).
      say(`Seeded the logins. Loading ${mode.term.semesterLabel} AY ${mode.term.academicYear} from the term file${facultySeedOnly ? ' without the private files (--faculty-seed: tracked data only)' : ', with the private faculty files when they are present'} ...`);
      const loaded = await mode.load({ uri, facultySeedOnly, log: (line) => { if (line) console.log(`    ${line}`); } });
      facultySource = loaded.facultySource;
      if (mode.presentationMode) {
        // Phase 7: the defense hides the evaluation ratings on screen (the Output Setting the loader just
        // wrote); the Dean can switch them on again in Output Settings.
        await withDatabase(uri, db => db.collection('output_settings').updateOne({ key: 'active' }, { $set: { showEvaluationRatings: false } }, { upsert: true }));
        say('Presentation mode: the evaluation ratings are hidden on screen (Output Settings, "Show evaluation ratings on screen").');
      }
      await writeMeta(uri, { mode: modeName, seededAt: new Date(), preparedAt: null, secretsId: secrets.id, seedCounts: counts, facultySource, seedFileHash: seedHash, termLoad: { changes: loaded.result.changes, problems: loaded.result.problems, sources: loaded.result.sources } });
    } else {
      facultySource = facultySourceOf(counts);
      await writeMeta(uri, { mode: modeName, seededAt: new Date(), preparedAt: null, secretsId: secrets.id, seedCounts: counts, facultySource, seedFileHash: seedHash });
      say(`Seeded: ${counts.catalog} subjects, ${counts.mappings} curriculum mappings, ${counts.sections} sections, ${counts.rooms} rooms, ${counts.faculty} faculty (${counts.activeFaculty} active; from ${counts.facultySource}).`);
    }
  } else {
    // --faculty-seed would be ignored on a database kept as it was: stop and say so (never reseed by itself).
    const kept = keptDatabaseFaculty({ meta, facultySeedOnly, modeName });
    if (kept.problem) throw new Error(kept.problem);
    facultySource = kept.source;
    say(`Keeping ${mode.dbName} as it was left (npm run ${resetScriptOf(modeName)} starts it fresh).`);
    // A newer seed file (e.g. the subject descriptions of 1 Oct 2026) reaches a kept database only
    // through a reset: say so, never reseed by itself.
    const notice = seedFileNotice({ meta, hash: seedHash, dbName: mode.dbName, modeName });
    if (notice) say(notice);
    // Accounts this mode no longer makes stay in a kept database until its reset (Phase 7: the defense's
    // System Admin and College Secretary from before); the secrets file still names them, so say so.
    const stale = staleLoginFields(secrets);
    if (stale.length) say(`${mode.dbName} keeps the accounts made before this mode had ${loginsWords()} only (${staleEmails(secrets, stale).join(', ')}); npm run ${resetScriptOf(modeName)} leaves ${loginsWords()} only.`);
  }
  // Every start: the mode's logins exist with the logins in the secrets file (the Dean's, then the
  // extra TEST logins), also in a database seeded before they existed (Phase 3 Steps 4 and 6; a demo
  // kept from Phase 2 has only the Dean) or whose accounts someone changed. No other account is added,
  // and nothing else is touched (Phase 7: the defense ensures the Dean's account alone).
  const accounts = [LOGINS.dean, ...LOGINS.extra];
  const ensured = await ensureUsers({ uri, users: [deanLoginOf(secrets), ...extraLoginsOf(secrets)] });
  ensured.forEach((result, i) => {
    if (result.outcome !== 'kept') say(`${accounts[i].label} login ${result.outcome === 'created' ? 'added to' : 'put back in'} ${mode.dbName}.`);
  });
  checkStop();

  // Phase 8 Part 11: the ranking's model is this database's own copy (.demo-data/models/<database>/),
  // so Retrain on Model Feedback never replaces the file committed in ../intellisched_backend; copied
  // from it on the first start and on every reset, kept between starts like the database.
  const modelPath = demoModelCopy(mode.dbName, reset);
  say(`Starting the Python service on 127.0.0.1:${ports.python} ...`);
  const pyHealth = await startAndWait({
    name: 'python', label: 'Python service', timeoutMs: 180000,
    command: PYTHON_EXE, args: ['main.py'], cwd: BACKEND_DIR,
    env: envFor({ MONGO_URI: uri, HOST: '127.0.0.1', PORT: String(ports.python), ADMIN_API_KEY: secrets.apiKey, ALLOWED_ORIGINS: clientUrl, ML_MODEL_PATH: modelPath, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
    ready: async () => {
      const res = await procs.httpGet(`http://127.0.0.1:${ports.python}/api/health`);
      return res.status === 200 && res.body?.status === 'online' ? res.body : null;
    }
  });
  if (pyHealth.database !== mode.dbName) throw new Error(`The Python service reports the database "${pyHealth.database}", not ${mode.dbName}. Stopping.`);

  say(`Starting the gateway (E2E mode) on port ${ports.gateway} ...`);
  const apiBase = `http://127.0.0.1:${ports.gateway}/api`;
  const health = await startAndWait({
    name: 'gateway', label: 'gateway', timeoutMs: 90000,
    command: process.execPath, args: [path.join(SERVER_DIR, 'src', 'app.js')], cwd: GATEWAY_CWD,
    env: envFor({
      E2E_MODE: '1', E2E_FASTAPI_URL: `http://127.0.0.1:${ports.python}`, MONGODB_URI: uri, PORT: String(ports.gateway),
      CLIENT_URL: clientUrl, JWT_SECRET: secrets.jwtSecret, PYTHON_ML_API_KEY: secrets.apiKey, NODE_ENV: 'development'
    }),
    ready: async () => {
      const res = await procs.httpGet(`${apiBase}/health`, 5000);
      return res.status === 200 && res.body?.database ? res.body : null;
    }
  });
  if (health.mode !== 'e2e' || health.database !== mode.dbName || health.services?.python?.database !== mode.dbName) {
    throw new Error(`The gateway reports mode "${health.mode}", database "${health.database}" and a Python service on "${health.services?.python?.database}"; expected e2e and ${mode.dbName}. Stopping.`);
  }
  checkStop();

  if (seedReason) {
    say(`${mode.load ? 'Reading' : 'Preparing'} ${mode.term.semesterLabel} AY ${mode.term.academicYear} through the gateway as the ${LOGINS.dean.label} ...`);
    const login = await fetch(`${apiBase}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: secrets.deanEmail, password: secrets.deanPassword })
    });
    const session = await login.json().catch(() => ({}));
    if (!login.ok || !session.token) throw new Error(`The ${LOGINS.dean.label} could not sign in (${login.status}: ${session.message || 'no token'}). Try npm run ${resetScriptOf(modeName)}.`);
    // One sign-in for every call (the login route is rate-limited).
    const api = async (method, route, body) => {
      const res = await fetch(`${apiBase}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const summary = await mode.prepare(api);
    await writeMeta(uri, { preparedAt: new Date(), prepared: summary });
    mode.describe(summary).forEach(line => say(line));
  }
  checkStop();

  say(`Starting the web client (Vite) on port ${ports.client} ...`);
  await startAndWait({
    name: 'vite', label: 'web client (Vite)', timeoutMs: 90000,
    command: process.execPath, args: [VITE_BIN, '--port', String(ports.client), '--strictPort'], cwd: CLIENT_DIR,
    env: envFor({
      VITE_API_BASE_URL: `http://localhost:${ports.gateway}/api`,
      VITE_DEFAULT_ACADEMIC_YEAR: mode.term.academicYear,
      VITE_DEFAULT_SEMESTER: mode.term.semesterLabel,
      NO_COLOR: '1' // plain text in the log file
    }),
    ready: async () => {
      const res = await procs.httpGet(clientUrl);
      return res.status === 200 && res.contentType.includes('html');
    }
  });
  checkStop();

  // Everything started, including children of children (the venv's python.exe starts the real
  // interpreter), so all of it can be stopped and checked.
  const table = procs.processTable();
  state.processes = [
    ...procs.treeOf(state.mongo.pid, table).map(p => ({ ...p, service: 'mongod' })),
    ...(state.mongo.killerPid ? procs.treeOf(state.mongo.killerPid, table).map(p => ({ ...p, service: 'mongod watchdog' })) : []),
    ...state.services.flatMap(s => procs.treeOf(s.child.pid, table).map(p => ({ ...p, service: s.name })))
  ];
  // facultySource: the PDF spec (client/e2e/demo/outputs-pdf.demo.js) writes the committed sample PDFs
  // only from a demo seeded with the seed file's faculty.
  writeRunFile({ state: 'ready', database: mode.dbName, clientUrl, ports, processes: state.processes, facultySource: facultySource || null, secretsFile: rel(SECRETS), term: mode.term });
  state.ready = true;

  console.log('');
  say(`Ready: IntelliSched ${mode.resetPrompt ? '' : 'demo '}(${mode.title}), ${mode.term.semesterLabel} AY ${mode.term.academicYear}.`);
  // The logins, each label padded to the longest ("TEST College Secretary password:").
  const width = Math.max(...[LOGINS.dean, ...LOGINS.extra].map(l => `${l.label} password:`.length), 'Gateway / Python:'.length) + 2;
  const row = (label, value) => console.log(`  ${`${label}`.padEnd(width)}${value}`);
  row('Open this address:', clientUrl);
  row(`${LOGINS.dean.label} email:`, secrets.deanEmail);
  row(`${LOGINS.dean.label} password:`, secrets.deanPassword);
  // More logins, when a mode has any (Phase 8 Part 8: none — the Dean's one account does the technical
  // work, the review and the approval).
  for (const login of LOGINS.extra) {
    row(`${login.label} email:`, secrets[`${login.key}Email`]);
    row(`${login.label} password:`, secrets[`${login.key}Password`]);
  }
  row('Database:', `${mode.dbName} (MongoDB on 127.0.0.1:${ports.mongo}, data in ${rel(MONGO_DIR)})`);
  row('Faculty from:', mode.facultyWords ? mode.facultyWords(facultySource) : facultySourceWords(facultySource));
  row('Gateway / Python:', `http://localhost:${ports.gateway}/api  /  http://127.0.0.1:${ports.python}`);
  row('Logs:', `${rel(LOG_DIR)}/ (mongod.log, python.log, gateway.log, vite.log)`);
  if (mode.presentationMode) {
    const settings = await withDatabase(uri, db => db.collection('output_settings').findOne({ key: 'active' }));
    row('Ratings on screen:', settings?.showEvaluationRatings === false
      ? 'hidden (presentation mode; Output Settings, "Show evaluation ratings on screen")'
      : `SHOWN: turn "Show evaluation ratings on screen" off in Output Settings, or npm run ${resetScriptOf(modeName)}`);
  }
  if (mode.resetPrompt) row('Kept between starts:', `everything done here (assignments, Drafts, approvals); npm run ${resetScriptOf(modeName)} starts again from the term file.`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
};

// Stops everything this run started, then exits. Safe to call more than once.
const shutdown = (code) => {
  if (state.exiting) return state.exiting;
  state.exiting = (async () => {
    if (state.services.length || state.mongo) say('Stopping everything the demo started ...');
    for (const service of [...state.services].reverse()) {
      if (procs.isRunning(service.child)) procs.killTree(service.child.pid);
    }
    // Anything recorded that outlived its parent (e.g. the real Python interpreter).
    for (const p of state.processes) {
      if (!p.service.startsWith('mongod') && procs.isAlive(p.pid, p.name)) procs.killTree(p.pid);
    }
    if (state.mongo) {
      try {
        await state.mongo.stop(); // a clean shutdown; the data folder is kept
      } catch (err) {
        say(`MongoDB did not stop cleanly (${err.message}); stopping it now.`);
        procs.killTree(state.mongo.pid);
      }
    }
    try {
      if (JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')).demoPid === process.pid) fs.unlinkSync(RUN_FILE);
    } catch { /* no run file */ }
    state.cleaned = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    say(code === 0 ? 'Stopped.' : 'Stopped after an error.');
    process.exit(code);
  })();
  return state.exiting;
};

const requestStop = (reason) => {
  if (state.stopRequested) return;
  state.stopRequested = true;
  console.log('');
  say(`${reason}: stopping ...`);
  if (state.ready) shutdown(0);
  // While starting, main() notices the request at its next step and stops from there.
};

// Ctrl+C: in a console, raw mode makes it a key press for the demo alone (the services do not get
// the console's Ctrl+C and are stopped in order instead). Through a pipe, a Ctrl+C byte also stops it.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => { if (chunk.includes(3)) requestStop('Ctrl+C'); });
process.stdin.on('error', () => {});
process.stdin.resume();
['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].forEach(signal => process.on(signal, () => requestStop(signal)));
process.on('uncaughtException', (err) => { say(`Unexpected error: ${err.stack || err.message}`); shutdown(1); });
process.on('unhandledRejection', (err) => { say(`Unexpected error: ${err?.stack || err}`); shutdown(1); });
// Last resort (e.g. process.exit elsewhere): nothing the demo started outlives it.
process.on('exit', () => {
  if (state.cleaned) return;
  state.services.forEach(service => { if (procs.isRunning(service.child)) procs.killTree(service.child.pid); });
  state.processes.forEach(p => { if (procs.isAlive(p.pid, p.name)) procs.killTree(p.pid); });
  if (state.mongo) [state.mongo.pid, state.mongo.killerPid].forEach(pid => procs.killTree(pid));
});

main().catch((err) => {
  if (err.stopRequested) return shutdown(0);
  console.log('');
  say(`Could not start the demo: ${err.message}`);
  if (err.logFile) {
    console.log(`Last lines of ${rel(err.logFile)}:`);
    console.log(procs.tailLog(err.logFile));
  }
  return shutdown(1);
});
