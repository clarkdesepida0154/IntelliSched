const mongoose = require('mongoose');

// One GA run (Phase 2 Step 4), collection generation_runs. The gateway starts the run as a
// background job on the Python service, follows it, and saves the Draft itself exactly once when the
// job is done (even if the browser was closed). Nothing here is ever deleted.
//   status: running -> saving -> done       (the result passed the validator and was saved)
//           running -> failed               (the job failed, the result broke a hard rule, or the
//                                            Python service lost the job)
//           running -> cancelled            (the Dean cancelled; nothing is saved)
// No index: the collection is small; restart recovery reads the runs still marked running/saving.
const personSchema = new mongoose.Schema({ id: String, name: String, role: String }, { _id: false });

const generationRunSchema = new mongoose.Schema({
  academicYear: { type: String, required: true, trim: true },
  semester: { type: Number, required: true, enum: [1, 2] },
  status: { type: String, required: true, enum: ['running', 'saving', 'done', 'failed', 'cancelled'], default: 'running' },
  // Who pressed Execute (rows the gateway writes on its own name "System" as the actor).
  startedBy: { type: personSchema, default: null },
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
  // The GA settings as sent (mode, time budget, population, ...) and the seed (always recorded).
  settings: { type: mongoose.Schema.Types.Mixed, default: undefined },
  seed: { type: Number },
  pythonJobId: { type: String, trim: true },
  // sha256 of the Engine 3 request: the result is saved only against the same request (the term's data
  // may not change while the GA runs), rebuilt from the database after a gateway restart.
  requestHash: { type: String },
  // The time budget in milliseconds (the GA page shows elapsed time against it).
  budgetMs: { type: Number },
  cancelRequested: { type: Boolean, default: false },
  cancelledBy: { type: personSchema, default: undefined },
  // Live progress while running: { generation, elapsedMs, bestHard, bestSoft, budgetMs }.
  progress: { type: mongoose.Schema.Types.Mixed, default: undefined },
  demands: { type: Number },
  // The outcome in the Dean's words ("No conflicts – saved as Draft v2", "The schedule still has 3
  // conflicts"), the technical cause for "Advanced" when there is one, and the saved version.
  message: { type: String, trim: true },
  detail: { type: String, trim: true, default: undefined },
  scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'MotherSchedule', default: null },
  version: { type: String, default: null },
  // Phase 3 Step 4, for the plain result (also in gaStats): the TBA rooms the run had { mode, lab, lec }
  // (set at the start), and in the saved Draft the classes in TBA rooms, the TBA rooms that received
  // classes { lab, lec }, the Saturday classes (NSTP not counted), the classes that need no CCS room
  // (TBA), and the time the run took.
  tbaRooms: { type: mongoose.Schema.Types.Mixed, default: undefined },
  classesInTbaRooms: { type: Number, default: undefined },
  tbaRoomsUsed: { type: mongoose.Schema.Types.Mixed, default: undefined },
  saturdayClasses: { type: Number, default: undefined },
  noRoomClasses: { type: Number, default: undefined },
  // Phase 3 Step 7: the lectures held online (a day and a time, no room); only when there are some.
  onlineClasses: { type: Number, default: undefined },
  runtimeMs: { type: Number, default: undefined },
  // Phase 8 Part 5: the saved schedule's single-class days ({ professors, sections }) and, when the
  // transcribed CSV has the semester, last year's manual schedule's ({ termLabel, professors,
  // sections, note }) — the Generate result shows them side by side.
  singleClassDays: { type: mongoose.Schema.Types.Mixed, default: undefined },
  lastYearSingleClassDays: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Phase 8 Part 5 (decision 2c): the plain cause a failed run names when the rooms sit above the
  // headroom level, with the two ways out — never only "Try again".
  cause: { type: String, trim: true, default: undefined },
  // The validator's answer when the result broke a hard rule (nothing saved).
  hard: { type: mongoose.Schema.Types.Mixed, default: undefined },
  violations: { type: mongoose.Schema.Types.Mixed, default: undefined },
  gaStats: { type: mongoose.Schema.Types.Mixed, default: undefined }
}, { timestamps: true });

module.exports = mongoose.model('GenerationRun', generationRunSchema, 'generation_runs');
