// Phase 8 Part 7 (decision 5): a backup before every defense reset, and the restore.
//
//   - backupThenWipe     npm run defense:reset's order: after RESET is typed and before anything is
//                        wiped, every collection of the defense database is saved to
//                        .demo-data/backups/defense-<local date-time>/ with the migrations' EJSON
//                        writer (server/scripts/migrate-phase1.js writeBackup, the one migrate-part6.js
//                        uses: one file per collection with its indexes, each re-read and counted, and
//                        manifest.json with the counts). Only a whole backup lets the wipe run; a failed
//                        one stops the reset with nothing wiped.
//   - restoreDatabase    puts a backup back: the database becomes exactly the backup (every collection
//                        of it with its documents and indexes; a collection made since is dropped). It
//                        accepts only the database it is told to (the defense's), and the backup's own
//                        manifest must name that database. The current state is saved first, the same
//                        way, so a restore can itself be undone.
//   - checkBackupFolder  reads a backup folder and checks it before anything is touched.
//   - runningDemo        the demo running from this folder (they share one MongoDB data folder).
// Phase 8 Part 8 (decision 1a-1b):
//   - backupOnly         npm run defense:backup: the backup half alone (nothing is wiped or changed),
//                        into .demo-data/backups/defense-<local date-time>/ (another demo database
//                        with --db, e.g. demo-<date-time>/ for npm run demo's), re-read and checked.
//   - intoProblem        npm run defense:restore -- --into <name>: only a throwaway database (a name
//                        ending in _test that is no demo mode's database, the defense's least of all).
//   - withDemoMongo      starts the demo's own MongoDB for one job (holding its data folder like a demo
//                        does) and stops it after; refuses while a demo (the defense included) runs.
//
// The backup holds what the database holds, ratings included: it stays in the gitignored .demo-data/,
// is never committed, and nothing here prints a document — only collection names and counts.
// The command lines: this file (npm run defense:backup [-- --db <name>]) and
// scripts/demo/defense-restore.js (npm run defense:restore -- --from <folder> [--into <name>]).
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { REPO_ROOT, DEMO_DATA, SERVER_DIR, MONGO_DIR, LOG_DIR, RUN_FILE } = require('./paths');
const procs = require('./processes');

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const mongoose = serverRequire('mongoose');
const { EJSON } = mongoose.mongo.BSON;
// The migrations' EJSON writer (it reads server/.env for its own command line; nothing here takes an
// address from the environment: the demo's own mongod is always named explicitly).
const { writeBackup } = require(path.join(SERVER_DIR, 'scripts', 'migrate-phase1.js'));
const { isTestDatabaseName } = require(path.join(SERVER_DIR, 'src', 'config', 'db.js'));

const BACKUPS_DIR = path.join(DEMO_DATA, 'backups');
const INDEX_OPTIONS = ['unique', 'sparse', 'partialFilterExpression', 'expireAfterSeconds', 'collation'];
const DEFENSE_DB = 'intellisched_defense_test';

// "2026-10-09_19-30-05" in the computer's LOCAL time (as the system check names its folders).
const localStamp = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};
const backupFolderFor = (date = new Date(), suffix = '', prefix = 'defense') => path.join(BACKUPS_DIR, `${prefix}-${localStamp(date)}${suffix}`);

// The demo modes' databases ({ dbName: modeName }); modes.js is read only when asked.
const modeDatabases = () => Object.fromEntries(Object.entries(require('./modes').MODES).map(([name, mode]) => [mode.dbName, name]));
// A backup folder's prefix: defense-, demo- (npm run demo), demo-full-, demo-sem2-, or the name itself.
const FOLDER_PREFIX = { defense: 'defense', normal: 'demo', full: 'demo-full', sem2: 'demo-sem2' };
const prefixOfDb = (dbName) => FOLDER_PREFIX[modeDatabases()[dbName]] || String(dbName).replace(/^intellisched_/, '').replace(/_test$/, '').replace(/_/g, '-');

