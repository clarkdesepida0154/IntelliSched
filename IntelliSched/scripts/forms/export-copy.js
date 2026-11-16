// Phase 8 Part 9: the three forms exported straight from a THROWAWAY copy of a database (a defense
// backup restored with `npm run defense:restore -- --from <folder> --into <name>_test`), through the
// gateway's own outputs builder and export engine — the same code the Export card runs. It starts the
// demo's MongoDB for the job alone (refused while a demo runs) and reads only; --drop drops the copy
// at the end. Never the defense database, never intellisched_db: only a name ending in _test that no
// demo mode owns.
//   node scripts/forms/export-copy.js --db <name>_test --out <folder> [--formats docx,pdf] [--drop]
// Writes every file of the term (all sections, all professors, the Room Schedule) into <folder>
// with the export's own file names, and <folder>/exports.json: each file's page count.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const mongoose = serverRequire('mongoose');
const { withDemoMongo, intoProblem } = require(path.join(REPO_ROOT, 'scripts', 'demo', 'defense-backup.js'));

const valueOf = (args, flag) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null;
};

// Every file of one term: the three forms, the Room Schedule once (Phase 11.2).
const exportAll = async ({ query, outDir, formats, say }) => {
  const { loadScheduleOutputs } = require(path.join(SERVER_DIR, 'src', 'controllers', 'outputsController.js'));
  const { buildExport } = require(path.join(SERVER_DIR, 'src', 'exports'));
  const { buildExportModel } = require(path.join(SERVER_DIR, 'src', 'exports', 'pageModels.js'));
  const { outputs, error } = await loadScheduleOutputs(query);
  if (error) throw new Error(error.payload.message);
  // Phase 11.2: ONE Room Schedule file (the labs' week groups are pages of it).
  const groups = ['ALL'];
  const jobs = [
    { view: 'class-schedule' },
    ...groups.map(weekGroup => ({ view: 'room-schedule', weekGroup })),
    { view: 'teachers-program' }
  ];
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const job of jobs) {
    const pageNames = buildExportModel(outputs, job.view, { weekGroup: job.weekGroup || 'ALL' }).pages.map(p => p.name);
    for (const format of formats) {
      const file = await buildExport({ outputs, view: job.view, format, weekGroup: job.weekGroup || 'ALL' });
      fs.writeFileSync(path.join(outDir, file.fileName), file.buffer);
      written.push({ view: job.view, weekGroup: job.weekGroup || null, format, file: file.fileName, pages: file.pages, pageNames });
      say(`${file.fileName}: ${file.pages} page(s)`);
    }
  }
  // The titles the fit rule shortened with "…" (Phase 8 Part 9, decision 1), for the report.
  const shortened = jobs.flatMap(job => (buildExportModel(outputs, job.view, { weekGroup: job.weekGroup || 'ALL' }).shortened || [])
    .map(s => ({ view: job.view, weekGroup: job.weekGroup || null, ...s })));
  say(`Shortened titles: ${shortened.length}`);
  fs.writeFileSync(path.join(outDir, 'exports.json'), `${JSON.stringify({ version: outputs.schedule?.versionLabel || outputs.schedule?.version || null, status: outputs.schedule?.status, files: written, shortened }, null, 2)}\n`);
  return written;
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const db = valueOf(args, '--db');
  const outDir = path.resolve(valueOf(args, '--out') || path.join(REPO_ROOT, '.demo-data', 'part9', 'export'));
  const formats = (valueOf(args, '--formats') || 'docx,pdf').split(',');
  const say = (line) => console.log(`[forms:export-copy] ${line}`);
  const problem = intoProblem(db);
  if (problem) { console.error(`[forms:export-copy] ${problem.replace('--into', '--db')}`); process.exit(1); }
  withDemoMongo({
    runMode: 'forms-export-copy',
    say,
    job: async ({ uriFor }) => {
      await mongoose.connect(uriFor(db), { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
      try {
        await exportAll({ query: { academicYear: '2026-2027', semester: 2, prefer: valueOf(args, '--prefer') || 'draft' }, outDir, formats, say });
        if (args.includes('--drop')) {
          await mongoose.connection.db.dropDatabase();
          say(`Dropped the throwaway copy ${db}.`);
        }
      } finally {
        await mongoose.disconnect();
      }
    }
  }).then(() => say(`Done: ${path.relative(REPO_ROOT, outDir)}`), (err) => {
    console.error(`[forms:export-copy] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { exportAll };
