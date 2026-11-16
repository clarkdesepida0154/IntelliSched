const express = require('express');
const router = express.Router();
const orchestrator = require('../controllers/orchestratorController');
const generation = require('../controllers/generationController');
const outputs = require('../controllers/outputsController');
const decisions = require('../controllers/decisionsController');
const fillTbaRooms = require('../controllers/fillTbaRoomsController');
const manualEdits = require('../controllers/manualEditsController');
const { requirePermission } = require('../middleware/roles');

// Mounted behind `protect`: every signed-in user may read and watch. Each write names its action from
// the one permission map (utils/permissions.js; Phase 3 Step 6). Checked inside the handlers, because
// they depend on the request: GA settings sent with a start (advanced.edit, generationController) and
// the approval stage (by stepNumber, orchestratorController).
const assignFaculty = requirePermission('faculty.assign');
const runGa = requirePermission('ga.run');
// POST /schedule/override: with `updates` it moves a class in a Draft (the editor's Save); without,
// it records a faculty decision (Assign Faculty). The handler writes the row of the branch checked
// here, never a kind the body names (orchestratorController recordOverride).
const moveClass = requirePermission('schedule.move');
const overrideGuard = (req, res, next) => (req.body?.updates ? moveClass : assignFaculty)(req, res, next);

// Faculty Recommendations (Engines 1 & 2): reads, open to every signed-in user
router.post('/schedule/recommendations', orchestrator.getRecommendations);
router.post('/schedule/recommendations/batch', orchestrator.getBatchRecommendations);

// Authoritative Lock Pipeline (Phase C)
router.get('/schedule/locks', orchestrator.getLocks);
router.post('/schedule/lock', assignFaculty, orchestrator.lockAssignment);
router.delete('/schedule/lock', assignFaculty, orchestrator.unlockAssignment);
// Phase 8 Part 8 (decision 4): a GenEd class's outside teacher, and the list of outside teachers (a
// read for every signed-in user; adding, renaming and removing are part of assigning).
router.post('/schedule/lock-outside', assignFaculty, orchestrator.lockOutsideTeacher);
const outsideTeachers = require('../controllers/outsideTeachersController');
router.get('/outside-teachers', outsideTeachers.listOutsideTeachers);
router.post('/outside-teachers', assignFaculty, outsideTeachers.createOutsideTeacher);
router.patch('/outside-teachers/:id', assignFaculty, outsideTeachers.renameOutsideTeacher);
router.delete('/outside-teachers/:id', assignFaculty, outsideTeachers.removeOutsideTeacher);

// Faculty loads for a term (the one load rule): Course Matrix, Faculty roster, pre-flight
router.get('/schedule/loads', orchestrator.getTermLoads);
// The part-time loads panel (Phase 8): the loads, the spread and "Suggest a balance" (a read; the
// Dean applies a move with POST /schedule/lock above, so the Guardian and the decision rows are the
// assign route's own).
router.get('/schedule/part-time-loads', require('../controllers/partTimeLoadsController').getPartTimeLoads);

// Timetable Generation (Engine 3: GA)
// Pre-flight check: can a conflict-free schedule exist? (generate runs it first too). A read.
router.post('/schedule/preflight', orchestrator.preflightCheck);
// A GA run is a background job (Phase 2 Step 4): generate answers 202 with the run's id at once; the
// gateway follows the job and saves the Draft itself. The GA page polls the run and may cancel it.
router.get('/schedule/ga-settings', generation.getGaSettings);
router.post('/schedule/generate', runGa, generation.generateSchedule);
router.get('/schedule/runs', generation.listRuns);
router.get('/schedule/runs/:id', generation.getRun);
router.post('/schedule/runs/:id/cancel', runGa, generation.cancelRun);
// The validator on a saved version (the Schedule Views & Editor's check), optionally with one class
// moved. A check of the whole version is kept on it as lastCheck (Phase 3 Step 4); a preview of a move
// saves nothing. Open to everyone who may view: it only records a check.
router.post('/schedule/validate', orchestrator.validateSchedule);

// Dean Override Telemetry; with `updates`, a class move (saved only into a Draft)
router.post('/schedule/override', overrideGuard, orchestrator.recordOverride);
// Fill TBA rooms (Phase 4 Part 1): the classes in TBA rooms go into real rooms with free time, without
// moving any time; the preview saves nothing, the save makes a new Draft. A schedule edit (schedule.move).
router.post('/schedule/fill-tba-rooms/preview', moveClass, fillTbaRooms.previewFillTbaRooms);
router.post('/schedule/fill-tba-rooms', moveClass, fillTbaRooms.fillTbaRooms);
// The Dean's manual edits in a Draft (Phase 4 Part 2), checked live and saved only without a new conflict.
// Change professor is a faculty decision (faculty.assign: it also changes the term's assignment and logs
// the decision row); swap two classes is a schedule edit (schedule.move). The check routes save nothing.
router.post('/schedule/change-professor/check', assignFaculty, manualEdits.checkProfessorChange);
router.post('/schedule/change-professor', assignFaculty, manualEdits.changeProfessor);
router.post('/schedule/swap/check', moveClass, manualEdits.checkSwap);
router.post('/schedule/swap', moveClass, manualEdits.swapClasses);

// Dynamic Ingestion & Active Learning Triggers
router.post('/schedule/sync-roster', requirePermission('roster.sync'), orchestrator.syncRoster);
router.post('/schedule/retrain', requirePermission('model.retrain'), orchestrator.retrainModel);
// The term's decisions on the rankings and what Engine 4 retrains on (Model Feedback); a read.
router.get('/schedule/decisions', decisions.getDecisions);

// Schedule State, Review & Sign-Off Endpoints (Phase 4)
router.get('/schedule/active', orchestrator.getActiveSchedule);
router.get('/schedule/versions', orchestrator.getScheduleVersions);
// The three outputs of one version (Mother Schedule, Teachers' Program, Room Program), joined; a read.
router.get('/schedule/outputs', outputs.getScheduleOutputs);
// The office's exports (Phase 8 Part 2): the Class Schedule (SF-003), the room schedule per week
// group and the Teachers' Program (SF-029) as DOCX or PDF, streamed with plain names. Reads only,
// open to every signed-in role, like printing; /fonts answers the Export card's font note.
const exportsController = require('../controllers/exportsController');
router.get('/schedule/exports/fonts', exportsController.exportFonts);
router.get('/schedule/exports', exportsController.exportSchedule);
router.get('/schedule/print-sheets', exportsController.printSheets);
router.post('/schedule/restore', requirePermission('version.restore'), orchestrator.restoreScheduleVersion);
router.post('/schedule/approve-stage', orchestrator.advanceApprovalStage);

module.exports = router;
