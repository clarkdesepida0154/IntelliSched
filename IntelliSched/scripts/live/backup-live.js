// npm run live:backup (Phase 4 Part 4, Step 4): exports every collection of the live database, read only,
// to a new folder backups/live-<date-time>/ (git ignores it): one Extended JSON file per collection (the
// Phase 1 migration's writeBackup, so restore-phase1-backup.js can put it back) and a manifest with the
// counts. It refuses without ALLOW_LIVE_DB=1 (a person sets it for the one command: in PowerShell
// `$env:ALLOW_LIVE_DB='1'; npm run live:backup; Remove-Item Env:ALLOW_LIVE_DB`), and it prints counts per
// collection, never a document. The address comes from server/.env MONGODB_URI (or MONGODB_URI in the
// shell); the folder holds the faculty records with their ratings, so it is never committed.
//
// Tests: run({ uri, env: { ALLOW_LIVE_DB: '1' }, backupsDir, io }) against a `_test` database.
const fs = require('fs');
const path = require('path');
const kit = require('./kit');

const run = async ({ uri = null, env = process.env, backupsDir = kit.BACKUPS_DIR, io = kit.consoleIo(), now = new Date(), envFile = kit.ENV_FILES.server } = {}) => {
  const say = io.say;
  if (env.ALLOW_LIVE_DB !== '1') {
    say('live:backup refuses to run: ALLOW_LIVE_DB=1 is not set. A person sets it for this one command (PowerShell):');
    say("  $env:ALLOW_LIVE_DB='1'; npm run live:backup; Remove-Item Env:ALLOW_LIVE_DB");
    say('Nothing was read.');
    return { ok: false, reason: 'ALLOW_LIVE_DB' };
  }
  const address = uri || env.MONGODB_URI || (fs.existsSync(envFile) ? kit.readEnvFile(envFile).values.MONGODB_URI : null);
  if (!address) { say('No MongoDB address: set MONGODB_URI in server/.env. Nothing was read.'); return { ok: false, reason: 'no uri' }; }
  const dbName = kit.databaseNameOf(address);
  if (!dbName) { say(`The address names no database (${kit.describeUri(address)}). Nothing was read.`); return { ok: false, reason: 'no database' }; }

  const folder = path.join(backupsDir, `live-${kit.stamp(now)}`);
  say(`live:backup will read every collection of ${kit.describeUri(address)} and write it to ${path.relative(kit.REPO_ROOT, folder) || folder}${path.sep} (git ignores it). It changes nothing in the database.`);

  const mongoose = require(path.join(kit.SERVER_DIR, 'node_modules', 'mongoose'));
  const { writeBackup } = require(path.join(kit.SERVER_DIR, 'scripts', 'migrate-phase1.js'));
  const conn = await mongoose.createConnection(address, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  try {
    const db = conn.db;
    const names = (await db.listCollections().toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort();
    if (!names.length) { say(`${dbName} has no collection. Nothing to back up.`); return { ok: true, folder: null, counts: {} }; }
    kit.ensureDir(folder);
    // One call: every collection and ONE manifest (the restore script reads it).
    const manifest = await writeBackup(db, folder, names);
    const counts = Object.fromEntries(names.map(name => [name, manifest.collections[name]?.documents ?? 0]));
    fs.writeFileSync(path.join(folder, 'README.txt'), [
      `Backup of ${dbName} (${kit.describeUri(address)}) taken ${now.toISOString()} by npm run live:backup, read only.`,
      'One Extended JSON file per collection (and its indexes), the format of the Phase 1 migration\'s backups.',
      'To put a collection back: from server/, node scripts/restore-phase1-backup.js --backup-dir "<this folder>" (the dry run first, then --apply).',
      'This folder holds the faculty records with their ratings: keep it private; it is never committed.',
      ''
    ].join('\n'));
    say(`Written: ${names.length} collection${names.length === 1 ? '' : 's'}:`);
    for (const name of names) say(`  ${name}: ${counts[name]} document${counts[name] === 1 ? '' : 's'}`);
    say(`Folder: ${path.relative(kit.REPO_ROOT, folder) || folder}${path.sep}`);
    return { ok: true, folder, counts };
  } finally {
    await conn.close();
  }
};

if (require.main === module) {
  run().then((r) => process.exit(r.ok ? 0 : 1)).catch((err) => { console.error(`live:backup stopped: ${kit.redact(err.message)}`); process.exit(1); });
}

module.exports = { run };
