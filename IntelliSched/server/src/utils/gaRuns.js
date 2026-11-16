// GA runs as background jobs (Phase 2 Step 4). The gateway starts a run on the Python service
// (POST /api/ga/jobs), records it in generation_runs, follows it itself (every second), and when the
// job is done validates the result and saves the Draft exactly once, even if the browser was closed.
// A run never stays "running" forever: when the gateway starts it follows the runs still marked
// running again, and a run whose job the Python service no longer has is marked failed.
// Phase 3 Step 4: a run's `message` is in the Dean's words ("No conflicts – saved as Draft v2", "The
// schedule still has 3 conflicts"); the technical cause, when there is one, is in `detail` ("Advanced").
const crypto = require('crypto');
const mlClient = require('../config/mlClient');
const GenerationRun = require('../models/GenerationRun');
const MotherSchedule = require('../models/MotherSchedule');
const { buildGaRequest, tbaRoomCounts } = require('./gaRequest');
const { loadTermInputs, nextVersionName } = require('./termInputs');
const { validateGeneratedSchedule } = require('./constraintValidator');
const { buildTermAssignments } = require('./termAssignments');
const { buildScheduleItems, extraRoomUse, resultCounts, checkEngineStats } = require('./scheduleItems');
const { placeOjtRecords } = require('./ojtPlacement');
const { SOFT_TERMS } = require('./constraints');
const { lastYearSingleClassDays } = require('./lastYearSchedule');
const { headroomCause } = require('./preflight');
const changeFeed = require('./changeFeed');
const { systemActor } = require('./actor');

// Tests shorten these (GA_RUN_POLL_MS, GA_RUN_LOST_AFTER_MS, read at each use); the defaults are for real runs.
const POLL_MS = 1000;
const LOST_AFTER_MS = 30000;   // no answer from the Python service for this long -> the run failed
// A job still going this long after its time budget is stopped and the run marked failed (the GA
// stops itself at the budget; this only catches a job that never ends).
const OVERRUN_MS = 5 * 60 * 1000;
const pollMs = () => Number(process.env.GA_RUN_POLL_MS) || POLL_MS;
const lostAfterMs = () => Number(process.env.GA_RUN_LOST_AFTER_MS) || LOST_AFTER_MS;
const overrunMs = () => Number(process.env.GA_RUN_OVERRUN_MS) || OVERRUN_MS;
const JOB_CALL_TIMEOUT_MS = 10000;
const TERM_PROGRAM = 'ALL';

const following = new Map();   // runId -> { timer, lastContact }

// The request in a canonical form: object keys sorted, and every array sorted by its elements' own
// canonical text, so the hash depends on the data only, never on the order the database returned it in.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
};
const hashOf = (request) => crypto.createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(request))))).digest('hex');

// The Dean's words for a saved run and for one whose result still had hard violations.
const savedMessage = (version) => `No conflicts – saved as Draft ${version}`;
const conflictsMessage = (n) => `The schedule still has ${n} ${n === 1 ? 'conflict' : 'conflicts'}`;
// The plain result a saved Draft adds to its run record, copied from its gaStats (a Draft saved before
// Phase 3 Step 4 has none of these, and adds nothing). Phase 8 Part 5 adds the single-class days
// (professors' and sections') with last year's manual schedule's count beside them.
const PLAIN_RESULT_FIELDS = ['tbaRooms', 'classesInTbaRooms', 'tbaRoomsUsed', 'saturdayClasses', 'noRoomClasses', 'onlineClasses', 'runtimeMs', 'singleClassDays', 'lastYearSingleClassDays'];
const plainResult = (gaStats) => Object.fromEntries(PLAIN_RESULT_FIELDS.filter(f => gaStats?.[f] !== undefined && gaStats?.[f] !== null).map(f => [f, gaStats[f]]));

// The term's request exactly as at the start (same data, same seed, the same resolved TBA rooms: both
// read loadTermInputs), with what saving needs.
const buildRunRequest = async ({ academicYear, semester, seed }) => {
  const inputs = await loadTermInputs({ academicYear, semester });
  const built = buildGaRequest({ ...inputs, seed });
  return { inputs, ...built };
};

const setRun = (id, fields) => GenerationRun.updateOne({ _id: id }, { $set: fields });

