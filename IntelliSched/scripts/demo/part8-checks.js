// Phase 8 Part 8, Step 4: the checks after the migration (read only). On the demo's own MongoDB:
//   node scripts/demo/part8-checks.js --db <name> --source <backup folder of the adopted database> [--out <file.json>]
// Against the backup the target was adopted from (last night's database), it checks:
//   - the counts are unchanged except the listed changes (one account added: the defense's login);
//   - every saved version is identical — so every assignment (the locks), every class and every decision
//     row is as it was — and the validator re-checks each version with classes: 0 conflicts;
//   - the sections, rooms, catalog, curriculum, policy, runs and audit rows are identical;
//   - the faculty differ only in the migrated fields (name, degree, Program, the blocks outside the grid),
//     every name is in the one style and no block is left outside the grid;
//   - the accounts: the source's accounts kept (locked), exactly one active account, no active College
//     Secretary; the Output Settings differ only in presentation mode (and an empty room block filled).
// It prints PASS/FAIL lines with the numbers and writes them to --out (default
// .demo-data/logs/part8-checks-<db>.json). Names and counts only, never a rating or a password.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { REPO_ROOT, SERVER_DIR, DEMO_DATA } = require('./paths');
const { withDemoMongo, checkBackupFolder, DEFENSE_DB, intoProblem } = require('./defense-backup');

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const mongoose = serverRequire('mongoose');
const { EJSON } = mongoose.mongo.BSON;
const { normalizeName } = require(path.join(SERVER_DIR, 'src', 'utils', 'names.js'));
const { gridWindowOf, insideGrid } = require(path.join(SERVER_DIR, 'scripts', 'migrate-part8.js'));
const { mergePolicy, defaultPolicy } = require(path.join(SERVER_DIR, 'src', 'utils', 'policy.js'));

