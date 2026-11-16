// npm run live:users:reset [-- --apply] (Phase 7, Step 4; Phase 8 Part 6: the office's two accounts):
// the live database's accounts started over with one account, the Dean's (Phase 8 Part 8), for a person
// (docs/GO_LIVE.md, step 4).
//   npm run live:users:reset              the dry run: lists the accounts (counts per role, names and
//                                         emails; never a password); nothing is written
//   npm run live:users:reset -- --apply   lists them, asks YES, asks for the two accounts (each password
//                                         typed hidden, twice), backs up users to backups/users-<date-time>/,
//                                         deletes every account and creates the two
// The work is server/scripts/reset-users.js, run as a child process with the console (it asks the
// questions) and ALLOW_LIVE_DB=1 for that one process only (never written to a file). It reads the
// address from server/.env (MONGODB_URI) itself; this wrapper reads no value and prints none.
//
// Tests: run({ argv, io, child }) with a stub child.
const path = require('path');
const kit = require('./kit');

const SCRIPT = path.join(kit.SERVER_DIR, 'scripts', 'reset-users.js');

const run = async ({ argv = process.argv.slice(2), io = kit.consoleIo(), child = kit.runNode } = {}) => {
  const apply = argv.includes('--apply');
  io.say(apply
    ? "live:users:reset -- --apply replaces every account of the live database with one account, the Dean's: it lists them, asks YES, and backs them up before it writes."
    : 'live:users:reset lists the accounts of the live database (the dry run). Nothing is written.');
  const code = await child({ script: SCRIPT, args: apply ? ['--apply'] : [], cwd: kit.SERVER_DIR, extraEnv: { ALLOW_LIVE_DB: '1' } });
  if (code !== 0) io.say(`live:users:reset stopped (exit code ${code}). Read its message above; when it says "Nothing was changed.", nothing was.`);
  return { ok: code === 0, apply, code };
};

if (require.main === module) {
  run().then((r) => process.exit(r.ok ? 0 : 1)).catch((err) => { console.error(`live:users:reset stopped: ${kit.redact(err.message)}`); process.exit(1); });
}

module.exports = { run, SCRIPT };