const finishAs = async (id, status, message, extra = {}) => {
  try {
    await GenerationRun.updateOne({ _id: id, status: { $in: ['running', 'saving'] } }, { $set: { status, message, finishedAt: new Date(), ...extra } });
  } finally {
    stopFollowing(id);
    // Phase 8 Part 8 (decision 6): no request saves a run's end, so the change feed is told here.
    changeFeed.record(['schedule']);
  }
};

// Asks the Python service to stop a job; a failure is only logged (the job then ends at its budget).
const cancelJob = async (jobId) => {
  if (!jobId) return;
  try {
    await mlClient.post(`/api/ga/jobs/${jobId}/cancel`, {}, { timeout: JOB_CALL_TIMEOUT_MS });
  } catch (err) {
    if (err.response?.status !== 404) console.warn(`[GA runs] cancel job ${jobId}: ${err.message}`);
  }
};

const stopFollowing = (id) => {
  const f = following.get(String(id));
  if (f?.timer) clearTimeout(f.timer);
  following.delete(String(id));
};

// Saves the finished job's result: claimed atomically (running -> saving), so only one follower
// ever saves; a cancel that arrived meanwhile wins. The term's request is built again from the
// database now: when its hash differs from the one recorded at the start, the term's data changed
// during the run (e.g. a lock approved or released) and the result is not saved, since saving it
// would put back the old locks. Otherwise it is validated and saved as a new Draft naming this run.
const saveResult = async (runId, result) => {
  const run = await GenerationRun.findOneAndUpdate({ _id: runId, status: 'running' }, { $set: { status: 'saving' } }, { new: true });
  if (!run) return;
  if (run.cancelRequested) return await finishAs(runId, 'cancelled', `Cancelled by ${run.cancelledBy?.name || 'the Dean'}; nothing was saved.`, { gaStats: result?.stats });
  let saved = null;
  try {
    const built = await buildRunRequest({ academicYear: run.academicYear, semester: run.semester, seed: run.seed });
    if (hashOf(built.request) !== run.requestHash) {
      return await finishAs(runId, 'failed', 'The term\'s data changed while the schedule was being generated (a section, subject, room, professor or assignment was edited), so the result no longer matches it. Nothing was saved. Generate again.');
    }
    const { inputs, request, unscheduledItems, demandInfo } = built;
    const placements = result?.items || [];
    const assignmentsByFaculty = buildTermAssignments({ faculty: inputs.faculty, pairs: inputs.pairs, locks: inputs.locks });
    const validation = validateGeneratedSchedule({ request, placements, faculty: inputs.faculty, assignmentsByFaculty, policy: inputs.policy });
    const stats = result?.stats || {};
    const runtime = Number.isFinite(stats.runtimeMs) ? { runtimeMs: stats.runtimeMs } : {};
    if (!placements.length) {
      return await finishAs(runId, 'failed', 'The scheduling service returned no classes, so nothing was saved. Try again.', { detail: 'The GA returned no classes.', gaStats: stats, ...runtime });
    }
    if (!validation.isValid) {
      // Phase 8 Part 5 (decision 2c): a run that fails while the rooms sit above the headroom level
      // names the cause and the two fixes, never only "Try again".
      const cause = headroomCause(inputs.policy);
      // Phase 8 Part 6 (decision 5c): when the part-timers' rule is the only one left, it says so,
      // who and which day, and the ways out.
      const loneDays = validation.violations.filter(v => v.code === 'HC10_PART_TIMER_SINGLE_DAY');
      const onlyLoneDays = loneDays.length > 0 && loneDays.length === validation.violations.length;
      // Phase 8 Part 8 (decision 5): the ways out never name a setting that is already on (roomWaysOut).
      const ways = cause?.waysOut || [];
      const causeSentence = cause
        ? `${cause.opening}, which makes a conflict-free timetable very hard to find. ${ways.length === 1 ? 'One way out' : 'Two ways out'}: ${ways.join(', or ')}.`
        : onlyLoneDays
          ? `Only the part-timers' rule is left: ${loneDays.slice(0, 3).map(v => `${v.name} on ${v.day}`).join('; ')}${loneDays.length > 3 ? `; and ${loneDays.length - 3} more` : ''} would have just one class. Generate again, or give that professor another class for that day in Assign Faculty; as a last resort, turn off "Part-time professors never have a day with only one class" under Advanced (system team) in the Scheduling Policy.`
          : undefined;
      return await finishAs(runId, 'failed', conflictsMessage(validation.violationCount), {
        detail: `The result breaks ${validation.violationCount} hard rule(s), so it was not saved. The list below names each one.`,
        ...(causeSentence ? { cause: causeSentence } : {}),
        hard: validation.hard, violations: validation.violations.slice(0, 50), gaStats: stats, ...runtime
      });
    }
    // An answer from older Engine 3 code is refused; a disagreement with the gateway's counting is kept as a warning.
    const engine = checkEngineStats(stats, validation.soft);
    if (engine.problem) {
      return await finishAs(runId, 'failed', 'The scheduling service answered in an older format, so nothing was saved. Ask the system team to restart it (Service Health).', { detail: engine.problem, gaStats: stats, ...runtime });
    }
    const scheduleData = buildScheduleItems({ placements, request, demandInfo, facilities: inputs.facilities, policy: inputs.policy });
    // Phase 8 Part 3 (decision 2): the 4th-year On-The-Job Training becomes schedule records of the
    // section — placed after the GA in the coordinator's and the section's free time, never moving a
    // GA class. The run's own numbers below stay the GA classes' (resultCounts leaves OJT out).
    const ojt = placeOjtRecords({ scheduleData, unscheduledItems, pairs: inputs.pairs, faculty: inputs.faculty, policy: inputs.policy });
    scheduleData.push(...ojt.items);
    const gaStats = {
      ...stats,
      softBreakdown: Object.fromEntries(SOFT_TERMS.map(t => [t, validation.soft[t]])),
      softTotal: validation.soft.total,
      engineSoftBreakdown: stats.softBreakdown,
      ...(engine.warnings.length ? { warnings: engine.warnings } : {}),
      extraRoomUse: extraRoomUse(scheduleData),
      // Phase 3 Step 4, the plain result: the TBA rooms the run had (the resolved mode and counts) and
      // what the saved classes use. The Chapter 4 numbers above stay as Engine 3 recorded them.
      tbaRooms: tbaRoomCounts(inputs.policy),
      // Phase 8 Part 5: the single-class days of this answer (the gateway validator's own counts),
      // with last year's manual schedule's count beside them (absent when the transcribed CSV has
      // no such semester — never an invented number). Part 6 (decision 5): the professors' count
      // split — the part-timers' days must be 0 (the Generate result says so), the full-timers'
      // are information only.
      singleClassDays: {
        professors: validation.softCounts.facultySingleClassDays,
        partTimers: validation.softCounts.facultySingleClassDaysPartTime,
        fullTimers: validation.softCounts.facultySingleClassDaysFullTime,
        sections: validation.softCounts.sectionSingleClassDays
      },
      ...(() => { const lastYear = lastYearSingleClassDays({ academicYear: run.academicYear, semester: run.semester }); return lastYear ? { lastYearSingleClassDays: lastYear } : {}; })(),
      ...resultCounts(scheduleData)
    };
    // The term's v{n} sequence (utils/termInputs.js), which restored copies share.
    const version = await nextVersionName({ academicYear: run.academicYear, semester: run.semester });
    saved = await MotherSchedule.create({
      academicYear: run.academicYear,
      semester: run.semester,
      program: TERM_PROGRAM,
      schemaVersion: 2,
      status: 'Draft',
      version,
      scheduleData,
      unscheduledItems,
      gaStats,
      policySnapshot: inputs.policy,
      overrideLogs: [],
      lockedAssignments: inputs.locks,
      hyperparameters: { ...(run.settings || {}), seed: run.seed },
      createdBy: systemActor(run.startedBy || null),
      generationRunId: run._id,
      // Phase 8 Part 3: the version's notes (today only the OJT placement writes one).
      ...(ojt.notes.length ? { notes: ojt.notes } : {})
    });
    await finishAs(runId, 'done', savedMessage(version), { scheduleId: saved._id, version, gaStats, ...plainResult(gaStats) });
  } catch (err) {
    // The Draft was saved and only recording the outcome failed: the run is done, never "nothing saved".
    if (saved) {
      console.error(`[GA runs] ${runId}: Draft ${saved.version} saved, but the run record could not be updated: ${err.message}`);
      await finishAs(runId, 'done', savedMessage(saved.version), { scheduleId: saved._id, version: saved.version, gaStats: saved.gaStats, ...plainResult(saved.gaStats) });
      return;
    }
    await finishAs(runId, 'failed', 'The result could not be saved. Try again.', { detail: `The result could not be saved: ${err.message}` });
  }
};

