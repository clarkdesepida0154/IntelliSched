// Phase 8 Part 7 (decision 5): npm run defense:restore -- --from <folder>
//
// Puts a backup that npm run defense:reset or npm run defense:backup made
// (.demo-data/backups/defense-<local date-time>/) back into the defense database, after "Type RESTORE …"
// is answered in a console (--yes skips the question for a script; without a console and without --yes
// it refuses). It accepts only the defense database (the backup's manifest must name it), and it
// refuses while the defense — or any demo, which shares the one MongoDB data folder in .demo-data/mongo
// — is running. Before restoring it saves the current state the same way
// (.demo-data/backups/defense-<date-time>-before-restore/), so a restore can itself be undone. It starts
// the demo's MongoDB for the restore alone and stops it afterwards; it prints collection names and
// counts only, never a document (the backup holds the ratings).
// The next npm run defense starts the restored database as it was (its login from
// .demo-data/defense-secrets.json is ensured on every start, as always).
//
// Phase 8 Part 8 (decision 1b): --into <name> rehearses on a copy instead. The backup (of the defense
// database or of another demo mode's database, e.g. npm run demo's) goes into a THROWAWAY database: a
// name ending in _test that is no demo mode's database — never the defense's. The defense database is
// not touched.
const path = require('path');
const readline = require('readline');
const { REPO_ROOT } = require('./paths');
const { checkBackupFolder, restoreDatabase, withDemoMongo, backupFolderFor, intoProblem, modeDatabases, prefixOfDb, totalOf, DEFENSE_DB } = require('./defense-backup');

const say = (line) => console.log(`[defense:restore] ${line}`);
const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => { rl.close(); resolve(answer); });
});
const valueOf = (args, flag) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null;
};

const main = async () => {
  const args = process.argv.slice(2);
  const fromArg = valueOf(args, '--from');
  const from = fromArg ? path.resolve(fromArg) : null;
  if (!from) throw new Error('Name the backup: npm run defense:restore -- --from .demo-data/backups/defense-<date-time>');
  const into = args.includes('--into') ? valueOf(args, '--into') : null;

  // Everything is checked before anything is touched: the target, the backup, then that nothing runs.
  let target = DEFENSE_DB;
  let sourceDb = DEFENSE_DB;
  if (args.includes('--into')) {
    const problem = intoProblem(into);
    if (problem) throw new Error(problem);
    target = into;
    // A rehearsal may copy a backup of any demo mode's database (the manifest says which).
    const peek = (() => { try { return JSON.parse(require('fs').readFileSync(path.join(from, 'manifest.json'), 'utf8')); } catch { return null; } })();
    if (peek?.database && !modeDatabases()[peek.database]) throw new Error(`This backup is of ${peek.database}, which is no demo mode's database. Nothing was changed.`);
    sourceDb = peek?.database || DEFENSE_DB;
  }
  const { manifest } = checkBackupFolder(from, sourceDb);
  const words = `the backup of ${sourceDb} taken ${manifest.createdAt} (${Object.keys(manifest.collections).length} collections, ${totalOf(manifest)} documents)`;
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) throw new Error(`${target} is restored only after RESTORE is typed in a console. From a script, add --yes: npm run defense:restore -- --from <folder>${target === DEFENSE_DB ? '' : ` --into ${target}`} --yes. Nothing was changed.`);
    const answer = await ask(`Type RESTORE to replace ${target === DEFENSE_DB ? `the defense database (${DEFENSE_DB})` : `the throwaway database ${target}`} with ${words}, or anything else to keep it: `);
    if (answer.trim() !== 'RESTORE') {
      say(`${target} is kept; nothing was changed.`);
      return 0;
    }
  }

  return withDemoMongo({
    runMode: 'defense-restore',
    say,
    job: async ({ uriFor }) => {
      const safetyDir = backupFolderFor(new Date(), '-before-restore', prefixOfDb(target));
      const result = await restoreDatabase({ uri: uriFor(target), dir: from, expectedDb: target, sourceDb, safetyDir, log: line => say(line.replace(safetyDir, `${rel(safetyDir)}/`)) });
      say(`Restored ${target} from ${rel(from)}/:`);
      for (const [name, count] of Object.entries(result.counts)) say(`  ${name}: ${count} document${count === 1 ? '' : 's'}`);
      if (target === DEFENSE_DB) say(`Start it with npm run defense. To undo this restore: npm run defense:restore -- --from ${rel(safetyDir)}`);
      else say(`${target} is a throwaway copy for a rehearsal; the defense database was not touched.`);
      return 0;
    }
  });
};

main().then(code => process.exit(code)).catch((err) => {
  say(err.message);
  process.exit(1);
});
