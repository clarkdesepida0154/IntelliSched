// GA runs as background jobs (Phase 2 Step 4). POST /schedule/generate runs the pre-flight check (the
// Readiness Check), starts the job on the Python service and answers 202 with the run's id; the
// gateway then follows the job itself (utils/gaRuns.js) and saves the Draft exactly once when it is
// done, even if the browser was closed. Every run is recorded in generation_runs.
// Phase 3 Step 4: every answer's `message` is in the Dean's words; a technical cause is in `detail`,
// which the page shows only under "Advanced".
const mlClient = require('../config/mlClient');
const GenerationRun = require('../models/GenerationRun');
const { loadTermInputs } = require('../utils/termInputs');
const { runPreflight } = require('../utils/preflight');
const { buildGaRequest, tbaRoomCounts } = require('../utils/gaRequest');
const { toSemesterLabel } = require('../utils/curriculumMatcher');
const { GA_SETTINGS, sanitizeHyperparameters } = require('../utils/gaSettings');
const { follow, recoverRun, cancelJob, hashOf, JOB_CALL_TIMEOUT_MS } = require('../utils/gaRuns');
const { actorOf } = require('../utils/actor');
const { can } = require('../utils/permissions');

const OPEN = ['running', 'saving'];

// Phase 3 Step 4: the GA settings (time budget, seed, population, ...) are "Advanced (system team)",
// advanced.edit in the permission map (Step 6). Anyone else who may start a run (ga.run, checked by the
// route) presses Generate without them: the run uses the defaults and a new random seed, so "Try again"
// is just another start. The refusal keeps Step 4's code, ADVANCED_ONLY, which the pages read.
const ADVANCED_ONLY_MESSAGE = 'Only the Dean can change the generation settings. Press Generate without them.';
// A request carries GA settings when `hyperparameters` is anything but empty (null, undefined or {}).
const carriesSettings = (value) => value !== undefined && value !== null && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "Not ready yet: 2 things to fix (...)": the Readiness Check's own fail lines, in its words.
const notReadyMessage = (readiness) => {
  const failing = readiness.lines.filter(l => l.status === 'fail').map(l => l.text.replace(/\.$/, ''));
  return `Not ready yet: ${plural(readiness.toFix, 'thing')} to fix (${failing.join('; ')}). See the Readiness Check page.`;
};

const { plainMessage } = require('../utils/messages');
const { isAcademicYear } = require('../utils/academicCalendar');
// The page gets plain words; the raw error goes to the server log (utils/messages.js, Phase 4 Part 4).
const sanitizedMessage = (err, fallback) => plainMessage(err, fallback, { label: '[Generation]' });

// The Python service's error detail in words (a string, or { message } for the 409 busy answer).
const detailText = (detail) => (typeof detail === 'string' ? detail : detail?.message || (detail ? JSON.stringify(detail).slice(0, 300) : ''));
// A job the Python service is running that no open run record follows, older than this, is an orphan
// (its gateway stopped before recording it); a younger one may belong to a start happening right now.
const ORPHAN_AFTER_SECONDS = 30;