const tick = async (runId) => {
  const key = String(runId);
  const f = following.get(key);
  if (!f) return;
  try {
    const run = await GenerationRun.findById(runId).lean();
    if (!run || run.status !== 'running') return stopFollowing(runId);
    let job;
    try {
      job = (await mlClient.get(`/api/ga/jobs/${run.pythonJobId}`, { timeout: JOB_CALL_TIMEOUT_MS })).data;
      f.lastContact = Date.now();
    } catch (err) {
      if (err.response?.status === 404) {
        return await finishAs(runId, 'failed', 'The scheduling service no longer has this run (it may have restarted), so nothing was saved. Generate again.',
          { detail: `The Python service answered 404 for job ${run.pythonJobId}.` });
      }
      if (Date.now() - f.lastContact > lostAfterMs()) {
        cancelJob(run.pythonJobId);   // in case it is still going and answers again later
        return await finishAs(runId, 'failed', 'The scheduling service stopped answering during the run, so nothing was saved. Try again; if it keeps happening, ask the system team to check Service Health.',
          { detail: `The Python service did not answer for ${Math.round(lostAfterMs() / 1000)} s (${err.message}).` });
      }
      return schedule(runId);
    }
    if (job.progress) await setRun(runId, { progress: job.progress });
    if (job.status === 'done') return await saveResult(runId, job.result);
    if (job.status === 'cancelled') return await finishAs(runId, 'cancelled', `Cancelled by ${run.cancelledBy?.name || 'the Dean'}; nothing was saved.`, { gaStats: job.stats || job.result?.stats });
    if (job.status === 'failed') {
      return await finishAs(runId, 'failed', 'The scheduling service stopped with an error, so nothing was saved. Try again.', { detail: job.error || 'The GA stopped with an error.' });
    }
    // Still going. A cancel asked for is sent again until the job stops (the first call may have failed).
    if (run.cancelRequested) cancelJob(run.pythonJobId);
    // Never "running" forever: far past its budget, the job is stopped and the run failed.
    if (run.budgetMs && Date.now() - new Date(run.startedAt).getTime() > run.budgetMs + overrunMs()) {
      cancelJob(run.pythonJobId);
      return await finishAs(runId, 'failed', 'The run went far past its time limit, so it was stopped. Nothing was saved. Try again.',
        { detail: `The run was still going ${Math.round(overrunMs() / 60000)} minutes after its time budget.` });
    }
    schedule(runId);
  } catch (err) {
    console.error(`[GA runs] following ${key}: ${err.message}`);
    schedule(runId);
  }
};

