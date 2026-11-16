// Phase 8 Part 11 (decision 2): npm run defense:refresh-history [-- --db <throwaway _test name>] [--yes]
//
// Rewrites ONE field of the faculty records, `teachingHistory`, with the term loader's own function
// (server/scripts/load-term.js historyRowsOf, from docs/ml/teaching_history.json), so each subject's
// entry carries the sections taught per term (`termSections`) that Engine 2's sections_taught reads.
// Nothing else changes: not programHistory, not a name, not a rating. A professor with no entry in the
// history file keeps what is stored.
//
// The target is the defense database (intellisched_defense_test) or, with --db, a THROWAWAY copy (a name
// ending in _test that is no demo mode's database: the rehearsal, after npm run defense:restore --
// --from <backup> --into <name>). It prints the plan (names and counts only, never a rating), then
// writes only after "Type REFRESH" in a console (--yes for a script). Each write is guarded: a record
// changes only while its teachingHistory is still as it was read. It starts the demo's MongoDB for the
// job alone and refuses while a demo or the defense runs. Back up first: npm run defense:backup (the
// restore folder it names undoes this).
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { createRequire } = require('module');
const { REPO_ROOT, SERVER_DIR } = require('./paths');
const { withDemoMongo, intoProblem, DEFENSE_DB } = require('./defense-backup');

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const mongoose = serverRequire('mongoose');
const { historyRowsOf, readHistoryFile, keyOf, surnameOf } = require(path.join(SERVER_DIR, 'scripts', 'load-term.js'));

const SEED_FILE = path.join(REPO_ROOT, 'docs', 'data', 'intellisched_seed_data.json');
const say = (line) => console.log(`[defense:refresh-history] ${line}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => { rl.close(); resolve(answer); });
});
// The stored entry without the new field, to tell "only the section counts are new" from a real change.
const withoutSections = (list) => JSON.stringify((list || []).map(h => ({
  subjectId: h.subjectId ? String(h.subjectId) : null, subjectCode: h.subjectCode, descriptiveTitle: h.descriptiveTitle,
  terms: h.terms || [], timesTaught: h.timesTaught, lastTerm: h.lastTerm ?? null
})));

// The plan for one database: [{ _id, name, before, teachingHistory, sectionsOnly }] for every record whose
// stored teachingHistory differs from the loader's.
const planFor = async (db) => {
  const { history, problem } = readHistoryFile();
  if (!history) throw new Error(`${problem}. Nothing was changed.`);
  const catalog = await db.collection('subject_catalog').find({}).project({ subjectCode: 1, descriptiveTitle: 1 }).toArray();
  const byKey = new Map(catalog.map(c => [keyOf(c.subjectCode, c.descriptiveTitle), c]));
  const seed = fs.existsSync(SEED_FILE) ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) : { catalog: [] };
  const bySeed = new Map((seed.catalog || []).map(s => [s.seedKey, byKey.get(keyOf(s.subjectCode, s.descriptiveTitle))]).filter(([, doc]) => doc));
  const entries = new Map(Object.entries(history.professors || {}).map(([key, value]) => [String(key).toUpperCase(), value]));
  const stored = await db.collection('faculty').find({}).project({ name: 1, teachingHistory: 1 }).toArray();
  const plan = [];
  let withoutEntry = 0;
  for (const f of stored) {
    const entry = entries.get(surnameOf(f.name));
    if (!entry) { withoutEntry += 1; continue; }
    const { teachingHistory } = historyRowsOf(entry, { bySeedKey: k => bySeed.get(k), byCodeAndTitle: (c, t) => byKey.get(keyOf(c, t)) });
    const norm = (v) => JSON.stringify(JSON.parse(JSON.stringify(v ?? [])));
    if (norm(f.teachingHistory) === norm(teachingHistory)) continue;
    plan.push({ _id: f._id, name: f.name, before: f.teachingHistory ?? null, teachingHistory, sectionsOnly: withoutSections(f.teachingHistory) === withoutSections(teachingHistory) });
  }
  return { plan, faculty: stored.length, withoutEntry };
};

const main = async () => {
  const args = process.argv.slice(2);
  const at = args.indexOf('--db');
  const dbName = at >= 0 ? args[at + 1] : DEFENSE_DB;
  if (dbName !== DEFENSE_DB) {
    const problem = intoProblem(dbName);
    if (problem) throw new Error(problem.replace(/--into/g, '--db'));
  }
  return withDemoMongo({
    runMode: 'defense-refresh-history', say, job: async ({ uriFor }) => {
      const conn = await mongoose.createConnection(uriFor(dbName), { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 }).asPromise();
      try {
        const { plan, faculty, withoutEntry } = await planFor(conn.db);
        say(`${dbName}: ${plural(faculty, 'professor')}; ${plural(withoutEntry, 'professor')} with no past Teachers' Program in the history (kept as stored).`);
        if (!plan.length) { say('Every teaching history already matches the loader\'s. Nothing to change.'); return { dbName, changed: 0, plan: [] }; }
        const sectionsOnly = plan.filter(p => p.sectionsOnly).length;
        say(`The teaching history to rewrite (only that field) for ${plural(plan.length, 'professor')}: ${plan.map(p => `${p.name} (${plural(p.teachingHistory.length, 'subject')})`).join('; ')}.`);
        say(`${sectionsOnly} of them gain only the section counts per term; ${plan.length - sectionsOnly} also differ in the terms or subjects (the loader's file wins).`);
        if (!args.includes('--yes')) {
          if (!process.stdin.isTTY) throw new Error('Writes only after REFRESH is typed in a console; from a script add --yes. Nothing was changed.');
          const answer = await ask(`Type REFRESH to rewrite the teaching history in ${dbName}, or anything else to stop: `);
          if (answer.trim() !== 'REFRESH') { say('Stopped. Nothing was changed.'); return { dbName, changed: 0, plan }; }
        }
        let changed = 0;
        for (const p of plan) {
          const guard = p.before === null ? { teachingHistory: { $exists: false } } : { teachingHistory: p.before };
          changed += (await conn.db.collection('faculty').updateOne({ _id: p._id, ...guard }, { $set: { teachingHistory: p.teachingHistory } })).modifiedCount;
        }
        say(`Rewrote the teaching history of ${plural(changed, 'professor')}${changed < plan.length ? ` (${plan.length - changed} changed meanwhile and were left as they were)` : ''}. Nothing else was changed.`);
        const after = await planFor(conn.db);
        say(after.plan.length ? `Still different after the write: ${after.plan.map(p => p.name).join(', ')}.` : 'Re-read: every teaching history now matches the loader\'s.');
        return { dbName, changed, plan };
      } finally {
        await conn.close();
      }
    }
  });
};

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { say(err.message); process.exit(1); });
}

module.exports = { planFor };