// --into (decision 1b): a rehearsal goes into a throwaway database only. Returns the refusal, or null.
const intoProblem = (name) => {
  if (!name) return 'Name the throwaway database: --into <a name ending in _test>.';
  if (!isTestDatabaseName(name)) return `Refusing ${name}: --into takes only a throwaway database whose name ends in "_test". Nothing was changed.`;
  if (name === DEFENSE_DB) return `Refusing ${name}: that is the defense database itself. --into takes only a throwaway database (without --into the restore puts a defense backup back into the defense). Nothing was changed.`;
  const mode = modeDatabases()[name];
  if (mode) return `Refusing ${name}: that is the database of npm run ${require('./modes').startScriptOf(mode)}. --into takes only a throwaway database. Nothing was changed.`;
  return null;
};

const connect = (uri) => mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 }).asPromise();
const collectionsOf = async (db) => (await db.listCollections({}, { nameOnly: true }).toArray())
  .map(c => c.name).filter(name => !name.startsWith('system.')).sort();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const totalOf = (manifest) => Object.values(manifest.collections || {}).reduce((sum, c) => sum + (Number(c.documents) || 0), 0);

// Every collection of the database at `uri` into `dir` (a new or empty folder). Returns the manifest.
const backupDatabase = async ({ uri, dir }) => {
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) {
    throw new Error(`${dir} is not a new, empty folder: an earlier backup is never overwritten.`);
  }
  const conn = await connect(uri);
  try {
    const names = await collectionsOf(conn.db);
    fs.mkdirSync(dir, { recursive: true });
    return await writeBackup(conn.db, dir, names);
  } finally {
    await conn.close();
  }
};

// The reset's order (decision 5): the backup first; the wipe only when the backup is whole. A failed
// backup throws BACKUP_FAILED and the wipe is never called. A database with no collection (the first
// start) has nothing to save. Returns { backup: { dir, manifest } | null, result: what wipe() returned }.
const backupThenWipe = async ({ uri, dir = backupFolderFor(), wipe, log = () => {}, dbLabel = 'the defense database' }) => {
  let manifest = null;
  try {
    const conn = await connect(uri);
    const names = await collectionsOf(conn.db).finally(() => conn.close());
    if (names.length) {
      log(`Backing up ${dbLabel} before anything is wiped ...`);
      manifest = await backupDatabase({ uri, dir });
    }
  } catch (err) {
    throw Object.assign(new Error(`The backup of ${dbLabel} failed (${err.message}), so nothing was wiped. Free some disk space or check .demo-data/backups/, then try the reset again.`), { code: 'BACKUP_FAILED', cause: err });
  }
  if (manifest) {
    const shown = path.relative(path.resolve(DEMO_DATA, '..'), dir).split(path.sep).join('/');
    log(`Backup: ${shown}/ (${plural(Object.keys(manifest.collections).length, 'collection')}, ${plural(totalOf(manifest), 'document')}). To put it back: npm run defense:restore -- --from ${shown}`);
  } else {
    log(`${dbLabel[0].toUpperCase()}${dbLabel.slice(1)} is empty: nothing to back up.`);
  }
  const result = await wipe();
  return { backup: manifest ? { dir, manifest } : null, result };
};

// Reads and checks a backup folder before anything is touched: manifest.json present, naming
// `expectedDb`, every collection's file there with the manifest's count. Returns { manifest, docs }.
const checkBackupFolder = (dir, expectedDb) => {
  const manifestFile = path.join(dir || '', 'manifest.json');
  if (!dir || !fs.existsSync(manifestFile)) {
    throw Object.assign(new Error(`No backup in ${dir || '(no folder named)'}: name the folder that holds manifest.json, e.g. --from .demo-data/backups/defense-<date-time>.`), { code: 'NO_BACKUP' });
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.database !== expectedDb) {
    throw Object.assign(new Error(`This backup is of ${manifest.database || 'an unnamed database'}, not ${expectedDb}. The restore accepts only the defense database. Nothing was changed.`), { code: 'WRONG_DATABASE' });
  }
  const docs = {};
  for (const [name, info] of Object.entries(manifest.collections || {})) {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) throw Object.assign(new Error(`${name}.json is missing from the backup. Nothing was changed.`), { code: 'BROKEN_BACKUP' });
    const list = EJSON.parse(fs.readFileSync(file, 'utf8'), { relaxed: false });
    if (list.length !== info.documents) throw Object.assign(new Error(`${name}.json holds ${list.length} documents; the manifest says ${info.documents}. Nothing was changed.`), { code: 'BROKEN_BACKUP' });
    docs[name] = list;
  }
  return { manifest, docs };
};