const schedule = (runId) => {
  const f = following.get(String(runId));
  if (!f) return;
  f.timer = setTimeout(() => tick(runId).catch(err => console.error(`[GA runs] following ${runId}: ${err.message}`)), pollMs());
  if (f.timer.unref) f.timer.unref();
};

const follow = (runId) => {
  const key = String(runId);
  if (following.has(key)) return;
  following.set(key, { timer: null, lastContact: Date.now() });
  schedule(runId);
};

// A run left open that this gateway is not following (after a restart, or a save whose outcome could
// not be recorded): a run left "saving" is done when its Draft exists (with that Draft's statistics),
// otherwise it goes back to running; a running run is followed again (its job answers, or 404 marks
// it failed).
const recoverRun = async (run) => {
  if (following.has(String(run._id))) return;
  if (run.status === 'saving') {
    const saved = await MotherSchedule.findOne({ generationRunId: run._id }).select('_id version gaStats').lean();
    if (saved) {
      await GenerationRun.updateOne({ _id: run._id, status: 'saving' }, { $set: { status: 'done', scheduleId: saved._id, version: saved.version, gaStats: saved.gaStats, ...plainResult(saved.gaStats), finishedAt: new Date(), message: savedMessage(saved.version) } });
      return;
    }
    await GenerationRun.updateOne({ _id: run._id, status: 'saving' }, { $set: { status: 'running' } });
  }
  follow(run._id);
};

// On gateway start: every run still marked running or saving.
const recoverRuns = async () => {
  const open = await GenerationRun.find({ status: { $in: ['running', 'saving'] } }).lean();
  for (const run of open) await recoverRun(run);
  return open.length;
};

module.exports = { follow, stopFollowing, saveResult, recoverRun, recoverRuns, cancelJob, buildRunRequest, hashOf, following, POLL_MS, LOST_AFTER_MS, OVERRUN_MS, JOB_CALL_TIMEOUT_MS };
