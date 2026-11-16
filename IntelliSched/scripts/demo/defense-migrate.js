// Phase 8 Part 8 (decision 1c): npm run defense:migrate [-- --db <name>] [--adopt-from <folder>] [--apply] [--yes]
//
// The one write to the kept defense database: server/scripts/migrate-part8.js (the Dean's data changes)
// on the demo's own MongoDB. With --adopt-from it first puts a backup of another demo database into the
// target (the Dean's answer of 10 Oct 2026: last night's work, which ran in npm run demo's database, goes
// into the defense database). The order, with --apply:
//   1. a backup of the whole target first, into .demo-data/backups/<defense|name>-<date-time>-before-part8/
//      (npm run defense:restore -- --from <it> undoes everything);
//   2. --adopt-from: the backup's collections replace the target's (the versions with them, untouched);
//   3. the migration (names, degrees, Program, the blocks outside the grid, the College Secretary's lock,
//      the room schedules' signatory block), with its lists;
//   4. --adopt-from: the defense's own state — its one login (person@example.test, from
//      .demo-data/defense-secrets.json) ensured, every other active account locked (they stay, with
//      their audit rows), presentation mode on (the ratings hidden on screen), and the meta record
//      named for the defense, so npm run defense keeps the database as it is (never reseeds it).
// Without --apply it is a dry run: it shows what would change (an adoption is rehearsed on a scratch
// copy, intellisched_part8_dryrun_test, dropped after) and writes nothing to the target.
// --db takes the defense database (the default) or a throwaway one for a rehearsal (a name ending in
// _test that is no demo mode's database). It refuses while a demo or the defense runs (they share one
// MongoDB data folder), asks "Type MIGRATE" in a console (--yes for a script), and prints names and
// counts only, never a rating or a password.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createRequire } = require('module');
const { REPO_ROOT, SERVER_DIR, DEMO_DATA } = require('./paths');
const { withDemoMongo, backupOnly, backupFolderFor, prefixOfDb, checkBackupFolder, restoreDatabase, intoProblem, modeDatabases, DEFENSE_DB } = require('./defense-backup');

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const mongoose = serverRequire('mongoose');
const migration = require(path.join(SERVER_DIR, 'scripts', 'migrate-part8.js'));
const { ensureUsers } = require(path.join(SERVER_DIR, 'scripts', 'seed-test-db.js'));

const DEFENSE_SECRETS = path.join(DEMO_DATA, 'defense-secrets.json');
const DRY_RUN_DB = 'intellisched_part8_dryrun_test';
const say = (line) => console.log(`[defense:migrate] ${line}`);
const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
const valueOf = (args, flag) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null;
};
const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => { rl.close(); resolve(answer); });
});
const withDb = async (uri, fn) => {
  const conn = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 }).asPromise();
  try { return await fn(conn.db); } finally { await conn.close(); }
};

// The defense's own state after an adoption (step 4). Returns the lines it did.
const defenseState = async ({ uri, db, sourceDb, backupName, secrets }) => {
  const done = [];
  const others = await db.collection('users').find({ email: { $ne: secrets.deanEmail }, status: { $ne: 'Locked' } }).project({ name: 1, email: 1, role: 1 }).toArray();
  if (others.length) {
    await db.collection('users').updateMany({ _id: { $in: others.map(u => u._id) }, status: { $ne: 'Locked' } }, { $set: { status: 'Locked' } });
    done.push(`locked (the defense's one login is ${secrets.deanEmail}; the accounts and their audit rows stay): ${others.map(u => `${u.name} <${u.email}> (${u.role})`).join('; ')}`);
  }
  const settings = await db.collection('output_settings').findOne({ key: 'active' });
  if (settings && settings.showEvaluationRatings !== false) {
    await db.collection('output_settings').updateOne({ _id: settings._id }, { $set: { showEvaluationRatings: false } });
    done.push('presentation mode on: "Show evaluation ratings on screen" off (the defense\'s own setting; the Dean can switch it on in Output Settings)');
  }
  await db.collection('demo_meta').updateOne({ _id: 'seed' }, {
    $set: {
      mode: 'defense',
      secretsId: secrets.id,
      preparedAt: new Date(),
      adoptedFrom: { database: sourceDb, backup: backupName, at: new Date(), why: "Phase 8 Part 8: the Dean's session of 9 Oct 2026 ran in npm run demo's database; moved into the defense (answer of 10 Oct 2026)" }
    }
  }, { upsert: true });
  done.push(`the meta record names the defense (npm run defense keeps this database as it is)`);
  // The one login, made the way every defense start makes it (ensureUsers hashes the password).
  const ensured = await ensureUsers({ uri, users: [{ name: 'Dean', email: secrets.deanEmail, password: secrets.deanPassword, role: 'Dean' }] });
  done.push(`the defense's login ${secrets.deanEmail}: ${ensured[0].outcome}`);
  return done;
};

