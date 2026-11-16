// Phase 9: the GA evaluation runs. With `npm run demo:eval:reset` running (2nd Sem AY 2025-26, the
// office's assignments locked, database intellisched_eval_test), generates the Mother Schedule once per seed for each of the two Engine 3 modes, ONE AFTER ANOTHER (memetic then basic
// for each seed, so a slow minute of the machine falls on both), every answer re-checked by the gateway
// validator, and records each run:
//   docs/eval/ga_runs.csv                    the table for the report (exactly the columns below)
//   .demo-data/logs/ga-eval-runs.json        the same plus the version and schedule id of every run
// Settings: the 180 s budget (3 minutes), everything else from shared/ga-settings.json.
//   node scripts/eval/run-ga-eval.js [--seeds 1,2,...,10]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RUN_FILE = path.join(ROOT, '.demo-data', 'run.json');
const OUT_CSV = path.join(ROOT, 'docs', 'eval', 'ga_runs.csv');
const OUT_JSON = path.join(ROOT, '.demo-data', 'logs', 'ga-eval-runs.json');
const COLUMNS = ['GA (Basic/Memetic)', 'Seed', 'H_start', 'H_final', 'Soft S', 'Fitness', 'First feasible (s)', 'Total time (s)', 'Rooms used', 'TBA placements'];
const MODES = [['memetic', 'Memetic'], ['baseline', 'Basic']];

const args = process.argv.slice(2);
const seeds = (args.includes('--seeds') ? args[args.indexOf('--seeds') + 1] : '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);
const log = (line) => console.log(`[ga-eval ${new Date().toLocaleTimeString('en-GB')}] ${line}`);
const round2 = (n) => Math.round(n * 100) / 100;
const empty = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : v);

