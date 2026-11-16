// npm run live:load:dry / npm run live:load (Phase 4 Part 4, Step 4): the term loader on the live
// database, for a person.
//   live:load:dry   node server/scripts/load-term.js --term docs/data/term_2nd_sem_AY2026_27.json --db intellisched_db --uri <server/.env MONGODB_URI>
//                   (reads only; prints what --apply would create, update or leave, with "Problems and things to check")
//   live:load       asks YES, then the same with --apply --backup-dir backups/load-<date-time>
// ALLOW_LIVE_DB=1 is set for that one child process only (never written to a file). The loader reads no
// .env, so this wrapper passes the address from server/.env (MONGODB_URI) to it in the environment of the
// child process only (LOAD_TERM_MONGODB_URI, never on a command line); nothing of it is printed. The backup folder (git ignores backups/) holds the faculty
// records with their ratings: keep it private. The private files docs/data/faculty_data.json and
// faculty_data.ratings.json are used when they are on this computer (the loader says which).
//
// Tests: run({ argv, io, env, now, child, uri }) with a stub child.
const fs = require('fs');
const path = require('path');
const kit = require('./kit');

const SCRIPT = path.join(kit.SERVER_DIR, 'scripts', 'load-term.js');
const TERM_FILE = path.join(kit.REPO_ROOT, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');

const run = async ({ argv = process.argv.slice(2), io = kit.consoleIo(), env = process.env, now = new Date(), child = kit.runNode, uri = null, envFile = kit.ENV_FILES.server, termFile = TERM_FILE } = {}) => {
  const say = io.say;
  const apply = argv.includes('--apply');
  const address = uri || env.MONGODB_URI || (fs.existsSync(envFile) ? kit.readEnvFile(envFile).values.MONGODB_URI : null);
  if (!address) { say('No MongoDB address: set MONGODB_URI in server/.env. Nothing was changed.'); return { ok: false, reason: 'no uri' }; }
  const dbName = kit.databaseNameOf(address);
  if (!dbName) { say(`The address in server/.env (MONGODB_URI) names no database or is not a MongoDB address (${kit.describeUri(address)}). Nothing was changed.`); return { ok: false, reason: 'no database' }; }
  // The address reaches the loader in its environment only (never on a command line a process list shows).
  const base = ['--term', termFile, '--db', dbName];
  const childEnv = { ALLOW_LIVE_DB: '1', LOAD_TERM_MONGODB_URI: address };
  if (!apply) {
    say(`live:load:dry reads ${dbName} (${kit.describeUri(address)}) and prints what the term loader would create, update or leave. Nothing is written.`);
    const code = await child({ script: SCRIPT, args: base, cwd: kit.SERVER_DIR, extraEnv: childEnv });
    say(code === 0 ? 'Dry run finished. Read "Problems and things to check"; when it is right, run: npm run live:load' : `The dry run stopped (exit code ${code}). Fix what it says and run it again.`);
    return { ok: code === 0, apply: false, code };
  }
  const folder = kit.backupFolder('load', now);
  say('live:load will:');
  say(`  1. export every collection the loader touches to ${path.relative(kit.REPO_ROOT, folder)}${path.sep} (git ignores it; it holds the faculty's ratings: keep it private) BEFORE writing;`);
  say(`  2. load ${path.relative(kit.REPO_ROOT, termFile)} into ${dbName}: the catalog and its changes, the mappings, the rooms, the faculty, the sections, the policy when none is stored, the assignments through Assign Faculty's own handler, the Output Settings' empty signatories;`);
  say('  3. print counts and names only (never a rating).');
  say('ALLOW_LIVE_DB=1 is given to the loader process only, never written to a file. Afterwards restart the Python service so the ranking reads the new faculty list.');
  if (!(await kit.confirmYes(io, 'load the term into the live database'))) { say('Stopped: nothing was changed.'); return { ok: false, apply: true, reason: 'not confirmed' }; }
  const code = await child({ script: SCRIPT, args: [...base, '--apply', '--backup-dir', folder], cwd: kit.SERVER_DIR, extraEnv: childEnv });
  say(code === 0 ? `Term loaded. Backup: ${path.relative(kit.REPO_ROOT, folder)}${path.sep}` : `The loader stopped (exit code ${code}). Read its message; the backup folder (if written) names the restore command.`);
  return { ok: code === 0, apply: true, code, backup: folder };
};

if (require.main === module) {
  run().then((r) => process.exit(r.ok ? 0 : 1)).catch((err) => { console.error(`live:load stopped: ${kit.redact(err.message)}`); process.exit(1); });
}

module.exports = { run, SCRIPT, TERM_FILE };
