// Phase 10, Step 3 (after the Playwright runs of client/e2e/phase10.spec.js): every saved schedule read
// back (read only) and counted twice, by the gateway's own validator (utils/versionCheck.js, the check the
// Approval page runs) and by the independent counting helper (validator-counts.js scheduleUnits), with the
// same compared classes per view as the manual schedule (compared_classes.json). With npm run demo:eval running:
//   node scripts/eval/runs-units.js [--no-print]
// Writes docs/eval/phase10/: ga_runs_ui.csv; the IntelliSched (Dean's assignment) and Pipeline (IntelliSched's
// assignment) rows of schedule_units.csv (the Manual rows kept); the pre-chosen run's meetings in meetings.csv;
// print/ (the pre-chosen run's PDF exports beside the manual schedule's PDFs, made separately).
//   Checker conflicts = the helper's overlapping pairs on the WHOLE saved schedule (teachers + sections + rooms
//   in one week group); Validator conflicts = the gateway validator's conflicts (every hard rule).
const fs = require('fs');
const path = require('path');
const C = require('./phase10-common');
const { scheduleUnits, unitCells, UNIT_COLUMNS } = require('./validator-counts');

const SOURCES = [['dean', 'IntelliSched', 'Dean'], ['pipeline', 'Pipeline', 'IntelliSched']];
const say = (line) => console.log(`[runs] ${line}`);
const round2 = (n) => Math.round(n * 100) / 100;

const main = async () => {
  const mongoose = await C.connect();
  const S = (p) => require(path.join(C.SERVER, 'src', p));
  S('models/SubjectCatalog'); S('models/Section'); S('models/Faculty');
  const MotherSchedule = S('models/MotherSchedule');
  const { checkScheduleVersion } = S('utils/versionCheck');
  const ctx = await C.loadContext(mongoose);
  const compared = C.readCompared();
  const curriculum = C.curriculumOf(compared.Section, ctx);
  const options = { curriculum, capOf: C.capOf(ctx) };

  const unitsFile = path.join(C.OUT, 'schedule_units.csv');
  const manualUnits = C.readCsv(unitsFile).filter(r => r.Source === 'Manual').map(r => UNIT_COLUMNS.map(c => r[c]));
  const unitRows = [...manualUnits];
  const runRows = []; const detail = [];
  const deanRuns = [];
  for (const [part, source, assignment] of SOURCES) {
    const file = path.join(C.LOGS, `phase10-ui-${part}.json`);
    if (!fs.existsSync(file)) { say(`${file} missing: no ${part} runs`); continue; }
    const runs = JSON.parse(fs.readFileSync(file, 'utf8')).sort((a, b) => a.run - b.run);
    for (const r of runs) {
      const row = { assignment, run: r.run, seed: r.seed, screen: r.conflictsOnScreen, validator: '', checker: '', soft: '', seconds: r.seconds, approve: r.approveEnabled === null ? '' : r.approveEnabled ? 1 : 0, exports: r.exportsOk === null ? '' : r.exportsOk ? 1 : 0 };
      if (r.scheduleId) {
        const doc = await MotherSchedule.findById(r.scheduleId).lean();
        const check = await checkScheduleVersion(doc);
        row.validator = check.violationCount ?? check.violations.length;
        row.soft = round2(check.soft.total);
        const classes = await C.loadClasses(r.scheduleId);
        const all = C.meetingsFromClasses(classes, ctx);
        const whole = scheduleUnits(all, options);
        row.checker = whole.reduce((sum, u) => sum + u.conflicts, 0);
        for (const [view, set] of Object.entries(compared)) {
          for (const u of scheduleUnits(C.onlyCompared(all, set), options).filter(x => x.view === view)) unitRows.push(unitCells(u, source, r.run));
        }
        if (part === 'dean') deanRuns.push({ ...r, soft: row.soft, meetings: C.onlyCompared(all, compared.Section) });
        detail.push({ part, run: r.run, version: r.version, scheduleId: r.scheduleId, validatorByCode: check.violations.reduce((a, v) => { a[v.code] = (a[v.code] || 0) + 1; return a; }, {}), soft: check.soft });
      }
      runRows.push([row.assignment, row.run, row.seed, row.screen ?? '', row.validator, row.checker, row.soft, row.seconds, row.approve, row.exports]);
      say(`${assignment} run ${r.run}: screen ${row.screen}, validator ${row.validator}, checker ${row.checker}, soft ${row.soft}, ${row.seconds} s, approve ${row.approve}, exports ${row.exports}`);
    }
  }
  C.writeCsv(path.join(C.OUT, 'ga_runs_ui.csv'), ['Assignment', 'Run', 'Seed', 'Conflicts on screen', 'Validator conflicts', 'Checker conflicts', 'Soft S', 'Time to result (s)', 'Approve enabled', 'Exports ok'], runRows);
  C.writeCsv(unitsFile, UNIT_COLUMNS, unitRows);

  // The pre-chosen run: among the Dean-assignment runs, the median soft penalty (on a tie, the lower run).
  let pick = null;
  if (deanRuns.length) {
    const softs = deanRuns.map(r => r.soft).sort((a, b) => a - b);
    const mid = softs.length / 2;
    const median = softs.length % 2 ? softs[(softs.length - 1) / 2] : (softs[mid - 1] + softs[mid]) / 2;
    pick = [...deanRuns].sort((a, b) => Math.abs(a.soft - median) - Math.abs(b.soft - median) || a.run - b.run)[0];
    const meetingsFile = path.join(C.OUT, 'meetings.csv');
    const manualMeetings = C.readCsv(meetingsFile).filter(r => r.Source === 'Manual').map(r => C.MEETING_COLUMNS.map(c => r[c]));
    C.writeCsv(meetingsFile, C.MEETING_COLUMNS, [...manualMeetings, ...pick.meetings.map(m => C.meetingRow('IntelliSched', pick.run, m, ctx))]);
    say(`pre-chosen run: Dean-assignment run ${pick.run} (seed ${pick.seed}, ${pick.version}), soft ${pick.soft}; median ${median}`);
    if (!process.argv.includes('--no-print')) {
      const { loadScheduleOutputs } = require(path.join(C.SERVER, 'src', 'controllers', 'outputsController.js'));
      const { buildExport } = require(path.join(C.SERVER, 'src', 'exports'));
      const { outputs } = await loadScheduleOutputs({ ...C.TERM, scheduleId: pick.scheduleId });
      const dir = path.join(C.OUT, 'print');
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, view, weekGroup] of [['IntelliSched-Teachers-Program.pdf', 'teachers-program', 'ALL'], ['IntelliSched-Class-Schedule.pdf', 'class-schedule', 'ALL'],
        ['IntelliSched-Room-Schedule-Odd.pdf', 'room-schedule', 'ODD'], ['IntelliSched-Room-Schedule-Even.pdf', 'room-schedule', 'EVEN']]) {
        const out = await buildExport({ outputs, view, format: 'pdf', weekGroup });
        fs.writeFileSync(path.join(dir, name), out.buffer);
        say(`print/${name}: ${out.pages} page(s)`);
      }
    }
  }
  fs.writeFileSync(path.join(C.LOGS, 'phase10-runs-detail.json'), `${JSON.stringify({ pick: pick && { run: pick.run, seed: pick.seed, version: pick.version, soft: pick.soft }, detail }, null, 1)}\n`);
  await mongoose.disconnect();
};

main().catch((err) => { console.error(`[runs] ${err.stack || err.message}`); process.exit(1); });