const main = async () => {
  if (!fs.existsSync(RUN_FILE)) throw new Error('No demo is running: start `npm run demo:eval:reset` first.');
  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (run.state !== 'ready' || run.database !== 'intellisched_eval_test') throw new Error(`The demo is not the ready evaluation demo (database ${run.database}, state ${run.state}).`);
  const secrets = JSON.parse(fs.readFileSync(path.resolve(ROOT, run.secretsFile), 'utf8'));
  // The gateway's own modules, in this process, against the demo's throwaway database and Python service.
  process.env.E2E_MODE = '1';
  process.env.E2E_FASTAPI_URL = `http://127.0.0.1:${run.ports.python}`;
  process.env.PYTHON_ML_API_KEY = secrets.apiKey;
  const S = path.join(ROOT, 'server', 'src');
  const sreq = (p) => require(path.join(S, p));
  const mongoose = require(path.join(ROOT, 'server', 'node_modules', 'mongoose'));
  const mlClient = sreq('config/mlClient');
  const MotherSchedule = sreq('models/MotherSchedule');
  const { buildGaRequest, tbaRoomCounts } = sreq('utils/gaRequest');
  const { loadTermInputs, nextVersionName } = sreq('utils/termInputs');
  const { validateGeneratedSchedule } = sreq('utils/constraintValidator');
  const { buildTermAssignments } = sreq('utils/termAssignments');
  const { buildScheduleItems, extraRoomUse, resultCounts } = sreq('utils/scheduleItems');
  const { placeOjtRecords } = sreq('utils/ojtPlacement');
  const { SOFT_TERMS } = sreq('utils/constraints');
  const { systemActor } = sreq('utils/actor');
  const { sanitizeHyperparameters } = sreq('utils/gaSettings');
  const { loadScheduleOutputs } = sreq('controllers/outputsController.js');
  if (!/_test$/.test(run.database)) throw new Error('Not a _test database.');
  await mongoose.connect(`mongodb://127.0.0.1:${run.ports.mongo || 27037}/${run.database}`, { autoIndex: false, autoCreate: false });
  // Resumable: the runs already recorded (and their saved Drafts) are kept; only the missing ones run.
  // Never delete schedules: the term's locked assignments live in its first Draft.
  const previous = fs.existsSync(OUT_JSON) ? JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')).runs : [];
  const TERM = { academicYear: run.term.academicYear, semester: Number(run.term.semester) };

  const results = [...previous];
  const started = Date.now();
  for (const seed of seeds) {
    for (const [mode, label] of MODES) {
      if (results.some(r => r.mode === mode && r.seed === seed)) continue;
      const inputs = await loadTermInputs(TERM);
      const settings = sanitizeHyperparameters({ seed, mode, timeBudgetMinutes: 3 });
      const built = buildGaRequest({ ...inputs, seed });
      const job = (await mlClient.post('/api/ga/jobs', { ...built.request, hyperparameters: { ...settings, seed } })).data;
      let result;
      for (;;) {
        await new Promise(r => setTimeout(r, 2000));
        const j = (await mlClient.get(`/api/ga/jobs/${job.jobId}`)).data;
        if (j.status === 'done') { result = j.result; break; }
        if (['failed', 'cancelled'].includes(j.status)) throw new Error(`${mode} seed ${seed}: job ${j.status}: ${j.error || ''}`);
      }
      const stats = result.stats;
      const placements = result.items;
      const assignmentsByFaculty = buildTermAssignments({ faculty: inputs.faculty, pairs: inputs.pairs, locks: inputs.locks });
      const validation = validateGeneratedSchedule({ request: built.request, placements, faculty: inputs.faculty, assignmentsByFaculty, policy: inputs.policy });
      const scheduleData = buildScheduleItems({ placements, request: built.request, demandInfo: built.demandInfo, facilities: inputs.facilities, policy: inputs.policy });
      const ojt = placeOjtRecords({ scheduleData, unscheduledItems: built.unscheduledItems, pairs: inputs.pairs, faculty: inputs.faculty, policy: inputs.policy });
      scheduleData.push(...ojt.items);
      const gaStats = { ...stats, softBreakdown: Object.fromEntries(SOFT_TERMS.map(t => [t, validation.soft[t]])), softTotal: validation.soft.total, extraRoomUse: extraRoomUse(scheduleData), tbaRooms: tbaRoomCounts(inputs.policy), ...resultCounts(scheduleData) };
      const version = await nextVersionName(TERM);
      const saved = await MotherSchedule.create({
        academicYear: TERM.academicYear, semester: TERM.semester, program: 'ALL', schemaVersion: 2, status: 'Draft', version,
        scheduleData, unscheduledItems: built.unscheduledItems, gaStats, policySnapshot: inputs.policy, overrideLogs: [], lockedAssignments: inputs.locks,
        hyperparameters: { ...settings, seed }, createdBy: systemActor(null), ...(ojt.notes.length ? { notes: ojt.notes } : {})
      });
      const { outputs } = await loadScheduleOutputs({ academicYear: TERM.academicYear, semester: TERM.semester, scheduleId: String(saved._id) });
      const classes = outputs.classes || [];
      const hFinal = validation.violationCount;
      const soft = validation.soft.total;
      const row = {
        ga: label, mode, seed, version, scheduleId: String(saved._id),
        hStart: stats.initialHard ?? null, hFinal, engineFinalHard: stats.finalHard ?? null,
        soft: round2(soft), fitness: round2(-(100000 * hFinal + soft)),
        firstFeasibleS: stats.timeToFirstFeasibleMs == null ? null : round2(stats.timeToFirstFeasibleMs / 1000),
        totalS: stats.runtimeMs == null ? null : round2(stats.runtimeMs / 1000),
        roomsUsed: new Set(classes.filter(c => c.roomKey).map(c => c.roomKey)).size,
        tbaPlacements: classes.filter(c => c.roomKind === 'TBA_ROOM').length,
        meetings: classes.length, generations: stats.generations ?? null, stopReason: stats.stopReason || null
      };
      results.push(row);
      log(`${label} seed ${seed} (${version}): H ${row.hStart} -> ${row.hFinal}, soft ${row.soft}, first feasible ${row.firstFeasibleS ?? 'never'} s, total ${row.totalS} s, rooms ${row.roomsUsed}, TBA ${row.tbaPlacements}, ${row.generations} generations`);
      fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
      fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
      fs.writeFileSync(OUT_JSON, `${JSON.stringify({ term: TERM, database: run.database, seeds, runs: results }, null, 2)}\n`);
      const table = [COLUMNS.join(','), ...results.map(r => [r.ga, r.seed, empty(r.hStart), empty(r.hFinal), empty(r.soft), empty(r.fitness), empty(r.firstFeasibleS), empty(r.totalS), empty(r.roomsUsed), empty(r.tbaPlacements)].join(','))];
      fs.writeFileSync(OUT_CSV, `${table.join('\n')}\n`);
    }
  }
  await mongoose.disconnect();
  log(`Done: ${results.length} runs in ${round2((Date.now() - started) / 60000)} minutes.`);
};

main().catch((err) => { console.error(`[ga-eval] ${err.message}`); process.exit(1); });