const describeRun = (run) => `started by ${run.startedBy?.name || 'someone'} at ${new Date(run.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

// GET /schedule/ga-settings: what the GA page offers (defaults and limits).
exports.getGaSettings = (req, res) => {
  res.status(200).json({ success: true, defaults: GA_SETTINGS.defaults, limits: GA_SETTINGS.limits, modes: GA_SETTINGS.modes });
};

// POST /schedule/generate { targetAcademicYear, targetSemester, hyperparameters } (ga.run). Only a
// role with advanced.edit (the Dean's alone since Phase 8 Part 8) may send
// hyperparameters; anyone else who may run presses Generate without them.
exports.generateSchedule = async (req, res) => {
  try {
    const academicYear = String(req.body?.targetAcademicYear ?? req.body?.academicYear ?? '').trim();
    const semester = Number(req.body?.targetSemester ?? req.body?.semester);
    if (!isAcademicYear(academicYear) || ![1, 2].includes(semester)) {
      return res.status(400).json({ success: false, message: 'Choose a target academic year (YYYY-YYYY) and a semester (1st or 2nd).' });
    }
    if (carriesSettings(req.body?.hyperparameters) && !can(req.user?.role, 'advanced.edit')) {
      return res.status(403).json({ success: false, code: 'ADVANCED_ONLY', message: ADVANCED_ONLY_MESSAGE });
    }
    const semesterLabel = toSemesterLabel(semester);
    // The TBA rooms the run gets are resolved here, in the loader (automatic by default).
    const inputs = await loadTermInputs({ academicYear, semester });
    if (!inputs.pairs.length) {
      return res.status(400).json({ success: false, message: `No subject placed in the curriculum for the ${semesterLabel} matches an active section (program, year level and track), so there is nothing to schedule.` });
    }
    // The Readiness Check first: an impossible term never reaches the GA.
    const preflight = runPreflight({ ...inputs, academicYear, semesterLabel });
    if (!preflight.ok) {
      return res.status(400).json({ success: false, code: 'NOT_READY', message: notReadyMessage(preflight.readiness), preflight });
    }
    // One run at a time (the Python service runs one; this answers before building anything).
    const open = await GenerationRun.findOne({ status: { $in: OPEN } }).sort({ startedAt: -1 }).lean();
    // A run this gateway is not following (e.g. its outcome could not be recorded) is picked up again,
    // so it ends on its own instead of blocking every start.
    if (open) await recoverRun(open);
    if (open) {
      return res.status(409).json({ success: false, message: `A schedule run is already going (${describeRun(open)}). Wait for it to finish, or cancel it, before starting another.`, run: open });
    }

    const settings = sanitizeHyperparameters(req.body?.hyperparameters);
    // A seed is always sent and recorded, so every run can be reproduced.
    const seed = Number.isInteger(settings.seed) ? settings.seed : Math.floor(Math.random() * 2 ** 31);
    const built = buildGaRequest({ ...inputs, seed });
    if (!built.request.demands.length) {
      // Practicum and self-paced online lectures (Phase 3 Step 7) are never placed.
      return res.status(400).json({ success: false, message: `The ${semesterLabel} has only classes that are not placed on the timetable (practicum, self-paced online lectures), so there is nothing to schedule.` });
    }

    let job;
    try {
      job = (await mlClient.post('/api/ga/jobs', { ...built.request, hyperparameters: { ...settings, seed } }, { timeout: JOB_CALL_TIMEOUT_MS })).data;
    } catch (err) {
      // The Dean's words in `message`; the technical cause in `detail` ("Advanced").
      if (err.response?.status === 409) {
        const busy = err.response.data?.detail || {};
        const followed = busy.jobId ? await GenerationRun.exists({ pythonJobId: busy.jobId, status: { $in: OPEN } }) : true;
        if (!followed && Number(busy.ageSeconds) > ORPHAN_AFTER_SECONDS) {
          await cancelJob(busy.jobId);
          return res.status(409).json({
            success: false,
            message: 'An earlier run was still going and has been stopped. Press Generate Mother Schedule again in a few seconds.',
            detail: `A GA job that no run record follows (${busy.jobId}, started before the gateway stopped) was still going on the Python service; it was cancelled.`
          });
        }
        return res.status(409).json({
          success: false,
          message: 'The scheduling service is still busy with another run. Wait for it to finish, then try again.',
          detail: `The Python service is already running a GA run${busy.jobId ? ` (${busy.jobId})` : ''}.`
        });
      }
      return res.status(502).json({
        success: false,
        message: 'The schedule could not be started because the scheduling service did not answer. Try again in a minute; if it keeps failing, ask the system team to check Service Health.',
        detail: `The Python service could not start the run (${detailText(err.response?.data?.detail) || err.message}).`
      });
    }

    const { seed: _sentSeed, ...recorded } = settings;
    let run;
    try {
      run = await GenerationRun.create({
        academicYear,
        semester,
        status: 'running',
        startedBy: actorOf(req),
        settings: recorded,
        seed,
        pythonJobId: job.jobId,
        requestHash: hashOf(built.request),
        budgetMs: settings.timeBudgetSeconds * 1000,
        demands: built.request.demands.length,
        // The TBA rooms this run has (the resolved mode and counts; "Advanced" shows them).
        tbaRooms: tbaRoomCounts(inputs.policy),
        message: 'Running'
      });
    } catch (err) {
      // Never leave a job going that no run record follows: it would hold the one run slot.
      await cancelJob(job.jobId);
      throw err;
    }
    follow(run._id);
    console.log(`[GA runs] ${run._id} started by ${run.startedBy?.name || 'unknown'}: ${built.request.demands.length} demands, seed ${seed}, ${settings.mode}, budget ${settings.timeBudgetSeconds} s.`);
    res.status(202).json({ success: true, runId: String(run._id), run: run.toObject() });
  } catch (err) {
    console.error('[GA runs - generate]', err);
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The run could not be started. Try again.') });
  }
};

// GET /schedule/runs/:id
exports.getRun = async (req, res) => {
  try {
    const run = /^[a-f\d]{24}$/i.test(String(req.params.id)) ? await GenerationRun.findById(req.params.id).lean() : null;
    if (!run) return res.status(404).json({ success: false, message: 'That run does not exist. Reload the page.' });
    res.status(200).json({ success: true, run });
  } catch (err) {
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The run could not be read. Try again.') });
  }
};

// GET /schedule/runs?academicYear&semester: the term's runs, newest first (at most 10).
exports.listRuns = async (req, res) => {
  try {
    const filter = {};
    if (req.query.academicYear) filter.academicYear = String(req.query.academicYear);
    if (req.query.semester) filter.semester = Number(req.query.semester);
    const runs = await GenerationRun.find(filter).sort({ startedAt: -1 }).limit(10).lean();
    res.status(200).json({ success: true, runs });
  } catch (err) {
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The runs could not be read. Try again.') });
  }
};

// POST /schedule/runs/:id/cancel: the Python job stops within 2 seconds; the follower then marks the
// run cancelled, and nothing is saved (a result that finished meanwhile is not saved either).
exports.cancelRun = async (req, res) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(String(req.params.id))) return res.status(404).json({ success: false, message: 'That run does not exist. Reload the page.' });
    // Atomic: only a run still running can be cancelled (one being saved has already finished).
    const run = await GenerationRun.findOneAndUpdate(
      { _id: req.params.id, status: 'running' },
      { $set: { cancelRequested: true, cancelledBy: actorOf(req) } },
      { new: true, lean: true }
    );
    if (!run) {
      const existing = await GenerationRun.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ success: false, message: 'That run does not exist. Reload the page.' });
      return res.status(409).json({ success: false, message: existing.status === 'saving' ? 'The run has finished and its result is being saved; it can no longer be cancelled.' : `The run has already ended (${existing.status}).`, run: existing });
    }
    try {
      await mlClient.post(`/api/ga/jobs/${run.pythonJobId}/cancel`, {}, { timeout: JOB_CALL_TIMEOUT_MS });
    } catch (err) {
      if (err.response?.status !== 404) console.warn(`[GA runs] cancel ${run._id}: ${err.message}`);
    }
    res.status(200).json({ success: true, run });
  } catch (err) {
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The run could not be cancelled. Try again.') });
  }
};
