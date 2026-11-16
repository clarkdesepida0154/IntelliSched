// npm run live:migrate:dry / npm run live:migrate (Phase 4 Part 4, Step 4): the Phase 1 migration on the
// live database, for a person.
//   live:migrate:dry   node server/scripts/migrate-phase1.js (reads only; prints the table of planned changes)
//   live:migrate       asks YES, then node server/scripts/migrate-phase1.js --apply --backup-dir backups/migrate-<date-time>
// ALLOW_LIVE_DB=1 is set for that one child process only (never written to a file). The migration reads the
// address from server/.env (MONGODB_URI) itself; this wrapper reads no value and prints none. The backup
// folder (git ignores backups/) is written by the migration before its first write and names the restore
// command. Run it with the gateway stopped.
//
// Tests: run({ argv: ['--apply'], io, env, now, child }) with a stub child.
const path = require('path');
const kit = require('./kit');

const SCRIPT = path.join(kit.SERVER_DIR, 'scripts', 'migrate-phase1.js');

const run = async ({ argv = process.argv.slice(2), io = kit.consoleIo(), env = process.env, now = new Date(), child = kit.runNode } = {}) => {
  const say = io.say;
  const apply = argv.includes('--apply');
  if (!apply) {
    say('live:migrate:dry reads the live database and prints what the Phase 1 migration would change. Nothing is written.');
    const code = await child({ script: SCRIPT, args: [], cwd: kit.SERVER_DIR, extraEnv: { ALLOW_LIVE_DB: '1' } });
    say(code === 0 ? 'Dry run finished. Read the table; when it is right, run: npm run live:migrate' : `The dry run stopped (exit code ${code}). Fix what it says and run it again.`);
    return { ok: code === 0, apply: false, code };
  }
  const folder = kit.backupFolder('migrate', now);
  say('live:migrate will:');
  say(`  1. export every collection the migration touches to ${path.relative(kit.REPO_ROOT, folder)}${path.sep} (git ignores it) BEFORE writing;`);
  say('  2. apply the Phase 1 migration to the live database (the changes the dry run printed);');
  say('  3. print the restore command for that backup.');
  say('Stop the gateway first. ALLOW_LIVE_DB=1 is given to the migration process only, never written to a file.');
  if (!(await kit.confirmYes(io, 'apply the migration to the live database'))) { say('Stopped: nothing was changed.'); return { ok: false, apply: true, reason: 'not confirmed' }; }
  const code = await child({ script: SCRIPT, args: ['--apply', '--backup-dir', folder], cwd: kit.SERVER_DIR, extraEnv: { ALLOW_LIVE_DB: '1' } });
  const wrote = require('fs').existsSync(folder);
  say(code === 0 ? (wrote ? `Migration applied. Backup: ${path.relative(kit.REPO_ROOT, folder)}${path.sep}` : 'Nothing to apply: the database was already prepared, so no backup was written.') : `The migration stopped (exit code ${code}). Read its message; the backup folder (if written) names the restore command.`);
  return { ok: code === 0, apply: true, code, backup: folder };
};

if (require.main === module) {
  run().then((r) => process.exit(r.ok ? 0 : 1)).catch((err) => { console.error(`live:migrate stopped: ${kit.redact(err.message)}`); process.exit(1); });
}

module.exports = { run, SCRIPT };