const main = async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const target = valueOf(args, '--db') || DEFENSE_DB;
  if (target !== DEFENSE_DB) {
    const problem = intoProblem(target);
    if (problem) throw new Error(problem.replace('--into takes', '--db takes'));
  }
  const fromArg = valueOf(args, '--adopt-from');
  const from = fromArg ? path.resolve(fromArg) : null;
  let source = null;
  if (from) {
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8')); } catch { /* checked below */ }
    if (!manifest?.database || !modeDatabases()[manifest.database]) throw new Error(`--adopt-from takes a backup of a demo mode's database (made by npm run defense:backup -- --db <name>); ${rel(from)} is not one. Nothing was changed.`);
    if (manifest.database === target) throw new Error(`--adopt-from names a backup of ${target} itself; use npm run defense:restore for that. Nothing was changed.`);
    checkBackupFolder(from, manifest.database);
    source = { dir: from, db: manifest.database, name: path.basename(from), createdAt: manifest.createdAt };
  }
  let secrets = null;
  if (source) {
    try { secrets = JSON.parse(fs.readFileSync(DEFENSE_SECRETS, 'utf8')); } catch { /* checked below */ }
    if (!secrets?.id || !secrets.deanEmail || String(secrets.deanPassword || '').length < 6) throw new Error(`${rel(DEFENSE_SECRETS)} has no Dean login: start the defense once to make it. Nothing was changed.`);
  }
  say(`${apply ? 'APPLY' : 'Dry run (nothing is written to the target)'} — target ${target}${source ? `; adopting ${source.db} from ${rel(source.dir)}/ (taken ${source.createdAt})` : ''}`);
  if (apply && !args.includes('--yes')) {
    if (!process.stdin.isTTY) throw new Error(`${target} is migrated only after MIGRATE is typed in a console. From a script, add --yes. Nothing was changed.`);
    const answer = await ask(`Type MIGRATE to back up ${target} and then ${source ? `replace it with ${source.db}'s backup and ` : ''}migrate it, or anything else to stop: `);
    if (answer.trim() !== 'MIGRATE') { say('Stopped: nothing was changed.'); return 0; }
  }

  return withDemoMongo({
    runMode: 'defense-migrate',
    say,
    job: async ({ uriFor }) => {
      const record = { target, apply, adoptedFrom: source ? { database: source.db, backup: source.name } : null, at: new Date().toISOString() };
      if (!apply) {
        const scratch = source ? DRY_RUN_DB : target;
        if (source) await restoreDatabase({ uri: uriFor(DRY_RUN_DB), dir: source.dir, expectedDb: DRY_RUN_DB, sourceDb: source.db });
        try {
          const plan = await withDb(uriFor(scratch), db => migration.buildPlan(db));
          migration.printPlan(plan, line => say(line.replace('[migrate-part8] ', 'would: ')));
          if (source) say(`would then: lock every active account but ${secrets.deanEmail}, ensure that login, switch presentation mode on, and name the meta record for the defense.`);
          record.plan = plan.changes.map(({ area, change, count }) => ({ area, change, count }));
          record.lists = plan.lists;
        } finally {
          if (source) await withDb(uriFor(DRY_RUN_DB), db => db.dropDatabase());
        }
        say('Dry run: nothing was written to the target. Add --apply to do it.');
        return { code: 0, record };
      }
      // 1. the backup of the whole target first
      const backupDir = backupFolderFor(new Date(), '-before-part8', prefixOfDb(target));
      const backup = await backupOnly({ uri: uriFor(target), dir: backupDir, dbName: target });
      if (backup.manifest) say(`Backed up ${target} to ${rel(backupDir)}/ first. To undo everything: npm run defense:restore -- --from ${rel(backupDir)}${target === DEFENSE_DB ? '' : ` --into ${target}`}`);
      record.backup = backup.manifest ? rel(backupDir) : null;
      // 2. the adoption
      if (source) {
        const restored = await restoreDatabase({ uri: uriFor(target), dir: source.dir, expectedDb: target, sourceDb: source.db });
        say(`${target} now holds ${source.db}'s data (${Object.entries(restored.counts).map(([n, c]) => `${n} ${c}`).join(', ')}).`);
        record.adopted = restored.counts;
      }
      // 3. the migration
      const result = await withDb(uriFor(target), async (db) => {
        const plan = await migration.buildPlan(db);
        migration.printPlan(plan, say);
        const results = await migration.applyPlan(db, plan);
        return { plan, results };
      });
      for (const r of result.results) say(`${r.area}: ${r.done} changed${r.skipped ? `, ${r.skipped} skipped (changed since the read)` : ''}`);
      record.changes = result.plan.changes.map(({ area, change, count, rows }) => ({ area, change, count, rows }));
      record.lists = result.plan.lists;
      record.results = result.results.map(({ area, done, skipped }) => ({ area, done, skipped }));
      // 4. the defense's own state after an adoption
      if (source) {
        const done = await withDb(uriFor(target), db => defenseState({ uri: uriFor(target), db, sourceDb: source.db, backupName: source.name, secrets }));
        done.forEach(line => say(line));
        record.defenseState = done;
      }
      return { code: 0, record };
    }
  });
};

main().then(({ code, record } = {}) => {
  if (record) {
    const out = path.join(DEMO_DATA, 'logs', `part8-defense-migrate-${record.target}-${record.apply ? 'apply' : 'dry'}-${require('./defense-backup').localStamp()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(record, (k, v) => (k === '_id' ? String(v) : v), 2)}\n`);
    say(`Record: ${rel(out)}`);
  }
  process.exit(code ?? 0);
}).catch((err) => { say(err.message); process.exit(1); });
