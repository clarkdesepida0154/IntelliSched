// IntelliSched deployment kit (decision 7, install step 8-9): restores a backup (.isbak) through the
// Phase 11.3 restore service itself, so every check is the same (the password, every file's checksum,
// the schema and app version, the record counts, the model files into app\models), then builds the
// gateway's indexes on the fresh database and sets the System settings.
//   node restore-cli.js --root <install> --file <backup.isbak> --backup-folder <folder>
// The backup password comes on standard input (kit-lib readSecret). Prints counts, never a document.
const fs = require('fs');
const path = require('path');
const { P, argValue, loadServerEnv, fromServer, readSecret, connect, loadModels, say, fail, writeFile } = require('./kit-lib');

const main = async () => {
  const file = path.resolve(argValue('--file') || '');
  const folder = argValue('--backup-folder');
  if (!fs.existsSync(file)) fail(`The backup file was not found: ${file}`);
  if (!folder) fail('No backup folder was given.');
  loadServerEnv();
  const password = await readSecret();
  if (!password) fail('No backup password was given.');

  const mongoose = await connect();
  const S = fromServer('src/backup/settings.js');
  const ops = fromServer('src/backup/operations.js');
  const svc = fromServer('src/backup/service.js');

  // The backup folder first: the restore writes its safety backup there.
  const check = S.checkFolder(folder);
  if (!check.writable) fail(`The backup folder cannot be written: ${check.problem}`);
  await S.updateSettings({ folder, daily: true, keep: S.KEEP_RANGE.default });

  let opened;
  try {
    opened = svc.openFullBackup(fs.readFileSync(file), password);
  } catch (err) {
    fail(err.plain || err.code ? err.message : `The backup could not be opened: ${err.message}`, 3);
  }
  const m = opened.manifest;
  say(`Backup: made ${m.createdAt} by IntelliSched ${m.appVersion}, ${Object.keys(m.counts).length} collections, model files: ${(m.model || []).length}`);
  for (const t of m.terms || []) say(`  term ${t.academicYear} semester ${t.semester}`);

  try {
    const result = await ops.restore(fs.readFileSync(file), password, { fileName: path.basename(file) });
    say(`Restored ${result.collections} collections (safety backup ${result.safety})`);
  } catch (err) {
    fail(err.message, 4);
  }

  // The gateway's indexes (unique e-mail and the rest) on the fresh local database.
  loadModels();
  let built = 0;
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).createIndexes();
    built += 1;
  }
  say(`Built the indexes of ${built} collections`);

  // Decision 7 step 9: the System settings (folder, daily backup on, keep 30; the password stays the default).
  await S.updateSettings({ folder, daily: true, keep: S.KEEP_RANGE.default });
  const counts = {};
  for (const name of Object.keys(m.counts).sort()) counts[name] = await mongoose.connection.db.collection(name).countDocuments({});
  writeFile(path.join(P.data, 'restored-manifest.json'), `${JSON.stringify({ restoredAt: new Date().toISOString(), file: path.basename(file), createdAt: m.createdAt, appVersion: m.appVersion, terms: m.terms || [], counts: m.counts, model: m.model || [] }, null, 2)}\n`);
  const wrong = Object.keys(m.counts).filter(n => n !== 'audit_events' && counts[n] !== m.counts[n]);
  if (wrong.length) fail(`The restored counts differ from the backup: ${wrong.join(', ')}`, 5);
  say(`Record counts match the backup (${Object.values(m.counts).reduce((a, b) => a + b, 0)} records)`);
  say(`System settings: backup folder set, daily backup on, keep ${S.KEEP_RANGE.default}`);
  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => fail(err.message));