const args = process.argv.slice(2);
const valueOf = (flag) => { const at = args.indexOf(flag); return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null; };
const target = valueOf('--db') || DEFENSE_DB;
const sourceDir = valueOf('--source') ? path.resolve(valueOf('--source')) : null;
const OUT = path.resolve(valueOf('--out') || path.join(DEMO_DATA, 'logs', `part8-checks-${target}.json`));
const say = (line) => console.log(`[part8-checks] ${line}`);
const canon = (doc) => EJSON.stringify(doc, { relaxed: false });
// The fields the migration may change (the teaching history: filled where it was empty).
const MIGRATED_FACULTY_FIELDS = ['name', 'degreeAfterName', 'program', 'unavailableBlocks', 'teachingHistory', 'programHistory', 'evalScore', 'updatedAt'];
const without = (doc, keys) => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  say(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

const main = async () => {
  if (target !== DEFENSE_DB && intoProblem(target)) throw new Error(intoProblem(target));
  if (!sourceDir) throw new Error('Name the backup the target was adopted from: --source .demo-data/backups/demo-<date-time>');
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  const { docs: source } = checkBackupFolder(sourceDir, manifest.database);
  await withDemoMongo({
    runMode: 'part8-checks',
    say,
    job: async ({ uriFor }) => {
      await mongoose.connect(uriFor(target), { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
      try {
        const db = mongoose.connection.db;
        const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort();
        const live = {};
        for (const n of names) live[n] = await db.collection(n).find({}).sort({ _id: 1 }).toArray();
        const sorted = (list) => [...list].sort((a, b) => String(a._id).localeCompare(String(b._id)));
        // counts
        const counts = names.map(n => `${n} ${live[n].length}${source[n] ? (source[n].length === live[n].length ? '' : ` (was ${source[n].length})`) : ' (new)'}`);
        const countProblems = Object.keys(source).filter(n => (live[n]?.length ?? 0) !== source[n].length && n !== 'users').concat(names.filter(n => !source[n]));
        record('the counts are unchanged except the accounts', countProblems.length === 0 && (live.users?.length ?? 0) - (source.users?.length ?? 0) <= 1, counts.join(', '));
        // identical collections
        for (const n of ['mother_schedules', 'sections', 'facilities', 'subject_catalog', 'curriculum_mappings', 'scheduling_policies', 'generation_runs', 'audit_events', 'counters', 'reference_lists']) {
          if (!source[n]) continue;
          const same = canon(sorted(source[n])) === canon(sorted(live[n] || []));
          record(`${n} identical to the adopted backup${n === 'mother_schedules' ? ' (every version, class, assignment and decision row)' : ''}`, same, `${(live[n] || []).length} documents`);
        }
        // every assignment, by version
        const lockWords = (list) => list.map(v => `${v.version} ${v.status}: ${(v.lockedAssignments || []).length} assignments, ${(v.scheduleData || []).length} classes`).join('; ');
        record('every assignment is identical (the locks of every version)', canon(sorted(source.mother_schedules || []).map(v => v.lockedAssignments)) === canon(sorted(live.mother_schedules || []).map(v => v.lockedAssignments)), lockWords(live.mother_schedules || []));
        // the validator on every version with classes (every gateway model registered first)
        const modelsDir = path.join(SERVER_DIR, 'src', 'models');
        for (const file of fs.readdirSync(modelsDir).filter(f => f.endsWith('.js'))) require(path.join(modelsDir, file));
        const MotherSchedule = require(path.join(SERVER_DIR, 'src', 'models', 'MotherSchedule.js'));
        const { checkScheduleVersion } = require(path.join(SERVER_DIR, 'src', 'utils', 'versionCheck.js'));
        for (const v of await MotherSchedule.find({ 'scheduleData.0': { $exists: true } })) {
          const check = await checkScheduleVersion(v);
          const byCode = {};
          for (const x of check.violations || []) byCode[x.code] = (byCode[x.code] || 0) + 1;
          record(`${v.version} (${v.academicYear} Sem ${v.semester}, ${v.status}) re-checked by the validator: 0 conflicts`, (check.violations || []).length === 0,
            `${(check.violations || []).length} conflicts${Object.keys(byCode).length ? ` (${Object.entries(byCode).map(([c, k]) => `${c} ${k}`).join(', ')})` : ''}; ${v.scheduleData.length} classes`);
        }
        // faculty: only the migrated fields differ; names in style; nothing outside the grid
        const srcFac = new Map((source.faculty || []).map(f => [String(f._id), f]));
        const otherDiffs = (live.faculty || []).filter(f => !srcFac.has(String(f._id)) || canon(without(srcFac.get(String(f._id)), MIGRATED_FACULTY_FIELDS)) !== canon(without(f, MIGRATED_FACULTY_FIELDS)));
        record('the faculty differ only in the migrated fields (name, degree, Program, the blocks outside the grid, an empty teaching history or rating)', otherDiffs.length === 0, otherDiffs.map(f => f.name).join(', ') || `${(live.faculty || []).length} profiles`);
        const notInStyle = (live.faculty || []).filter(f => normalizeName(f.name).name !== f.name || normalizeName(f.name).degree);
        record('every name is in the one style ("First M. Last", no degree inside)', notInStyle.length === 0, notInStyle.map(f => f.name).join(', ') || 'all');
        const policy = live.scheduling_policies?.[0] ? mergePolicy(live.scheduling_policies[0], undefined) : defaultPolicy();
        const win = gridWindowOf(policy);
        const outside = (live.faculty || []).filter(f => insideGrid(f.unavailableBlocks || [], win).removed.length);
        record('no unavailable time is left outside the grid', outside.length === 0, outside.map(f => f.name).join(', ') || 'none');
        // accounts
        const srcUsers = new Map((source.users || []).map(u => [String(u._id), u]));
        const keptAll = [...srcUsers.values()].every(u => (live.users || []).some(x => String(x._id) === String(u._id) && x.email === u.email && x.password === u.password && x.role === u.role));
        const active = (live.users || []).filter(u => (u.status || 'Active') === 'Active');
        const activeSecretaries = active.filter(u => u.role === 'College Secretary');
        record('the adopted accounts are kept (same email, role and password hash)', keptAll, (live.users || []).map(u => `${u.email} (${u.role}, ${u.status || 'Active'})`).join(', '));
        record('exactly one active account', active.length === 1, active.map(u => `${u.email} (${u.role})`).join(', '));
        record('no active College Secretary account', activeSecretaries.length === 0, activeSecretaries.map(u => u.email).join(', ') || 'none');
        // output settings
        const srcSettings = (source.output_settings || [])[0];
        const settings = (live.output_settings || [])[0];
        const settingsKeys = ['showEvaluationRatings', 'roomProgram', 'updatedAt'];
        record('the Output Settings differ only in presentation mode (and an empty room block filled)', Boolean(srcSettings && settings) && canon(without(srcSettings, settingsKeys)) === canon(without(settings, settingsKeys)),
          `showEvaluationRatings ${settings?.showEvaluationRatings}; room block ${(settings?.roomProgram?.signatories || []).length} lines`);
        const meta = (live.demo_meta || [])[0];
        if (target === DEFENSE_DB) record('the meta record names the defense', meta?.mode === 'defense' && Boolean(meta?.preparedAt), `mode ${meta?.mode}, adopted from ${meta?.adoptedFrom?.database}`);
      } finally {
        await mongoose.disconnect();
      }
    }
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ target, source: path.relative(REPO_ROOT, sourceDir), at: new Date().toISOString(), results }, null, 2)}\n`);
  const failed = results.filter(r => !r.pass).length;
  say(`${results.length - failed} of ${results.length} passed. Record: ${path.relative(REPO_ROOT, OUT).split(path.sep).join('/')}`);
  return failed ? 1 : 0;
};

main().then(code => process.exit(code)).catch((err) => { say(err.message); process.exit(1); });