// Puts the backup in `dir` back into the database at `uri`, which must be `expectedDb` (the
// defense's); the backup's manifest must name `sourceDb` (the same database unless a rehearsal puts a
// backup into a throwaway one, Part 8's --into). The current state is saved first to `safetyDir` (when
// given). Returns { manifest, safety, counts }.
const restoreDatabase = async ({ uri, dir, expectedDb, sourceDb = expectedDb, safetyDir = null, log = () => {} }) => {
  const target = String(uri).replace(/^mongodb(\+srv)?:\/\/[^/]+\//, '').split('?')[0];
  if (target !== expectedDb) {
    throw Object.assign(new Error(`The restore accepts only ${expectedDb}, not ${target || 'a database with no name'}. Nothing was changed.`), { code: 'WRONG_DATABASE' });
  }
  const { manifest, docs } = checkBackupFolder(dir, sourceDb);
  // The current state is saved first (an empty database, e.g. a new throwaway, has nothing to save).
  const before = await connect(uri);
  const hasData = (await collectionsOf(before.db).finally(() => before.close())).length > 0;
  const safety = safetyDir && hasData ? await backupDatabase({ uri, dir: safetyDir }) : null;
  if (safety) log(`The current state was saved first: ${safetyDir}`);
  const conn = await connect(uri);
  try {
    const db = conn.db;
    const present = new Set(await collectionsOf(db));
    // A collection made since the backup is dropped: the database becomes exactly the backup.
    for (const name of present) if (!(name in manifest.collections) || !manifest.collections[name].existed) await db.collection(name).drop();
    const counts = {};
    for (const [name, info] of Object.entries(manifest.collections)) {
      if (!info.existed) continue;
      if (present.has(name)) await db.collection(name).drop();
      await db.createCollection(name);
      const col = db.collection(name);
      if (docs[name].length) await col.insertMany(docs[name], { ordered: true });
      for (const idx of info.indexes || []) {
        if (idx.name === '_id_') continue;
        const options = { name: idx.name };
        for (const key of INDEX_OPTIONS) if (idx[key] !== undefined) options[key] = idx[key];
        await col.createIndex(idx.key, options);
      }
      counts[name] = await col.countDocuments();
      if (counts[name] !== info.documents) throw new Error(`${name}: ${counts[name]} documents after the restore, ${info.documents} in the backup.`);
    }
    return { manifest, safety, counts };
  } finally {
    await conn.close();
  }
};

// The demo running from this folder, from its run file ({ pid, mode } or null): every mode shares the
// one MongoDB data folder, so nothing is restored while one runs.
const runningDemo = (runFile) => {
  let run = null;
  try { run = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { return null; }
  if (!run?.demoPid || run.demoPid === process.pid) return null;
  return procs.isAlive(run.demoPid, 'node.exe') ? { pid: run.demoPid, mode: run.mode || 'unknown', startedAt: run.startedAt || null } : null;
};
// The refusal while a demo runs (decision 1c: the scripts refuse while the defense system is running).
const runningWords = (running) => (running.mode === 'defense'
  ? `The defense is running (PID ${running.pid}). Stop it with Ctrl+C in its window first; nothing was changed.`
  : `A demo is running (${running.mode}, PID ${running.pid}); every demo shares one MongoDB data folder. Stop it with Ctrl+C in its window first; nothing was changed.`);

// npm run defense:backup (Part 8, decision 1a): every collection of the database at `uri` into `dir`
// (a new folder), each file re-read against the manifest; nothing is wiped or changed. Returns
// { dir, manifest }, or { dir: null, manifest: null } when the database has no collection.
const backupOnly = async ({ uri, dir, dbName }) => {
  const conn = await connect(uri);
  const names = await collectionsOf(conn.db).finally(() => conn.close());
  if (!names.length) return { dir: null, manifest: null };
  const manifest = await backupDatabase({ uri, dir });
  checkBackupFolder(dir, dbName);
  return { dir, manifest };
};

// Starts the demo's own MongoDB (data in .demo-data/mongo) for one job and stops it after. While the
// job runs, the run file holds the data folder like a demo does, so no demo starts meanwhile; it
// refuses while one runs. job({ uriFor, port }) returns the result.
const withDemoMongo = async ({ runMode, say = () => {}, job, runFile = RUN_FILE }) => {
  const running = runningDemo(runFile);
  if (running) throw Object.assign(new Error(runningWords(running)), { code: 'DEMO_RUNNING' });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(runFile, `${JSON.stringify({ demoPid: process.pid, mode: runMode, startedAt: new Date().toISOString(), state: runMode }, null, 2)}\n`);
  let mongo = null;
  try {
    const { startMongo } = require('./mongo');
    const port = await procs.pickPort('MongoDB', 27037);
    say(`Starting MongoDB on 127.0.0.1:${port} (data in ${path.relative(REPO_ROOT, MONGO_DIR).split(path.sep).join('/')}) ...`);
    mongo = await startMongo({ dbPath: MONGO_DIR, port, logFile: path.join(LOG_DIR, 'mongod.log') });
    return await job({ uriFor: mongo.uriFor, port });
  } finally {
    if (mongo) await mongo.stop().catch(() => procs.killTree(mongo.pid));
    try { if (JSON.parse(fs.readFileSync(runFile, 'utf8')).demoPid === process.pid) fs.unlinkSync(runFile); } catch { /* no run file */ }
  }
};

module.exports = { BACKUPS_DIR, DEFENSE_DB, localStamp, backupFolderFor, prefixOfDb, modeDatabases, intoProblem, backupDatabase, backupOnly, backupThenWipe, checkBackupFolder, restoreDatabase, runningDemo, runningWords, withDemoMongo, totalOf };

// npm run defense:backup [-- --db <name>] (Phase 8 Part 8, decision 1a): a backup of the defense
// database (or, with --db, of another demo mode's database, e.g. intellisched_demo_test), with no wipe,
// into .demo-data/backups/<defense|demo|demo-full|demo-sem2>-<local date-time>/. It starts the demo's
// MongoDB for the backup alone and refuses while a demo runs. It prints collection names and counts
// only, never a document (the backup holds the ratings).
if (require.main === module) {
  const say = (line) => console.log(`[defense:backup] ${line}`);
  const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--db');
  const dbName = at >= 0 ? argv[at + 1] : DEFENSE_DB;
  (async () => {
    if (!dbName || dbName.startsWith('--') || !modeDatabases()[dbName]) {
      throw new Error(`--db takes a demo mode's database (${Object.keys(modeDatabases()).join(', ')}), not ${dbName || 'nothing'}. Nothing was backed up.`);
    }
    const dir = backupFolderFor(new Date(), '', prefixOfDb(dbName));
    const { manifest } = await withDemoMongo({ runMode: 'defense-backup', say, job: ({ uriFor }) => backupOnly({ uri: uriFor(dbName), dir, dbName }) });
    if (!manifest) { say(`${dbName} has no collection: nothing to back up.`); return 0; }
    say(`Backed up ${dbName} to ${rel(dir)}/ (${Object.keys(manifest.collections).length} collections, ${totalOf(manifest)} documents; every file re-read and counted):`);
    for (const [name, info] of Object.entries(manifest.collections)) say(`  ${name}: ${info.documents} document${info.documents === 1 ? '' : 's'}`);
    say(dbName === DEFENSE_DB
      ? `Nothing was changed. To put it back: npm run defense:restore -- --from ${rel(dir)}`
      : `Nothing was changed. To rehearse on a copy: npm run defense:restore -- --from ${rel(dir)} --into <a throwaway name ending in _test>`);
    return 0;
  })().then(code => process.exit(code)).catch((err) => { say(err.message); process.exit(1); });
}
